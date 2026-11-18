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

/// What `zcash-devtool` prints when the server ANSWERED and refused the transaction
/// (`Error::SendFailed`'s display, `src/error.rs` at the commit `engine/versions.lock` pins:
/// `"Send failed: ({code}) {reason}"`). A refusal is not retried on another server. Pinned by a test
/// that builds the line the way the engine does, so a change of wording breaks a test, not a send.
pub const REJECTION_MARKER: &str = "Send failed: (";

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
//    which is the median of several answers and only when enough of them agree ([`birthday`]).
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

/// How many answers that agree (all within [`MAX_LAG`] of the median) a decision that leaves a
/// server that still answers, or sets a wallet birthday, needs.
pub const MIN_AGREE: usize = 3;

/// How often the background probe asks every server.
pub const PROBE_EVERY: Duration = Duration::from_secs(60);

/// How long one probe may take.
pub const PROBE_WITHIN: Duration = Duration::from_secs(10);

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

struct Assessment {
    /// Answered, on the configured chain, on the branch most answers report.
    eligible: Vec<usize>,
    median: Option<u64>,
    /// Eligible and within [`MAX_LAG`] of the median.
    in_band: Vec<usize>,
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
    let mut heights: Vec<u64> = eligible.iter().map(|i| height(*i)).collect();
    heights.sort_unstable();
    let median = match heights.len() {
        0 => None,
        n if n % 2 == 1 => Some(heights[n / 2]),
        n => Some((heights[n / 2 - 1] + heights[n / 2]) / 2),
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
    let strict = a.eligible.len() >= MIN_AGREE;
    if a.eligible.contains(&current) {
        // Eligible but out of band.
        if a.in_band.len() >= MIN_AGREE {
            let to = a.in_band[0];
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
    let pool = if strict { &a.in_band } else { &a.eligible };
    match pool.first() {
        Some(&to) => Choice {
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
            "kept {}: it failed and no other server is eligible; heights {}",
            list[current],
            describe(list, obs, &all),
        ))),
    }
}

/// The birthday a new wallet is given: the median height minus [`BIRTHDAY_BACK`], and only when at
/// least [`MIN_AGREE`] eligible answers agree. `None` means today's behaviour (the engine asks one
/// server).
pub fn birthday(obs: &[Observed], network: &str) -> Option<u64> {
    let a = assess(obs, network);
    if a.in_band.len() < MIN_AGREE {
        return None;
    }
    a.median.map(|m| m.saturating_sub(BIRTHDAY_BACK))
}

struct State {
    current: usize,
    obs: Vec<Observed>,
    last_note: Option<String>,
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
    /// From a `KONCLAVE_LIGHTWALLETD` value and the network ("main" or "test") the chain must be.
    pub fn parse(raw: &str, network: &str) -> Servers {
        let list = parse_list(raw);
        let n = list.len();
        Servers {
            list: Arc::new(list),
            network: Arc::from(network),
            state: Arc::new(Mutex::new(State {
                current: 0,
                obs: vec![Observed::Unknown; n],
                last_note: None,
            })),
        }
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
        let c = choose(&self.list, st.current, &obs, &self.network);
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
    /// another chain or branch, or (with at least [`MIN_AGREE`] in band) out of band. A server not
    /// probed yet is kept: a probe that has not run is not a verdict.
    pub fn broadcast_order(&self, start: &str) -> Vec<String> {
        let st = self.lock();
        let a = assess(&st.obs, &self.network);
        let strict = a.in_band.len() >= MIN_AGREE;
        let mut out = vec![start.to_string()];
        for (i, host) in self.list.iter().enumerate() {
            if host == start {
                continue;
            }
            let keep = match &st.obs[i] {
                Observed::Unknown => true,
                Observed::Failed => false,
                Observed::Answered(_) => {
                    if strict {
                        a.in_band.contains(&i)
                    } else {
                        a.eligible.contains(&i)
                    }
                }
            };
            if keep {
                out.push(host.clone());
            }
        }
        out
    }

    /// The wallet birthday a new wallet should be given, or `None` for the engine's default.
    pub fn birthday(&self) -> Option<u64> {
        birthday(&self.lock().obs, &self.network)
    }
}

/// Whether a failed attempt may be made again on another server: the call did not finish (a
/// deadline, a broken pipe) or the engine failed without the server having refused. Not when the
/// server answered and refused ([`REJECTION_MARKER`]), and not when the engine could not even start.
fn retryable(e: &ToolError) -> bool {
    match e {
        ToolError::Io(_) => true,
        ToolError::NonZero { stderr, .. } => !stderr.contains(REJECTION_MARKER),
        // The tool ran and printed a failure, or what it printed could not be read: not a connection
        // problem, and the same on every server.
        ToolError::Parse { .. } | ToolError::Spawn { .. } => false,
    }
}

/// Broadcast `signed` (the same bytes every time) starting on `start`, and on a timeout or a
/// connection failure on the next server of [`Servers::broadcast_order`]; a refusal by a server stops
/// it. THE one place a transaction is sent: both send paths call it, and `send_with` still sees one
/// call and one result. Rebroadcasting the identical transaction is not signing again: same bytes,
/// same txid.
///
/// The whole thing stops at [`BROADCAST_TOTAL`]. When no server accepted it and any attempt did not
/// finish, the error says the transaction may have reached the network: an attempt that timed out may
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
                if !retryable(&e) {
                    // A refusal after an attempt that did not finish may still be the answer of a
                    // server that already has it (a duplicate).
                    last = Some(e);
                    break;
                }
                unfinished = true;
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
                "the transaction may have reached the network (a server did not answer in time or                  was unreachable); do not send it again before checking: {e}"
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
    Some(Info {
        version,
        chain,
        branch,
        height: height?,
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
    let base = if server.contains("://") {
        server.trim_end_matches('/').to_string()
    } else {
        format!("https://{server}")
    };
    let url = format!("{base}{LIGHTD_INFO_PATH}");
    let secs = PROBE_WITHIN.as_secs().to_string();
    let args = [
        "--http2",
        "--silent",
        "--show-error",
        "--max-time",
        secs.as_str(),
        "-H",
        "content-type: application/grpc",
        "-H",
        "te: trailers",
        "--data-binary",
        "@-",
        url.as_str(),
    ];
    match crate::tools::run_within(curl, &args, Some(&EMPTY_FRAME), probe_within()) {
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
    fn the_birthday_is_the_median_minus_a_hundred_and_needs_three_in_agreement() {
        let obs = [
            main_at(1000),
            main_at(1004),
            main_at(1002),
            Observed::Failed,
        ];
        assert_eq!(birthday(&obs, "main"), Some(1002 - BIRTHDAY_BACK));
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
        assert_eq!(birthday(&obs, "main"), Some(1001 - BIRTHDAY_BACK));
        // Nothing probed: none.
        assert_eq!(birthday(&vec![Observed::Unknown; 3], "main"), None);
        // Never underflows.
        let obs = [main_at(5), main_at(6), main_at(7)];
        assert_eq!(birthday(&obs, "main"), Some(0));
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
        assert_eq!(sv.birthday(), Some(1004 - BIRTHDAY_BACK));
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

    #[cfg(unix)]
    #[test]
    fn a_connection_failure_is_sent_on_the_next_server() {
        let (dev, dir) = stand_in(
            "conn",
            &format!(
                "  a:443) echo 'Error: transport error: connection refused' >&2; exit 1 ;;\n  *) echo {TXID} ;;"
            ),
        );
        let r = broadcast(&dev, "/w", &three(), "a:443", b"x");
        assert_eq!(r.unwrap(), TXID);
        assert_eq!(tried(&dir), ["a:443", "b:443"]);
        std::fs::remove_dir_all(&dir).ok();
    }

    #[cfg(unix)]
    #[test]
    fn a_rejection_is_not_retried_on_another_server() {
        let (dev, dir) = stand_in(
            "reject",
            &format!(
                "  a:443) echo 'Error: Send failed: (-26) bad-txns-inputs-missingorspent' >&2; exit 1 ;;\n  *) echo {TXID} ;;"
            ),
        );
        let e = broadcast(&dev, "/w", &three(), "a:443", b"x").unwrap_err();
        assert_eq!(tried(&dir), ["a:443"], "a refusal went to a second server");
        let text = e.to_string();
        assert!(text.contains("bad-txns-inputs-missingorspent"), "{text}");
        assert!(
            !text.contains("may have reached"),
            "a plain refusal is not 'may have gone out': {text}"
        );
        std::fs::remove_dir_all(&dir).ok();
    }

    /// The marker is the engine's own wording, built here the way `zcash-devtool` builds it
    /// (`Error::SendFailed`'s display at the pinned commit), so a change of wording on either side is
    /// a red test and not a retried refusal.
    #[test]
    fn the_rejection_marker_matches_the_engines_wording() {
        let (code, reason) = (-26, "bad-txns-inputs-missingorspent");
        let line = format!("Error: Send failed: ({code}) {reason}");
        assert!(line.contains(REJECTION_MARKER));
        assert_eq!(REJECTION_MARKER, "Send failed: (");
        let refusal = ToolError::NonZero {
            program: "d".into(),
            code: Some(1),
            stderr: line,
        };
        assert!(!retryable(&refusal));
        let down = ToolError::NonZero {
            program: "d".into(),
            code: Some(1),
            stderr: "Error: transport error".into(),
        };
        assert!(retryable(&down));
        assert!(retryable(&ToolError::Io(std::io::Error::from(
            std::io::ErrorKind::TimedOut
        ))));
        assert!(!retryable(&ToolError::parse("broadcast", "no txid")));
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
            "  a:443) exec sleep 30 ;;\n  b:443) echo 'Error: Send failed: (-27) txn-already-in-mempool' >&2; exit 1 ;;\n  *) exit 9 ;;",
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
}
