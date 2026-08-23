//! Konclave - the blind mailbox relay, standalone and PUBLIC.
//!
//! This is the hosted counterpart of `orchestrator/src/relay.rs`: the same in-memory,
//! opaque-message room mailbox, but bound on `0.0.0.0` with permissive CORS so browsers on
//! `konclave.app` (any origin) can reach it for multi-device DKG/signing ceremonies. It is
//! blind by construction - it forwards public/encrypted bytes it cannot read and holds no key.
//!
//! Public by design, so there is NO Host gate and NO session token here (unlike the loopback
//! bridge). Hardening in place for a public relay: rooms/messages are capped and TTL-evicted,
//! the presence map is pruned (stale `from` tags dropped past `PRESENCE_TTL`), and a
//! dependency-free fixed-window rate limiter refuses floods with `429` - keyed BOTH per client IP
//! (robust: a flooding source cannot cheaply change it) and per `from`/room key (#64). It moves
//! nothing but ciphertext/public FROST material between peers.

use std::collections::HashMap;
use std::io::Read;
use std::sync::Mutex;
use std::time::{SystemTime, UNIX_EPOCH};

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
// (a `from` tag, or the room id when a poll carries none). Generous - a real short-poll
// ceremony sends a couple of requests per second, well under this - it only refuses floods.
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

#[derive(Default)]
struct RelayState {
    rooms: Mutex<HashMap<String, Room>>,
    // Source key -> (window_start_unix, count_in_window). A fixed-window flood limiter.
    limiter: Mutex<HashMap<String, (i64, u32)>>,
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
        ip: &str,
    ) -> (u16, String) {
        let Some(room_id) = path.strip_prefix("/api/relay/") else {
            return (404, r#"{"error":"not found"}"#.into());
        };
        if room_id.is_empty() || room_id.contains('/') || room_id.len() > 128 {
            return (400, r#"{"error":"bad room id"}"#.into());
        }
        // Per-IP flood check FIRST (robust: the client cannot cheaply change its IP), so a source
        // rotating `from` tags to dodge the per-key limit below is still capped. `ip:` namespaces
        // the key so it never collides with a `from`/room key in the same map.
        if !self.rate_ok(&format!("ip:{ip}"), now, RATE_MAX_IP) {
            return (429, r#"{"error":"rate limited"}"#.into());
        }
        match *method {
            Method::Post => self.post(room_id, body, now),
            Method::Get | Method::Head => self.get(room_id, raw, now),
            _ => (405, r#"{"error":"method not allowed"}"#.into()),
        }
    }

    /// Fixed-window per-key rate check. Returns `true` if the request is within budget.
    /// O(1) amortized; the key map is pruned of stale windows only when it grows large.
    fn rate_ok(&self, key: &str, now: i64, max: u32) -> bool {
        let mut lim = self.limiter.lock().unwrap_or_else(|e| e.into_inner());
        if lim.len() > MAX_RATE_KEYS {
            lim.retain(|_, (start, _)| now.saturating_sub(*start) < RATE_WINDOW);
        }
        let entry = lim.entry(key.to_string()).or_insert((now, 0));
        if now.saturating_sub(entry.0) >= RATE_WINDOW {
            *entry = (now, 0);
        }
        entry.1 += 1;
        entry.1 <= max
    }

    fn post(&self, room_id: &str, body: &[u8], now: i64) -> (u16, String) {
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
        if !self.rate_ok(&req.from, now, RATE_MAX) {
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

    fn get(&self, room_id: &str, raw: &str, now: i64) -> (u16, String) {
        let since: u64 = query(raw, "since")
            .and_then(|s| s.parse().ok())
            .unwrap_or(0);
        let from = query(raw, "from");
        let key = match &from {
            Some(f) if !f.is_empty() => f.as_str(),
            _ => room_id,
        };
        if !self.rate_ok(key, now, RATE_MAX) {
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
            if !f.is_empty() && f.len() <= MAX_FROM {
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
fn client_ip(req: &tiny_http::Request) -> String {
    for h in req.headers() {
        if h.field.equiv("X-Forwarded-For") {
            if let Some(first) = h.value.as_str().split(',').next() {
                let ip = first.trim();
                if !ip.is_empty() {
                    return ip.to_string();
                }
            }
        }
    }
    req.remote_addr()
        .map(|a| a.ip().to_string())
        .unwrap_or_else(|| "unknown".to_string())
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
    let port: u16 = std::env::var("PORT")
        .ok()
        .and_then(|p| p.parse().ok())
        .unwrap_or(8080);
    let addr = format!("0.0.0.0:{port}");
    let server = Server::http(&addr).expect("bind");
    let state = RelayState::default();
    eprintln!("konclave relay listening on {addr}");

    for mut req in server.incoming_requests() {
        let method = req.method().clone();
        let url = req.url().to_string();
        let path = url.split(['?', '#']).next().unwrap_or(&url).to_string();
        let ip = client_ip(&req);

        if method == Method::Options {
            let _ = req.respond(with_cors(Response::empty(204), false));
            continue;
        }

        let (status, body) = if path.starts_with("/api/relay/") {
            let mut buf = Vec::new();
            if req
                .body_length()
                .map(|n| n <= 2 * 1024 * 1024)
                .unwrap_or(true)
            {
                let _ = req.as_reader().read_to_end(&mut buf);
            }
            state.handle(&method, &path, &url, &buf, now_unix(), &ip)
        } else if path == "/" || path == "/health" {
            (
                200,
                r#"{"status":"ok","service":"konclave-relay"}"#.to_string(),
            )
        } else {
            (404, r#"{"error":"not found"}"#.to_string())
        };

        let resp = Response::from_string(body).with_status_code(status);
        let _ = req.respond(with_cors(resp, true));
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn rate_ok_blocks_past_max_then_resets_next_window() {
        let st = RelayState::default();
        let now = 1_000_000;
        // First `max` requests pass; the (max+1)-th in the same window is refused.
        for i in 0..5 {
            assert!(st.rate_ok("k", now, 5), "req {i} should pass");
        }
        assert!(!st.rate_ok("k", now, 5), "6th in-window request is refused");
        // A new window (>= RATE_WINDOW later) resets the counter.
        assert!(st.rate_ok("k", now + RATE_WINDOW, 5), "next window resets");
    }

    #[test]
    fn rate_ok_keys_are_independent() {
        let st = RelayState::default();
        let now = 2_000_000;
        assert!(!(1..=6).all(|_| st.rate_ok("a", now, 5))); // "a" hits its cap
                                                            // A different key (e.g. a per-IP key vs a from key) has its own budget.
        assert!(st.rate_ok("ip:203.0.113.7", now, 5));
    }

    #[test]
    fn per_ip_check_stops_from_tag_rotation() {
        // The point of #64: rotating the `from` tag dodges the per-key limit, but the per-IP key
        // (same ip) keeps counting and eventually refuses. Simulate handle's IP-first check.
        let st = RelayState::default();
        let now = 3_000_000;
        let ip_key = "ip:198.51.100.9";
        let mut refused = false;
        for _ in 0..(RATE_MAX_IP + 10) {
            if !st.rate_ok(ip_key, now, RATE_MAX_IP) {
                refused = true;
                break;
            }
        }
        assert!(
            refused,
            "a single IP is capped regardless of from-tag rotation"
        );
    }
}
