//! Konclave — the blind mailbox relay, standalone and PUBLIC.
//!
//! This is the hosted counterpart of `orchestrator/src/relay.rs`: the same in-memory,
//! opaque-message room mailbox, but bound on `0.0.0.0` with permissive CORS so browsers on
//! `konclave.app` (any origin) can reach it for multi-device DKG/signing ceremonies. It is
//! blind by construction — it forwards public/encrypted bytes it cannot read and holds no key.
//!
//! Public by design, so there is NO Host gate and NO session token here (unlike the loopback
//! bridge). Honest limits for a demo relay: rooms/messages are capped and TTL-evicted, but the
//! presence map is not pruned and there is no rate limiting — hardening tracked before any
//! serious use. It moves nothing but ciphertext/public FROST material between peers.

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
}

#[derive(Default)]
struct RelayState {
    rooms: Mutex<HashMap<String, Room>>,
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
    ) -> (u16, String) {
        let Some(room_id) = path.strip_prefix("/api/relay/") else {
            return (404, r#"{"error":"not found"}"#.into());
        };
        if room_id.is_empty() || room_id.contains('/') || room_id.len() > 128 {
            return (400, r#"{"error":"bad room id"}"#.into());
        }
        match *method {
            Method::Post => self.post(room_id, body, now),
            Method::Get | Method::Head => self.get(room_id, raw, now),
            _ => (405, r#"{"error":"method not allowed"}"#.into()),
        }
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
            state.handle(&method, &path, &url, &buf, now_unix())
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
