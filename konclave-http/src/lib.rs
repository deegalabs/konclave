//! The HTTP-serving rules the helper and the relay must apply IDENTICALLY.
//!
//! Both are public servers on the open internet, and both fixed a body read with no ceiling - but
//! in two files called `concurrency.rs`, one per server, and only ONE of them actually got the cap. The helper went on reading an unbounded body from a public POST for the
//! fifteen days between #269 being filed and someone noticing that the release notes claimed
//! otherwise.
//!
//! That is this repo's dominant defect shape, and the answer that works here is the same one that
//! worked for the write message in `konclave-seal`: the rule lives in ONE place that both callers
//! read. A third copy cannot drift from the other two if there is no third copy.
//!
//! The worker pool deliberately stays OUT of here, and finding out why is the reason this crate is
//! small. The two look like one duplicated rule and are not: the helper sizes at
//! `(parallelism * 4).clamp(16, 64)` because a send holds a worker for as long as the quorum takes,
//! the relay at `(parallelism * 2).clamp(4, 32)` because it is in-memory mailbox work behind one
//! mutex. Sharing them would have quietly shrunk the helper's pool - on the service whose outage
//! came from being too serial. Same shape is not the same rule.
//!
//! Deliberately dependency-free. The relay depends on `tiny_http`, `serde` and `serde_json` and
//! nothing else, on purpose - it is a blind mailbox and its bus factor is its smallness. Sharing
//! through `orchestrator` would have dragged the whole engine-facing crate into it, so this crate
//! carries no dependencies at all and stays something either server can take without argument.

/// How much of a request body to read.
#[derive(Debug, PartialEq, Eq)]
pub enum ReadPlan {
    /// Over the ceiling before a byte is read: do not buffer it at all.
    Skip,
    /// Read at most this many bytes.
    Read(u64),
}

/// The largest request body either server will buffer.
///
/// Generous for the JSON both actually take - a relay message is capped at 128 KiB once parsed, and
/// the helper's biggest real body is a payroll of a few hundred lines - while still bounded, which
/// is the whole point. A cap that is never hit in normal use is a cap doing its job.
pub const MAX_BODY: u64 = 2 * 1024 * 1024;

/// The largest message the relay accepts (`data`, in bytes), past which a post is a `413`.
///
/// Here, rather than in the relay, because a second reader has to agree with it exactly: the
/// coordinator decides from this number how large a payment can still be signed, since its signing
/// request crosses the relay as one message (#821). Two copies of it would let the relay tighten
/// while the coordinator went on approving payments the relay then refuses at send time.
pub const RELAY_MAX_DATA: usize = 128 * 1024;

/// Decide how much of a body to read from its declared `Content-Length`.
///
/// The hole this closes: a body with NO `Content-Length` (chunked, or a dribbling client) was read
/// unbounded. Absent is not the same as small, so it gets the same ceiling as any other body.
pub fn body_read_cap(content_length: Option<u64>) -> ReadPlan {
    match content_length {
        Some(n) if n > MAX_BODY => ReadPlan::Skip,
        Some(n) => ReadPlan::Read(n),
        None => ReadPlan::Read(MAX_BODY),
    }
}

/// Who is asking, as far as the server can tell: an address, or nobody it could name.
///
/// There is no way to build one from text. The only producer of a value from a request is
/// [`client_address`], which accepts nothing that does not parse as an address, and the only other
/// way in is [`ClientAddress::from_ip`], which takes a parsed `IpAddr`. So the text a
/// `ClientAddress` prints is always an address in its canonical spelling (or `unknown`), and two
/// spellings of one address are one value: `2001:DB8::1` and `2001:db8::1` are equal, and so are
/// `::ffff:203.0.113.7` and `203.0.113.7`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub struct ClientAddress(Option<std::net::IpAddr>);

impl ClientAddress {
    /// An address the server has parsed. An IPv4 address written as an IPv4-mapped IPv6 address is
    /// the IPv4 address.
    pub const fn from_ip(ip: std::net::IpAddr) -> Self {
        ClientAddress(Some(ip.to_canonical()))
    }

    /// No address could be named. Every such request shares this one value, which is deliberate: a
    /// request with no address at all must still be limited, and must not get a value of its own.
    pub const fn unknown() -> Self {
        ClientAddress(None)
    }
}

impl std::fmt::Display for ClientAddress {
    /// The canonical text of the address, or `unknown`. Never contains an `@`.
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self.0 {
            Some(ip) => write!(f, "{ip}"),
            None => f.write_str("unknown"),
        }
    }
}

/// What a [`RateLimiter`] counts by. Opaque: it is built here, by one of three constructors, and
/// nowhere else, so no caller can hand the limiter a string of its own.
///
/// Every key is scoped to the client address the server attributes to the request (see
/// [`client_address`]), and says what kind of key it is:
///
/// - `ip:<address>` counts everything one address does
/// - `from:<tag>@<address>` counts what one address does under a sender tag
/// - `room:<id>@<address>` counts what one address does in one room, when it names no sender
///
/// A tag or a room id comes from the caller, so it is only ever placed behind a kind prefix and
/// followed by the address. The three prefixes start with different letters, and an address never
/// contains an `@`, so different (kind, text, address) triples give different keys, whatever the
/// text.
///
/// The caller bounds the length of what it passes in; this type does not truncate.
#[derive(Debug, Clone, PartialEq, Eq, Hash)]
pub struct RateKey(String);

impl RateKey {
    /// Everything one address does.
    pub fn address(addr: &ClientAddress) -> Self {
        RateKey(format!("ip:{addr}"))
    }

    /// What one address does under a sender tag.
    pub fn sender(tag: &str, addr: &ClientAddress) -> Self {
        RateKey(format!("from:{tag}@{addr}"))
    }

    /// What one address does in one room, for a request that names no sender.
    pub fn room(room_id: &str, addr: &ClientAddress) -> Self {
        RateKey(format!("room:{room_id}@{addr}"))
    }
}

/// A fixed-window limiter: at most `max` requests per window, per key.
///
/// It was written for the relay (#64) and lived in the relay's own file. The coordinator had none
/// (#558), for the reason this crate exists: the rule was somewhere only one of the two servers
/// could reach. It is dependency-free, O(1) amortized, and takes `now` instead of reading a clock,
/// so a test can move time rather than sleep through it.
///
/// A key is a [`RateKey`], and every one of them is scoped to a client address. An address is the
/// robust base, since a flooding source cannot cheaply change it; the tags and ids a client
/// chooses are only ever counted underneath one.
pub struct RateLimiter {
    window_secs: i64,
    max_keys: usize,
    // key -> (window_start, count_in_window)
    seen: std::sync::Mutex<std::collections::HashMap<RateKey, (i64, u32)>>,
}

impl RateLimiter {
    /// `max_keys` bounds memory: past it, windows that have already ended are reclaimed.
    pub fn new(window_secs: i64, max_keys: usize) -> Self {
        RateLimiter {
            window_secs,
            max_keys,
            seen: std::sync::Mutex::new(std::collections::HashMap::new()),
        }
    }

    /// Count one request for `key`, and answer whether it is within `max` for the current window.
    ///
    /// A refused request is counted too. A source that keeps hammering stays refused until its
    /// window ends, rather than being let back in as soon as it drops under the line.
    pub fn allow(&self, key: &RateKey, now: i64, max: u32) -> bool {
        // A panic while holding this lock must not wedge every later request behind a poisoned
        // mutex: the counts are advisory, so the inner value is still the right thing to use.
        let mut seen = self.seen.lock().unwrap_or_else(|e| e.into_inner());
        if seen.len() > self.max_keys {
            let window = self.window_secs;
            seen.retain(|_, (start, _)| now.saturating_sub(*start) < window);
        }
        let entry = seen.entry(key.clone()).or_insert((now, 0));
        if now.saturating_sub(entry.0) >= self.window_secs {
            *entry = (now, 0);
        }
        entry.1 = entry.1.saturating_add(1);
        entry.1 <= max
    }

    /// How many keys are being tracked. For tests and for an operator's log, never for a decision.
    pub fn tracked(&self) -> usize {
        self.seen.lock().unwrap_or_else(|e| e.into_inner()).len()
    }
}

/// The environment variable that names the [`ForwardingRule`], read once at boot by each server.
pub const TRUSTED_PROXY_HOPS_VAR: &str = "KONCLAVE_TRUSTED_PROXY_HOPS";

/// The most proxies a setting may name. A typo that asks for more is refused, not clamped.
pub const MAX_TRUSTED_PROXY_HOPS: usize = 8;

/// Which value of `X-Forwarded-For` names the client.
///
/// What the header says is only as good as what the platform in front of the server does with it,
/// and that is a fact about the platform, not something this code can make true. So the rule is a
/// setting, the default is the one that has always been in force, and the operator sets the number
/// from what the platform is measured to do (`DEPLOY.md`).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ForwardingRule {
    /// The default, unchanged: the first hop of the first header value that holds an address. Right
    /// only where the platform replaces what the client sent.
    FirstHop,
    /// Trust this many proxies, nearest to the server last. `0` ignores the header and uses the
    /// socket; `n` takes the `n`th value from the right of the whole chain, which is the address
    /// the outermost trusted proxy saw, whatever the client wrote to the left of it.
    TrustedHops(usize),
}

impl ForwardingRule {
    /// The rule a setting names. Unset or empty is the default; anything that is not a whole number
    /// from 0 to [`MAX_TRUSTED_PROXY_HOPS`] is an error, so a typo does not quietly become the
    /// default, which is the unsafe direction.
    pub fn from_setting(value: Option<&str>) -> Result<Self, String> {
        let Some(text) = value.map(str::trim).filter(|t| !t.is_empty()) else {
            return Ok(ForwardingRule::FirstHop);
        };
        let shown: String = text.chars().take(32).collect();
        if !text.bytes().all(|b| b.is_ascii_digit()) {
            return Err(format!(
                "{TRUSTED_PROXY_HOPS_VAR} must be a whole number from 0 to {MAX_TRUSTED_PROXY_HOPS}, or unset; got {shown:?}"
            ));
        }
        match text.parse::<usize>() {
            Ok(n) if n <= MAX_TRUSTED_PROXY_HOPS => Ok(ForwardingRule::TrustedHops(n)),
            _ => Err(format!(
                "{TRUSTED_PROXY_HOPS_VAR} must be a whole number from 0 to {MAX_TRUSTED_PROXY_HOPS}, or unset; got {shown:?}"
            )),
        }
    }

    /// The number a health answer reports: `None` for the default rule.
    pub fn trusted_hops(self) -> Option<usize> {
        match self {
            ForwardingRule::FirstHop => None,
            ForwardingRule::TrustedHops(n) => Some(n),
        }
    }
}

/// The rule a server runs with, set once by [`boot_forwarding_rule`].
static BOOTED_RULE: std::sync::OnceLock<ForwardingRule> = std::sync::OnceLock::new();

#[cfg(test)]
thread_local! {
    /// A test's rule for its own thread ([`with_forwarding_rule`]); `None` everywhere else.
    static RULE_OVERRIDE: std::cell::Cell<Option<ForwardingRule>> =
        const { std::cell::Cell::new(None) };
}

/// The rule the environment names. A value that is not text is an error, like any other value
/// this does not understand: it never becomes the default.
pub fn forwarding_rule_from_env() -> Result<ForwardingRule, String> {
    rule_from_os_value(std::env::var_os(TRUSTED_PROXY_HOPS_VAR).as_deref())
}

/// [`forwarding_rule_from_env`] on a value already read, so it can be tested without the environment.
fn rule_from_os_value(value: Option<&std::ffi::OsStr>) -> Result<ForwardingRule, String> {
    match value {
        None => Ok(ForwardingRule::FirstHop),
        Some(value) => match value.to_str() {
            Some(text) => ForwardingRule::from_setting(Some(text)),
            None => Err(format!(
                "{TRUSTED_PROXY_HOPS_VAR} must be a whole number from 0 to {MAX_TRUSTED_PROXY_HOPS}, or unset; got a value that is not text"
            )),
        },
    }
}

/// Reads the setting, records it as the rule for the life of the process, and says which rule is
/// in force. The one place a server learns its rule: both public servers call it first in `main`,
/// before they touch a volume or a socket, so a value it does not understand stops the process
/// (`Err`, which the caller turns into exit code 2) and never becomes the default.
pub fn init_forwarding_rule() -> Result<ForwardingRule, String> {
    let rule = forwarding_rule_from_env()?;
    Ok(*BOOTED_RULE.get_or_init(|| rule))
}

/// [`init_forwarding_rule`] for a server's `main`: logs the rule under `service`, or the reason and
/// exits with code 2.
pub fn boot_forwarding_rule(service: &str) -> ForwardingRule {
    match init_forwarding_rule() {
        Ok(rule) => {
            eprintln!("{service} counts a client by {rule}");
            rule
        }
        Err(why) => {
            eprintln!("{service}: {why}");
            std::process::exit(2);
        }
    }
}

/// The rule in force: the booted rule, else the default (and, in this crate's own tests, a test's
/// override on its thread first).
pub fn forwarding_rule() -> ForwardingRule {
    #[cfg(test)]
    if let Some(rule) = RULE_OVERRIDE.with(|c| c.get()) {
        return rule;
    }
    BOOTED_RULE
        .get()
        .copied()
        .unwrap_or(ForwardingRule::FirstHop)
}

/// Runs `f` with `rule` in force on THIS thread only, and restores what was there after. Tests of
/// this crate only: no server can set a rule of its own.
#[cfg(test)]
fn with_forwarding_rule<T>(rule: ForwardingRule, f: impl FnOnce() -> T) -> T {
    struct Restore(Option<ForwardingRule>);
    impl Drop for Restore {
        fn drop(&mut self) {
            RULE_OVERRIDE.with(|c| c.set(self.0));
        }
    }
    let _restore = Restore(RULE_OVERRIDE.with(|c| c.replace(Some(rule))));
    f()
}

/// Longest forwarding chain counted on its own; longer ones share the last slot.
const CHAIN_SLOTS: usize = 10;

/// Which chain lengths this process has seen, so the first sighting of each is logged once.
static CHAIN_SEEN: [std::sync::atomic::AtomicBool; CHAIN_SLOTS] =
    [const { std::sync::atomic::AtomicBool::new(false) }; CHAIN_SLOTS];

/// How many values `X-Forwarded-For` carries across every header line, split at the commas; `0`
/// when there is no such header. A count, never an address.
pub fn chain_length<'a>(forwarded: impl IntoIterator<Item = &'a str>) -> usize {
    chain(forwarded).len()
}

/// The values of `X-Forwarded-For` as one chain, across every header line, split at the commas. The
/// one splitter: the count in the log and the rule's pick read the same chain.
fn chain<'a>(forwarded: impl IntoIterator<Item = &'a str>) -> Vec<&'a str> {
    forwarded
        .into_iter()
        .flat_map(|value| value.split(','))
        .collect()
}

/// The first time this process sees a chain of a given length, it says so in the log, as a number
/// only. This is how the operator learns from the platform how many values it writes: one request
/// with no header and one with a known number of values, then read the log (`DEPLOY.md`).
fn note_chain_length(len: usize) -> Option<usize> {
    let slot = len.min(CHAIN_SLOTS - 1);
    let first = !CHAIN_SEEN[slot].swap(true, std::sync::atomic::Ordering::Relaxed);
    first.then_some(slot)
}

/// The address the limits count a request under: the rule in force ([`forwarding_rule`]) applied
/// to the request's `X-Forwarded-For` values and socket address. The only entry point a server
/// has: [`client_address`] is private to this crate, so no server can pass a rule of its own.
pub fn request_client_address<'a>(
    forwarded: impl IntoIterator<Item = &'a str> + Clone,
    remote: Option<&str>,
) -> ClientAddress {
    if let Some(slot) = note_chain_length(chain_length(forwarded.clone())) {
        let plus = if slot == CHAIN_SLOTS - 1 {
            " or more"
        } else {
            ""
        };
        eprintln!("forwarding: first request with {slot}{plus} X-Forwarded-For value(s)");
    }
    client_address(forwarding_rule(), forwarded, remote)
}

impl std::fmt::Display for ForwardingRule {
    /// What a boot line says, so an operator can see which rule is in force.
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            ForwardingRule::FirstHop => write!(
                f,
                "the first hop of X-Forwarded-For ({TRUSTED_PROXY_HOPS_VAR} unset)"
            ),
            ForwardingRule::TrustedHops(0) => write!(
                f,
                "the socket address, X-Forwarded-For ignored ({TRUSTED_PROXY_HOPS_VAR}=0)"
            ),
            ForwardingRule::TrustedHops(n) => write!(
                f,
                "value {n} from the right of X-Forwarded-For ({TRUSTED_PROXY_HOPS_VAR}={n})"
            ),
        }
    }
}

/// The client's address, for rate limiting, under a [`ForwardingRule`].
///
/// Behind a platform proxy the socket's peer is the proxy, so the address has to come from
/// `X-Forwarded-For`; a direct connection has no such header and falls back to the socket. Which
/// value of the header to believe is the rule: the default takes the first hop, which is right only
/// if the platform replaces what the client sent. Nothing here makes that true.
///
/// `forwarded` is EVERY value of that header, in order, because a request may carry more than one.
/// Under the default rule the first value whose first hop is an address wins (the relay has always
/// walked every header; requiring an address is new with #558, and stricter than what it did). Under
/// `TrustedHops(n)` the values are one chain, split at the commas, and the `n`th from the right is
/// the answer: if it is not an address the answer is unknown, and its neighbour is not tried; a
/// chain shorter than `n` did not pass the proxies the setting names, so the socket is the answer.
///
/// Takes strings, not a request, so this crate stays free of any HTTP library. Returns a
/// [`ClientAddress`], never text: what comes back is an address in its canonical spelling, or
/// unknown.
pub(crate) fn client_address<'a>(
    rule: ForwardingRule,
    forwarded: impl IntoIterator<Item = &'a str>,
    remote: Option<&str>,
) -> ClientAddress {
    // Only something that PARSES as an address is used. The value becomes a key in a map, so a
    // header carrying thirty thousand bytes of anything would otherwise be stored as one, and a
    // value that is not an address names no client anyway.
    let parse = |s: &str| s.trim().parse::<std::net::IpAddr>().ok();
    let named = |ip: Option<std::net::IpAddr>| {
        ip.map_or_else(ClientAddress::unknown, ClientAddress::from_ip)
    };
    match rule {
        ForwardingRule::FirstHop => named(
            forwarded
                .into_iter()
                .filter_map(|value| value.split(',').next())
                .find_map(parse)
                .or_else(|| remote.and_then(parse)),
        ),
        ForwardingRule::TrustedHops(0) => named(remote.and_then(parse)),
        ForwardingRule::TrustedHops(n) => {
            let chain = chain(forwarded);
            match chain.len().checked_sub(n) {
                Some(i) => named(parse(chain[i])),
                None => named(remote.and_then(parse)),
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::HashSet;

    /// A parsed address, the way a server hands one to the limiter.
    fn addr(s: &str) -> ClientAddress {
        ClientAddress::from_ip(s.parse().expect("a test address"))
    }

    /// A key for tests that only need "some key": any (tag, address) pair does.
    fn key(tag: &str) -> RateKey {
        RateKey::sender(tag, &addr("203.0.113.7"))
    }

    #[test]
    fn the_request_past_the_limit_is_refused_and_the_next_window_starts_over() {
        let l = RateLimiter::new(10, 64);
        let now = 1_000_000;
        for i in 0..5 {
            assert!(
                l.allow(&key("k"), now, 5),
                "request {i} is within the limit"
            );
        }
        assert!(
            !l.allow(&key("k"), now, 5),
            "the 6th in the same window is refused"
        );
        assert!(
            !l.allow(&key("k"), now + 9, 5),
            "and still refused inside the window"
        );
        assert!(l.allow(&key("k"), now + 10, 5), "a new window starts over");
    }

    #[test]
    fn keys_are_counted_separately() {
        let l = RateLimiter::new(10, 64);
        let now = 2_000_000;
        for _ in 0..6 {
            let _ = l.allow(&key("a"), now, 5);
        }
        assert!(!l.allow(&key("a"), now, 5), "a is over its limit");
        assert!(l.allow(&key("b"), now, 5), "and b has its own");
    }

    /// The map must not grow without bound under many distinct sources. Past `max_keys`, windows
    /// that have ended are reclaimed; windows still open are kept, because dropping one would hand
    /// its source a fresh allowance.
    #[test]
    fn ended_windows_are_reclaimed_and_open_ones_are_kept() {
        let l = RateLimiter::new(10, 4);
        for i in 0..5 {
            let _ = l.allow(&key(&format!("old-{i}")), 1_000, 5);
        }
        assert_eq!(l.tracked(), 5);
        // One more, a window later: the five old windows have ended and go.
        assert!(l.allow(&key("new"), 1_010, 5));
        assert_eq!(l.tracked(), 1, "only the open window remains");

        // Open windows survive a reclaim, and a source over its limit stays refused.
        let l = RateLimiter::new(10, 2);
        for _ in 0..6 {
            let _ = l.allow(&key("flooder"), 2_000, 5);
        }
        let _ = l.allow(&key("x"), 2_000, 5);
        let _ = l.allow(&key("y"), 2_000, 5);
        let _ = l.allow(&key("z"), 2_001, 5);
        assert!(
            !l.allow(&key("flooder"), 2_002, 5),
            "a reclaim must not hand a flooding source a fresh allowance"
        );
    }

    /// The same tag from two addresses is two keys, and so is the same address under two tags: a
    /// budget belongs to the pair.
    #[test]
    fn a_budget_belongs_to_the_pair_of_tag_and_address() {
        let l = RateLimiter::new(10, 64);
        let now = 3_000_000;
        for _ in 0..6 {
            let _ = l.allow(&RateKey::sender("t", &addr("198.51.100.9")), now, 5);
        }
        assert!(!l.allow(&RateKey::sender("t", &addr("198.51.100.9")), now, 5));
        assert!(
            l.allow(&RateKey::sender("t", &addr("203.0.113.7")), now, 5),
            "the same tag from another address has its own budget"
        );
        assert!(
            l.allow(&RateKey::sender("u", &addr("198.51.100.9")), now, 5),
            "and the same address under another tag has its own"
        );
    }

    /// The three kinds of key the servers count by, for a spread of tags a client could send.
    fn every_key(tags: &[String], addrs: &[ClientAddress]) -> Vec<(String, RateKey)> {
        let mut keys = Vec::new();
        for a in addrs {
            keys.push((format!("address {a}"), RateKey::address(a)));
            for t in tags {
                keys.push((format!("sender {t:?} {a}"), RateKey::sender(t, a)));
                keys.push((format!("room {t:?} {a}"), RateKey::room(t, a)));
            }
        }
        keys
    }

    fn awkward_tags() -> Vec<String> {
        vec![
            "ip:203.0.113.7".into(),
            "ip:198.51.100.9".into(),
            "ip:unknown".into(),
            "ip:2001:db8::1".into(),
            "x@203.0.113.7".into(),
            "@".into(),
            "@203.0.113.7".into(),
            "a@b@203.0.113.7".into(),
            "".into(),
            "@".repeat(128),
            "é".into(),
            "ünïcode@203.0.113.7".into(),
            "from:t@203.0.113.7".into(),
            "room:t@203.0.113.7".into(),
            "member-tag".into(),
            "2".into(),
            "t".into(),
            "T".into(),
            "room:t".into(),
            "from:t".into(),
        ]
    }

    fn some_addresses() -> Vec<ClientAddress> {
        vec![
            addr("203.0.113.7"),
            addr("198.51.100.9"),
            addr("2001:db8::1"),
            addr("::1"),
            addr("3.0.113.7"),
            addr("23.0.113.7"),
            ClientAddress::unknown(),
        ]
    }

    /// Each kind of key is its own namespace: for any text and any address, the address keys, the
    /// sender keys and the room keys are three sets with nothing in common.
    #[test]
    fn each_kind_of_key_is_its_own_namespace() {
        let (tags, addrs) = (awkward_tags(), some_addresses());
        let address_keys: HashSet<RateKey> = addrs.iter().map(RateKey::address).collect();
        let mut sender_keys = HashSet::new();
        let mut room_keys = HashSet::new();
        for tag in &tags {
            for a in &addrs {
                sender_keys.insert(RateKey::sender(tag, a));
                room_keys.insert(RateKey::room(tag, a));
            }
        }
        assert!(
            address_keys.is_disjoint(&sender_keys),
            "a sender key equals an address key"
        );
        assert!(
            address_keys.is_disjoint(&room_keys),
            "a room key equals an address key"
        );
        assert!(
            sender_keys.is_disjoint(&room_keys),
            "a sender key equals a room key"
        );
    }

    /// Two different (kind, tag, address) triples are two different keys. Counted by building every
    /// key and checking that the set has as many members as there are distinct triples.
    #[test]
    fn two_different_pairs_never_share_a_key() {
        let tags = awkward_tags();
        let addrs = some_addresses();
        let keys = every_key(&tags, &addrs);
        let distinct: HashSet<&RateKey> = keys.iter().map(|(_, k)| k).collect();
        assert_eq!(
            distinct.len(),
            keys.len(),
            "two different (kind, tag, address) triples were given one key"
        );
    }

    /// Keys of different kinds never coincide, whatever the text.
    #[test]
    fn keys_of_different_kinds_never_coincide() {
        let (a, b) = (addr("203.0.113.7"), addr("198.51.100.9"));
        assert_ne!(RateKey::sender("ip:203.0.113.7", &b), RateKey::address(&a));
        assert_ne!(RateKey::room("ip:203.0.113.7", &b), RateKey::address(&a));
        assert_ne!(
            RateKey::room("t", &a),
            RateKey::sender("t", &a),
            "a room and a sender of the same text are different kinds"
        );
        assert_ne!(RateKey::sender("room:t", &a), RateKey::room("t", &a));
        assert_ne!(RateKey::room("from:t", &a), RateKey::sender("t", &a));
    }

    /// Within one kind, a different text or a different address is a different key.
    #[test]
    fn a_different_text_or_address_is_a_different_key() {
        let (a, b) = (addr("203.0.113.7"), addr("198.51.100.9"));
        assert_ne!(
            RateKey::sender("t@203.0.113.7", &b),
            RateKey::sender("t", &a)
        );
        assert_ne!(RateKey::room("r@203.0.113.7", &b), RateKey::room("r", &a));
        assert_ne!(RateKey::sender("t", &a), RateKey::sender("t", &b));
        assert_ne!(RateKey::room("r", &a), RateKey::room("r", &b));
        assert_ne!(
            RateKey::sender("T", &a),
            RateKey::sender("t", &a),
            "text that differs only in case is different text"
        );
    }

    #[test]
    fn an_ipv6_address_has_one_canonical_text() {
        assert_eq!(addr("2001:DB8::1"), addr("2001:db8::1"));
        assert_eq!(addr("2001:DB8::1").to_string(), "2001:db8::1");
        assert_eq!(addr("0:0:0:0:0:0:0:1").to_string(), "::1");
        assert_eq!(
            RateKey::address(&addr("2001:DB8::1")),
            RateKey::address(&addr("2001:db8::1")),
            "two spellings of one address are one key"
        );
        assert_eq!(
            RateKey::sender("t", &addr("2001:DB8:0:0:0:0:0:1")),
            RateKey::sender("t", &addr("2001:db8::1"))
        );
    }

    #[test]
    fn a_mapped_ipv4_address_is_the_ipv4_address_and_a_plain_ipv6_one_stays() {
        assert_eq!(addr("::ffff:203.0.113.7"), addr("203.0.113.7"));
        assert_eq!(addr("::ffff:203.0.113.7").to_string(), "203.0.113.7");
        // Addresses that merely look close are not folded.
        assert_ne!(addr("::203.0.113.7"), addr("203.0.113.7"));
        assert_ne!(addr("2001:db8::cb00:7107"), addr("203.0.113.7"));
        assert_eq!(
            addr("2001:db8::cb00:7107").to_string(),
            "2001:db8::cb00:7107"
        );
        assert_ne!(addr("2001:db8::1"), addr("203.0.113.7"));
    }

    #[test]
    fn an_address_prints_no_at_sign_and_unknown_prints_unknown() {
        for a in some_addresses() {
            assert!(!a.to_string().contains('@'), "{a}");
        }
        assert_eq!(ClientAddress::unknown().to_string(), "unknown");
        assert_eq!(
            RateKey::address(&ClientAddress::unknown()),
            RateKey::address(&ClientAddress::unknown())
        );
    }

    #[test]
    fn the_first_forwarded_hop_is_the_client() {
        assert_eq!(
            client_address(
                ForwardingRule::FirstHop,
                ["203.0.113.7, 10.0.0.1, 10.0.0.2"],
                Some("10.0.0.2")
            ),
            addr("203.0.113.7")
        );
        assert_eq!(
            client_address(
                ForwardingRule::FirstHop,
                ["  203.0.113.7  "],
                Some("10.0.0.2")
            ),
            addr("203.0.113.7"),
            "surrounding space is not part of the address"
        );
    }

    #[test]
    fn without_a_forwarded_header_the_socket_is_the_client() {
        assert_eq!(
            client_address(ForwardingRule::FirstHop, [], Some("198.51.100.9")),
            addr("198.51.100.9")
        );
        assert_eq!(
            client_address(ForwardingRule::FirstHop, [""], Some("198.51.100.9")),
            addr("198.51.100.9"),
            "an empty header is an absent one"
        );
        assert_eq!(
            client_address(
                ForwardingRule::FirstHop,
                [" , 10.0.0.1"],
                Some("198.51.100.9")
            ),
            addr("198.51.100.9"),
            "an empty first hop is not an address"
        );
    }

    /// A request may carry the header more than once. The first value that names a client wins, and
    /// one that names nobody is skipped rather than ending the search.
    #[test]
    fn a_second_forwarded_header_is_read_when_the_first_names_nobody() {
        assert_eq!(
            client_address(
                ForwardingRule::FirstHop,
                ["", "203.0.113.7, 10.0.0.1"],
                Some("10.0.0.2")
            ),
            addr("203.0.113.7")
        );
        assert_eq!(
            client_address(
                ForwardingRule::FirstHop,
                ["198.51.100.9", "203.0.113.7"],
                Some("10.0.0.2")
            ),
            addr("198.51.100.9"),
            "and the first that does name one is the answer"
        );
    }

    /// The value becomes a key in a map. Anything that is not an address is skipped, however long,
    /// and the search goes on to the next header and then to the socket.
    #[test]
    fn a_forwarded_value_that_is_not_an_address_is_never_the_key() {
        let junk = "x".repeat(30_000);
        assert_eq!(
            client_address(
                ForwardingRule::FirstHop,
                [junk.as_str()],
                Some("198.51.100.9")
            ),
            addr("198.51.100.9")
        );
        assert_eq!(
            client_address(
                ForwardingRule::FirstHop,
                ["not-an-address", "203.0.113.7"],
                Some("10.0.0.2")
            ),
            addr("203.0.113.7")
        );
        assert_eq!(
            client_address(
                ForwardingRule::FirstHop,
                ["203.0.113.7:4780"],
                Some("198.51.100.9")
            ),
            addr("198.51.100.9"),
            "an address with a port is not an address"
        );
        assert_eq!(
            client_address(ForwardingRule::FirstHop, ["2001:db8::1"], None),
            addr("2001:db8::1")
        );
        assert_eq!(
            client_address(ForwardingRule::FirstHop, ["junk"], Some("also junk")),
            ClientAddress::unknown()
        );
    }

    /// Every unknown client shares one key. That is deliberate: a request with no address at all
    /// must still be limited, and must not get a key of its own to be counted alone under.
    #[test]
    fn a_client_with_no_address_at_all_is_still_a_key() {
        assert_eq!(
            client_address(ForwardingRule::FirstHop, [], None),
            ClientAddress::unknown()
        );
        assert_eq!(
            client_address(ForwardingRule::FirstHop, [], None).to_string(),
            "unknown"
        );
    }

    #[test]
    fn one_client_is_one_key_however_its_address_is_spelled() {
        assert_eq!(
            client_address(ForwardingRule::FirstHop, ["2001:DB8::1"], None).to_string(),
            "2001:db8::1"
        );
        assert_eq!(
            client_address(ForwardingRule::FirstHop, [], Some("0:0:0:0:0:0:0:1")).to_string(),
            "::1",
            "the same address written out in full"
        );
        assert_eq!(
            client_address(ForwardingRule::FirstHop, ["::ffff:203.0.113.7"], None).to_string(),
            "203.0.113.7"
        );
        assert_eq!(
            RateKey::address(&client_address(
                ForwardingRule::FirstHop,
                ["2001:DB8::1"],
                None
            )),
            RateKey::address(&client_address(
                ForwardingRule::FirstHop,
                [],
                Some("2001:db8::1")
            )),
            "the forwarded header and the socket spell it differently and name one client"
        );
    }

    // ---- the forwarding rule (#400) --------------------------------------------------------------

    fn hops(n: usize) -> ForwardingRule {
        ForwardingRule::TrustedHops(n)
    }

    #[test]
    fn an_unset_or_empty_setting_is_the_first_hop_rule_as_before() {
        assert_eq!(
            ForwardingRule::from_setting(None),
            Ok(ForwardingRule::FirstHop)
        );
        assert_eq!(
            ForwardingRule::from_setting(Some("")),
            Ok(ForwardingRule::FirstHop)
        );
        assert_eq!(
            ForwardingRule::from_setting(Some("  ")),
            Ok(ForwardingRule::FirstHop)
        );
        assert_eq!(ForwardingRule::FirstHop.trusted_hops(), None);
    }

    #[test]
    fn a_whole_number_names_the_trusted_hops() {
        for n in 0..=MAX_TRUSTED_PROXY_HOPS {
            let rule = ForwardingRule::from_setting(Some(&n.to_string()));
            assert_eq!(rule, Ok(hops(n)), "{n}");
            assert_eq!(hops(n).trusted_hops(), Some(n));
        }
        assert_eq!(ForwardingRule::from_setting(Some(" 2 ")), Ok(hops(2)));
    }

    /// A typo must not quietly become the first-hop rule, which is the unsafe direction.
    #[test]
    fn anything_else_is_refused_and_the_refusal_names_the_variable() {
        let too_many = (MAX_TRUSTED_PROXY_HOPS + 1).to_string();
        for bad in [
            "-1",
            "+1",
            "1.5",
            "two",
            "0x1",
            "1,2",
            too_many.as_str(),
            "99999999999999999999",
        ] {
            let err = ForwardingRule::from_setting(Some(bad)).expect_err(bad);
            assert!(err.contains(TRUSTED_PROXY_HOPS_VAR), "{bad}: {err}");
        }
    }

    #[test]
    fn with_trusted_hops_the_client_is_counted_from_the_right() {
        let chain = ["198.51.100.1, 203.0.113.9"];
        assert_eq!(
            client_address(hops(1), chain, Some("10.0.0.2")),
            addr("203.0.113.9")
        );
        assert_eq!(
            client_address(hops(2), chain, Some("10.0.0.2")),
            addr("198.51.100.1")
        );
    }

    /// The whole point. Whatever the client writes to the left of what the proxies appended is not
    /// the answer, while the first-hop rule is exactly what that text fools.
    #[test]
    fn what_the_client_wrote_to_the_left_is_never_the_answer() {
        let written = ["6.6.6.6, 203.0.113.7, 10.0.0.1"];
        assert_eq!(
            client_address(hops(2), written, Some("10.0.0.2")),
            addr("203.0.113.7")
        );
        assert_eq!(
            client_address(ForwardingRule::FirstHop, written, Some("10.0.0.2")),
            addr("6.6.6.6"),
            "the first-hop rule takes the value the client wrote: it is only as good as the platform"
        );
    }

    #[test]
    fn several_header_values_are_one_chain_in_order() {
        let two_headers = ["10.0.0.1, 10.0.0.2", "203.0.113.7"];
        assert_eq!(
            client_address(hops(1), two_headers, None),
            addr("203.0.113.7")
        );
        assert_eq!(client_address(hops(3), two_headers, None), addr("10.0.0.1"));
    }

    #[test]
    fn a_chain_shorter_than_the_trusted_hops_is_the_socket() {
        assert_eq!(
            client_address(hops(2), ["203.0.113.7"], Some("198.51.100.9")),
            addr("198.51.100.9")
        );
        assert_eq!(
            client_address(hops(1), [], Some("198.51.100.9")),
            addr("198.51.100.9")
        );
        assert_eq!(client_address(hops(1), [], None), ClientAddress::unknown());
    }

    /// The selected hop must be an address, and a neighbour is not tried instead: a position that
    /// holds junk means the chain is not what the setting says it is.
    #[test]
    fn a_selected_hop_that_is_not_an_address_is_unknown_not_its_neighbour() {
        let socket = Some("198.51.100.9");
        assert_eq!(
            client_address(hops(1), ["203.0.113.7, not-an-address"], socket),
            ClientAddress::unknown()
        );
        assert_eq!(
            client_address(hops(1), ["203.0.113.7, "], socket),
            ClientAddress::unknown()
        );
        let junk = "x".repeat(30_000);
        assert_eq!(
            client_address(hops(1), [junk.as_str()], socket),
            ClientAddress::unknown()
        );
    }

    #[test]
    fn zero_trusted_hops_ignores_the_header_altogether() {
        assert_eq!(
            client_address(hops(0), ["6.6.6.6"], Some("198.51.100.9")),
            addr("198.51.100.9")
        );
        assert_eq!(
            client_address(hops(0), ["6.6.6.6"], None),
            ClientAddress::unknown()
        );
    }

    #[test]
    fn the_answer_is_canonical_under_every_rule() {
        assert_eq!(
            client_address(hops(1), ["2001:DB8::1"], None).to_string(),
            "2001:db8::1"
        );
        assert_eq!(
            client_address(hops(1), ["::ffff:203.0.113.7"], None),
            addr("203.0.113.7")
        );
        assert_eq!(
            client_address(hops(0), [], Some("0:0:0:0:0:0:0:1")).to_string(),
            "::1"
        );
    }

    #[test]
    fn the_rule_prints_what_the_boot_line_reports() {
        assert_eq!(
            ForwardingRule::FirstHop.to_string(),
            "the first hop of X-Forwarded-For (KONCLAVE_TRUSTED_PROXY_HOPS unset)"
        );
        assert_eq!(
            hops(0).to_string(),
            "the socket address, X-Forwarded-For ignored (KONCLAVE_TRUSTED_PROXY_HOPS=0)"
        );
        assert_eq!(
            hops(2).to_string(),
            "value 2 from the right of X-Forwarded-For (KONCLAVE_TRUSTED_PROXY_HOPS=2)"
        );
    }

    #[test]
    fn a_body_over_the_ceiling_is_never_buffered() {
        assert_eq!(body_read_cap(Some(MAX_BODY + 1)), ReadPlan::Skip);
    }

    #[test]
    fn a_body_at_the_ceiling_is_read() {
        assert_eq!(body_read_cap(Some(MAX_BODY)), ReadPlan::Read(MAX_BODY));
    }

    #[test]
    fn an_absent_content_length_is_capped_not_unbounded() {
        // The #390 hole. A client that declares nothing must not be trusted more than one that does.
        assert_eq!(body_read_cap(None), ReadPlan::Read(MAX_BODY));
    }

    #[test]
    fn a_declared_length_is_read_exactly() {
        assert_eq!(body_read_cap(Some(1234)), ReadPlan::Read(1234));
        assert_eq!(body_read_cap(Some(0)), ReadPlan::Read(0));
    }

    #[cfg(unix)]
    #[test]
    fn a_setting_that_is_not_text_is_refused_not_read_as_the_default() {
        use std::os::unix::ffi::OsStrExt;
        let not_text = std::ffi::OsStr::from_bytes(&[0x31, 0xff]);
        assert!(rule_from_os_value(Some(not_text)).is_err());
        assert_eq!(rule_from_os_value(None), Ok(ForwardingRule::FirstHop));
        assert_eq!(
            rule_from_os_value(Some(std::ffi::OsStr::new("2"))),
            Ok(ForwardingRule::TrustedHops(2))
        );
        assert!(rule_from_os_value(Some(std::ffi::OsStr::new("abc"))).is_err());
    }

    #[test]
    fn the_chain_length_counts_values_across_header_lines_and_never_reads_them() {
        assert_eq!(chain_length([]), 0);
        assert_eq!(chain_length(["198.51.100.1"]), 1);
        assert_eq!(chain_length(["a, b", "c"]), 3);
        assert_eq!(chain_length(["", "x,,y"]), 4);
    }

    #[test]
    fn each_chain_length_is_noted_once() {
        // Lengths nothing else in this test binary uses: the table is process-wide.
        assert_eq!(note_chain_length(7), Some(7));
        assert_eq!(note_chain_length(7), None);
        assert_eq!(note_chain_length(40), Some(CHAIN_SLOTS - 1));
        assert_eq!(
            note_chain_length(12),
            None,
            "longer chains share the last slot"
        );
    }

    #[test]
    fn a_request_is_counted_under_the_rule_in_force() {
        let written = ["203.0.113.66, 198.51.100.20"];
        let socket = Some("192.0.2.1");
        assert_eq!(
            request_client_address(written, socket),
            addr("203.0.113.66"),
            "no rule booted and no override: the default, the first hop"
        );
        with_forwarding_rule(ForwardingRule::TrustedHops(1), || {
            assert_eq!(forwarding_rule(), ForwardingRule::TrustedHops(1));
            assert_eq!(
                request_client_address(written, socket),
                addr("198.51.100.20")
            );
        });
        with_forwarding_rule(ForwardingRule::TrustedHops(0), || {
            assert_eq!(request_client_address(written, socket), addr("192.0.2.1"));
        });
        assert_eq!(
            forwarding_rule(),
            ForwardingRule::FirstHop,
            "the override is restored"
        );
    }
}
