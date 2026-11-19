//! Every call that reaches a light-client server goes through here: the arguments that name the
//! server, and how long the call may take before it is stopped.
//!
//! `zcash-devtool` in `--connection direct` mode has no timeout of its own, so a server that accepts
//! the connection and never answers holds the calling worker, and the vault's lock with it, for as
//! long as it hangs. A call made with [`run`] is stopped at its deadline instead, and the caller gets
//! an error it already handles. A source scan (`every_server_call_is_made_here`) keeps it the only
//! place that names a server.

use std::path::{Path, PathBuf};
use std::time::Duration;

use crate::tools::ToolError;

/// How long a broadcast may take. A broadcast that is stopped may still have reached the network:
/// the send's attempt record stays, as it does for any broadcast error (`send_record`), so nothing
/// signs again on the strength of a timeout.
pub const BROADCAST_WITHIN: Duration = Duration::from_secs(120);

/// How long a broadcast may take across every server it is tried on. A broadcast holds the vault's
/// lock and a worker for as long as it runs, so the budget is total, never per server.
pub const BROADCAST_TOTAL: Duration = Duration::from_secs(180);

/// How long a short call to a server may take: registering a viewing key (`init-fvk`), reading the
/// chain's tip (`get-info`).
pub const CALL_WITHIN: Duration = Duration::from_secs(120);

/// The kind of call, which decides its deadline.
#[derive(Debug, Clone, Copy)]
pub enum Call {
    Broadcast,
    Short,
    /// A wallet sync, with the deadline the wallet module gives it (its `SYNC_WITHIN`).
    Sync(Duration),
    /// A call with a deadline of its own: what is left of a budget (the broadcast across servers).
    Within(Duration),
}

#[cfg(test)]
thread_local! {
    static WITHIN_FOR_TEST: std::cell::Cell<Option<Duration>> = const { std::cell::Cell::new(None) };
}

/// Test only: this thread's deadline for every call made here. Thread-local, so a test that shortens
/// it cannot shorten another test's.
#[cfg(test)]
pub(crate) fn set_within_for_test(within: Option<Duration>) {
    WITHIN_FOR_TEST.with(|c| c.set(within));
}

fn within(call: Call) -> Duration {
    #[cfg(test)]
    if let Some(d) = WITHIN_FOR_TEST.with(|c| c.get()) {
        return d;
    }
    match call {
        Call::Broadcast => BROADCAST_WITHIN,
        Call::Short => CALL_WITHIN,
        Call::Sync(d) | Call::Within(d) => d,
    }
}

/// Run `devtool` with `args` followed by the arguments that name `server`, stopped at the deadline
/// of `call`.
pub fn run(
    devtool: &Path,
    args: &[&str],
    server: &str,
    stdin: Option<&[u8]>,
    call: Call,
) -> Result<Vec<u8>, ToolError> {
    let mut all: Vec<&str> = args.to_vec();
    all.extend_from_slice(&["-s", server, "--connection", "direct"]);
    crate::tools::run_within(devtool, &all, stdin, within(call))
}

/// The same, with stdout decoded as UTF-8.
pub fn run_text(
    devtool: &Path,
    args: &[&str],
    server: &str,
    stdin: Option<&[u8]>,
    call: Call,
) -> Result<String, ToolError> {
    let out = run(devtool, args, server, stdin, call)?;
    String::from_utf8(out).map_err(|e| ToolError::parse("utf-8 output", e.to_string()))
}

// ---------------------------------------------------------------------------------------------
// The list of servers, the background probe, and the choice between them.
//
// Rules that are easy to lose, so they are written here and nowhere else:
//  - The probe's height NEVER enters a money decision (a fee, a hold, the settling or expiry of a
//    send). Those read the wallet's own tip. The one exception is the wallet birthday at creation,
//    which is taken from several answers (the lowest, bounded by their median) and only when enough
//    of them agree ([`birthday`]).
//  - The reference for "behind" is the MEDIAN of the answers, never the highest: the highest is a
//    value any one server of the list can choose.
//  - The choice is sticky: a server that answers and stays within the band is kept, and nothing is
//    switched on fewer than [`MIN_AGREE`] agreeing answers unless the current server has failed.
//  - A probe is never made inside a request: a background thread fills the cache, and everything
//    else reads it.
// ---------------------------------------------------------------------------------------------

use std::sync::{Arc, Mutex};

/// How many blocks a server may differ from the median before it is out of band (about 8 minutes at
/// 25 seconds a block).
pub const MAX_LAG: u64 = 20;

/// How many blocks from the median a server may be and still be a place to broadcast to: a node a few
/// blocks behind may not know the anchor the transaction was built on (about 75 seconds at 25 seconds
/// a block). Reads keep [`MAX_LAG`].
pub const MAX_BROADCAST_LAG: u64 = 3;

/// The largest height an answer may carry. Heights are `u32` on the chain and in the engine; a larger
/// number is not a height, and is a failed probe rather than something to take a median of.
pub const MAX_HEIGHT: u64 = u32::MAX as u64;

/// How many answers that agree (all within [`MAX_LAG`] of the median) a decision that leaves a
/// server that still answers, or sets a wallet birthday, needs.
pub const MIN_AGREE: usize = 3;

/// How often the background probe asks every server.
pub const PROBE_EVERY: Duration = Duration::from_secs(60);

/// How long one probe may take.
pub const PROBE_WITHIN: Duration = Duration::from_secs(10);

/// The most a probe may read from a server, by `curl --max-filesize` and by the reader that stops at
/// it. A real `GetLightdInfo` is a few hundred bytes.
pub const PROBE_MAX_BYTES: usize = 65536;

/// How far below the median height a new wallet's birthday is set.
pub const BIRTHDAY_BACK: u64 = 100;

/// What a server said about itself (`GetLightdInfo`).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Info {
    pub version: String,
    pub chain: String,
    pub branch: String,
    pub height: u64,
    pub subversion: String,
}

/// What the last probe learned about one server.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Observed {
    /// Not probed yet.
    Unknown,
    /// Probed, and it did not answer a well-formed reply.
    Failed,
    Answered(Info),
}

/// Split a `KONCLAVE_LIGHTWALLETD` value: comma-separated, trimmed, empties dropped, duplicates
/// dropped, order kept. A value with nothing in it is one empty server, which fails when used, as an empty
/// setting did before the list existed.
pub fn parse_list(raw: &str) -> Vec<String> {
    let mut out: Vec<String> = Vec::new();
    for part in raw.split(',') {
        let p = part.trim();
        if !p.is_empty() && !out.iter().any(|o| o == p) {
            out.push(p.to_string());
        }
    }
    if out.is_empty() {
        out.push(String::new());
    }
    out
}

/// Whether `entry` is `host:port` and nothing else: a DNS name or IPv4 address, a numeric port, no
/// scheme, no path, no spaces. What the probe puts into a URL and the engine into its `-s` must
/// mean the same server, so anything either could read differently is refused when the list is read.
pub fn validate_entry(entry: &str) -> Result<(), String> {
    let bad = |why: &str| {
        Err(format!(
            "light-client server {entry:?} is not host:port ({why})"
        ))
    };
    let Some((host, port)) = entry.rsplit_once(':') else {
        return bad("no port");
    };
    if host.is_empty() || host.len() > 253 {
        return bad("no host");
    }
    if !host
        .bytes()
        .all(|b| b.is_ascii_alphanumeric() || b == b'.' || b == b'-')
        || host.starts_with(['.', '-'])
        || host.ends_with(['.', '-'])
        || host.contains("..")
    {
        return bad("the host may hold only letters, digits, dots and hyphens");
    }
    match port.parse::<u16>() {
        Ok(p) if p > 0 && port.bytes().all(|b| b.is_ascii_digit()) => Ok(()),
        _ => bad("the port is not a number from 1 to 65535"),
    }
}

/// The rule of a LIST (two or more servers), on top of [`validate_entry`]: every entry is a public DNS
/// name the background probe can read over https. An onion name, `localhost` and an IP literal are
/// refused: the probe reaches servers over https only (an IP has no certificate to match, and an onion
/// name or `localhost` the engine reads over plain HTTP), so such an entry would always read as failed
/// and silently never be a fallback. One configured server is not probed and keeps today's rule. (A
/// later transport over Tor would revisit this.)
fn list_entry_reachable(entry: &str) -> Result<(), String> {
    let host = entry
        .rsplit_once(':')
        .map_or(entry, |(h, _)| h)
        .to_ascii_lowercase();
    let why = if host.ends_with(".onion") {
        Some("an onion name")
    } else if host == "localhost" || host.ends_with(".localhost") {
        Some("localhost")
    } else if host.bytes().all(|b| b.is_ascii_digit() || b == b'.') {
        Some("an IP address")
    } else {
        None
    };
    match why {
        Some(w) => Err(format!(
            "light-client server {entry:?} is {w}, which a server list cannot use: the list is checked over https by name (use it as the only server instead)"
        )),
        None => Ok(()),
    }
}

struct Assessment {
    /// Answered, on the configured chain, on the branch most answers report.
    eligible: Vec<usize>,
    median: Option<u64>,
    /// Eligible and within [`MAX_LAG`] of the median.
    in_band: Vec<usize>,
    /// The height each eligible server reported.
    heights: Vec<(usize, u64)>,
}

impl Assessment {
    /// THE rule for "a server a decision may move to", read by the choice, the broadcast order and the
    /// health route alike: in band when enough answered to have a band (and any are in it), else
    /// every eligible server. A rule with three copies is what let the health route call a server not
    /// ok while the broadcast still used it.
    fn usable(&self) -> &[usize] {
        if self.eligible.len() >= MIN_AGREE && !self.in_band.is_empty() {
            &self.in_band
        } else {
            &self.eligible
        }
    }

    /// Whether server `i` is eligible and within `lag` blocks of the median.
    fn within(&self, i: usize, lag: u64) -> bool {
        match (self.median, self.heights.iter().find(|(j, _)| *j == i)) {
            (Some(m), Some((_, h))) => h.abs_diff(m) <= lag,
            _ => false,
        }
    }
}

fn assess(obs: &[Observed], network: &str) -> Assessment {
    let on_chain: Vec<(usize, &Info)> = obs
        .iter()
        .enumerate()
        .filter_map(|(i, o)| match o {
            Observed::Answered(info) if info.chain == network => Some((i, info)),
            _ => None,
        })
        .collect();
    // The branch most answers report; a tie goes to the one the earliest server in the list reports.
    let mut modal: Option<(&str, usize)> = None;
    for (_, info) in &on_chain {
        let n = on_chain
            .iter()
            .filter(|(_, o)| o.branch.eq_ignore_ascii_case(&info.branch))
            .count();
        if modal.is_none_or(|(_, best)| n > best) {
            modal = Some((info.branch.as_str(), n));
        }
    }
    let eligible: Vec<usize> = match modal {
        Some((b, _)) => on_chain
            .iter()
            .filter(|(_, i)| i.branch.eq_ignore_ascii_case(b))
            .map(|(idx, _)| *idx)
            .collect(),
        None => Vec::new(),
    };
    let height = |i: usize| match &obs[i] {
        Observed::Answered(info) => info.height,
        _ => 0,
    };
    let pairs: Vec<(usize, u64)> = eligible.iter().map(|i| (*i, height(*i))).collect();
    let mut heights: Vec<u64> = pairs.iter().map(|(_, h)| *h).collect();
    heights.sort_unstable();
    // The middle of two is `lo + (hi - lo) / 2`: sorted, so it cannot overflow, whatever a server says.
    let median = match heights.len() {
        0 => None,
        n if n % 2 == 1 => Some(heights[n / 2]),
        n => Some(heights[n / 2 - 1] + (heights[n / 2] - heights[n / 2 - 1]) / 2),
    };
    let in_band = match median {
        Some(m) => eligible
            .iter()
            .copied()
            .filter(|i| height(*i).abs_diff(m) <= MAX_LAG)
            .collect(),
        None => Vec::new(),
    };
    Assessment {
        eligible,
        median,
        in_band,
        heights: pairs,
    }
}

/// The outcome of [`choose`]: which server to use, and what to log when something was decided.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Choice {
    pub index: usize,
    /// A switch or a skip, in words and without secrets; `None` when nothing was decided.
    pub note: Option<String>,
}

fn describe(list: &[String], obs: &[Observed], idx: &[usize]) -> String {
    idx.iter()
        .map(|i| match &obs[*i] {
            Observed::Answered(info) => format!("{}={}", list[*i], info.height),
            Observed::Failed => format!("{}=failed", list[*i]),
            Observed::Unknown => format!("{}=unknown", list[*i]),
        })
        .collect::<Vec<_>>()
        .join(" ")
}

/// Which server to use, given the current one and the last probe of each. PURE: the same inputs give
/// the same answer on every device and in every test.
///
/// - The current server is kept while it is eligible and in band, and while it has not been probed.
/// - One that is eligible but out of band is left only for the first in-band server of the list, and
///   only when at least [`MIN_AGREE`] servers are in band; otherwise it is kept and the skip is noted.
/// - One that failed (no answer, another chain, another branch) is left for the first eligible server
///   of the list (in band, when at least [`MIN_AGREE`] answered); with none, it is kept.
pub fn choose(list: &[String], current: usize, obs: &[Observed], network: &str) -> Choice {
    choose_from(list, current, obs, network, 0)
}

/// From `pool` (in list order), the server a switch goes to: the first not behind `scanned` (the
/// highest height the wallets may have scanned to), else the highest of them, so a switch never lands
/// on a server the wallets are ahead of while one that is not was there. `None` for an empty pool.
fn pick(pool: &[usize], a: &Assessment, scanned: u64) -> Option<usize> {
    let h = |i: usize| {
        a.heights
            .iter()
            .find(|(j, _)| *j == i)
            .map_or(0, |(_, h)| *h)
    };
    pool.iter()
        .copied()
        .find(|&i| h(i) >= scanned)
        .or_else(|| pool.iter().copied().rev().max_by_key(|&i| h(i)))
}

/// [`choose`], knowing how far the wallets may have scanned (`scanned`, see [`pick`]).
pub fn choose_from(
    list: &[String],
    current: usize,
    obs: &[Observed],
    network: &str,
    scanned: u64,
) -> Choice {
    let keep = |note: Option<String>| Choice {
        index: current,
        note,
    };
    if current >= list.len() || obs.len() != list.len() {
        return keep(None);
    }
    let a = assess(obs, network);
    if obs[current] == Observed::Unknown {
        return keep(None);
    }
    let all: Vec<usize> = (0..list.len()).collect();
    if a.in_band.contains(&current) {
        return keep(None);
    }
    if a.eligible.contains(&current) {
        // Eligible but out of band.
        if a.in_band.len() >= MIN_AGREE {
            let to = pick(&a.in_band, &a, scanned).unwrap_or(a.in_band[0]);
            return Choice {
                index: to,
                note: Some(format!(
                    "switched {} -> {}: out of band (median {}); heights {}",
                    list[current],
                    list[to],
                    a.median.unwrap_or(0),
                    describe(list, obs, &all),
                )),
            };
        }
        return keep(Some(format!(
            "kept {}: out of band but only {} agree; heights {}",
            list[current],
            a.in_band.len(),
            describe(list, obs, &all),
        )));
    }
    // The current server failed.
    match pick(a.usable(), &a, scanned) {
        Some(to) => Choice {
            index: to,
            note: Some(format!(
                "switched {} -> {}: {} did not answer as the {} chain; heights {}",
                list[current],
                list[to],
                list[current],
                network,
                describe(list, obs, &all),
            )),
        },
        None => keep(Some(format!(
            "kept {}: it failed and no server is eligible; heights {}",
            list[current],
            describe(list, obs, &all),
        ))),
    }
}

/// The birthday a new wallet is given, only when at least [`MIN_AGREE`] eligible answers agree (`None`
/// means today's behaviour: the engine asks one server): the LOWEST eligible height, but never more
/// than [`BIRTHDAY_FLOOR`] below the median, minus [`BIRTHDAY_BACK`]. A birthday too late would hide
/// notes, one too early only costs scanning; so a minority reporting too high cannot move it past the
/// lowest honest answer, and one reporting too low costs at most the floor. A MAJORITY reporting too
/// high (several hosts of one operator count as several) still moves the median, and the birthday with
/// it, so list servers run by different operators.
pub fn birthday(obs: &[Observed], network: &str) -> Option<u64> {
    let a = assess(obs, network);
    if a.in_band.len() < MIN_AGREE {
        return None;
    }
    let m = a.median?;
    let low = a.heights.iter().map(|(_, h)| *h).min()?;
    Some(
        low.max(m.saturating_sub(BIRTHDAY_FLOOR))
            .saturating_sub(BIRTHDAY_BACK),
    )
}

/// How far below the median the lowest answer may pull a birthday (about 7 hours at 25 s blocks).
pub const BIRTHDAY_FLOOR: u64 = 1000;

/// One server as the health route reports it. No vault data: hosts are public.
#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize)]
pub struct ServerStatus {
    pub host: String,
    /// `None` until a probe has run (and always, with one server and no probe thread).
    pub ok: Option<bool>,
    pub chain: Option<String>,
    pub height_lag: Option<i64>,
}

struct State {
    current: usize,
    obs: Vec<Observed>,
    last_note: Option<String>,
    /// The highest height the server in use reported while it was usable: how far the wallets may
    /// have scanned. Only the server in use, and only within the rule ([`Assessment::usable`]), so a
    /// server far ahead of the others never raises it.
    scanned: u64,
}

/// The configured servers, the last probe of each and the one in use. Cheap to clone: clones share
/// state, so the background probe and every request see one answer.
#[derive(Clone)]
pub struct Servers {
    list: Arc<Vec<String>>,
    network: Arc<str>,
    state: Arc<Mutex<State>>,
}

impl std::fmt::Debug for Servers {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("Servers")
            .field("list", &self.list)
            .field("network", &self.network)
            .finish()
    }
}

impl Servers {
    /// From a `KONCLAVE_LIGHTWALLETD` value and the network ("main" or "test") the chain must be,
    /// refusing any entry that is not `host:port` ([`validate_entry`]) and a value with no entry. What
    /// the coordinator reads its configuration with.
    pub fn try_parse(raw: &str, network: &str) -> Result<Servers, String> {
        let list = parse_list(raw);
        if list.len() == 1 && list[0].is_empty() {
            return Err("KONCLAVE_LIGHTWALLETD names no server".to_string());
        }
        for entry in &list {
            validate_entry(entry)?;
            if list.len() > 1 {
                list_entry_reachable(entry)?;
            }
        }
        Ok(Servers::parse(raw, network))
    }

    /// One server, taken as it is: not split at commas, not checked. For the local bridge and the
    /// command line, which name one server in their own configuration (and may use the engine's own
    /// shorthand for it).
    pub fn single(server: &str, network: &str) -> Servers {
        Servers::from_list(vec![server.to_string()], network)
    }

    fn from_list(list: Vec<String>, network: &str) -> Servers {
        let n = list.len();
        Servers {
            list: Arc::new(list),
            network: Arc::from(network),
            state: Arc::new(Mutex::new(State {
                current: 0,
                scanned: 0,
                obs: vec![Observed::Unknown; n],
                last_note: None,
            })),
        }
    }

    /// Like [`Servers::try_parse`] without the check: for values already known to be well formed
    /// (tests, and a list that was validated where it was read).
    pub fn parse(raw: &str, network: &str) -> Servers {
        Servers::from_list(parse_list(raw), network)
    }

    fn lock(&self) -> std::sync::MutexGuard<'_, State> {
        self.state.lock().unwrap_or_else(|p| p.into_inner())
    }

    /// The servers, in the order they were configured.
    pub fn list(&self) -> &[String] {
        &self.list
    }

    /// More than one server: only then is there anything to probe or choose.
    pub fn is_list(&self) -> bool {
        self.list.len() > 1
    }

    /// The server to use. An operation takes it once and uses it for the whole operation.
    pub fn current(&self) -> String {
        self.list[self.lock().current].clone()
    }

    /// Store a probe round (one entry per server, in list order) and re-choose. Logs a switch or a
    /// skip when it differs from the last one logged.
    pub fn record(&self, obs: Vec<Observed>) {
        if obs.len() != self.list.len() {
            return;
        }
        let mut st = self.lock();
        let a = assess(&obs, &self.network);
        if a.usable().contains(&st.current) {
            if let Observed::Answered(info) = &obs[st.current] {
                st.scanned = st.scanned.max(info.height);
            }
        }
        let c = choose_from(&self.list, st.current, &obs, &self.network, st.scanned);
        if c.index != st.current {
            st.current = c.index;
        }
        if c.note != st.last_note {
            if let Some(n) = &c.note {
                eprintln!("konclave-helper: light server {n}");
            }
            st.last_note = c.note;
        }
        st.obs = obs;
    }

    /// The servers a broadcast may be tried on, in order: `start` (the one the operation has been
    /// using) first, then the others in list order, leaving out any the last probe found failed, on
    /// another chain or branch, not usable by the one rule ([`Assessment::usable`]) or more than
    /// [`MAX_BROADCAST_LAG`] blocks from the median. A server not probed yet is kept: a probe that has
    /// not run is not a verdict.
    pub fn broadcast_order(&self, start: &str) -> Vec<String> {
        let st = self.lock();
        let a = assess(&st.obs, &self.network);
        let mut out = vec![start.to_string()];
        for (i, host) in self.list.iter().enumerate() {
            if host == start {
                continue;
            }
            let keep = match &st.obs[i] {
                Observed::Unknown => true,
                Observed::Failed => false,
                // `usable()` is implied by the 3-block band today; it stays so the order can never be
                // wider than the one rule if either band changes.
                Observed::Answered(_) => a.usable().contains(&i) && a.within(i, MAX_BROADCAST_LAG),
            };
            if keep {
                out.push(host.clone());
            }
        }
        out
    }

    /// What the last probe says of each server, in list order, for the health route. Reads the cache
    /// only: it never probes, and the route it feeds is open to anyone.
    pub fn status(&self) -> Vec<ServerStatus> {
        let st = self.lock();
        let a = assess(&st.obs, &self.network);
        self.list
            .iter()
            .enumerate()
            .map(|(i, host)| match &st.obs[i] {
                Observed::Unknown => ServerStatus {
                    host: host.clone(),
                    ok: None,
                    chain: None,
                    height_lag: None,
                },
                Observed::Failed => ServerStatus {
                    host: host.clone(),
                    ok: Some(false),
                    chain: None,
                    height_lag: None,
                },
                Observed::Answered(info) => ServerStatus {
                    host: host.clone(),
                    ok: Some(a.usable().contains(&i)),
                    // Only the two names a chain can have: whatever else a server sends is "other",
                    // so the open route never repeats a string a server chose.
                    chain: Some(match info.chain.as_str() {
                        "main" | "test" => info.chain.clone(),
                        _ => "other".to_string(),
                    }),
                    // Blocks behind the median of the answers; negative is ahead of it.
                    height_lag: a.median.map(|m| {
                        i64::try_from(i128::from(m) - i128::from(info.height))
                            .unwrap_or(if m > info.height { i64::MAX } else { i64::MIN })
                    }),
                },
            })
            .collect()
    }

    /// The wallet birthday a new wallet should be given, or `None` for the engine's default.
    pub fn birthday(&self) -> Option<u64> {
        birthday(&self.lock().obs, &self.network)
    }
}

/// What a failed attempt allows. `Some(true)`: our own deadline stopped it, so the server may have
/// received the transaction, and it is tried on the next server. `Some(false)`: the engine could not be
/// started, or exited before it got to sending, so nothing was sent anywhere. `None`: anything else,
/// and above all a non-zero exit AFTER the engine said it was sending: the server answered or the link
/// failed mid-send, and a different server will not change what the network has already heard. Those surface as the tool's own error. (What a server refuses is not
/// read from the engine's wording: it varies by server software, and a rule that depends on it would
/// retry what the network has already answered.)
fn retry(e: &ToolError) -> Option<bool> {
    match e {
        ToolError::Io(io) if io.kind() == std::io::ErrorKind::TimedOut => Some(true),
        ToolError::Spawn { .. } => Some(false),
        // The engine stopped before it got to sending: it connects to the server first and prints
        // [`SENDING`] only once connected and holding the transaction, so a non-zero exit without that
        // line (connection refused, DNS, TLS) sent nothing anywhere, and the next server may work.
        ToolError::NonZero { stdout, .. } if !stdout.contains(SENDING) => Some(false),
        _ => None,
    }
}

/// The line `zcash-devtool pczt send` prints right before it sends, after it has connected to the
/// server and extracted the transaction (read at zcash/zcash-devtool
/// 0b3436bb8d235c67cd36b800cb45a7b1b489c415, src/commands/pczt/send.rs: `println!("Sending
/// transaction...")`, after `connection.connect` and the extraction). Re-read it on every devtool
/// bump: if the wording changes, a failed send on a reachable server is retried on the next one (the
/// same bytes, so never a second transaction), and a fast connection failure still fails over.
pub(crate) const SENDING: &str = "Sending transaction...";

/// Broadcast `signed` (the same bytes every time) starting on `start`, and, only when an attempt was
/// stopped at OUR deadline, or the engine could not start or exited before it said [`SENDING`], on the
/// next server of
/// [`Servers::broadcast_order`]; any other failure stops it and is the tool's error. THE one place a transaction is sent: both send paths call it, and `send_with` still sees one
/// call and one result. Rebroadcasting the identical transaction is not signing again: same bytes,
/// same txid.
///
/// The whole thing stops at [`BROADCAST_TOTAL`]. When no server accepted it and any attempt was stopped
/// at the deadline, the error says the transaction may have reached the network: an attempt that timed out may
/// have been received, and the attempt record the caller keeps is what a later settle reads.
pub fn broadcast(
    devtool: &Path,
    wallet_dir: &str,
    servers: &Servers,
    start: &str,
    signed: &[u8],
) -> Result<String, ToolError> {
    broadcast_within(BROADCAST_TOTAL, devtool, wallet_dir, servers, start, signed)
}

fn broadcast_within(
    budget: Duration,
    devtool: &Path,
    wallet_dir: &str,
    servers: &Servers,
    start: &str,
    signed: &[u8],
) -> Result<String, ToolError> {
    let started = std::time::Instant::now();
    let order = servers.broadcast_order(start);
    let mut unfinished = false;
    let mut last: Option<ToolError> = None;
    for (n, server) in order.iter().enumerate() {
        let left = budget.saturating_sub(started.elapsed());
        if n > 0 && left.is_zero() {
            eprintln!("konclave-helper: broadcast budget used up before {server}");
            break;
        }
        let attempt = crate::pczt::send_on(
            devtool,
            wallet_dir,
            server,
            signed,
            Call::Within(left.min(BROADCAST_WITHIN)),
        );
        match attempt {
            Ok(txid) => return Ok(txid),
            Err(e) => {
                let Some(delivered_maybe) = retry(&e) else {
                    // The engine ran and failed: the same on every server. Whatever an earlier
                    // attempt left in doubt stays in doubt, and is said below.
                    last = Some(e);
                    break;
                };
                unfinished |= delivered_maybe;
                match order.get(n + 1) {
                    Some(next) => eprintln!(
                        "konclave-helper: broadcast to {server} did not finish; trying {next} with the same transaction"
                    ),
                    None => eprintln!("konclave-helper: broadcast to {server} did not finish"),
                }
                last = Some(e);
            }
        }
    }
    let e = last.unwrap_or_else(|| ToolError::parse("broadcast", "no server to send to"));
    if unfinished {
        return Err(ToolError::parse(
            "broadcast",
            format!(
                "the transaction may have reached the network (a server did not answer in time); \
                 do not send it again before checking: {e}"
            ),
        ));
    }
    Err(e)
}

/// The empty gRPC request message: flag 0, length 0.
const EMPTY_FRAME: [u8; 5] = [0, 0, 0, 0, 0];

const LIGHTD_INFO_PATH: &str = "/cash.z.wallet.sdk.rpc.CompactTxStreamer/GetLightdInfo";

fn varint(buf: &[u8], pos: &mut usize) -> Option<u64> {
    let mut v: u64 = 0;
    for shift in (0..70).step_by(7) {
        let b = *buf.get(*pos)?;
        *pos += 1;
        if shift == 63 && b > 1 {
            return None;
        }
        v |= u64::from(b & 0x7f) << shift;
        if b & 0x80 == 0 {
            return Some(v);
        }
    }
    None
}

/// Decode a `GetLightdInfo` reply: a 5-byte gRPC frame header, then the protobuf message. Fields read
/// are 1 (version), 4 (chain name), 6 (consensus branch id), 7 (block height) and 14 (node
/// subversion); any other is skipped. A truncated frame, a message shorter than its header says, a
/// field that overruns it, or one without a chain name and a height is refused.
pub fn decode_info(frame: &[u8]) -> Option<Info> {
    if frame.len() < 5 || frame[0] != 0 {
        return None;
    }
    let len = u32::from_be_bytes([frame[1], frame[2], frame[3], frame[4]]) as usize;
    let msg = frame.get(5..)?;
    if msg.len() < len {
        return None;
    }
    let msg = &msg[..len];
    let (mut version, mut chain, mut branch, mut sub) =
        (String::new(), String::new(), String::new(), String::new());
    let mut height: Option<u64> = None;
    let mut pos = 0;
    while pos < msg.len() {
        let key = varint(msg, &mut pos)?;
        let (field, wire) = (key >> 3, key & 7);
        match wire {
            0 => {
                let v = varint(msg, &mut pos)?;
                if field == 7 {
                    height = Some(v);
                }
            }
            1 => pos = pos.checked_add(8).filter(|p| *p <= msg.len())?,
            5 => pos = pos.checked_add(4).filter(|p| *p <= msg.len())?,
            2 => {
                let n = usize::try_from(varint(msg, &mut pos)?).ok()?;
                let end = pos.checked_add(n).filter(|e| *e <= msg.len())?;
                let bytes = &msg[pos..end];
                pos = end;
                let slot = match field {
                    1 => Some(&mut version),
                    4 => Some(&mut chain),
                    6 => Some(&mut branch),
                    14 => Some(&mut sub),
                    _ => None,
                };
                if let Some(slot) = slot {
                    *slot = String::from_utf8(bytes.to_vec()).ok()?;
                }
            }
            _ => return None,
        }
    }
    if chain.is_empty() {
        return None;
    }
    let height = height.filter(|h| *h <= MAX_HEIGHT)?;
    Some(Info {
        version,
        chain,
        branch,
        height,
        subversion: sub,
    })
}

fn probe_within() -> Duration {
    #[cfg(test)]
    if let Some(d) = WITHIN_FOR_TEST.with(|c| c.get()) {
        return d;
    }
    PROBE_WITHIN
}

/// Ask one server who it is, with `curl` over HTTP/2 (the image has it; the engine's own `get-info`
/// is a 100 MB process that needs a wallet directory). Stopped at [`PROBE_WITHIN`].
pub fn probe_one(curl: &Path, server: &str) -> Observed {
    let url = format!("https://{server}{LIGHTD_INFO_PATH}");
    let secs = PROBE_WITHIN.as_secs().to_string();
    let max = PROBE_MAX_BYTES.to_string();
    let args = [
        // First, so that no `.curlrc` of the user the coordinator runs as can add an option.
        "--disable",
        "--http2",
        "--silent",
        "--show-error",
        "--max-time",
        secs.as_str(),
        "--max-filesize",
        max.as_str(),
        // TLS only, no redirect (none is asked for), and no proxy from the environment: the engine's
        // own client uses none, so the probe would otherwise look down a different road.
        "--proto",
        "=https",
        "--noproxy",
        "*",
        "-H",
        "content-type: application/grpc",
        "-H",
        "te: trailers",
        "--data-binary",
        "@-",
        "--url",
        url.as_str(),
    ];
    match crate::tools::run_within_capped(
        curl,
        &args,
        Some(&EMPTY_FRAME),
        probe_within(),
        PROBE_MAX_BYTES,
    ) {
        Ok(out) => match decode_info(&out) {
            Some(info) => Observed::Answered(info),
            None => Observed::Failed,
        },
        Err(_) => Observed::Failed,
    }
}

/// One round: every server probed in its own thread, then recorded together.
pub fn probe_round(curl: &Path, servers: &Servers) {
    let obs: Vec<Observed> = std::thread::scope(|s| {
        let handles: Vec<_> = servers
            .list()
            .iter()
            .map(|h| s.spawn(move || probe_one(curl, h)))
            .collect();
        handles
            .into_iter()
            .map(|h| h.join().unwrap_or(Observed::Failed))
            .collect()
    });
    servers.record(obs);
}

/// Start the background probe: one round now and one every [`PROBE_EVERY`]. With a single server there
/// is nothing to choose between, so no thread is started and `false` is returned.
pub fn spawn_probe(servers: &Servers, curl: PathBuf) -> bool {
    if !servers.is_list() {
        return false;
    }
    let servers = servers.clone();
    std::thread::spawn(move || loop {
        probe_round(&curl, &servers);
        std::thread::sleep(PROBE_EVERY);
    });
    true
}

#[cfg(test)]
mod tests {
    use super::*;

    /// No call names a server anywhere else: a call that does is a call with no deadline. Reads the
    /// production code (top-level test modules skipped, as `the_wallet_is_synced_and_stamped_in_one_place`
    /// reads it) of every crate that could call the engine, recursively; each root must hold sources,
    /// so a vanished root does not pass by being empty. The needle is a quote followed by the flag, so
    /// `"--connection=direct"` is caught as well, and it is assembled from parts so this file's own
    /// test does not match it.
    #[test]
    fn every_server_call_is_made_here() {
        fn walk(dir: &std::path::Path, out: &mut Vec<std::path::PathBuf>) {
            for e in std::fs::read_dir(dir).unwrap().flatten() {
                let p = e.path();
                if p.is_dir() {
                    walk(&p, out);
                } else if p.extension().is_some_and(|x| x == "rs") {
                    out.push(p);
                }
            }
        }
        fn production(src: &str) -> String {
            let mut code = Vec::new();
            let mut lines = src.lines().peekable();
            while let Some(line) = lines.next() {
                if line == "#[cfg(test)]" && lines.peek().is_some_and(|n| n.starts_with("mod ")) {
                    for skipped in lines.by_ref() {
                        if skipped == "}" {
                            break;
                        }
                    }
                    continue;
                }
                code.push(line);
            }
            code.join("\n")
        }
        let needle = ["\"", "--conn", "ection"].concat();
        let root = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("..");
        let mut files = Vec::new();
        for crate_src in ["orchestrator/src", "helper-server/src", "src-tauri/src"] {
            let before = files.len();
            walk(&root.join(crate_src), &mut files);
            assert!(
                files.len() > before,
                "the scan found sources under {crate_src}"
            );
        }
        let offenders: Vec<String> = files
            .iter()
            .filter(|f| !f.ends_with("orchestrator/src/lightclient.rs"))
            .filter(|f| production(&std::fs::read_to_string(f).unwrap()).contains(&needle))
            .map(|f| f.display().to_string())
            .collect();
        assert!(
            offenders.is_empty(),
            "server named outside lightclient: {offenders:?}"
        );
    }

    /// A server that never answers is stopped at the deadline, for every kind of call.
    #[cfg(unix)]
    #[test]
    fn a_server_that_never_answers_is_stopped_at_the_deadline() {
        let dir = std::env::temp_dir().join(format!("konclave-lightclient-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let hang = dir.join("devtool");
        crate::test_exec::write_script(&hang, "#!/bin/sh\nexec sleep 30\n");
        set_within_for_test(Some(Duration::from_millis(300)));
        for call in [
            Call::Broadcast,
            Call::Short,
            Call::Sync(Duration::from_secs(600)),
        ] {
            let started = std::time::Instant::now();
            let r = run(&hang, &["pczt", "send"], "zec.rocks:443", Some(b"x"), call);
            assert!(r.is_err(), "{call:?} returned without the server answering");
            assert!(
                started.elapsed() < Duration::from_secs(5),
                "{call:?} was not stopped"
            );
        }
        set_within_for_test(None);
        std::fs::remove_dir_all(&dir).ok();
    }

    // ---- the list, the decoder, the chooser --------------------------------------------------

    fn s(v: &[&str]) -> Vec<String> {
        v.iter().map(|x| x.to_string()).collect()
    }

    fn info(chain: &str, branch: &str, height: u64) -> Observed {
        Observed::Answered(Info {
            version: "v0.6.1".into(),
            chain: chain.into(),
            branch: branch.into(),
            height,
            subversion: "/Zebra:7.1.0/".into(),
        })
    }

    const NU7: &str = "77190ad9";

    fn main_at(h: u64) -> Observed {
        info("main", NU7, h)
    }

    #[test]
    fn the_list_is_trimmed_deduped_and_keeps_its_order() {
        assert_eq!(
            parse_list(" a:443 , b:443,,a:443,c:9067 ,"),
            s(&["a:443", "b:443", "c:9067"])
        );
        // One value is one server, exactly as before the list existed.
        assert_eq!(parse_list("zec.rocks:443"), s(&["zec.rocks:443"]));
        assert_eq!(parse_list(""), s(&[""]));
        assert_eq!(parse_list(" , "), s(&[""]));
    }

    fn field_str(out: &mut Vec<u8>, field: u8, v: &str) {
        out.push(field << 3 | 2);
        out.push(v.len() as u8);
        out.extend_from_slice(v.as_bytes());
    }
    fn field_varint(out: &mut Vec<u8>, field: u8, mut v: u64) {
        out.push(field << 3);
        loop {
            let b = (v & 0x7f) as u8;
            v >>= 7;
            if v == 0 {
                out.push(b);
                break;
            }
            out.push(b | 0x80);
        }
    }
    fn frame(msg: &[u8]) -> Vec<u8> {
        let mut f = vec![0];
        f.extend_from_slice(&(msg.len() as u32).to_be_bytes());
        f.extend_from_slice(msg);
        f
    }
    /// A `GetLightdInfo` message built by hand from the field list, with fields the decoder does not
    /// read (3 bool, 5 varint, 12 varint, 9 string) in between.
    fn lightd_info_message() -> Vec<u8> {
        let mut m = Vec::new();
        field_str(&mut m, 1, "v0.6.1");
        field_varint(&mut m, 3, 1);
        field_str(&mut m, 4, "main");
        field_varint(&mut m, 5, 419_200);
        field_str(&mut m, 6, "77190ad9");
        field_varint(&mut m, 7, 3_586_790);
        field_str(&mut m, 9, "master");
        field_varint(&mut m, 12, 3_586_791);
        field_str(&mut m, 14, "/Zebra:7.1.0/");
        m
    }

    #[test]
    fn a_lightd_info_frame_is_decoded() {
        let got = decode_info(&frame(&lightd_info_message())).unwrap();
        assert_eq!(
            got,
            Info {
                version: "v0.6.1".into(),
                chain: "main".into(),
                branch: "77190ad9".into(),
                height: 3_586_790,
                subversion: "/Zebra:7.1.0/".into(),
            }
        );
    }

    #[test]
    fn a_malformed_lightd_info_frame_is_refused() {
        let good = frame(&lightd_info_message());
        assert!(decode_info(&[]).is_none());
        assert!(decode_info(&good[..4]).is_none());
        // Cut short: the header promises more than there is.
        assert!(decode_info(&good[..good.len() - 1]).is_none());
        // A compressed frame is not read.
        let mut compressed = good.clone();
        compressed[0] = 1;
        assert!(decode_info(&compressed).is_none());
        // A field that overruns the message.
        let mut over = Vec::new();
        field_str(&mut over, 4, "main");
        over.extend_from_slice(&[7 << 3 | 2, 50, b'x']);
        assert!(decode_info(&frame(&over)).is_none());
        // No height, no chain.
        let mut nh = Vec::new();
        field_str(&mut nh, 4, "main");
        assert!(decode_info(&frame(&nh)).is_none());
        let mut nc = Vec::new();
        field_varint(&mut nc, 7, 5);
        assert!(decode_info(&frame(&nc)).is_none());
        // An empty body (a gRPC error comes back with no message).
        assert!(decode_info(&frame(&[])).is_none());
        // A varint that never ends.
        assert!(decode_info(&frame(&[7 << 3, 0x80, 0x80, 0x80])).is_none());
        // A wire type that is not defined for these fields (a group).
        assert!(decode_info(&frame(&[7 << 3 | 3])).is_none());
    }

    #[test]
    fn a_single_server_is_kept_and_nothing_is_decided() {
        let list = s(&["a:443"]);
        for o in [Observed::Unknown, Observed::Failed, main_at(100)] {
            assert_eq!(choose(&list, 0, &[o], "main").index, 0);
        }
    }

    #[test]
    fn a_current_server_that_is_in_band_is_kept_even_when_a_better_one_is_first() {
        let list = s(&["a", "b", "c", "d"]);
        let obs = [main_at(1000), main_at(1010), main_at(1005), main_at(1000)];
        // Current is "c" (index 2): in band of the median, so it stays, though "a" is first.
        let c = choose(&list, 2, &obs, "main");
        assert_eq!(
            c,
            Choice {
                index: 2,
                note: None
            }
        );
    }

    #[test]
    fn nothing_is_decided_before_the_first_probe() {
        let list = s(&["a", "b", "c"]);
        let obs = [Observed::Unknown, main_at(10), main_at(10)];
        assert_eq!(choose(&list, 0, &obs, "main").index, 0);
    }

    #[test]
    fn a_failed_current_goes_to_the_first_eligible_server_of_the_list() {
        let list = s(&["a", "b", "c", "d"]);
        let obs = [
            Observed::Failed,
            Observed::Failed,
            main_at(1000),
            main_at(1001),
        ];
        let c = choose(&list, 0, &obs, "main");
        assert_eq!(c.index, 2);
        assert!(c.note.unwrap().contains("a -> c"));
    }

    #[test]
    fn a_failed_current_with_one_answer_goes_to_that_answer() {
        let list = s(&["a", "b", "c"]);
        let obs = [Observed::Failed, Observed::Failed, main_at(1000)];
        assert_eq!(choose(&list, 0, &obs, "main").index, 2);
    }

    #[test]
    fn a_failed_current_with_nothing_eligible_is_kept_and_noted() {
        let list = s(&["a", "b"]);
        let obs = [Observed::Failed, Observed::Failed];
        let c = choose(&list, 1, &obs, "main");
        assert_eq!(c.index, 1);
        assert!(c.note.is_some());
    }

    #[test]
    fn a_failed_current_skips_a_server_out_of_band_when_three_answered() {
        // a failed; b is 500 blocks behind; c, d, e agree.
        let list = s(&["a", "b", "c", "d", "e"]);
        let obs = [
            Observed::Failed,
            main_at(500),
            main_at(1000),
            main_at(1002),
            main_at(1001),
        ];
        assert_eq!(choose(&list, 0, &obs, "main").index, 2);
    }

    #[test]
    fn a_server_on_another_chain_is_never_chosen() {
        let list = s(&["a", "b", "c"]);
        let obs = [Observed::Failed, info("test", NU7, 1000), main_at(1000)];
        assert_eq!(choose(&list, 0, &obs, "main").index, 2);
        // The current server that answers as the other chain has failed.
        let obs = [info("test", NU7, 1000), main_at(1000), main_at(1000)];
        assert_eq!(choose(&list, 0, &obs, "main").index, 1);
        // A test network wants "test".
        let obs = [
            main_at(1000),
            info("test", NU7, 1000),
            info("test", NU7, 1000),
        ];
        assert_eq!(choose(&list, 0, &obs, "test").index, 1);
    }

    #[test]
    fn a_server_on_another_branch_is_not_eligible() {
        let list = s(&["a", "b", "c"]);
        // a reports an older branch; b and c, the majority, report NU7.
        let obs = [info("main", "4dec4df0", 1000), main_at(1000), main_at(1000)];
        assert_eq!(choose(&list, 0, &obs, "main").index, 1);
    }

    #[test]
    fn an_out_of_band_current_is_left_only_when_three_agree() {
        let list = s(&["a", "b", "c", "d"]);
        // a is 100 behind; b, c, d agree: leave a for the first in band.
        let obs = [main_at(900), main_at(1000), main_at(1001), main_at(1002)];
        let c = choose(&list, 0, &obs, "main");
        assert_eq!(c.index, 1);
        assert!(c.note.unwrap().contains("out of band"));
        // Only two agree (the third is far from them): keep, and say why.
        let obs = [main_at(900), main_at(1000), main_at(1001), Observed::Failed];
        let c = choose(&list, 0, &obs, "main");
        assert_eq!(c.index, 0);
        assert!(c.note.unwrap().contains("only"));
    }

    #[test]
    fn the_reference_is_the_median_so_one_liar_above_cannot_move_it() {
        // b reports a height far above everyone: the median is still the honest cluster, so the
        // honest current stays and the liar is out of band, never chosen.
        let list = s(&["a", "b", "c", "d"]);
        let obs = [
            main_at(1000),
            main_at(9_000_000),
            main_at(1001),
            main_at(1002),
        ];
        assert_eq!(choose(&list, 0, &obs, "main").index, 0);
        // If the current is the liar, it is out of band and left for the first honest one.
        assert_eq!(choose(&list, 1, &obs, "main").index, 0);
        // And a liar BELOW is out of band the same way.
        let obs = [main_at(1), main_at(1000), main_at(1001), main_at(1002)];
        assert_eq!(choose(&list, 0, &obs, "main").index, 1);
    }

    #[test]
    fn the_choice_is_deterministic() {
        let list = s(&["a", "b", "c", "d"]);
        let obs = [
            Observed::Failed,
            main_at(1000),
            main_at(1001),
            main_at(1002),
        ];
        assert_eq!(
            choose(&list, 0, &obs, "main"),
            choose(&list, 0, &obs, "main")
        );
    }

    #[test]
    fn the_birthday_is_the_lowest_answer_bounded_by_the_median_and_needs_three_in_agreement() {
        let obs = [
            main_at(1000),
            main_at(1004),
            main_at(1002),
            Observed::Failed,
        ];
        assert_eq!(birthday(&obs, "main"), Some(1000 - BIRTHDAY_BACK));
        // Two answers are not enough.
        let obs = [
            main_at(1000),
            main_at(1004),
            Observed::Failed,
            Observed::Failed,
        ];
        assert_eq!(birthday(&obs, "main"), None);
        // Three answers that do not agree with each other: no birthday.
        let obs = [main_at(1000), main_at(5000), main_at(9000)];
        assert_eq!(birthday(&obs, "main"), None);
        // A liar far above does not move the median of the honest three.
        let obs = [
            main_at(1000),
            main_at(1001),
            main_at(1002),
            main_at(9_000_000),
        ];
        assert_eq!(birthday(&obs, "main"), Some(1000 - BIRTHDAY_BACK));
        // Nothing probed: none.
        assert_eq!(birthday(&vec![Observed::Unknown; 3], "main"), None);
        // Never underflows.
        let obs = [main_at(5), main_at(6), main_at(7)];
        assert_eq!(birthday(&obs, "main"), Some(0));
        // Three hosts agreeing high do not move it past a lower honest answer.
        let obs = [main_at(1015), main_at(1016), main_at(1017), main_at(1000)];
        assert_eq!(birthday(&obs, "main"), Some(1000 - BIRTHDAY_BACK));
        // A server far below costs at most the floor.
        let obs = [main_at(5000), main_at(5001), main_at(5002), main_at(1)];
        assert_eq!(
            birthday(&obs, "main"),
            Some(5000 - BIRTHDAY_FLOOR - BIRTHDAY_BACK)
        );
    }

    #[test]
    fn servers_stick_to_the_current_across_rounds_and_switch_on_failure() {
        let sv = Servers::parse("a:443, b:443, c:443", "main");
        assert_eq!(sv.current(), "a:443");
        assert!(sv.is_list());
        sv.record(vec![main_at(1000), main_at(1001), main_at(1002)]);
        assert_eq!(sv.current(), "a:443");
        // b is first in band after a fails.
        sv.record(vec![Observed::Failed, main_at(1001), main_at(1002)]);
        assert_eq!(sv.current(), "b:443");
        // a comes back: sticky, no switch back.
        sv.record(vec![main_at(1003), main_at(1004), main_at(1005)]);
        assert_eq!(sv.current(), "b:443");
        // A round of the wrong length is ignored.
        sv.record(vec![Observed::Failed]);
        assert_eq!(sv.current(), "b:443");
        assert_eq!(sv.birthday(), Some(1003 - BIRTHDAY_BACK));
    }

    #[test]
    fn a_single_server_never_starts_a_probe_thread() {
        let sv = Servers::parse("zec.rocks:443", "main");
        assert!(!sv.is_list());
        assert!(!spawn_probe(&sv, PathBuf::from("/nonexistent/curl")));
        assert_eq!(sv.current(), "zec.rocks:443");
        assert_eq!(sv.birthday(), None);
    }

    /// The probe runs `curl` against each server (a stand-in here, so no network): an answer is
    /// decoded, a failure is a failure, and the round is recorded in list order.
    #[cfg(unix)]
    #[test]
    fn a_probe_round_records_each_server_from_its_own_answer() {
        let dir = std::env::temp_dir().join(format!("konclave-probe-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let good = dir.join("good.bin");
        std::fs::write(&good, frame(&lightd_info_message())).unwrap();
        let curl = dir.join("curl");
        crate::test_exec::write_script(
            &curl,
            &format!(
                "#!/bin/sh\nfor last; do :; done\ncase \"$last\" in\n  https://a.test:443/cash.z.wallet.sdk.rpc.CompactTxStreamer/GetLightdInfo) cat {} ;;\n  https://c.test:9067/*) printf garbage ;;\n  *) exit 22 ;;\nesac\n",
                good.display()
            ),
        );
        let sv = Servers::parse("a.test:443,b.test:443,c.test:9067", "main");
        probe_round(&curl, &sv);
        let st = sv.lock();
        assert!(
            matches!(&st.obs[0], Observed::Answered(i) if i.height == 3_586_790 && i.chain == "main")
        );
        assert_eq!(st.obs[1], Observed::Failed);
        assert_eq!(st.obs[2], Observed::Failed);
        drop(st);
        std::fs::remove_dir_all(&dir).ok();
    }

    /// A probe that hangs is stopped, and the round still records.
    #[cfg(unix)]
    #[test]
    fn a_probe_that_hangs_is_a_failure_not_a_hang() {
        let dir = std::env::temp_dir().join(format!("konclave-probe-hang-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let curl = dir.join("curl");
        crate::test_exec::write_script(&curl, "#!/bin/sh\nexec sleep 30\n");
        set_within_for_test(Some(Duration::from_millis(300)));
        let started = std::time::Instant::now();
        let r = probe_one(&curl, "a.test:443");
        set_within_for_test(None);
        assert_eq!(r, Observed::Failed);
        assert!(started.elapsed() < Duration::from_secs(5));
        std::fs::remove_dir_all(&dir).ok();
    }

    // ---- broadcast failover ---------------------------------------------------------------------

    const TXID: &str = "11111111111111111111111111111111111111111111111111111111111111aa";

    /// A stand-in devtool for `pczt send`: logs which server it was asked for, keeps the bytes it was
    /// fed, and behaves per server (`$6` is the host after `-s`).
    #[cfg(unix)]
    fn stand_in(name: &str, per_server: &str) -> (PathBuf, PathBuf) {
        let dir = std::env::temp_dir().join(format!("konclave-bc-{name}-{}", std::process::id()));
        std::fs::remove_dir_all(&dir).ok();
        std::fs::create_dir_all(&dir).unwrap();
        let log = dir.join("log");
        let dev = dir.join("devtool");
        crate::test_exec::write_script(
            &dev,
            &format!(
                "#!/bin/sh\necho \"$6\" >> {log}\ncat > {dir}/in.\"$6\"\ncase \"$6\" in\n{per_server}\nesac\n",
                log = log.display(),
                dir = dir.display(),
            ),
        );
        (dev, dir)
    }

    #[cfg(unix)]
    fn tried(dir: &Path) -> Vec<String> {
        std::fs::read_to_string(dir.join("log"))
            .unwrap_or_default()
            .lines()
            .map(str::to_string)
            .collect()
    }

    #[cfg(unix)]
    fn three() -> Servers {
        Servers::parse("a:443,b:443,c:443", "main")
    }

    #[cfg(unix)]
    #[test]
    fn a_broadcast_that_times_out_is_sent_on_the_next_server_with_the_same_bytes() {
        let (dev, dir) = stand_in(
            "timeout",
            &format!("  a:443) exec sleep 30 ;;\n  b:443) echo {TXID} ;;\n  *) exit 9 ;;"),
        );
        set_within_for_test(Some(Duration::from_millis(300)));
        let r = broadcast(&dev, "/w", &three(), "a:443", b"SIGNED-BYTES");
        set_within_for_test(None);
        assert_eq!(r.unwrap(), TXID);
        assert_eq!(tried(&dir), ["a:443", "b:443"]);
        // The server that answered was fed exactly what the first one was.
        assert_eq!(
            std::fs::read(dir.join("in.b:443")).unwrap(),
            b"SIGNED-BYTES"
        );
        assert_eq!(
            std::fs::read(dir.join("in.a:443")).unwrap(),
            b"SIGNED-BYTES"
        );
        std::fs::remove_dir_all(&dir).ok();
    }

    /// Any non-zero exit of the engine is the tool's error and is not sent on: with the engine's
    /// refusal text, with a gRPC status as another server software words it, or a local failure. A
    /// different server would answer the same, and the bytes would go to more operators for nothing.
    #[cfg(unix)]
    #[test]
    fn no_non_zero_exit_is_sent_on_whatever_it_says() {
        // Every failure AFTER the engine said it was sending is final, whatever it says.
        for (name, stderr) in [
            (
                "marker",
                "Error: Send failed: (-26) bad-txns-inputs-missingorspent",
            ),
            (
                "status",
                "Error: status: InvalidArgument, message: \"transaction rejected\"",
            ),
            ("transport", "Error: transport error: connection reset"),
        ] {
            let (dev, dir) = stand_in(
                name,
                &format!(
                    "  a:443) echo '{SENDING}'; echo '{stderr}' >&2; exit 1 ;;\n  *) echo {TXID} ;;"
                ),
            );
            let e = broadcast(&dev, "/w", &three(), "a:443", b"x").unwrap_err();
            assert_eq!(tried(&dir), ["a:443"], "{name}: went to a second server");
            let text = e.to_string();
            assert!(
                text.contains(&stderr[7..20]),
                "{name}: the tool's text is kept: {text}"
            );
            assert!(!text.contains("may have reached"), "{name}: {text}");
            std::fs::remove_dir_all(&dir).ok();
        }
    }

    /// A failure BEFORE the engine got to sending (it could not reach the server, or failed locally
    /// before sending) sent nothing: the same bytes go to the next server, and nothing says the
    /// transaction may be out.
    #[cfg(unix)]
    #[test]
    fn a_server_that_cannot_be_reached_is_passed_over_for_the_next() {
        for (name, stderr) in [
            ("refused", "Error: transport error: Connection refused"),
            (
                "dns",
                "Error: transport error: dns error: failed to lookup address",
            ),
            (
                "local",
                "Error: Failed to extract and store transaction from PCZT",
            ),
        ] {
            let (dev, dir) = stand_in(
                name,
                &format!("  a:443) echo '{stderr}' >&2; exit 1 ;;\n  *) echo '{SENDING}'; echo {TXID} ;;"),
            );
            let got = broadcast(&dev, "/w", &three(), "a:443", b"x");
            assert_eq!(got.unwrap(), TXID, "{name}");
            assert_eq!(tried(&dir), ["a:443", "b:443"], "{name}");
            std::fs::remove_dir_all(&dir).ok();
        }
        // Every server unreachable: the last error, and no claim that it may have gone out.
        let (dev, dir) = stand_in(
            "none",
            "  *) echo 'Error: transport error: Connection refused' >&2; exit 1 ;;",
        );
        let e = broadcast(&dev, "/w", &three(), "a:443", b"x").unwrap_err();
        assert_eq!(tried(&dir).len(), 3);
        assert!(!e.to_string().contains("may have reached"), "{e}");
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn only_our_deadline_or_a_start_failure_allows_another_server() {
        let timed_out = ToolError::Io(std::io::Error::from(std::io::ErrorKind::TimedOut));
        assert_eq!(retry(&timed_out), Some(true));
        let spawn = ToolError::Spawn {
            program: "d".into(),
            source: std::io::Error::from(std::io::ErrorKind::NotFound),
        };
        assert_eq!(retry(&spawn), Some(false));
        let other_io = ToolError::Io(std::io::Error::from(std::io::ErrorKind::BrokenPipe));
        assert_eq!(retry(&other_io), None);
        // After the engine said it was sending: final, whatever the text.
        for stderr in ["Send failed: (-1) x", "transport error", ""] {
            let nz = ToolError::NonZero {
                program: "d".into(),
                code: Some(1),
                stderr: stderr.into(),
                stdout: format!("{SENDING}\n"),
            };
            assert_eq!(retry(&nz), None, "{stderr:?}");
        }
        // Before it (connection refused, DNS, TLS): nothing was sent, the next server is tried.
        let refused = ToolError::NonZero {
            program: "d".into(),
            code: Some(1),
            stderr: "Error: transport error: Connection refused".into(),
            stdout: String::new(),
        };
        assert_eq!(retry(&refused), Some(false));
        assert_eq!(retry(&ToolError::parse("broadcast", "no txid")), None);
    }

    #[cfg(unix)]
    #[test]
    fn when_every_server_fails_the_error_says_it_may_have_gone_out() {
        let (dev, dir) = stand_in("allfail", "  *) exec sleep 30 ;;");
        set_within_for_test(Some(Duration::from_millis(200)));
        let e = broadcast(&dev, "/w", &three(), "a:443", b"x").unwrap_err();
        set_within_for_test(None);
        assert_eq!(tried(&dir), ["a:443", "b:443", "c:443"]);
        assert!(
            e.to_string().contains("may have reached the network"),
            "{e}"
        );
        std::fs::remove_dir_all(&dir).ok();
    }

    #[cfg(unix)]
    #[test]
    fn a_refusal_after_an_unfinished_attempt_still_says_it_may_have_gone_out() {
        // a hangs (it may have received it); b answers that it is a duplicate.
        let (dev, dir) = stand_in(
            "dup",
            "  a:443) exec sleep 30 ;;\n  b:443) echo 'Sending transaction...'; echo 'Error: Send failed: (-27) txn-already-in-mempool' >&2; exit 1 ;;\n  *) exit 9 ;;",
        );
        set_within_for_test(Some(Duration::from_millis(200)));
        let e = broadcast(&dev, "/w", &three(), "a:443", b"x").unwrap_err();
        set_within_for_test(None);
        assert_eq!(tried(&dir), ["a:443", "b:443"]);
        let text = e.to_string();
        assert!(text.contains("may have reached the network"), "{text}");
        assert!(text.contains("txn-already-in-mempool"), "{text}");
        std::fs::remove_dir_all(&dir).ok();
    }

    #[cfg(unix)]
    #[test]
    fn the_budget_is_total_not_per_server() {
        let (dev, dir) = stand_in("budget", "  *) exec sleep 30 ;;");
        let list = Servers::parse("a:443,b:443,c:443,d:443,e:443", "main");
        set_within_for_test(Some(Duration::from_millis(300)));
        let started = std::time::Instant::now();
        let e = broadcast_within(Duration::from_millis(400), &dev, "/w", &list, "a:443", b"x")
            .unwrap_err();
        set_within_for_test(None);
        // 5 servers x 300 ms would be 1.5 s; the budget of 400 ms allows the first and one more.
        assert!(tried(&dir).len() <= 2, "{:?}", tried(&dir));
        assert!(started.elapsed() < Duration::from_millis(1400));
        assert!(e.to_string().contains("may have reached the network"));
        std::fs::remove_dir_all(&dir).ok();
    }

    #[cfg(unix)]
    #[test]
    fn one_server_is_tried_once_and_the_error_is_the_tools() {
        let (dev, dir) = stand_in(
            "single",
            "  *) echo 'Error: Send failed: (-1) nope' >&2; exit 1 ;;",
        );
        let one = Servers::parse("a:443", "main");
        let e = broadcast(&dev, "/w", &one, "a:443", b"x").unwrap_err();
        assert_eq!(tried(&dir), ["a:443"]);
        assert!(e.to_string().contains("nope"));
        std::fs::remove_dir_all(&dir).ok();
    }

    #[cfg(unix)]
    #[test]
    fn a_server_the_probe_found_failed_or_on_another_chain_is_not_tried() {
        let sv = three();
        sv.record(vec![
            main_at(1000),
            Observed::Failed,
            info("test", NU7, 1000),
        ]);
        assert_eq!(sv.broadcast_order("a:443"), ["a:443"]);
        // Not probed yet: kept.
        assert_eq!(
            three().broadcast_order("b:443"),
            ["b:443", "a:443", "c:443"]
        );
        // The operation's own server goes first even when it is not first in the list.
        let ok = three();
        ok.record(vec![main_at(1000), main_at(1001), main_at(1002)]);
        assert_eq!(ok.broadcast_order("c:443"), ["c:443", "a:443", "b:443"]);
    }

    /// Both send paths put bytes on the network through `lightclient::broadcast`, and nothing else
    /// calls the single-attempt function: a second implementation of the failover would be the
    /// legacy path keeping the old rule.
    #[test]
    fn nothing_but_the_broadcast_function_makes_a_send_attempt() {
        let needle = ["pczt::send", "_on("].concat();
        let root = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("..");
        let mut offenders = Vec::new();
        for crate_src in ["orchestrator/src", "helper-server/src", "src-tauri/src"] {
            let mut stack = vec![root.join(crate_src)];
            while let Some(d) = stack.pop() {
                for e in std::fs::read_dir(&d).unwrap().flatten() {
                    let p = e.path();
                    if p.is_dir() {
                        stack.push(p);
                    } else if p.extension().is_some_and(|x| x == "rs")
                        && !p.ends_with("orchestrator/src/lightclient.rs")
                    {
                        let src = std::fs::read_to_string(&p).unwrap();
                        let prod = src.split("\n#[cfg(test)]\nmod tests").next().unwrap();
                        if prod.contains(&needle) {
                            offenders.push(p.display().to_string());
                        }
                    }
                }
            }
        }
        assert!(offenders.is_empty(), "{offenders:?}");
        let send = std::fs::read_to_string(root.join("orchestrator/src/send.rs")).unwrap();
        let prod = send.split("\n#[cfg(test)]\nmod tests").next().unwrap();
        assert_eq!(
            prod.matches("broadcast_bytes(sc,").count(),
            2,
            "both send paths use the one function"
        );
    }

    // ---- the health view ------------------------------------------------------------------------

    #[test]
    fn status_reads_the_cache_and_marks_each_server() {
        let sv = Servers::parse("a:443,b:443,c:443,d:443,e:443", "main");
        // Before any probe: every server unknown, nothing else known.
        for st in sv.status() {
            assert_eq!((st.ok, st.chain, st.height_lag), (None, None, None));
        }
        sv.record(vec![
            main_at(1000),
            main_at(1002),
            main_at(1001),
            main_at(100),
            Observed::Failed,
        ]);
        let st = sv.status();
        assert_eq!(
            st.iter().map(|x| x.host.as_str()).collect::<Vec<_>>(),
            ["a:443", "b:443", "c:443", "d:443", "e:443"]
        );
        // median of [100,1000,1001,1002] = 1000
        assert_eq!(st[0].ok, Some(true));
        assert_eq!(st[0].chain.as_deref(), Some("main"));
        assert_eq!(st[0].height_lag, Some(0));
        assert_eq!(st[1].height_lag, Some(-2));
        assert_eq!(st[3].ok, Some(false), "far behind the median is not ok");
        assert_eq!(st[3].height_lag, Some(900));
        assert_eq!(st[4].ok, Some(false));
        assert_eq!(st[4].chain, None);
        // A chain name the server chose is never repeated on the open route.
        let odd = Servers::parse("a:443,b:443", "main");
        odd.record(vec![
            info(&"x".repeat(5000), "c2d6d0b4", 1000),
            main_at(1000),
        ]);
        let st2 = odd.status();
        assert_eq!(st2[0].chain.as_deref(), Some("other"));
        assert_eq!(st2[0].ok, Some(false));
        let json = serde_json::to_value(&st[0]).unwrap();
        assert_eq!(
            json,
            serde_json::json!({"host":"a:443","ok":true,"chain":"main","height_lag":0})
        );
    }

    #[test]
    fn one_server_reports_one_unknown_entry() {
        let sv = Servers::parse("zec.rocks:443", "main");
        let st = sv.status();
        assert_eq!(st.len(), 1);
        assert_eq!(st[0].host, "zec.rocks:443");
        assert_eq!(st[0].ok, None);
        // A server on another chain is not ok.
        let sv = Servers::parse("a:443", "main");
        sv.record(vec![info("test", NU7, 5)]);
        assert_eq!(sv.status()[0].ok, Some(false));
    }

    // ---- one rule for a usable server, bands, overflow, the probe's argv and bound ---------------

    #[test]
    fn one_rule_decides_what_the_choice_the_broadcast_and_the_health_route_use() {
        // [1000, 1000, 1100]: median 1000, three eligible, two in band. c is not usable anywhere.
        let sv = Servers::parse("a:443,b:443,c:443", "main");
        sv.record(vec![main_at(1000), main_at(1000), main_at(1100)]);
        assert_eq!(sv.broadcast_order("a:443"), ["a:443", "b:443"]);
        let st = sv.status();
        assert_eq!(
            [st[0].ok, st[1].ok, st[2].ok],
            [Some(true), Some(true), Some(false)]
        );
        // And the choice, with the current one failed, never goes to the one out of band.
        let list = s(&["a", "b", "c", "d"]);
        let obs = [
            Observed::Failed,
            main_at(1100),
            main_at(1000),
            main_at(1000),
        ];
        assert_eq!(choose(&list, 0, &obs, "main").index, 2);
        // The broadcast order never holds a server the health route calls not ok (the order is the
        // rule narrowed by the broadcast band, so the converse need not hold in general).
        for (i, host) in ["a:443", "b:443", "c:443"].iter().enumerate() {
            let in_order = sv.broadcast_order("zzz").iter().any(|h| h == host);
            assert!(!in_order || st[i].ok == Some(true), "{host}");
        }
    }

    #[test]
    fn an_even_split_still_has_a_server_to_go_to() {
        // Two honest, two 100 ahead: the median is between them, nobody is in band. The failed
        // current still goes to the first eligible server, and the note does not say none is.
        let list = s(&["a", "b", "c", "d", "e"]);
        let obs = [
            Observed::Failed,
            main_at(1000),
            main_at(1000),
            main_at(1100),
            main_at(1100),
        ];
        let c = choose(&list, 0, &obs, "main");
        assert_eq!(c.index, 1);
        assert!(!c.note.unwrap().contains("no server is eligible"));
        // Nothing eligible at all: kept, and the note says so.
        let obs = [Observed::Failed, Observed::Failed];
        let c = choose(&s(&["a", "b"]), 0, &obs, "main");
        assert!(c.note.unwrap().contains("no server is eligible"));
    }

    #[test]
    fn the_broadcast_band_is_three_blocks_and_reads_keep_twenty() {
        let sv = Servers::parse("a:443,b:443,c:443,d:443", "main");
        // median of 1000, 1001, 1002, 1010 is 1001: c (1010) is 9 away, in the read band, out of the
        // broadcast band.
        sv.record(vec![
            main_at(1000),
            main_at(1002),
            main_at(1010),
            main_at(1001),
        ]);
        assert_eq!(sv.broadcast_order("a:443"), ["a:443", "b:443", "d:443"]);
        assert!(
            sv.status()[2].ok == Some(true),
            "c is still fine to read through"
        );
        assert_eq!(MAX_BROADCAST_LAG, 3);
        assert_eq!(MAX_LAG, 20);
    }

    #[test]
    fn with_fewer_than_three_eligible_the_eligible_ones_are_ok() {
        let sv = Servers::parse("a:443,b:443,c:443", "main");
        sv.record(vec![main_at(1000), main_at(1010), Observed::Failed]);
        let st = sv.status();
        assert_eq!(
            [st[0].ok, st[1].ok, st[2].ok],
            [Some(true), Some(true), Some(false)]
        );
        assert_eq!((st[0].height_lag, st[1].height_lag), (Some(5), Some(-5)));
        // One eligible, on another chain next to it.
        let sv = Servers::parse("a:443,b:443", "main");
        sv.record(vec![main_at(7), info("test", NU7, 7)]);
        let st = sv.status();
        assert_eq!([st[0].ok, st[1].ok], [Some(true), Some(false)]);
    }

    #[test]
    fn a_branch_tie_goes_to_the_branch_of_the_earliest_server() {
        let list = s(&["a", "b"]);
        let obs = [
            info("main", "aaaa0001", 1000),
            info("main", "bbbb0002", 1000),
        ];
        // a's branch wins the tie: b is not eligible, so a current b has failed.
        assert_eq!(choose(&list, 1, &obs, "main").index, 0);
        let sv = Servers::parse("a:443,b:443", "main");
        sv.record(vec![obs[0].clone(), obs[1].clone()]);
        assert_eq!(sv.status()[0].ok, Some(true));
        assert_eq!(sv.status()[1].ok, Some(false));
    }

    #[test]
    fn heights_that_would_overflow_are_handled_and_refused_at_the_decoder() {
        // The middle of two cannot overflow, however large one of them is.
        let list = s(&["a", "b", "c"]);
        let obs = [main_at(1000), main_at(u64::MAX), main_at(u64::MAX - 1)];
        let _ = choose(&list, 0, &obs, "main");
        let _ = birthday(&obs, "main");
        let sv = Servers::parse("a:443,b:443", "main");
        sv.record(vec![main_at(1000), main_at(u64::MAX)]);
        let st = sv.status();
        assert!(st[0].height_lag.is_some() && st[1].height_lag.is_some());
        // A frame whose height is not a u32 is a failed probe.
        let mut m = Vec::new();
        field_str(&mut m, 4, "main");
        field_varint(&mut m, 7, u64::from(u32::MAX) + 1);
        assert!(decode_info(&frame(&m)).is_none());
        let mut m = Vec::new();
        field_str(&mut m, 4, "main");
        field_varint(&mut m, 7, u64::from(u32::MAX));
        assert_eq!(decode_info(&frame(&m)).unwrap().height, u64::from(u32::MAX));
        // A ten-byte varint that fits u64 is read, and is then over the bound.
        let mut m = Vec::new();
        field_str(&mut m, 4, "main");
        field_varint(&mut m, 7, u64::MAX);
        assert!(decode_info(&frame(&m)).is_none());
    }

    #[test]
    fn the_decoder_skips_fixed_width_fields() {
        let mut m = lightd_info_message();
        m.push(20 << 3 | 1);
        m.extend_from_slice(&[0; 8]);
        m.push(21 << 3 | 5);
        m.extend_from_slice(&[0; 4]);
        assert_eq!(decode_info(&frame(&m)).unwrap().height, 3_586_790);
        // Cut short inside a fixed-width field.
        let mut m = lightd_info_message();
        m.push(20 << 3 | 1);
        m.extend_from_slice(&[0; 3]);
        assert!(decode_info(&frame(&m)).is_none());
    }

    #[test]
    fn a_server_is_host_and_port_and_nothing_else() {
        for ok in [
            "zec.rocks:443",
            "zcash.mysideoftheweb.com:9067",
            "10.0.0.1:9067",
            "a-b.c:1",
        ] {
            assert!(validate_entry(ok).is_ok(), "{ok}");
        }
        for bad in [
            "https://zec.rocks:443",
            "zec.rocks:443/x",
            "zec rocks:443",
            "zec.rocks",
            ":443",
            "zec.rocks:0",
            "zec.rocks:70000",
            "zec.rocks:+443",
            "zec.rocks:44 3",
            "-a.b:443",
            "a..b:443",
            "a.b.:443",
            "[::1]:443",
            "zecrocks",
            "a@b:443",
        ] {
            assert!(validate_entry(bad).is_err(), "{bad}");
        }
        assert!(Servers::try_parse("a.b:443, c.d:9067", "main").is_ok());
        let e = Servers::try_parse("a.b:443,https://c.d:443", "main").unwrap_err();
        assert!(
            e.contains("https://c.d:443") && e.contains("not host:port"),
            "{e}"
        );
        assert!(Servers::try_parse("", "main").is_err());
        assert!(Servers::try_parse(" , ", "main").is_err());
    }

    #[test]
    fn a_list_names_servers_the_probe_can_reach_over_https() {
        // A list is probed over https, so an entry the probe can never read is refused in a list.
        for bad in [
            "abc.onion:443",
            "x.ONION:9067",
            "localhost:9067",
            "a.localhost:443",
            "127.0.0.1:9067",
            "10.0.0.1:9067",
        ] {
            let e = Servers::try_parse(&format!("zec.rocks:443,{bad}"), "main").unwrap_err();
            assert!(e.contains(bad) && e.contains("list"), "{bad}: {e}");
        }
        // One server is not probed, so it keeps today's rule.
        for one in ["localhost:9067", "127.0.0.1:9067", "abc.onion:443"] {
            assert!(Servers::try_parse(one, "main").is_ok(), "{one}");
        }
        // The approved list passes.
        assert!(Servers::try_parse(
            "zec.rocks:443,eu.zec.rocks:443,na.zec.rocks:443,zcash.mysideoftheweb.com:9067",
            "main"
        )
        .is_ok());
    }

    #[test]
    fn a_switch_does_not_go_to_a_server_behind_what_the_wallets_scanned() {
        let sv = Servers::parse("a:443,b:443,c:443,d:443", "main");
        // a in use at 1010: the wallets may have scanned to 1010.
        sv.record(vec![
            main_at(1010),
            main_at(1000),
            main_at(1012),
            main_at(1011),
        ]);
        assert_eq!(sv.current(), "a:443");
        // a fails; b is first in band but behind 1010: c (not behind) is taken instead.
        sv.record(vec![
            Observed::Failed,
            main_at(1001),
            main_at(1013),
            main_at(1012),
        ]);
        assert_eq!(sv.current(), "c:443");
        // Every candidate behind: the highest is taken (least behind), never the first in the list.
        let sv = Servers::parse("a:443,b:443,c:443,d:443", "main");
        sv.record(vec![
            main_at(1020),
            main_at(1010),
            main_at(1015),
            main_at(1012),
        ]);
        sv.record(vec![
            Observed::Failed,
            main_at(1010),
            main_at(1016),
            main_at(1012),
        ]);
        assert_eq!(sv.current(), "c:443");
        // A server far ahead of the others (out of band) never raises what counts as scanned.
        let sv = Servers::parse("a:443,b:443,c:443,d:443", "main");
        sv.record(vec![
            main_at(1000),
            main_at(1001),
            main_at(1002),
            main_at(9000),
        ]);
        sv.record(vec![
            main_at(9000),
            main_at(1001),
            main_at(1002),
            main_at(1003),
        ]);
        // a is now out of band with three agreeing: it moves to b (first in band, not behind 1000).
        assert_eq!(sv.current(), "b:443");
        // b fails: c (1002) is not behind what was scanned (1000), so it is taken; had a's 9000 raised
        // the mark, every candidate would look behind and the highest (d) would win.
        sv.record(vec![
            main_at(9000),
            Observed::Failed,
            main_at(1002),
            main_at(1003),
        ]);
        assert_eq!(sv.current(), "c:443");
    }

    #[test]
    fn the_local_path_keeps_one_string_and_never_splits_it() {
        let one = Servers::single("a:443,b:443", "main");
        assert_eq!(one.list(), ["a:443,b:443"]);
        assert_eq!(one.current(), "a:443,b:443");
        assert_eq!(one.broadcast_order("a:443,b:443"), ["a:443,b:443"]);
    }

    /// The probe's whole command line, and what it feeds curl: pinned, so that dropping the hygiene
    /// flags, the bound or the headers is a red test.
    #[cfg(unix)]
    #[test]
    fn the_probe_runs_curl_with_exactly_these_arguments() {
        let dir = std::env::temp_dir().join(format!("konclave-probe-argv-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let curl = dir.join("curl");
        crate::test_exec::write_script(
            &curl,
            &format!(
                "#!/bin/sh\nprintf '%s\\n' \"$@\" > {d}/argv\ncat > {d}/stdin\n",
                d = dir.display()
            ),
        );
        let _ = probe_one(&curl, "a.test:443");
        let argv: Vec<String> = std::fs::read_to_string(dir.join("argv"))
            .unwrap()
            .lines()
            .map(str::to_string)
            .collect();
        assert_eq!(
            argv,
            [
                "--disable",
                "--http2",
                "--silent",
                "--show-error",
                "--max-time",
                "10",
                "--max-filesize",
                "65536",
                "--proto",
                "=https",
                "--noproxy",
                "*",
                "-H",
                "content-type: application/grpc",
                "-H",
                "te: trailers",
                "--data-binary",
                "@-",
                "--url",
                "https://a.test:443/cash.z.wallet.sdk.rpc.CompactTxStreamer/GetLightdInfo",
            ]
        );
        assert_eq!(std::fs::read(dir.join("stdin")).unwrap(), [0u8; 5]);
        std::fs::remove_dir_all(&dir).ok();
    }

    /// A server that sends far more than a `GetLightdInfo` is a failed probe, and what is read is
    /// bounded, whatever curl does.
    #[cfg(unix)]
    #[test]
    fn a_probe_reply_over_the_bound_is_a_failure() {
        let dir = std::env::temp_dir().join(format!("konclave-probe-big-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let curl = dir.join("curl");
        crate::test_exec::write_script(&curl, "#!/bin/sh\nexec head -c 50000000 /dev/zero\n");
        let started = std::time::Instant::now();
        assert_eq!(probe_one(&curl, "a.test:443"), Observed::Failed);
        assert!(started.elapsed() < Duration::from_secs(5));
        std::fs::remove_dir_all(&dir).ok();
    }

    /// With a list the background probe really runs and fills the cache; with a failing curl every
    /// server reads as failed.
    #[cfg(unix)]
    #[test]
    fn a_list_starts_the_probe_thread_and_it_fills_the_cache() {
        let dir = std::env::temp_dir().join(format!("konclave-probe-spawn-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let curl = dir.join("curl");
        crate::test_exec::write_script(&curl, "#!/bin/sh\nexit 22\n");
        let sv = Servers::parse("a.test:443,b.test:443", "main");
        assert!(spawn_probe(&sv, curl));
        let until = std::time::Instant::now() + Duration::from_secs(10);
        while sv.status()[0].ok.is_none() && std::time::Instant::now() < until {
            std::thread::sleep(Duration::from_millis(50));
        }
        assert_eq!(sv.status()[0].ok, Some(false));
        assert_eq!(sv.status()[1].ok, Some(false));
        std::fs::remove_dir_all(&dir).ok();
    }
}
