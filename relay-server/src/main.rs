//! Konclave - the blind mailbox relay, standalone and PUBLIC.
//!
//! This is the hosted counterpart of `orchestrator/src/relay.rs`: the same in-memory,
//! opaque-message room mailbox, but bound on `0.0.0.0` with permissive CORS so browsers on
//! `konclave.xyz` (any origin) can reach it for multi-device DKG/signing ceremonies. It is
//! blind by construction - it forwards public/encrypted bytes it cannot read and holds no key.
//!
//! Public by design, so there is NO Host gate and NO session token here (unlike the loopback
//! bridge). Hardening in place for a public relay: rooms/messages are capped and TTL-evicted,
//! the presence map is pruned (stale `from` tags dropped past `PRESENCE_TTL`), and a
//! dependency-free fixed-window rate limiter refuses floods with `429` - keyed BOTH per client IP
//! (robust: a flooding source cannot cheaply change it) and per `from`/room key (#64). It moves
//! nothing but ciphertext/public FROST material between peers.

mod concurrency;

use std::collections::HashMap;
use std::io::Read;
use std::sync::{Arc, Mutex};
use std::time::{SystemTime, UNIX_EPOCH};

use konclave_http::{ClientAddress, RateKey};
use serde::{Deserialize, Serialize};
use tiny_http::{Header, Method, Response, Server};

const MAX_ROOMS: usize = 512;
const MAX_MSGS: usize = 512;
const MAX_DATA: usize = 128 * 1024;
const MAX_FROM: usize = 128;
const ROOM_TTL: i64 = 3600;
const PEER_WINDOW: i64 = 45;
// A member idle longer than this (seconds) is dropped from the presence map so it cannot grow
// without bound. Larger than PEER_WINDOW: the live count already excludes it after 45s; this
// just reclaims the memory once it is long gone.
const PRESENCE_TTL: i64 = 300;
// Fixed-window rate limit: at most RATE_MAX requests per RATE_WINDOW seconds per source key
// (a `from` tag, or the room id when a poll carries none), each one scoped to the client address
// the server attributes to the request. Generous - a real short-poll ceremony sends a couple of
// requests per second, well under this - it only refuses floods.
const RATE_WINDOW: i64 = 10;
const RATE_MAX: u32 = 150;
// Per-IP fixed-window limit (#64). The `from`/room key above is client-controlled (an attacker can
// rotate `from` tags to dodge it), so the robust flood defense keys on the client IP - which a single
// flooding source cannot cheaply change. Higher than RATE_MAX because one IP (behind NAT) may carry
// several legitimate tabs/members; still far below any real flood (thousands/s).
const RATE_MAX_IP: u32 = 300;
// Cap on distinct rate-limit keys tracked at once (stale windows are reclaimed past this).
const MAX_RATE_KEYS: usize = 4096;

#[derive(Clone, Serialize)]
struct Msg {
    seq: u64,
    from: String,
    data: String,
}

struct Room {
    messages: Vec<Msg>,
    next_seq: u64,
    members: HashMap<String, i64>,
    last_active: i64,
}

impl Room {
    fn new(now: i64) -> Room {
        Room {
            messages: Vec::new(),
            next_seq: 1,
            members: HashMap::new(),
            last_active: now,
        }
    }
    fn peers(&self, now: i64) -> usize {
        self.members
            .values()
            .filter(|&&seen| now.saturating_sub(seen) <= PEER_WINDOW)
            .count()
    }
    fn prune_members(&mut self, now: i64) {
        self.members
            .retain(|_, &mut seen| now.saturating_sub(seen) <= PRESENCE_TTL);
    }
}

struct RelayState {
    rooms: Mutex<HashMap<String, Room>>,
    // The fixed-window flood limiter. It was written here and lived here until #558; it is in
    // `konclave-http` now, so the coordinator applies the same rule instead of none.
    limiter: konclave_http::RateLimiter,
}

impl Default for RelayState {
    fn default() -> Self {
        RelayState {
            rooms: Mutex::default(),
            limiter: konclave_http::RateLimiter::new(RATE_WINDOW, MAX_RATE_KEYS),
        }
    }
}

impl RelayState {
    /// Route a `/api/relay/...` request → `(status, json_body)`.
    fn handle(
        &self,
        method: &Method,
        path: &str,
        raw: &str,
        body: &[u8],
        now: i64,
        addr: &ClientAddress,
    ) -> (u16, String) {
        let Some(room_id) = path.strip_prefix("/api/relay/") else {
            return (404, r#"{"error":"not found"}"#.into());
        };
        if room_id.is_empty() || room_id.contains('/') || room_id.len() > 128 {
            return (400, r#"{"error":"bad room id"}"#.into());
        }
        // Per-address flood check FIRST (robust: the client cannot cheaply change its address), so
        // a source rotating `from` tags to dodge the per-sender limit below is still capped. Every
        // key the limiter sees is built by `RateKey` in `konclave-http` and is scoped to the
        // client address the server attributes to the request (`client_address`): a tag or a room
        // id from the request only enters behind a kind prefix and that address, so the three
        // kinds of key are distinct by construction and one address's budgets are never another's.
        if !self
            .limiter
            .allow(&RateKey::address(addr), now, RATE_MAX_IP)
        {
            return (429, r#"{"error":"rate limited"}"#.into());
        }
        match *method {
            Method::Post => self.post(room_id, body, now, addr),
            Method::Get | Method::Head => self.get(room_id, raw, now, addr),
            _ => (405, r#"{"error":"method not allowed"}"#.into()),
        }
    }

    fn post(&self, room_id: &str, body: &[u8], now: i64, addr: &ClientAddress) -> (u16, String) {
        #[derive(Deserialize)]
        struct PostReq {
            from: String,
            data: String,
        }
        let req: PostReq = match serde_json::from_slice(body) {
            Ok(v) => v,
            Err(_) => return (400, r#"{"error":"bad request"}"#.into()),
        };
        if req.from.is_empty() || req.from.len() > MAX_FROM {
            return (400, r#"{"error":"bad from tag"}"#.into());
        }
        if !self
            .limiter
            .allow(&RateKey::sender(&req.from, addr), now, RATE_MAX)
        {
            return (429, r#"{"error":"rate limited"}"#.into());
        }
        if req.data.len() > MAX_DATA {
            return (413, r#"{"error":"message too large"}"#.into());
        }
        let mut rooms = self.rooms.lock().unwrap_or_else(|e| e.into_inner());
        prune(&mut rooms, now);
        let room = rooms
            .entry(room_id.to_string())
            .or_insert_with(|| Room::new(now));
        room.last_active = now;
        room.members.insert(req.from.clone(), now);
        let seq = room.next_seq;
        room.next_seq += 1;
        room.messages.push(Msg {
            seq,
            from: req.from,
            data: req.data,
        });
        if room.messages.len() > MAX_MSGS {
            let drop = room.messages.len() - MAX_MSGS;
            room.messages.drain(0..drop);
        }
        let peers = room.peers(now);
        (
            200,
            serde_json::json!({ "seq": seq, "peers": peers }).to_string(),
        )
    }

    fn get(&self, room_id: &str, raw: &str, now: i64, addr: &ClientAddress) -> (u16, String) {
        let since: u64 = query(raw, "since")
            .and_then(|s| s.parse().ok())
            .unwrap_or(0);
        let from = query(raw, "from");
        // The same tag limit a post has, applied before any sender or room key is built.
        if from.as_ref().is_some_and(|f| f.len() > MAX_FROM) {
            return (400, r#"{"error":"bad from tag"}"#.into());
        }
        let key = match &from {
            Some(f) if !f.is_empty() => RateKey::sender(f, addr),
            _ => RateKey::room(room_id, addr),
        };
        if !self.limiter.allow(&key, now, RATE_MAX) {
            return (429, r#"{"error":"rate limited"}"#.into());
        }
        let mut rooms = self.rooms.lock().unwrap_or_else(|e| e.into_inner());
        prune(&mut rooms, now);
        let Some(room) = rooms.get_mut(room_id) else {
            return (
                200,
                serde_json::json!({ "messages": [], "next": since, "peers": 0 }).to_string(),
            );
        };
        room.last_active = now;
        if let Some(f) = from {
            if !f.is_empty() {
                room.members.insert(f, now);
            }
        }
        let msgs: Vec<&Msg> = room.messages.iter().filter(|m| m.seq > since).collect();
        let next = room.messages.last().map(|m| m.seq).unwrap_or(since);
        let peers = room.peers(now);
        (
            200,
            serde_json::json!({ "messages": msgs, "next": next, "peers": peers }).to_string(),
        )
    }
}

fn prune(rooms: &mut HashMap<String, Room>, now: i64) {
    rooms.retain(|_, r| now.saturating_sub(r.last_active) <= ROOM_TTL);
    for r in rooms.values_mut() {
        r.prune_members(now);
    }
    while rooms.len() > MAX_ROOMS {
        if let Some(oldest) = rooms
            .iter()
            .min_by_key(|(_, r)| r.last_active)
            .map(|(k, _)| k.clone())
        {
            rooms.remove(&oldest);
        } else {
            break;
        }
    }
}

fn query(raw: &str, key: &str) -> Option<String> {
    let q = raw.split('?').nth(1)?;
    let q = q.split('#').next().unwrap_or(q);
    q.split('&').find_map(|pair| {
        let mut it = pair.splitn(2, '=');
        (it.next() == Some(key)).then(|| it.next().unwrap_or("").to_string())
    })
}

/// The client's IP for rate limiting. Behind Railway's proxy `remote_addr` is the proxy, so prefer
/// the first hop of `X-Forwarded-For` (the real client); fall back to `remote_addr` for a direct
/// connection. An attacker can spoof XFF only if they bypass the proxy, which the platform prevents.
fn client_ip(req: &tiny_http::Request) -> ClientAddress {
    let remote = req.remote_addr().map(|a| a.ip().to_string());
    konclave_http::client_address(
        req.headers()
            .iter()
            .filter(|h| h.field.equiv("X-Forwarded-For"))
            .map(|h| h.value.as_str()),
        remote.as_deref(),
    )
}

fn now_unix() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs() as i64)
        .unwrap_or(0)
}

fn header(k: &str, v: &str) -> Header {
    Header::from_bytes(k.as_bytes(), v.as_bytes()).expect("valid header")
}

fn with_cors<R: Read>(mut resp: Response<R>, json: bool) -> Response<R> {
    resp.add_header(header("Access-Control-Allow-Origin", "*"));
    resp.add_header(header("Access-Control-Allow-Methods", "GET, POST, OPTIONS"));
    resp.add_header(header(
        "Access-Control-Allow-Headers",
        "Content-Type, X-Konclave-Session",
    ));
    if json {
        resp.add_header(header("Content-Type", "application/json; charset=utf-8"));
    }
    resp
}

fn main() {
    // `relay-server --digest` prints the same value `/health` reports, so checking what production
    // runs is: build this crate, run it with the flag, compare to the live endpoint. One
    // implementation, read two ways. A second copy of the hashing in a script would be the exact
    // shape of defect this repo keeps finding - one rule, two implementations, one of them stale.
    if std::env::args().any(|a| a == "--digest") {
        println!("{}", env!("KONCLAVE_SOURCE_DIGEST"));
        return;
    }
    let port: u16 = std::env::var("PORT")
        .ok()
        .and_then(|p| p.parse().ok())
        .unwrap_or(8080);
    let addr = format!("0.0.0.0:{port}");
    let server = Server::http(&addr).expect("bind");
    let state = RelayState::default();
    eprintln!("konclave relay listening on {addr}");

    // A worker pool, not a single-threaded loop: one connection that dribbles a slow body ties one
    // worker, not the whole relay. The single-threaded loop was a full outage from one IP with no
    // flood (#390) - the same shape as the helper's #375, fixed there in #384. The relay's state is
    // behind Mutexes, so it shares across workers by Arc.
    let state = Arc::new(state);
    let server = Arc::new(server);
    let workers = concurrency::worker_count(
        std::env::var("KONCLAVE_RELAY_WORKERS").ok().as_deref(),
        std::thread::available_parallelism().map_or(1, |n| n.get()),
    );
    eprintln!("konclave relay serving with {workers} worker(s)");

    let mut pool = Vec::with_capacity(workers);
    for _ in 0..workers {
        let (server, state) = (Arc::clone(&server), Arc::clone(&state));
        pool.push(std::thread::spawn(move || loop {
            let Ok(mut req) = server.recv() else { return };
            let method = req.method().clone();
            let url = req.url().to_string();
            let path = url.split(['?', '#']).next().unwrap_or(&url).to_string();
            let addr = client_ip(&req);

            if method == Method::Options {
                let _ = req.respond(with_cors(Response::empty(204), false));
                continue;
            }

            let (status, body) = if path.starts_with("/api/relay/") {
                let mut buf = Vec::new();
                // Read with a hard ceiling - including when there is NO Content-Length, which used
                // to be read unbounded (#390). `take` caps a dribbling or chunked body.
                match konclave_http::body_read_cap(req.body_length().map(|n| n as u64)) {
                    konclave_http::ReadPlan::Read(limit) => {
                        let _ = req.as_reader().take(limit).read_to_end(&mut buf);
                    }
                    konclave_http::ReadPlan::Skip => { /* over the cap: handle an empty body */ }
                }
                state.handle(&method, &path, &url, &buf, now_unix(), &addr)
            } else if path == "/" || path == "/health" {
                // Which sources this relay is running (#522). Not an attestation: whoever can
                // replace the binary can report any digest. It catches a stale deploy, which is the
                // thing that has actually happened here, twice.
                (
                    200,
                    format!(
                        r#"{{"status":"ok","service":"konclave-relay","source_digest":"{}"}}"#,
                        env!("KONCLAVE_SOURCE_DIGEST")
                    ),
                )
            } else {
                (404, r#"{"error":"not found"}"#.to_string())
            };

            let resp = Response::from_string(body).with_status_code(status);
            let _ = req.respond(with_cors(resp, true));
        }));
    }
    for w in pool {
        let _ = w.join();
    }
}

#[cfg(test)]
mod tests {

    // #522. The relay is built by Railway from an uploaded directory, so there is no commit to
    // stamp: no GitHub connection, no RAILWAY_GIT_COMMIT_SHA, and the Dockerfile copies no `.git`.
    // A digest of the sources answers the question better anyway - not "which commit" but "is the
    // running relay built from THIS source" - and needs nothing anyone has to remember at deploy.
    //
    // What this does NOT do is attest anything. Whoever can replace the binary can report any
    // digest. It catches a stale deploy, which is what has actually happened here.
    #[test]
    fn the_relay_says_which_sources_it_was_built_from() {
        let d = env!("KONCLAVE_SOURCE_DIGEST");
        assert_eq!(d.len(), 16, "expected a 16-char FNV-1a digest, got {d:?}");
        assert!(
            d.chars()
                .all(|c| c.is_ascii_hexdigit() && !c.is_ascii_uppercase()),
            "digest must be lowercase hex: {d:?}"
        );
        // All-zero is what a hash of nothing would look like if the build script ever silently
        // stopped reading the files it is supposed to read.
        assert_ne!(d, "0000000000000000", "the build script digested nothing");
    }
    use super::*;

    #[test]
    fn the_limiter_blocks_past_max_then_resets_next_window() {
        let st = RelayState::default();
        let now = 1_000_000;
        let key = RateKey::sender("k", &ADDR_A);
        // First `max` requests pass; the (max+1)-th in the same window is refused.
        for i in 0..5 {
            assert!(st.limiter.allow(&key, now, 5), "req {i} should pass");
        }
        assert!(
            !st.limiter.allow(&key, now, 5),
            "6th in-window request is refused"
        );
        // A new window (>= RATE_WINDOW later) resets the counter.
        assert!(
            st.limiter.allow(&key, now + RATE_WINDOW, 5),
            "next window resets"
        );
    }

    #[test]
    fn limiter_keys_are_independent() {
        let st = RelayState::default();
        let now = 2_000_000;
        let tagged = RateKey::sender("a", &ADDR_A);
        assert!(!(1..=6).all(|_| st.limiter.allow(&tagged, now, 5))); // "a" hits its cap
                                                                      // A different key (the per-address key vs a sender key) has its own budget.
        assert!(st.limiter.allow(&RateKey::address(&ADDR_A), now, 5));
    }

    #[test]
    fn per_ip_check_stops_from_tag_rotation() {
        // The point of #64: rotating the `from` tag dodges the per-sender limit, but the
        // per-address key keeps counting and eventually refuses. Simulate handle's address-first
        // check.
        let st = RelayState::default();
        let now = 3_000_000;
        let addr_key = RateKey::address(&ADDR_B);
        let mut refused = false;
        for _ in 0..(RATE_MAX_IP + 10) {
            if !st.limiter.allow(&addr_key, now, RATE_MAX_IP) {
                refused = true;
                break;
            }
        }
        assert!(
            refused,
            "a single address is capped regardless of from-tag rotation"
        );
    }

    // These tests drive `handle`, the real request path, and not the limiter alone: a limiter test
    // cannot see which keys the callers build.
    const ADDR_A: ClientAddress = ClientAddress::from_ip(std::net::IpAddr::V4(
        std::net::Ipv4Addr::new(203, 0, 113, 7),
    ));
    const ADDR_B: ClientAddress = ClientAddress::from_ip(std::net::IpAddr::V4(
        std::net::Ipv4Addr::new(198, 51, 100, 9),
    ));

    fn poll(
        st: &RelayState,
        room: &str,
        from: Option<&str>,
        now: i64,
        addr: &ClientAddress,
    ) -> u16 {
        let path = format!("/api/relay/{room}");
        let raw = match from {
            Some(f) => format!("{path}?since=0&from={f}"),
            None => format!("{path}?since=0"),
        };
        st.handle(&Method::Get, &path, &raw, b"", now, addr).0
    }

    fn send(st: &RelayState, room: &str, from: &str, now: i64, addr: &ClientAddress) -> u16 {
        let path = format!("/api/relay/{room}");
        let body = serde_json::json!({ "from": from, "data": "x" }).to_string();
        st.handle(&Method::Post, &path, &path, body.as_bytes(), now, addr)
            .0
    }

    #[test]
    fn a_budget_belongs_to_the_address_that_used_it() {
        let st = RelayState::default();
        let now = 4_000_000;
        // One address polls 250 times under one tag: past a single tag's limit, under its own
        // address limit.
        for _ in 0..250 {
            let _ = poll(&st, "room", Some(&format!("ip:{ADDR_A}")), now, &ADDR_B);
        }
        // Another address has its own budgets.
        let refused = (0..60)
            .filter(|_| poll(&st, "room", Some("member-tag"), now, &ADDR_A) == 429)
            .count();
        assert_eq!(refused, 0, "{refused} of 60 requests were refused");
    }

    #[test]
    fn a_tag_budget_belongs_to_the_address_that_used_it() {
        let st = RelayState::default();
        let now = 5_000_000;
        // One tag, used 160 times from one address in a window (the limit is 150).
        for _ in 0..160 {
            let _ = poll(&st, "room", Some("member-tag"), now, &ADDR_B);
        }
        assert_eq!(
            send(&st, "room", "member-tag", now, &ADDR_A),
            200,
            "a post from another address was refused for requests it did not make"
        );
        assert_eq!(
            poll(&st, "room", Some("member-tag"), now, &ADDR_A),
            200,
            "a poll from another address was refused for requests it did not make"
        );
        assert_eq!(
            poll(&st, "room", Some("member-tag"), now, &ADDR_B),
            429,
            "and the address that used the budget is still over it"
        );
    }

    #[test]
    fn a_posted_tag_budget_belongs_to_the_address_that_used_it() {
        let st = RelayState::default();
        let now = 5_100_000;
        for _ in 0..160 {
            let _ = send(&st, "room", "member-tag", now, &ADDR_B);
        }
        assert_eq!(
            send(&st, "room", "member-tag", now, &ADDR_A),
            200,
            "a post from another address was refused for requests it did not make"
        );
        assert_eq!(
            poll(&st, "room", Some("member-tag"), now, &ADDR_A),
            200,
            "a poll from another address was refused for requests it did not make"
        );
        assert_eq!(send(&st, "room", "member-tag", now, &ADDR_B), 429);
    }

    /// A post and a poll under one tag, from one address, are one budget: 100 posts leave 50 polls.
    #[test]
    fn a_post_and_a_poll_under_one_tag_and_address_share_one_budget() {
        let st = RelayState::default();
        let now = 5_200_000;
        for i in 0..100 {
            assert_eq!(
                send(&st, "room", "member-tag", now, &ADDR_B),
                200,
                "post {i}"
            );
        }
        let refused = (0..60)
            .filter(|_| poll(&st, "room", Some("member-tag"), now, &ADDR_B) == 429)
            .count();
        assert_eq!(refused, 10, "{refused} of 60 polls were refused, not 10");
    }

    #[test]
    fn an_untagged_budget_belongs_to_the_address_that_used_it() {
        let st = RelayState::default();
        let now = 6_000_000;
        // An untagged poll is counted per room AND address.
        for _ in 0..160 {
            let _ = poll(&st, "room", None, now, &ADDR_B);
        }
        assert_eq!(
            poll(&st, "room", None, now, &ADDR_A),
            200,
            "an untagged poll was refused for requests another address made"
        );
        assert_eq!(
            poll(&st, "room", None, now, &ADDR_B),
            429,
            "and the address that used the budget is still over it"
        );
    }

    #[test]
    fn untagged_polls_of_two_rooms_have_two_budgets() {
        let st = RelayState::default();
        let now = 6_100_000;
        for _ in 0..160 {
            let _ = poll(&st, "r1", None, now, &ADDR_B);
        }
        assert_eq!(
            poll(&st, "r2", None, now, &ADDR_B),
            200,
            "another room has its own budget"
        );
        assert_eq!(
            poll(&st, "r1", None, now, &ADDR_B),
            429,
            "and the room that was used is over its own"
        );
    }

    /// An empty `from` names no sender, so it is counted like an absent one: per room and address.
    #[test]
    fn an_empty_from_is_counted_per_room_and_address() {
        let st = RelayState::default();
        let now = 6_200_000;
        for _ in 0..160 {
            let _ = poll(&st, "r1", Some(""), now, &ADDR_B);
        }
        assert_eq!(
            poll(&st, "r2", Some(""), now, &ADDR_B),
            200,
            "another room has its own budget"
        );
        assert_eq!(
            poll(&st, "r1", Some(""), now, &ADDR_A),
            200,
            "another address has its own"
        );
        assert_eq!(poll(&st, "r1", Some(""), now, &ADDR_B), 429);
    }

    #[test]
    fn an_empty_and_an_absent_from_share_one_room_budget() {
        let st = RelayState::default();
        let now = 6_300_000;
        assert_eq!(poll(&st, "room", Some(""), now, &ADDR_A), 200);
        assert_eq!(poll(&st, "room", None, now, &ADDR_A), 200);
        assert_eq!(
            st.limiter.tracked(),
            2,
            "the address key and one room key, nothing else"
        );
    }

    #[test]
    fn an_oversized_poll_tag_is_refused() {
        let st = RelayState::default();
        let long = "a".repeat(MAX_FROM + 1);
        assert_eq!(
            poll(&st, "room", Some(&long), 7_000_000, &ADDR_A),
            400,
            "a poll applies the same tag limit as a post, before a sender or room key is built"
        );
    }

    #[test]
    fn a_poll_tag_of_exactly_the_post_limit_is_accepted() {
        let st = RelayState::default();
        let tag = "a".repeat(MAX_FROM);
        assert_eq!(poll(&st, "room", Some(&tag), 7_100_000, &ADDR_A), 200);
        assert_eq!(send(&st, "room", &tag, 7_100_000, &ADDR_A), 200);
    }

    #[test]
    fn an_oversized_poll_tag_creates_no_sender_or_room_key() {
        let st = RelayState::default();
        let long = "a".repeat(MAX_FROM + 1);
        assert_eq!(poll(&st, "room", Some(&long), 7_200_000, &ADDR_A), 400);
        assert_eq!(st.limiter.tracked(), 1, "only the address's own key exists");
    }

    /// The refusal still costs the address a request: the address check runs first.
    #[test]
    fn a_refused_poll_tag_still_counts_against_the_address() {
        let st = RelayState::default();
        let now = 7_300_000;
        let long = "a".repeat(MAX_FROM + 1);
        for i in 0..RATE_MAX_IP {
            assert_eq!(
                poll(&st, "room", Some(&long), now, &ADDR_A),
                400,
                "request {i}"
            );
        }
        assert_eq!(poll(&st, "room", Some("p-1"), now, &ADDR_A), 429);
    }

    // Controls: the fix must not loosen what already worked.
    #[test]
    fn a_member_is_still_limited_by_its_own_budget() {
        let st = RelayState::default();
        let now = 8_000_000;
        for i in 0..RATE_MAX {
            assert_eq!(
                poll(&st, "room", Some("busy"), now, &ADDR_A),
                200,
                "request {i}"
            );
        }
        assert_eq!(poll(&st, "room", Some("busy"), now, &ADDR_A), 429);
    }

    #[test]
    fn a_poster_is_still_limited_by_its_own_budget() {
        let st = RelayState::default();
        let now = 8_100_000;
        for i in 0..RATE_MAX {
            assert_eq!(send(&st, "room", "busy", now, &ADDR_A), 200, "post {i}");
        }
        assert_eq!(send(&st, "room", "busy", now, &ADDR_A), 429);
    }

    /// Posts count against the address too: each of these has a tag of its own, so only the
    /// address limit can refuse the last one.
    #[test]
    fn one_address_is_still_capped_however_many_tags_it_posts_under() {
        let st = RelayState::default();
        let now = 8_200_000;
        for i in 0..RATE_MAX_IP {
            assert_eq!(
                send(&st, "room", &format!("tag-{i}"), now, &ADDR_A),
                200,
                "post {i}"
            );
        }
        assert_eq!(send(&st, "room", "one-more", now, &ADDR_A), 429);
    }

    /// A post whose tag is empty or longer than the limit is refused before a sender key is built,
    /// as a poll's is: the only key left behind is the address's own.
    #[test]
    fn a_post_with_an_empty_or_oversized_from_creates_no_sender_key() {
        let st = RelayState::default();
        let now = 8_300_000;
        assert_eq!(send(&st, "room", "", now, &ADDR_A), 400);
        assert_eq!(st.limiter.tracked(), 1, "only the address's own key exists");
        let long = "a".repeat(MAX_FROM + 1);
        assert_eq!(send(&st, "room", &long, now, &ADDR_A), 400);
        assert_eq!(st.limiter.tracked(), 1, "only the address's own key exists");
    }

    #[test]
    fn one_address_is_still_capped_however_many_tags_it_rotates() {
        let st = RelayState::default();
        let now = 9_000_000;
        let refused = (0..(RATE_MAX_IP + 20))
            .filter(|i| poll(&st, "room", Some(&format!("tag-{i}")), now, &ADDR_B) == 429)
            .count();
        assert!(
            refused > 0,
            "rotating tags must not dodge the per-address cap"
        );
    }
}
