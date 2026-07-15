//! The blind mailbox — Milestone 1 of the konclave.app network.
//!
//! This answers the concrete question "how do three separate devices find each other?".
//! A device posts an **opaque** message into a room; the other devices in that room poll
//! and receive it. The relay **never parses `data`** — it forwards bytes it cannot read.
//! That is exactly what keeps it *blind*: it moves ciphertext and public FROST material
//! between peers and can do nothing with either.
//!
//! Honest about metadata: the relay does see room ids, per-peer `from` tags, message sizes
//! and timing. It sees **nothing** that lets it forge a signature or reconstruct a share.
//! For a hosted relay the `from` tag should be an ephemeral per-session pseudonym (not a
//! real identity), and rooms are short-lived (evicted on TTL below). The presence map is
//! pruned past `PRESENCE_TTL` and a per-source fixed-window rate limiter refuses floods with
//! `429`, so neither grows without bound. This is the same trust model as the Zcash
//! Foundation's `frostd`: a public-material-only coordinator.
//!
//! Transport shape: HTTP short-poll (no new dependency — same `tiny_http` server). A room is
//! an in-memory append-only log of messages with monotonic sequence numbers; a reader asks
//! for everything `since` the last seq it saw. Simple, testable, and trivially hostable as
//! the same handler on `0.0.0.0` when we move past two-tabs-on-one-machine (Milestone 5).

use std::collections::HashMap;
use std::sync::Mutex;

use serde::{Deserialize, Serialize};

use crate::server::Response;

/// Max rooms held at once; the least-recently-active is evicted past this (a public relay
/// must not grow without bound). Generous for a coordination relay — rooms are tiny.
const MAX_ROOMS: usize = 512;
/// Max messages retained per room. A DKG or signing ceremony is a few dozen messages; this
/// leaves ample headroom while capping a single room's memory.
const MAX_MSGS: usize = 512;
/// A message payload cap. Public FROST material and E2E-encrypted DKG packages are small
/// (well under this); the cap just refuses abuse.
const MAX_DATA: usize = 128 * 1024;
/// A `from` tag cap (it is an ephemeral pseudonym, not free-form text).
const MAX_FROM: usize = 128;
/// Rooms idle longer than this (seconds) are dropped on the next access — no background job.
const ROOM_TTL: i64 = 3600;
/// A peer counts as "present" if seen within this window (seconds).
const PEER_WINDOW: i64 = 45;
/// A member entry idle longer than this (seconds) is dropped from the presence map so it
/// cannot grow without bound. Larger than `PEER_WINDOW`: the live count already excludes it
/// after 45s; this just reclaims the memory once it is long gone.
const PRESENCE_TTL: i64 = 300;
/// Fixed-window rate limit: at most `RATE_MAX` requests per `RATE_WINDOW` seconds per source
/// key (a `from` tag, or the room id when a poll carries none). Generous — a real short-poll
/// ceremony sends a couple of requests per second, well under this — it only refuses floods.
const RATE_WINDOW: i64 = 10;
const RATE_MAX: u32 = 150;
/// Cap on distinct rate-limit keys tracked at once (stale windows are reclaimed past this).
const MAX_RATE_KEYS: usize = 4096;

/// One relayed message. `data` is opaque to the relay — it is only ever stored and echoed.
#[derive(Clone, Serialize)]
pub struct Msg {
    pub seq: u64,
    pub from: String,
    pub data: String,
}

struct Room {
    messages: Vec<Msg>,
    next_seq: u64,
    /// `from` tag -> last-seen unix, so we can report how many peers are live in the room.
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
    /// Drop `from` tags not seen within `PRESENCE_TTL` so the map cannot grow without bound.
    fn prune_members(&mut self, now: i64) {
        self.members
            .retain(|_, &mut seen| now.saturating_sub(seen) <= PRESENCE_TTL);
    }
}

/// The relay's whole state: a set of rooms behind one lock. `handle` takes `&self` (interior
/// mutability) so it drops straight into the request dispatch alongside the other handlers.
#[derive(Default)]
pub struct RelayState {
    rooms: Mutex<HashMap<String, Room>>,
    /// Source key -> (window_start_unix, count_in_window). A fixed-window flood limiter.
    limiter: Mutex<HashMap<String, (i64, u32)>>,
}

impl RelayState {
    pub fn new() -> RelayState {
        RelayState::default()
    }

    /// Route a `/api/relay/...` request. `path` is the clean path (no query); `raw_path`
    /// still carries `?since=&from=`. `now` is unix seconds (the caller owns the clock so
    /// this stays pure and testable).
    pub fn handle(
        &self,
        method: &str,
        path: &str,
        raw_path: &str,
        body: &[u8],
        now: i64,
    ) -> Response {
        let Some(room_id) = path.strip_prefix("/api/relay/") else {
            return json(404, serde_json::json!({"error": "not found"}));
        };
        // Rooms are flat ids: a code, no sub-paths.
        if room_id.is_empty() || room_id.contains('/') {
            return json(400, serde_json::json!({"error": "bad room id"}));
        }
        match method {
            "POST" => self.post(room_id, body, now),
            "GET" | "HEAD" => self.get(room_id, raw_path, now),
            _ => json(405, serde_json::json!({"error": "method not allowed"})),
        }
    }

    /// Fixed-window per-key rate check. Returns `true` if the request is within budget.
    /// O(1) amortized; the key map is pruned of stale windows only when it grows large.
    fn rate_ok(&self, key: &str, now: i64) -> bool {
        let mut lim = self.limiter.lock().unwrap_or_else(|e| e.into_inner());
        if lim.len() > MAX_RATE_KEYS {
            lim.retain(|_, (start, _)| now.saturating_sub(*start) < RATE_WINDOW);
        }
        let entry = lim.entry(key.to_string()).or_insert((now, 0));
        if now.saturating_sub(entry.0) >= RATE_WINDOW {
            *entry = (now, 0);
        }
        entry.1 += 1;
        entry.1 <= RATE_MAX
    }

    fn post(&self, room_id: &str, body: &[u8], now: i64) -> Response {
        #[derive(Deserialize)]
        struct PostReq {
            from: String,
            data: String,
        }
        let req: PostReq = match serde_json::from_slice(body) {
            Ok(v) => v,
            Err(e) => {
                return json(
                    400,
                    serde_json::json!({"error": "bad request", "detail": e.to_string()}),
                )
            }
        };
        if req.from.is_empty() || req.from.len() > MAX_FROM {
            return json(400, serde_json::json!({"error": "bad from tag"}));
        }
        if !self.rate_ok(&req.from, now) {
            return json(429, serde_json::json!({"error": "rate limited"}));
        }
        if req.data.len() > MAX_DATA {
            return json(413, serde_json::json!({"error": "message too large"}));
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
        // Cap retained history; readers that fell behind past the cap re-sync from `since=0`.
        if room.messages.len() > MAX_MSGS {
            let drop = room.messages.len() - MAX_MSGS;
            room.messages.drain(0..drop);
        }
        let peers = room.peers(now);
        json(200, serde_json::json!({ "seq": seq, "peers": peers }))
    }

    fn get(&self, room_id: &str, raw_path: &str, now: i64) -> Response {
        let since: u64 = query(raw_path, "since")
            .and_then(|s| s.parse().ok())
            .unwrap_or(0);
        let from = query(raw_path, "from");
        let key = match &from {
            Some(f) if !f.is_empty() => f.as_str(),
            _ => room_id,
        };
        if !self.rate_ok(key, now) {
            return json(429, serde_json::json!({"error": "rate limited"}));
        }

        let mut rooms = self.rooms.lock().unwrap_or_else(|e| e.into_inner());
        prune(&mut rooms, now);
        let Some(room) = rooms.get_mut(room_id) else {
            // An unknown room is not an error — it just has nothing yet.
            return json(
                200,
                serde_json::json!({ "messages": [], "next": since, "peers": 0 }),
            );
        };
        room.last_active = now;
        // A reader with a `from` tag marks itself present (so the poster sees it joined).
        if let Some(f) = from {
            if !f.is_empty() && f.len() <= MAX_FROM {
                room.members.insert(f, now);
            }
        }
        let msgs: Vec<&Msg> = room.messages.iter().filter(|m| m.seq > since).collect();
        let next = room.messages.last().map(|m| m.seq).unwrap_or(since);
        let peers = room.peers(now);
        json(
            200,
            serde_json::json!({ "messages": msgs, "next": next, "peers": peers }),
        )
    }
}

/// Drop idle rooms, prune each surviving room's stale presence entries, and, if still over the
/// ceiling, evict the least-recently-active rooms.
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

fn json(status: u16, v: serde_json::Value) -> Response {
    Response {
        status,
        content_type: "application/json; charset=utf-8".into(),
        body: serde_json::to_vec(&v).unwrap_or_else(|_| b"{}".to_vec()),
    }
}

/// Read one `?key=value` from a raw path (no external query parser needed for two keys).
fn query(raw_path: &str, key: &str) -> Option<String> {
    let q = raw_path.split('?').nth(1)?;
    let q = q.split('#').next().unwrap_or(q);
    q.split('&').find_map(|pair| {
        let mut it = pair.splitn(2, '=');
        (it.next() == Some(key)).then(|| it.next().unwrap_or("").to_string())
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn body_json(r: &Response) -> serde_json::Value {
        serde_json::from_slice(&r.body).unwrap()
    }

    fn post(s: &RelayState, room: &str, from: &str, data: &str, now: i64) -> Response {
        let b = serde_json::json!({ "from": from, "data": data }).to_string();
        s.handle(
            "POST",
            &format!("/api/relay/{room}"),
            &format!("/api/relay/{room}"),
            b.as_bytes(),
            now,
        )
    }
    fn get(s: &RelayState, room: &str, since: u64, from: &str, now: i64) -> Response {
        let raw = format!("/api/relay/{room}?since={since}&from={from}");
        s.handle("GET", &format!("/api/relay/{room}"), &raw, b"", now)
    }

    #[test]
    fn a_message_posted_is_delivered_to_the_other_peer() {
        let s = RelayState::new();
        // Alice creates the room by posting; Bob polls and receives it.
        let p = post(&s, "CODE1", "alice", "hello-ciphertext", 100);
        assert_eq!(p.status, 200);
        assert_eq!(body_json(&p)["seq"], 1);

        let g = get(&s, "CODE1", 0, "bob", 101);
        let msgs = body_json(&g);
        assert_eq!(msgs["messages"].as_array().unwrap().len(), 1);
        assert_eq!(msgs["messages"][0]["from"], "alice");
        assert_eq!(msgs["messages"][0]["data"], "hello-ciphertext");
        assert_eq!(msgs["next"], 1);
    }

    #[test]
    fn since_only_returns_newer_messages() {
        let s = RelayState::new();
        post(&s, "R", "a", "m1", 10);
        post(&s, "R", "a", "m2", 11);
        post(&s, "R", "a", "m3", 12);
        let g = get(&s, "R", 1, "b", 13); // seen up to seq 1 → want 2 and 3
        let v = body_json(&g);
        let arr = v["messages"].as_array().unwrap();
        assert_eq!(arr.len(), 2);
        assert_eq!(arr[0]["seq"], 2);
        assert_eq!(arr[1]["seq"], 3);
        assert_eq!(v["next"], 3);
    }

    #[test]
    fn both_peers_are_counted_present() {
        let s = RelayState::new();
        post(&s, "R", "alice", "x", 100); // alice present via post
        get(&s, "R", 0, "bob", 101); // bob present via poll
        let g = get(&s, "R", 0, "bob", 102);
        assert_eq!(body_json(&g)["peers"], 2);
    }

    #[test]
    fn a_stale_peer_drops_out_of_the_count() {
        let s = RelayState::new();
        post(&s, "R", "alice", "x", 100);
        get(&s, "R", 0, "bob", 101);
        // Much later: only the peer that polled recently still counts.
        let g = get(&s, "R", 0, "bob", 100 + PEER_WINDOW + 5);
        assert_eq!(body_json(&g)["peers"], 1);
    }

    #[test]
    fn the_relay_never_needs_to_parse_data() {
        // Opaque payload: not JSON, arbitrary bytes-as-text. The relay round-trips it verbatim.
        let s = RelayState::new();
        let opaque = "\u{0000}\u{0001}=not-json=%%%\u{FFFD}";
        post(&s, "R", "a", opaque, 1);
        let g = get(&s, "R", 0, "b", 2);
        assert_eq!(body_json(&g)["messages"][0]["data"], opaque);
    }

    #[test]
    fn an_unknown_room_is_empty_not_an_error() {
        let s = RelayState::new();
        let g = get(&s, "NEVER", 0, "b", 1);
        assert_eq!(g.status, 200);
        assert_eq!(body_json(&g)["messages"].as_array().unwrap().len(), 0);
    }

    #[test]
    fn oversized_and_malformed_posts_are_refused() {
        let s = RelayState::new();
        let big = "x".repeat(MAX_DATA + 1);
        assert_eq!(post(&s, "R", "a", &big, 1).status, 413);
        let bad = s.handle("POST", "/api/relay/R", "/api/relay/R", b"not json", 1);
        assert_eq!(bad.status, 400);
        let noroom = s.handle("POST", "/api/relay/", "/api/relay/", b"{}", 1);
        assert_eq!(noroom.status, 400);
    }

    #[test]
    fn a_wrong_method_is_405() {
        let s = RelayState::new();
        assert_eq!(
            s.handle("DELETE", "/api/relay/R", "/api/relay/R", b"", 1)
                .status,
            405
        );
    }

    #[test]
    fn history_is_capped_but_the_sequence_keeps_climbing() {
        let s = RelayState::new();
        // Advance the clock by a second per post: it is more realistic than a same-instant
        // burst and keeps each post inside a fresh rate-limit window (the cap is about floods,
        // not a long, paced stream of messages).
        let start = 1000;
        for i in 0..(MAX_MSGS + 10) {
            post(&s, "R", "a", &format!("m{i}"), start + i as i64);
        }
        // A fresh reader (since=0) gets only the retained tail, but seq numbers are monotonic
        // so a caught-up reader never re-sees or misses a message.
        let g = get(&s, "R", 0, "b", start + (MAX_MSGS + 10) as i64);
        let v = body_json(&g);
        assert_eq!(v["messages"].as_array().unwrap().len(), MAX_MSGS);
        assert_eq!(v["next"], (MAX_MSGS + 10) as u64);
    }

    #[test]
    fn a_flood_from_one_source_is_rate_limited() {
        let s = RelayState::new();
        let now = 500;
        // The whole per-window budget passes...
        for _ in 0..RATE_MAX {
            assert_eq!(post(&s, "R", "spammer", "x", now).status, 200);
        }
        // ...the next request in the same window is refused with 429...
        assert_eq!(post(&s, "R", "spammer", "x", now).status, 429);
        // ...and a later window resets the budget.
        assert_eq!(post(&s, "R", "spammer", "x", now + RATE_WINDOW).status, 200);
    }

    #[test]
    fn a_paced_ceremony_is_never_throttled() {
        // A generous stand-in for real short-poll traffic: a couple of requests per second
        // from each of three peers over a minute stays well under the limit.
        let s = RelayState::new();
        for t in 0..60 {
            for tag in ["dev-a", "dev-b", "dev-c"] {
                assert_eq!(post(&s, "R", tag, "round", 1000 + t).status, 200);
                assert_eq!(get(&s, "R", 0, tag, 1000 + t).status, 200);
            }
        }
    }

    #[test]
    fn stale_members_are_pruned_from_the_presence_map() {
        let s = RelayState::new();
        post(&s, "R", "alice", "x", 100);
        get(&s, "R", 0, "bob", 101);
        // A touch long past PRESENCE_TTL prunes the stale tags entirely, and only the live
        // peer is both counted and retained in the map.
        let g = get(&s, "R", 0, "carol", 100 + PRESENCE_TTL + 10);
        assert_eq!(body_json(&g)["peers"], 1);
        let rooms = s.rooms.lock().unwrap();
        assert_eq!(rooms.get("R").unwrap().members.len(), 1);
    }
}
