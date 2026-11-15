//! Konclave's OHTTP relay (RFC 9458 section 3): it forwards one opaque body to one gateway and
//! answers with what the gateway answered. It holds no key and cannot open what it carries.
//!
//! What it must never do, and where that is enforced:
//! - send the gateway anything of the client's: [`upstream`] builds the outbound request from
//!   constants and the body, and has no parameter for a header;
//! - keep or print the client's address: the address is read once, turned into a [`RateKey`] for
//!   the flood limit, and dropped; nothing here logs a request at all;
//! - retry: [`upstream::post_once`] is called once per client request, on every failure;
//! - fall back: there is one gateway, from the environment, and no other destination exists.
//!
//! What it must survive, and where that is enforced: connections that stop sending, or never stop
//! arriving. The front door is hyper 1.x, HTTP/1 only, on tokio ([`serve`]), and what hyper does
//! not do is done here, in [`Relay::handle`] and [`Limits`]:
//!
//! - **An idle connection costs a task and a few KiB, not a worker.** `header_read_timeout`
//!   ([`Inbound::head_deadline`]) closes one that does not finish its head, and a total
//!   deadline ([`Inbound::connection_deadline`]) closes anything still open, including a client
//!   that does not read its answer.
//! - **Caps, because they fail differently.** [`Limits::heads`] is large: connections still
//!   reading their head, which cost almost nothing. [`Limits::bodies`] counts requests past their
//!   head (a task each); the memory they can hold (a body up to 2 MiB, an answer up to 16 MiB) is
//!   the byte budget below. A global [`Limits::connections`] bounds the sum. Each count is its own
//!   semaphore.
//!   A connection over the head or global cap is closed at accept without a byte read or written
//!   (an answer per connection would cost what the cap saves); a request over the body cap is
//!   answered 503 without its body being read.
//! - **Memory is counted in bytes, not requests.** What a body costs is what has arrived, so the
//!   [`Limits::bodies`] count is large and the real bound is a [`Limits::body_bytes`] budget (64 MiB)
//!   for everything in flight. Bytes are charged as each frame arrives (request body) or is read
//!   back (the gateway's answer). A request body is given back once it has been sent to the
//!   gateway; an answer is kept by the CONNECTION ([`connection`]) and given back only when the
//!   connection is finished, that is, when hyper has written it out or the connection deadline has
//!   cut it. So a client that never reads its answer holds what it was sent, for at most the
//!   connection deadline, and cannot let the process exceed the budget.
//!   Request bodies have a smaller bound inside it: [`Limits::request_bytes`] (32 MiB, half the
//!   budget, so answers keep the other half), [`Limits::per_address_request_bytes`] (2 MiB, one
//!   largest body, per IPv4 address or IPv6 /64) and [`Limits::per_prefix48_request_bytes`] (4 MiB
//!   per IPv6 /48).
//! - **A body must keep arriving.** Each wait for the next piece has its own short deadline
//!   ([`Inbound::progress_deadline`], 2 s): "declare 2 MiB and send nothing" loses its place after
//!   2 s, not at the 10 s a 2 MiB body is due. A body is also due in proportion to its declared
//!   size ([`Inbound::body_deadline_for`]).
//! - **An address is a /64 for IPv6, and the /64s share their /48.** Every per-address cap here
//!   (flood window, requests in flight, bytes, connections) is keyed by
//!   [`RateKey::address_prefix64`]: a VPS or a home line owns its whole /64, so counting each /128
//!   would hand an attacker 2^64 addresses. Above it, the bodies and the request bytes of one /48
//!   are bounded together ([`Limits::per_prefix48`], 16 body slots; [`RateKey::address_prefix48`]),
//!   because a tunnel broker hands out 65,536 /64s. IPv4 has nothing above the address and is
//!   bounded per address only. The other servers still key by exact address; see that function's
//!   note.
//!
//! # What it takes to deny service now (the bound, defaults, 2026-11-15)
//!
//! A relay that has no client identity cannot stop an attacker with enough addresses. These are
//! the numbers, per way of doing it (an address is an IPv4 address or an IPv6 /64). "Measured"
//! names a test; the rest is computed from the limits:
//!
//! - **Request bytes** (a measured probe): 16 addresses, one 2 MiB body each, 32 MiB held for the
//!   10 s a body is due, about 27 Mbit/s sustained (measured: 15 addresses leave room, 16 do not). Answers keep their half of the budget meanwhile.
//! - **Body slots** (declared bodies, no bandwidth): [`Limits::bodies`] is 2048, one address holds
//!   8 and one IPv6 /48 holds 16, so 128 /48s or 256 IPv4 addresses, each renewing every 2 s (the
//!   progress window): a few hundred connections a second, almost no bandwidth (was one /56 or 64
//!   IPv4 addresses).
//! - **Head slots** (a head that never ends): [`Limits::heads`] is 2048 held for 2 s; with no proxy
//!   declared, 32 addresses at 64 connections each (the per-socket cap); behind a proxy that cap is
//!   the proxy's to apply.
//! - **A drip**: one byte every 1.9 s holds a body slot for the body's whole due time (up to 10 s),
//!   not 2 s, at the same per-address and per-/48 caps: the connection rate the body-slot count
//!   needs is a fifth of what it is for a body that sends nothing.
//! - **Answers**: only as large as the gateway sends; an unread answer holds its bytes for at most
//!   the 14 s connection deadline, against the same 64 MiB. Two concurrent 16 MiB answers from one
//!   address are refused (24 MiB per address).
//!
//! What this costs a legitimate client: a request is at most 2 MiB at one address and a
//! second concurrent large request from the same /64 is refused 503 while the first is in
//! flight; a /48 (an office, a tunnel) shares 16 requests and 4 MiB of request bytes; a 16 MiB
//! answer needs 18 MiB free for its address and the budget at the time.
//!
//! **What this does not do, on purpose:** it does not stop the distributed case. Those counts are
//! what an attacker with that many addresses spends; to go beyond them takes tokens (not built here:
//! a client identity the relay can count without learning who it is) together with the operator's
//! proxy (connection and rate limits at the edge, which sees the real addresses). Raising these
//! numbers here would only move the bound, at a memory cost.
//! - **Per address, on every path.** The flood window ([`DEFAULT_FLOOD_MAX`] per
//!   [`FLOOD_WINDOW_SECS`]) and the requests in flight ([`Limits::per_address`]) are checked right
//!   after the head, for every method and path: a flood of `GET /nope` is a flood. Connections per
//!   socket address ([`Limits::per_peer_connections`]) are checked at accept, before any byte is
//!   read, but only when no proxy is declared in front: behind one, the socket address is the
//!   proxy's and the real client address is known only from its head.
//! - **A panic in one connection stays in its task** ([`spawn_isolated`]).
//!
//! It acts on the request line, the headers it needs, and a `Content-Length` body, and nothing
//! else: no keep-alive, no upgrade, no chunked body, no `Expect`, no pipelining (the connection is
//! closed after its one answer).

pub mod upstream;

use std::collections::HashMap;
use std::convert::Infallible;
use std::future::Future;
use std::net::{IpAddr, TcpListener};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use http_body_util::{BodyExt, Full};
use hyper::body::{Bytes, Incoming};
use hyper::header::{
    HeaderValue, CONTENT_LENGTH, CONTENT_TYPE, EXPECT, ORIGIN, TRANSFER_ENCODING, VARY,
};
use hyper::{Method, Request, Response, StatusCode};
use hyper_util::rt::{TokioIo, TokioTimer};
use konclave_http::{RateKey, RateLimiter};
use tokio::sync::{OwnedSemaphorePermit, Semaphore};
use upstream::{Failure, Gateway, Timeouts, REQUEST_TYPE};

/// The one path the relay serves.
pub const RELAY_PATH: &str = "/relay";

/// The largest request body: the largest bucket of `konclave-ohttp::padding::REQUEST_BUCKETS`
/// (2 MiB), which is also what the coordinator reads from one request (`konclave_http::MAX_BODY`).
/// Copied, not imported, because this binary links no `konclave-ohttp`; the test
/// `the_size_cap_is_the_largest_request_bucket` pins it to the table, and a test in
/// `konclave-ohttp` pins the table to `MAX_BODY`.
pub const MAX_REQUEST_BODY: usize = 2048 * 1024;
/// The largest answer read back: `padding::RESPONSE_MAX` (16 MiB), pinned by the same test.
pub const MAX_ANSWER: usize = 16 * 1024 * 1024;

/// Flood limit per client address.
pub const FLOOD_WINDOW_SECS: i64 = 10;
pub const DEFAULT_FLOOD_MAX: u32 = 60;
const FLOOD_MAX_KEYS: usize = 50_000;

/// What hyper may buffer or accept in a head: at most this many headers, and a 16 KiB buffer (the
/// smallest hyper allows is 8 KiB). A head that does not fit is refused by hyper with a 431 or 400.
pub const MAX_HEADERS: usize = 32;
pub const MAX_HEAD_BUFFER: usize = 16 * 1024;

/// Limits on what a client may take of the relay's time. Defaults: [`Inbound::default`].
#[derive(Debug, Clone, Copy)]
pub struct Inbound {
    /// The most time the request line and headers may take in all, counted from the first byte of
    /// the connection's wait (hyper's `header_read_timeout`, which needs a timer).
    pub head_deadline: Duration,
    /// The most time the body may take in all. An idle timeout alone is beaten by a byte every
    /// few seconds.
    pub body_deadline: Duration,
    /// The longest a body may go without a byte arriving. A body that declares megabytes and sends
    /// nothing loses its place in this, not in `body_deadline`.
    pub progress_deadline: Duration,
    /// A body is due within `body_floor` plus its declared length at `min_body_rate`, and never
    /// later than `body_deadline`: see [`Inbound::body_deadline_for`].
    pub body_floor: Duration,
    /// The slowest rate, in bytes per second, at which a body is worth holding a place for.
    pub min_body_rate: u64,
    /// The most time a connection may stay open in all, whatever it is doing: the head, the body,
    /// the gateway, and writing the answer. Under what the browser client waits.
    pub connection_deadline: Duration,
}

impl Inbound {
    /// When a body of `len` declared bytes is due: a floor, plus the time the minimum rate needs
    /// for `len`, capped at the flat deadline. A 1 KiB body is due in about two seconds; the
    /// largest (2 MiB) in about ten.
    pub fn body_deadline_for(&self, len: usize) -> Duration {
        let rate = self.min_body_rate.max(1);
        let transfer = Duration::from_millis((len as u64).saturating_mul(1000) / rate);
        (self.body_floor + transfer).min(self.body_deadline)
    }
}

impl Default for Inbound {
    fn default() -> Self {
        Self {
            head_deadline: Duration::from_secs(2),
            body_deadline: Duration::from_secs(10),
            progress_deadline: Duration::from_secs(2),
            body_floor: Duration::from_secs(2),
            min_body_rate: 256 * 1024,
            connection_deadline: Duration::from_secs(14),
        }
    }
}

/// The caps on what may be open at once. See the module docs for why there are four, and what each
/// one is for.
#[derive(Debug, Clone, Copy)]
pub struct Limits {
    /// Connections open at once, in any state.
    pub connections: usize,
    /// Connections still reading their head. Large: each costs a task and a small buffer.
    pub heads: usize,
    /// Requests past their head, reading a body or waiting for the gateway. A count, and not what
    /// bounds memory (`body_bytes` does): this bounds only the tasks that wait on the gateway.
    pub bodies: usize,
    /// Requests past their head that one client address may have at once.
    pub per_address: usize,
    /// Requests past their head that one IPv6 /48 may have at once, whatever /64s they come from.
    /// IPv4 has no level above the address, so this does not apply to it.
    pub per_prefix48: usize,
    /// Connections one socket address may hold open. Applied only when no proxy is declared in
    /// front of the relay (`KONCLAVE_TRUSTED_PROXY_HOPS=0` or unset in a test): behind a proxy the
    /// socket address is the proxy's.
    pub per_peer_connections: usize,
    /// Bytes of bodies in flight at once, request and answer together, across every client.
    pub body_bytes: usize,
    /// The share of `body_bytes` one client address (an IPv6 /64) may hold. At least one largest
    /// exchange (a 2 MiB request and a 16 MiB answer), or the largest legitimate answer would be
    /// refused.
    pub per_address_bytes: usize,
    /// The part of `body_bytes` that REQUEST bodies may hold, across every client. The rest is
    /// reserved for answers already being read, so a flood of declared bodies cannot take the room
    /// an answer needs.
    pub request_bytes: usize,
    /// The request-body bytes one client address (an IPv6 /64) may hold: one largest body.
    pub per_address_request_bytes: usize,
    /// The request-body bytes one IPv6 /48 may hold.
    pub per_prefix48_request_bytes: usize,
}

impl Default for Limits {
    fn default() -> Self {
        Self {
            connections: 4096,
            heads: 2048,
            bodies: 2048,
            per_address: 8,
            per_prefix48: 16,
            per_peer_connections: 64,
            body_bytes: 64 * 1024 * 1024,
            per_address_bytes: 24 * 1024 * 1024,
            request_bytes: 32 * 1024 * 1024,
            per_address_request_bytes: MAX_REQUEST_BODY,
            per_prefix48_request_bytes: 2 * MAX_REQUEST_BODY,
        }
    }
}

/// The boot rule for the address setting. A relay run by someone else sits behind a platform proxy
/// of THEIR choosing, and which `X-Forwarded-For` value names the client is a fact about that
/// platform: the default (the first hop) is a value the client writes, which turns the flood limit
/// into one the client sets. So there is no default: the operator says it, `0` meaning no proxy.
///
/// The number is read by `konclave_http::require_trusted_hops`, which is built on the parser the
/// other servers boot with. There is no second copy of the rule here.
pub fn require_hops_choice(value: Option<&std::ffi::OsStr>) -> Result<(), String> {
    konclave_http::require_trusted_hops(value).map(|_| ())
}

/// `Access-Control-Max-Age`, seconds: a preflight is cached, so a poll loop does not double its
/// requests.
pub const CORS_MAX_AGE: &str = "86400";

pub struct Config {
    pub gateway: Gateway,
    /// Origins allowed to read an answer. An exact-match list; empty means no browser may.
    pub allowed_origins: Vec<String>,
    pub flood_max: u32,
    pub timeouts: Timeouts,
    pub limits: Limits,
    pub inbound: Inbound,
}

pub struct Relay {
    pub config: Config,
    limiter: RateLimiter,
    /// Requests past their head, by client address.
    in_flight: Arc<InFlight>,
    /// Requests past their head, by IPv6 /48.
    prefixes: Arc<InFlight>,
    /// Connections, by socket address.
    peers: Arc<InFlight>,
    connections: Arc<Semaphore>,
    heads: Arc<Semaphore>,
    bodies: Arc<Semaphore>,
    bytes: Arc<ByteBudget>,
}

/// The key every per-address cap of the relay uses: an IPv4 address, or an IPv6 /64. One function,
/// so the flood window, the requests in flight, the bytes and the connections cannot disagree
/// about who is one client.
fn client_key(addr: &konclave_http::ClientAddress) -> RateKey {
    RateKey::address_prefix64(addr)
}

/// Bytes of bodies in flight, in all and per client. Charged as bytes arrive. A request body is
/// given back when it has been sent to the gateway; an answer is held until the connection that
/// carries it is finished (see [`ByteGuard`] and [`connection`]).
struct ByteBudget {
    limits: Limits,
    state: Mutex<BudgetState>,
}

#[derive(Default)]
struct BudgetState {
    used: usize,
    /// The part of `used` that is request bodies.
    request_used: usize,
    /// Per /64 or IPv4: (all bytes, request bytes).
    by_key: HashMap<RateKey, (usize, usize)>,
    /// Per IPv6 /48: request bytes.
    by_prefix: HashMap<RateKey, usize>,
}

/// What a charge is for. A request body has its own, smaller shares; an answer is bounded by the
/// whole budget and the client's overall share.
#[derive(Clone, Copy, PartialEq)]
enum Charge {
    Request,
    Answer,
}

impl ByteBudget {
    fn new(limits: Limits) -> Arc<Self> {
        Arc::new(Self {
            limits,
            state: Mutex::default(),
        })
    }

    fn guard(self: &Arc<Self>, key: RateKey, prefix: Option<RateKey>) -> ByteGuard {
        ByteGuard {
            budget: self.clone(),
            key,
            prefix,
            held: Mutex::new((0, 0)),
        }
    }

    fn lock(&self) -> std::sync::MutexGuard<'_, BudgetState> {
        self.state
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
    }
}

/// What one request holds of the [`ByteBudget`]. Dropping it gives back what is left. It is not
/// dropped with the answer body but kept by the connection (see [`connection`]), so what an
/// answer holds is counted until the connection is done with it.
struct ByteGuard {
    budget: Arc<ByteBudget>,
    key: RateKey,
    prefix: Option<RateKey>,
    /// (request bytes, answer bytes) held by this guard.
    held: Mutex<(usize, usize)>,
}

impl ByteGuard {
    /// Take `n` more bytes, or none: false when a budget or this client's share is full.
    fn charge(&self, n: usize, kind: Charge) -> bool {
        let l = self.budget.limits;
        let mut st = self.budget.lock();
        let (mine, mine_req) = st.by_key.get(&self.key).copied().unwrap_or((0, 0));
        if st.used.saturating_add(n) > l.body_bytes || mine.saturating_add(n) > l.per_address_bytes
        {
            return false;
        }
        if kind == Charge::Request {
            let prefix_req = self
                .prefix
                .as_ref()
                .and_then(|k| st.by_prefix.get(k).copied())
                .unwrap_or(0);
            if st.request_used.saturating_add(n) > l.request_bytes
                || mine_req.saturating_add(n) > l.per_address_request_bytes
                || (self.prefix.is_some()
                    && prefix_req.saturating_add(n) > l.per_prefix48_request_bytes)
            {
                return false;
            }
            st.request_used += n;
            st.by_key.entry(self.key.clone()).or_default().1 += n;
            if let Some(k) = &self.prefix {
                *st.by_prefix.entry(k.clone()).or_insert(0) += n;
            }
        } else {
            st.by_key.entry(self.key.clone()).or_default();
        }
        st.used += n;
        st.by_key.entry(self.key.clone()).or_default().0 += n;
        let mut h = self
            .held
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        match kind {
            Charge::Request => h.0 += n,
            Charge::Answer => h.1 += n,
        }
        true
    }

    /// Give back up to `req` request bytes and `ans` answer bytes of what this holds.
    fn give_back(&self, req: usize, ans: usize) {
        let (req, ans) = {
            let mut h = self
                .held
                .lock()
                .unwrap_or_else(std::sync::PoisonError::into_inner);
            let r = req.min(h.0);
            let a = ans.min(h.1);
            h.0 -= r;
            h.1 -= a;
            (r, a)
        };
        if req + ans == 0 {
            return;
        }
        let mut st = self.budget.lock();
        st.used = st.used.saturating_sub(req + ans);
        st.request_used = st.request_used.saturating_sub(req);
        if let Some(v) = st.by_key.get_mut(&self.key) {
            v.0 = v.0.saturating_sub(req + ans);
            v.1 = v.1.saturating_sub(req);
            if v.0 == 0 {
                st.by_key.remove(&self.key);
            }
        }
        if let Some(k) = &self.prefix {
            if let Some(v) = st.by_prefix.get_mut(k) {
                *v = v.saturating_sub(req);
                if *v == 0 {
                    st.by_prefix.remove(k);
                }
            }
        }
    }

    /// Give back every request byte: the request has been sent (or failed).
    fn release_request(&self) {
        let r = self
            .held
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .0;
        self.give_back(r, 0);
    }
}

impl Drop for ByteGuard {
    fn drop(&mut self) {
        self.give_back(usize::MAX, usize::MAX);
    }
}

/// How many of something each address has open right now.
#[derive(Default)]
struct InFlight(Mutex<HashMap<RateKey, usize>>);

struct Slot {
    map: Arc<InFlight>,
    key: RateKey,
}

impl InFlight {
    fn enter(self: &Arc<Self>, key: RateKey, cap: usize) -> Option<Slot> {
        let mut m = self
            .0
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        let n = m.entry(key.clone()).or_insert(0);
        if *n >= cap {
            return None;
        }
        *n += 1;
        Some(Slot {
            map: self.clone(),
            key,
        })
    }
}

impl Drop for Slot {
    fn drop(&mut self) {
        let mut m = self
            .map
            .0
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        if let Some(n) = m.get_mut(&self.key) {
            *n -= 1;
            if *n == 0 {
                m.remove(&self.key);
            }
        }
    }
}

/// The typed refusal bodies. Fixed strings: a refusal never echoes anything of the request.
mod err {
    pub const NOT_FOUND: &str = r#"{"error":"not_found"}"#;
    pub const METHOD: &str = r#"{"error":"method_not_allowed"}"#;
    pub const CONTENT_TYPE: &str = r#"{"error":"unsupported_content_type"}"#;
    pub const LENGTH_REQUIRED: &str = r#"{"error":"length_required"}"#;
    pub const TOO_LARGE: &str = r#"{"error":"request_too_large"}"#;
    pub const EMPTY: &str = r#"{"error":"empty_body"}"#;
    pub const BAD_BODY: &str = r#"{"error":"bad_body"}"#;
    pub const EXPECT: &str = r#"{"error":"expectation_failed"}"#;
    pub const SLOW: &str = r#"{"error":"request_timeout"}"#;
    pub const FLOOD: &str = r#"{"error":"too_many_requests"}"#;
    pub const BUSY: &str = r#"{"error":"relay_busy"}"#;
    pub const UNREACHABLE: &str = r#"{"error":"gateway_unreachable"}"#;
    pub const TIMEOUT: &str = r#"{"error":"gateway_timeout"}"#;
    pub const CUT: &str = r#"{"error":"gateway_cut"}"#;
    pub const BAD_ANSWER: &str = r#"{"error":"gateway_bad_answer"}"#;
}

struct Out {
    status: u16,
    content_type: String,
    body: Vec<u8>,
}

fn refuse(status: u16, body: &str) -> Out {
    Out {
        status,
        content_type: "application/json".to_string(),
        body: body.as_bytes().to_vec(),
    }
}

fn now_secs() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map_or(0, |d| d.as_secs() as i64)
}

/// A request's `Content-Length`: exactly one header, only ASCII digits, at most ten of them.
/// Anything else is "no length": `+5`, `5, 5`, `0x5`, a repeat (equal or not), an empty value.
fn plain_length(headers: &hyper::HeaderMap) -> Option<usize> {
    let mut all = headers.get_all(CONTENT_LENGTH).iter();
    let (Some(one), None) = (all.next(), all.next()) else {
        return None;
    };
    let digits = one.as_bytes();
    if digits.is_empty() || digits.len() > 10 || !digits.iter().all(u8::is_ascii_digit) {
        return None;
    }
    std::str::from_utf8(digits).ok()?.parse().ok()
}

/// What the head of a request decides, before any body is read.
enum Head {
    /// Refused or answered on the head alone. `drain`: the client may still be sending a body, and
    /// closing on unread data makes the OS reset the connection, which can destroy the answer
    /// before the client reads it, so a little of it is read first.
    Answered {
        out: Out,
        preflight: bool,
        drain: bool,
    },
    /// A `POST /relay` of this many body bytes. The slot is the address's place among its requests
    /// in flight, held until the answer is made.
    Forward {
        len: usize,
        _slot: Slot,
        _prefix_slot: Option<Slot>,
    },
}

fn answered(status: u16, body: &str) -> Head {
    Head::Answered {
        out: refuse(status, body),
        preflight: false,
        drain: true,
    }
}

/// What a refused request's body may cost: read and thrown away, frame by frame and never kept,
/// for at most this long and this many bytes. Not charged to the byte budget, because nothing is
/// held.
const DRAIN_MAX_BYTES: usize = 64 * 1024;
const DRAIN_MAX_TIME: Duration = Duration::from_millis(200);

/// Read and drop what is left of a body: at most [`DRAIN_MAX_BYTES`] and [`DRAIN_MAX_TIME`].
async fn drain(mut body: Incoming) {
    let _ = tokio::time::timeout(DRAIN_MAX_TIME, async {
        let mut seen = 0usize;
        while let Some(Ok(frame)) = body.frame().await {
            seen += frame.data_ref().map_or(0, Bytes::len);
            if seen >= DRAIN_MAX_BYTES {
                break;
            }
        }
    })
    .await;
}

impl Relay {
    pub fn new(config: Config) -> Self {
        let l = config.limits;
        Self {
            config,
            limiter: RateLimiter::new(FLOOD_WINDOW_SECS, FLOOD_MAX_KEYS),
            in_flight: Arc::default(),
            prefixes: Arc::default(),
            peers: Arc::default(),
            connections: Arc::new(Semaphore::new(l.connections)),
            heads: Arc::new(Semaphore::new(l.heads)),
            bodies: Arc::new(Semaphore::new(l.bodies)),
            bytes: ByteBudget::new(l),
        }
    }

    /// One request, from the moment its head is parsed. `peer` is the socket address: it keys the
    /// limiter and goes no further.
    async fn handle(
        &self,
        req: Request<Incoming>,
        peer: IpAddr,
        now: i64,
        keep: &Mutex<Vec<ByteGuard>>,
    ) -> Response<Full<Bytes>> {
        let (parts, body) = req.into_parts();
        let origin = parts
            .headers
            .get(ORIGIN)
            .and_then(|v| v.to_str().ok())
            .map(str::to_string);
        let (len, _slot, prefix_slot) = match self.check_head(&parts, peer, now) {
            Head::Answered {
                out,
                preflight,
                drain: wants_drain,
            } => {
                if wants_drain {
                    drain(body).await;
                }
                return self.respond(out, origin.as_deref(), preflight);
            }
            Head::Forward {
                len,
                _slot,
                _prefix_slot,
            } => (len, _slot, _prefix_slot),
        };
        // The small cap: from here the request can hold megabytes. Refused without reading.
        let Ok(_body_permit) = self.bodies.clone().try_acquire_owned() else {
            drain(body).await;
            return self.respond(refuse(503, err::BUSY), origin.as_deref(), false);
        };
        // The bytes this request holds, from the first one read until its answer is written.
        let guard = self.bytes.guard(
            _slot.key.clone(),
            prefix_slot.as_ref().map(|s| s.key.clone()),
        );
        let out = self.forward(body, len, &guard).await;
        // The guard goes to the connection, which gives it back when the connection is finished:
        // the bytes of the answer count until they have left, not until hyper drops the body.
        keep.lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .push(guard);
        self.respond(out, origin.as_deref(), false)
    }

    /// Everything the head alone decides: the flood limit on EVERY path and method, then routing,
    /// then what the body may be.
    fn check_head(&self, parts: &hyper::http::request::Parts, peer: IpAddr, now: i64) -> Head {
        let xff: Vec<&str> = parts
            .headers
            .get_all("x-forwarded-for")
            .iter()
            .filter_map(|v| v.to_str().ok())
            .collect();
        let peer_text = peer.to_string();
        let addr = konclave_http::request_client_address(xff.iter().copied(), Some(&peer_text));
        let key = client_key(&addr);
        // `Expect` is refused on EVERY path, first of all, before the flood and in-flight answers
        // (those drain, and a read of the body makes hyper answer `100 Continue`, which invites the
        // body it then throws away). A client that sent it is waiting for permission and has sent
        // no body.
        if parts.headers.contains_key(EXPECT) {
            return Head::Answered {
                out: refuse(417, err::EXPECT),
                preflight: false,
                drain: false,
            };
        }
        if !self.limiter.allow(&key, now, self.config.flood_max) {
            return answered(429, err::FLOOD);
        }
        let Some(slot) = self.in_flight.enter(key, self.config.limits.per_address) else {
            return answered(429, err::FLOOD);
        };
        // The second level: the /64s of one /48 share its slots. IPv4 has none above the address.
        let prefix_slot = match RateKey::address_prefix48(&addr) {
            Some(k) => match self.prefixes.enter(k, self.config.limits.per_prefix48) {
                Some(s) => Some(s),
                None => return answered(429, err::FLOOD),
            },
            None => None,
        };
        if parts.method == Method::OPTIONS && parts.uri.path() == RELAY_PATH {
            return Head::Answered {
                out: Out {
                    status: 204,
                    content_type: String::new(),
                    body: Vec::new(),
                },
                preflight: true,
                drain: true,
            };
        }
        if parts.uri.path() != RELAY_PATH {
            return answered(404, err::NOT_FOUND);
        }
        if parts.method != Method::POST {
            return answered(405, err::METHOD);
        }
        let ct_ok = parts
            .headers
            .get(CONTENT_TYPE)
            .and_then(|v| v.to_str().ok())
            .is_some_and(|v| v.eq_ignore_ascii_case(REQUEST_TYPE));
        if !ct_ok {
            return answered(415, err::CONTENT_TYPE);
        }
        // A body of known length, once. Chunked (any Transfer-Encoding), a second length and a
        // length that is not plain digits are all "no length" here.
        let len = if parts.headers.contains_key(TRANSFER_ENCODING) {
            None
        } else {
            plain_length(&parts.headers)
        };
        let Some(len) = len else {
            return answered(411, err::LENGTH_REQUIRED);
        };
        if len > MAX_REQUEST_BODY {
            return answered(413, err::TOO_LARGE);
        }
        if len == 0 {
            return answered(400, err::EMPTY);
        }
        Head::Forward {
            len,
            _slot: slot,
            _prefix_slot: prefix_slot,
        }
    }

    /// Read the body (all of it, within its deadline, charging each frame to the byte budget as it
    /// arrives), then the one attempt at the gateway.
    async fn forward(&self, mut body: Incoming, len: usize, guard: &ByteGuard) -> Out {
        enum Stop {
            Bad,
            Busy,
            Slow,
        }
        let read = async {
            let mut got: Vec<u8> = Vec::new();
            let progress = self.config.inbound.progress_deadline;
            loop {
                // Each wait for the next piece has its own short deadline: a body that has sent
                // nothing for this long is dropped, however much it declared.
                let Ok(next) = tokio::time::timeout(progress, body.frame()).await else {
                    return Err(Stop::Slow);
                };
                let Some(frame) = next else { break };
                let Ok(frame) = frame else {
                    return Err(Stop::Bad);
                };
                if let Ok(data) = frame.into_data() {
                    if got.len() + data.len() > len {
                        return Err(Stop::Bad);
                    }
                    if !guard.charge(data.len(), Charge::Request) {
                        return Err(Stop::Busy);
                    }
                    got.extend_from_slice(&data);
                }
            }
            Ok(got)
        };
        let got = match tokio::time::timeout(self.config.inbound.body_deadline_for(len), read).await
        {
            Err(_) => return refuse(408, err::SLOW),
            Ok(Err(Stop::Slow)) => return refuse(408, err::SLOW),
            Ok(Err(Stop::Bad)) => return refuse(400, err::BAD_BODY),
            Ok(Err(Stop::Busy)) => {
                drain(body).await;
                return refuse(503, err::BUSY);
            }
            Ok(Ok(got)) => got,
        };
        if got.len() != len {
            return refuse(400, err::BAD_BODY);
        }
        // Handed on as it is: no second copy of the body.
        let sealed = Bytes::from(got);
        // ONE attempt. Whatever happens, the client hears it and decides; the relay never tries again.
        let result = upstream::post_once(
            &self.config.gateway,
            sealed,
            self.config.timeouts,
            MAX_ANSWER,
            &|n| guard.charge(n, Charge::Answer),
        )
        .await;
        // The request is sent (or failed): what is still held from here is the answer.
        guard.release_request();
        match result {
            Ok(a) => Out {
                status: a.status,
                content_type: a
                    .content_type
                    .unwrap_or_else(|| "application/octet-stream".to_string()),
                body: a.body,
            },
            // A certificate we refuse is, to the client, a gateway it cannot reach.
            Err(Failure::Unreachable | Failure::Untrusted) => refuse(502, err::UNREACHABLE),
            Err(Failure::Timeout) => refuse(502, err::TIMEOUT),
            Err(Failure::Cut) => refuse(502, err::CUT),
            Err(Failure::BadAnswer) => refuse(502, err::BAD_ANSWER),
            Err(Failure::Busy) => refuse(503, err::BUSY),
        }
    }

    fn respond(&self, out: Out, origin: Option<&str>, preflight: bool) -> Response<Full<Bytes>> {
        let mut resp = Response::new(Full::new(Bytes::from(out.body)));
        *resp.status_mut() = StatusCode::from_u16(out.status).unwrap_or(StatusCode::BAD_GATEWAY);
        let headers = resp.headers_mut();
        if !out.content_type.is_empty() {
            headers.insert(
                CONTENT_TYPE,
                HeaderValue::from_str(&out.content_type)
                    .unwrap_or_else(|_| HeaderValue::from_static("application/octet-stream")),
            );
        }
        for (n, v) in self.cors_headers(origin, preflight) {
            if let Ok(v) = HeaderValue::from_str(&v) {
                headers.insert(n, v);
            }
        }
        resp
    }

    /// Only what CORS needs, and only for a listed origin. An unlisted origin gets no
    /// `Access-Control-*` header, which makes the browser withhold the answer.
    fn cors_headers(&self, origin: Option<&str>, preflight: bool) -> Vec<(&'static str, String)> {
        let Some(origin) = origin.filter(|o| self.config.allowed_origins.iter().any(|a| a == o))
        else {
            return Vec::new();
        };
        let mut h = vec![
            ("access-control-allow-origin", origin.to_string()),
            (VARY.as_str(), "Origin".to_string()),
        ];
        if preflight {
            h.push(("access-control-allow-methods", "POST, OPTIONS".to_string()));
            h.push(("access-control-allow-headers", "Content-Type".to_string()));
            h.push(("access-control-max-age", CORS_MAX_AGE.to_string()));
        }
        h
    }
}

/// Run one connection's work in its own task. A panic in the task ends that task and nothing else:
/// tokio catches it at the task boundary, the connection's permits and slots are released as it
/// unwinds, and the accept loop never sees it. Every connection is started here and nowhere else
/// (a test scans the source for that).
pub fn spawn_isolated<F>(work: F) -> tokio::task::JoinHandle<()>
where
    F: Future<Output = ()> + Send + 'static,
{
    tokio::spawn(work)
}

/// Whether a connection can be told from the next by its socket address: false behind a declared
/// proxy, where every connection arrives from it.
fn peers_are_clients() -> bool {
    !matches!(
        konclave_http::forwarding_rule(),
        konclave_http::ForwardingRule::TrustedHops(n) if n > 0
    )
}

async fn accept_loop(listener: tokio::net::TcpListener, relay: Arc<Relay>) {
    loop {
        let (stream, peer) = match listener.accept().await {
            Ok(x) => x,
            // A full descriptor table or a connection reset before accept: wait, go on. The relay
            // must not stop because one accept failed.
            Err(_) => {
                tokio::time::sleep(Duration::from_millis(20)).await;
                continue;
            }
        };
        let ip = peer.ip();
        let Ok(conn_permit) = relay.connections.clone().try_acquire_owned() else {
            // Over the global cap: closed, unread and unanswered. Writing an answer to every
            // connection of a flood would cost what the cap exists to save.
            continue;
        };
        let peer_slot = if peers_are_clients() {
            match relay.peers.enter(
                client_key(&konclave_http::ClientAddress::from_ip(ip)),
                relay.config.limits.per_peer_connections,
            ) {
                Some(slot) => Some(slot),
                None => continue,
            }
        } else {
            None
        };
        let Ok(head_permit) = relay.heads.clone().try_acquire_owned() else {
            continue;
        };
        let relay = relay.clone();
        spawn_isolated(async move {
            connection(relay, stream, ip, head_permit).await;
            drop((conn_permit, peer_slot));
        });
    }
}

/// Serve one connection to completion: one request, one answer, then it is closed.
async fn connection(
    relay: Arc<Relay>,
    stream: tokio::net::TcpStream,
    peer: IpAddr,
    head_permit: OwnedSemaphorePermit,
) {
    let inb = relay.config.inbound;
    let _ = stream.set_nodelay(true);
    // The head permit goes back the moment the head is parsed, which is when this runs.
    let head_permit = Arc::new(Mutex::new(Some(head_permit)));
    let svc_relay = relay.clone();
    // What this connection's request holds of the byte budget, kept until the connection is
    // finished: written to the client, or cut by the deadline.
    let keep: Arc<Mutex<Vec<ByteGuard>>> = Arc::default();
    let svc_keep = keep.clone();
    let service = hyper::service::service_fn(move |req: Request<Incoming>| {
        let relay = svc_relay.clone();
        let head_permit = head_permit.clone();
        let keep = svc_keep.clone();
        async move {
            drop(
                head_permit
                    .lock()
                    .unwrap_or_else(std::sync::PoisonError::into_inner)
                    .take(),
            );
            Ok::<_, Infallible>(relay.handle(req, peer, now_secs(), &keep).await)
        }
    });
    let conn = hyper::server::conn::http1::Builder::new()
        .timer(TokioTimer::new())
        .header_read_timeout(inb.head_deadline)
        .keep_alive(false)
        .half_close(false)
        .max_headers(MAX_HEADERS)
        .max_buf_size(MAX_HEAD_BUFFER)
        .serve_connection(TokioIo::new(stream), service);
    // No `with_upgrades()`: an upgrade is never offered. The whole connection is bounded too, so a
    // client that does not read its answer cannot hold the connection or its permits.
    let _ = tokio::time::timeout(inb.connection_deadline, conn).await;
    // Only here, with the connection over, do the bytes go back.
    drop(keep);
}

/// Serve on `listener` until the process ends, on a runtime of `threads` threads (at least two: a
/// handshake or a slow gateway on one thread must not stop the rest). Blocks the calling thread.
///
/// When the gateway's name is not an address, its addresses are refreshed every
/// [`upstream::DNS_REFRESH`] on a blocking thread, off every request.
pub fn serve(listener: TcpListener, relay: Arc<Relay>, threads: usize) {
    let rt = match tokio::runtime::Builder::new_multi_thread()
        .worker_threads(threads.clamp(2, 32))
        .enable_all()
        .build()
    {
        Ok(rt) => rt,
        Err(e) => {
            eprintln!("konclave ohttp relay: cannot start the runtime: {e}");
            std::process::exit(2);
        }
    };
    rt.block_on(async move {
        if listener.set_nonblocking(true).is_err() {
            eprintln!("konclave ohttp relay: cannot use the listener");
            std::process::exit(2);
        }
        let Ok(listener) = tokio::net::TcpListener::from_std(listener) else {
            eprintln!("konclave ohttp relay: cannot use the listener");
            std::process::exit(2);
        };
        if !relay.config.gateway.host_is_address() {
            let gateway = relay.config.gateway.clone();
            tokio::spawn(async move {
                loop {
                    tokio::time::sleep(upstream::DNS_REFRESH).await;
                    let gw = gateway.clone();
                    // A failed refresh keeps the addresses already held.
                    let _ = tokio::task::spawn_blocking(move || gw.resolve()).await;
                }
            });
        }
        accept_loop(listener, relay).await;
    });
}

/// Parse a comma-separated origin list. An entry that is not `scheme://host[:port]` is refused: a
/// typo must stop the boot, not widen or silently narrow the list.
pub fn parse_origins(list: &str) -> Result<Vec<String>, String> {
    list.split(',')
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(|o| {
            let ok = (o.starts_with("https://") || o.starts_with("http://"))
                && !o.ends_with('/')
                && !o.contains(['*', ' ', '\r', '\n'])
                && o.matches("://").count() == 1;
            if ok {
                Ok(o.to_string())
            } else {
                Err(format!(
                    "not an origin (scheme://host[:port], no wildcard): {o}"
                ))
            }
        })
        .collect()
}
