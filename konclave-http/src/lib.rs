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

/// The client's address, for rate limiting.
///
/// Behind a platform proxy the socket's peer is the proxy, so the first hop of `X-Forwarded-For` is
/// the real client; a direct connection has no such header and falls back to the socket. A client
/// can forge the header only by reaching the server without passing the proxy, which the platform
/// prevents.
///
/// `forwarded` is EVERY value of that header, in order, because a request may carry more than one.
/// The first value whose first hop is an address wins. The relay has always walked every header;
/// requiring an address is new with #558, and stricter than what it did.
///
/// Takes strings, not a request, so this crate stays free of any HTTP library. Returns a
/// [`ClientAddress`], never text: what comes back is an address in its canonical spelling, or
/// unknown.
pub fn client_address<'a>(
    forwarded: impl IntoIterator<Item = &'a str>,
    remote: Option<&str>,
) -> ClientAddress {
    // Only something that PARSES as an address is used. The value becomes a key in a map, so a
    // header carrying thirty thousand bytes of anything would otherwise be stored as one, and a
    // value that is not an address names no client anyway.
    let parse = |s: &str| s.trim().parse::<std::net::IpAddr>().ok();
    forwarded
        .into_iter()
        .filter_map(|value| value.split(',').next())
        .find_map(parse)
        .or_else(|| remote.and_then(parse))
        .map_or_else(ClientAddress::unknown, ClientAddress::from_ip)
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
            client_address(["203.0.113.7, 10.0.0.1, 10.0.0.2"], Some("10.0.0.2")),
            addr("203.0.113.7")
        );
        assert_eq!(
            client_address(["  203.0.113.7  "], Some("10.0.0.2")),
            addr("203.0.113.7"),
            "surrounding space is not part of the address"
        );
    }

    #[test]
    fn without_a_forwarded_header_the_socket_is_the_client() {
        assert_eq!(
            client_address([], Some("198.51.100.9")),
            addr("198.51.100.9")
        );
        assert_eq!(
            client_address([""], Some("198.51.100.9")),
            addr("198.51.100.9"),
            "an empty header is an absent one"
        );
        assert_eq!(
            client_address([" , 10.0.0.1"], Some("198.51.100.9")),
            addr("198.51.100.9"),
            "an empty first hop is not an address"
        );
    }

    /// A request may carry the header more than once. The first value that names a client wins, and
    /// one that names nobody is skipped rather than ending the search.
    #[test]
    fn a_second_forwarded_header_is_read_when_the_first_names_nobody() {
        assert_eq!(
            client_address(["", "203.0.113.7, 10.0.0.1"], Some("10.0.0.2")),
            addr("203.0.113.7")
        );
        assert_eq!(
            client_address(["198.51.100.9", "203.0.113.7"], Some("10.0.0.2")),
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
            client_address([junk.as_str()], Some("198.51.100.9")),
            addr("198.51.100.9")
        );
        assert_eq!(
            client_address(["not-an-address", "203.0.113.7"], Some("10.0.0.2")),
            addr("203.0.113.7")
        );
        assert_eq!(
            client_address(["203.0.113.7:4780"], Some("198.51.100.9")),
            addr("198.51.100.9"),
            "an address with a port is not an address"
        );
        assert_eq!(client_address(["2001:db8::1"], None), addr("2001:db8::1"));
        assert_eq!(
            client_address(["junk"], Some("also junk")),
            ClientAddress::unknown()
        );
    }

    /// Every unknown client shares one key. That is deliberate: a request with no address at all
    /// must still be limited, and must not get a key of its own to be counted alone under.
    #[test]
    fn a_client_with_no_address_at_all_is_still_a_key() {
        assert_eq!(client_address([], None), ClientAddress::unknown());
        assert_eq!(client_address([], None).to_string(), "unknown");
    }

    #[test]
    fn one_client_is_one_key_however_its_address_is_spelled() {
        assert_eq!(
            client_address(["2001:DB8::1"], None).to_string(),
            "2001:db8::1"
        );
        assert_eq!(
            client_address([], Some("0:0:0:0:0:0:0:1")).to_string(),
            "::1",
            "the same address written out in full"
        );
        assert_eq!(
            client_address(["::ffff:203.0.113.7"], None).to_string(),
            "203.0.113.7"
        );
        assert_eq!(
            RateKey::address(&client_address(["2001:DB8::1"], None)),
            RateKey::address(&client_address([], Some("2001:db8::1"))),
            "the forwarded header and the socket spell it differently and name one client"
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
}
