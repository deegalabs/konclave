//! Konclave - the blind mailbox relay, standalone and PUBLIC.
//!
//! This is the hosted counterpart of `orchestrator/src/relay.rs`: the same in-memory,
//! opaque-message room mailbox, but bound on `0.0.0.0` with permissive CORS so browsers on
//! `konclave.xyz` (any origin) can reach it for multi-device DKG/signing ceremonies. It is
//! blind by construction - it forwards public/encrypted bytes it cannot read and holds no key.
//!
//! Public by design, so there is NO Host gate and NO session token here (unlike the loopback
//! bridge). Hardening in place for a public relay: rooms/messages are capped and TTL-evicted,
//! the message bytes held are bounded per room and in total (see `Ceilings`: they count the bytes
//! a message takes in a poll answer, `data` and `from` JSON-escaped plus a fixed framing, and
//! nothing else the process holds), the presence map is pruned (stale `from` tags dropped past
//! `PRESENCE_TTL`), and a dependency-free fixed-window rate limiter refuses floods with `429` -
//! keyed BOTH per client IP (robust: a flooding source cannot cheaply change it) and per
//! `from`/room key (#64). It moves nothing but ciphertext/public FROST material between peers.

mod concurrency;

use std::cmp::Reverse;
use std::collections::HashMap;
use std::io::Read;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{SystemTime, UNIX_EPOCH};

use konclave_http::{ClientAddress, RateKey};
use serde::{Deserialize, Serialize};
use tiny_http::{Header, Method, Response, Server};

use room::{message_cost, Msg, Room, MESSAGE_FRAMING};

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
// How long `/health` keeps the fill level it last worked out (seconds). The level is recomputed
// from the rooms at most this often, so the answer says how loaded the relay is and not when a
// message arrived.
const FILL_REFRESH: i64 = 60;

/// How many message bytes the relay holds, per room and in total, and how much of an active room
/// the total ceiling leaves alone.
///
/// WHAT IS COUNTED: message bytes only. A message costs what it takes in a poll answer, at most:
/// its `data` and its `from` tag as JSON writes them (`"` and `\` and the control characters take
/// two or six bytes) plus `MESSAGE_FRAMING` for the object around them (`message_cost`, the one
/// place that says so). The presence map, the rate-limit maps, the room ids and the per-message
/// overhead in memory are not counted, so the process uses more than these numbers; they are
/// starting values, not derived from the memory the container has. `/health` reports only how full
/// the relay is, in steps of ten percent.
#[derive(Clone, Copy, Debug)]
struct Ceilings {
    /// The most message bytes one room holds. When a post takes a room past it, the room's oldest
    /// messages leave until it is back under; the message just posted always stays.
    room_bytes: usize,
    /// The most message bytes all rooms hold together. A post that would take the relay past it is
    /// made room for (see `make_room`), or answered `503` when no room can be made.
    total_bytes: usize,
    /// How much of a room that is ACTIVE (posted to or polled within `PEER_WINDOW`) the total
    /// ceiling leaves alone: under pressure such a room gives up its oldest messages, never going
    /// below its newest messages that total this much (see `make_room`).
    active_floor: usize,
}

/// The ceilings the relay runs with.
const PRODUCTION: Ceilings = Ceilings {
    room_bytes: 4 * 1024 * 1024,
    total_bytes: 256 * 1024 * 1024,
    active_floor: 384 * 1024,
};

/// What the largest signing ceremony a vault can run takes in a room, in the cost unit above,
/// rounded up. Measured, not guessed (`relay-server/CHANGELOG.md` has the table): the largest
/// request a post may carry (128 KiB), the coordinating device's `sreq` carrying the PCZT when not
/// every device has registered its key (about 80 KiB), thirteen sequential spends of five devices
/// each (about 43 KiB), the devices' answers and the arming tally (about 5 KiB). The sealed form
/// of a request is smaller (about 152 KiB all told); this is the bigger of the two.
const LARGEST_CEREMONY_BYTES: usize = 256 * 1024;

/// What one message can cost at most: a post of the largest `data` and `from`, every byte of them
/// one that JSON writes as six.
const MAX_MESSAGE_COST: usize = 6 * (MAX_DATA + MAX_FROM) + MESSAGE_FRAMING;

// A message of the largest size a post may carry always fits an empty room, even written out in
// the worst way. If this stopped holding, a maximal message would be accepted into a room that
// could not keep it.
const _: () = assert!(PRODUCTION.room_bytes >= MAX_MESSAGE_COST);
const _: () = assert!(PRODUCTION.total_bytes >= PRODUCTION.room_bytes);
// The floor covers the largest real ceremony, and no more than a room holds.
const _: () = assert!(PRODUCTION.active_floor >= LARGEST_CEREMONY_BYTES);
const _: () = assert!(PRODUCTION.active_floor <= PRODUCTION.room_bytes);
// The bound the total ceiling is built on: every other room held down to the floor, and a post of
// a whole room's worth, still fit. With it no post is ever refused for want of room (`make_room`
// keeps its refusal for ceilings that do not meet this, and tests that).
const _: () =
    assert!(MAX_ROOMS * PRODUCTION.active_floor + PRODUCTION.room_bytes <= PRODUCTION.total_bytes);

/// A room's messages and the byte count that goes with them. The `messages` queue and the `bytes`
/// that count it are private to this module and change only through the methods of `Room`, so no
/// caller can update one and leave the other behind.
mod room {
    use std::collections::{HashMap, VecDeque};

    use serde::Serialize;

    use super::{MAX_MSGS, PEER_WINDOW, PRESENCE_TTL};

    /// The bytes the object around a message takes in a poll answer, at most: `{"seq":` and its
    /// digits (twenty at most), `,"from":"`, `","data":"`, `"}` and the comma after it in a list
    /// come to 49.
    pub const MESSAGE_FRAMING: usize = 64;

    /// One message of a room. What it costs is worked out ONCE, when it is made, and stored: every
    /// scan of a room (what it keeps at the floor, what a push would drop, what leaves) reads
    /// that number instead of reading the message's bytes again. The text is private so the
    /// stored cost cannot go out of step with it, and the cost is not part of the answer.
    #[derive(Clone, Serialize)]
    pub struct Msg {
        pub seq: u64,
        from: String,
        data: String,
        #[serde(skip)]
        cost: usize,
    }

    /// The length of `s` between the quotes of a JSON string, as `serde_json` writes it: `"`, `\`
    /// and `\b \f \n \r \t` take two bytes, any other control character below 0x20 takes six
    /// (`\u00XX`), everything else (DEL and every byte of UTF-8 included) takes one.
    pub fn escaped_len(s: &str) -> usize {
        s.bytes()
            .map(|b| match b {
                b'"' | b'\\' | 0x08 | 0x0c | b'\n' | b'\r' | b'\t' => 2,
                0x00..=0x1f => 6,
                _ => 1,
            })
            .sum()
    }

    /// What one message counts for against a byte ceiling: the bytes it takes in a poll answer,
    /// at most. Its `data` and its `from` tag written as JSON, and `MESSAGE_FRAMING` for the
    /// object around them. The only place that adds them up.
    pub fn message_cost(from: &str, data: &str) -> usize {
        escaped_len(from) + escaped_len(data) + MESSAGE_FRAMING
    }

    impl Msg {
        /// A message, and what it costs, worked out here and nowhere else (`message_cost`).
        pub fn new(seq: u64, from: String, data: String) -> Msg {
            let cost = message_cost(&from, &data);
            Msg {
                seq,
                from,
                data,
                cost,
            }
        }

        /// What it cost when it was made.
        pub fn cost(&self) -> usize {
            self.cost
        }
    }

    pub struct Room {
        /// Oldest first.
        messages: VecDeque<Msg>,
        /// The sum of `cost()` over `messages`, kept by `push`, `drop_oldest` and `clear_messages`.
        bytes: usize,
        /// The seq the next message gets. It only increases: dropping or clearing messages keeps
        /// it, so a device's cursor stays meaningful in a room that has lost its messages.
        next_seq: u64,
        pub members: HashMap<String, i64>,
        pub last_active: i64,
    }

    impl Room {
        pub fn new(now: i64) -> Room {
            Room {
                messages: VecDeque::new(),
                bytes: 0,
                next_seq: 1,
                members: HashMap::new(),
                last_active: now,
            }
        }

        /// The oldest messages a push of a message that costs `cost` drops, as (how many, how
        /// many bytes). They go while the room would hold more than `MAX_MSGS` or more than
        /// `room_bytes` message bytes. Only the messages already here are candidates, so the
        /// message just pushed is never the one dropped. The one place that says what a push
        /// drops: `push` does it and `would_drop` reports it.
        fn trim_plan(&self, cost: usize, room_bytes: usize) -> (usize, usize) {
            let mut len = self.messages.len() + 1;
            let mut bytes = self.bytes + cost;
            let (mut count, mut freed) = (0, 0);
            for m in &self.messages {
                if len <= MAX_MSGS && bytes <= room_bytes {
                    break;
                }
                let c = m.cost();
                len -= 1;
                bytes -= c;
                count += 1;
                freed += c;
            }
            (count, freed)
        }

        /// The message bytes a push of a message that costs `cost` would drop from this room.
        pub fn would_drop(&self, cost: usize, room_bytes: usize) -> usize {
            self.trim_plan(cost, room_bytes).1
        }

        /// Append a message and return its seq. Before it goes in, the room drops the OLDEST
        /// messages `would_drop` says it will. The message just appended is never the one
        /// dropped, so a room never ends up empty because of its own post.
        pub fn push(&mut self, from: String, data: String, room_bytes: usize) -> u64 {
            let msg = Msg::new(self.next_seq, from, data);
            let cost = msg.cost();
            let (count, _) = self.trim_plan(cost, room_bytes);
            for _ in 0..count {
                self.drop_oldest();
            }
            self.next_seq += 1;
            self.bytes += cost;
            let seq = msg.seq;
            self.messages.push_back(msg);
            seq
        }

        /// Drop the oldest message. Returns the bytes it held, or `None` when there is none.
        pub fn drop_oldest(&mut self) -> Option<usize> {
            let oldest = self.messages.pop_front()?;
            let freed = oldest.cost();
            self.bytes = self.bytes.saturating_sub(freed);
            Some(freed)
        }

        /// Drop the oldest message if the room holds more than `floor` message bytes. Returns the
        /// bytes it held, or `None` when the room is at or under the floor.
        pub fn drop_oldest_above(&mut self, floor: usize) -> Option<usize> {
            if self.bytes > floor {
                self.drop_oldest()
            } else {
                None
            }
        }

        /// What the room holds once `drop_oldest_above(floor)` has run until it refuses: the
        /// newest messages that total at most `floor`, or the whole room if it is under it.
        pub fn kept_at_floor(&self, floor: usize) -> usize {
            let mut bytes = self.bytes;
            for m in &self.messages {
                if bytes <= floor {
                    break;
                }
                bytes -= m.cost();
            }
            bytes
        }

        /// Drop every message. The room, its members and its `next_seq` stay.
        pub fn clear_messages(&mut self) {
            self.messages.clear();
            self.bytes = 0;
        }

        /// Message bytes held (see `Ceilings`).
        pub fn bytes(&self) -> usize {
            self.bytes
        }

        /// The messages held, oldest first.
        pub fn messages(&self) -> &VecDeque<Msg> {
            &self.messages
        }

        /// Copies of the messages after `since`, in order.
        pub fn after(&self, since: u64) -> Vec<Msg> {
            self.messages
                .iter()
                .filter(|m| m.seq > since)
                .cloned()
                .collect()
        }

        /// A room nobody has posted to or polled for longer than the peer window. The same window
        /// `peers` counts members by.
        pub fn idle(&self, now: i64) -> bool {
            now.saturating_sub(self.last_active) > PEER_WINDOW
        }

        pub fn peers(&self, now: i64) -> usize {
            self.members
                .values()
                .filter(|&&seen| now.saturating_sub(seen) <= PEER_WINDOW)
                .count()
        }

        pub fn prune_members(&mut self, now: i64) {
            self.members
                .retain(|_, &mut seen| now.saturating_sub(seen) <= PRESENCE_TTL);
        }
    }
}

struct RelayState {
    rooms: Mutex<HashMap<String, Room>>,
    // The fixed-window flood limiter. It was written here and lived here until #558; it is in
    // `konclave-http` now, so the coordinator applies the same rule instead of none.
    limiter: konclave_http::RateLimiter,
    ceilings: Ceilings,
    // How many posts were answered `relay_full`. Reported by `/health`.
    relay_full: AtomicU64,
    // The fill level `/health` last worked out and when (see `fill_level`).
    fill_cache: Mutex<(i64, u8)>,
}

impl Default for RelayState {
    fn default() -> Self {
        RelayState::with_ceilings(PRODUCTION)
    }
}

/// What a poll reads out of a room, as owned data: the messages after the cursor, the cursor to
/// continue from and how many members are present. It holds nothing that borrows the rooms, so the
/// answer is written out after the lock is released, and the type allows nothing else.
struct Snapshot {
    messages: Vec<Msg>,
    next: u64,
    peers: usize,
}

/// The poll answer as written on the wire. Serialised straight from the snapshot, with no
/// intermediate `Value` tree that would copy every message again.
#[derive(Serialize)]
struct Answer<'a> {
    messages: &'a [Msg],
    next: u64,
    peers: usize,
}

/// The poll answer for a snapshot, written once into a buffer sized from the cost of its messages
/// (which is at least what they take, so nothing is reallocated).
///
/// Memory: while one poll of a room at its ceiling is being answered it holds the copy of the
/// messages and the answer, about twice the room ceiling. The worker pool is 8 to 64 threads by
/// default and up to 256 when `KONCLAVE_RELAY_WORKERS` sets it (`concurrency::worker_count`), and
/// the allocator may keep the memory of the largest answer each worker has served. None of this
/// is counted in the ceilings.
fn answer_json(snap: &Snapshot) -> Option<String> {
    let capacity = snap.messages.iter().map(Msg::cost).sum::<usize>() + 128;
    let mut out = Vec::with_capacity(capacity);
    let answer = Answer {
        messages: &snap.messages,
        next: snap.next,
        peers: snap.peers,
    };
    serde_json::to_writer(&mut out, &answer).ok()?;
    String::from_utf8(out).ok()
}

/// The share of `total_bytes` that `held` is, as a whole percentage rounded DOWN to a multiple of
/// ten (0, 10, ... 100).
fn fill_percent(held: usize, total_bytes: usize) -> u8 {
    let percent = (held as u128 * 100 / total_bytes.max(1) as u128).min(100) as u8;
    percent / 10 * 10
}

impl RelayState {
    /// A relay with the given ceilings. `RelayState::default()` is this with `PRODUCTION`; tests
    /// use small ones to keep their arithmetic readable.
    fn with_ceilings(ceilings: Ceilings) -> Self {
        RelayState {
            rooms: Mutex::default(),
            limiter: konclave_http::RateLimiter::new(RATE_WINDOW, MAX_RATE_KEYS),
            ceilings,
            relay_full: AtomicU64::new(0),
            fill_cache: Mutex::new((i64::MIN, 0)),
        }
    }

    /// How full the relay is: the share of `total_bytes` held, rounded down to a multiple of ten
    /// percent, worked out at most once every `FILL_REFRESH` seconds. The rooms are locked only
    /// when the last answer is older than that; inside the minute the cached level is returned.
    /// `now` is the caller's clock, so a test can move it.
    ///
    /// The cache is never held while the rooms are waited for: a stale level is worked out under
    /// the rooms lock alone and stored afterwards, so a post that keeps the rooms for a while does
    /// not queue every `/health` behind the one call that recomputes. Two calls that both find the
    /// level stale each work it out, which costs a sum and gives the same answer.
    fn fill_level(&self, now: i64) -> u8 {
        let fresh = |computed_at: i64| (0..FILL_REFRESH).contains(&now.saturating_sub(computed_at));
        {
            let cache = self.fill_cache.lock().unwrap_or_else(|e| e.into_inner());
            if fresh(cache.0) {
                return cache.1;
            }
        }
        let held: usize = {
            let rooms = self.rooms.lock().unwrap_or_else(|e| e.into_inner());
            rooms.values().map(Room::bytes).sum()
        };
        let level = fill_percent(held, self.ceilings.total_bytes);
        *self.fill_cache.lock().unwrap_or_else(|e| e.into_inner()) = (now, level);
        level
    }

    /// The `/health` answer: which sources this relay is running (#522) and how loaded it is.
    ///
    /// Not an attestation: whoever can replace the binary can report any digest. It catches a
    /// stale deploy, which is the thing that has actually happened here, twice.
    ///
    /// It says how full the relay is in steps of ten percent, refreshed at most once a minute, and
    /// how many posts have been answered `503` since the process started. It carries no byte
    /// figure: the exact total changes with every message, and the answer is public.
    fn health_json(&self, now: i64) -> String {
        serde_json::json!({
            "status": "ok",
            "service": "konclave-relay",
            "source_digest": env!("KONCLAVE_SOURCE_DIGEST"),
            "relay_full": self.relay_full.load(Ordering::Relaxed),
            "fill": self.fill_level(now),
        })
        .to_string()
    }

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
        let cost = message_cost(&req.from, &req.data);
        let mut rooms = self.rooms.lock().unwrap_or_else(|e| e.into_inner());
        prune(&mut rooms, now);
        if !make_room(&mut rooms, room_id, cost, now, &self.ceilings) {
            self.relay_full.fetch_add(1, Ordering::Relaxed);
            return (503, r#"{"error":"relay_full"}"#.into());
        }
        let room = rooms
            .entry(room_id.to_string())
            .or_insert_with(|| Room::new(now));
        room.last_active = now;
        room.members.insert(req.from.clone(), now);
        let seq = room.push(req.from, req.data, self.ceilings.room_bytes);
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
        // No cap on the answer below the room ceiling: it is every message after `since`, and it
        // is bounded by the room ceiling because the ceiling counts what a message takes in the
        // answer. A device reading a room for the first time takes everything it gets in that
        // first answer as the room's history, so an answer that stopped short would hand the rest
        // over as if it were live. The messages are copied under the lock (`snapshot`) and the
        // answer is written after it is released.
        let snap = self.snapshot(room_id, since, from, now);
        match answer_json(&snap) {
            Some(body) => (200, body),
            None => (500, r#"{"error":"internal error"}"#.into()),
        }
    }

    /// Read a room for a poll: renew it, seat the sender, copy out the messages after `since`.
    /// A room nobody has written to is not created. Returns owned data, so the rooms lock is
    /// released when this returns.
    fn snapshot(&self, room_id: &str, since: u64, from: Option<String>, now: i64) -> Snapshot {
        let mut rooms = self.rooms.lock().unwrap_or_else(|e| e.into_inner());
        prune(&mut rooms, now);
        let Some(room) = rooms.get_mut(room_id) else {
            return Snapshot {
                messages: Vec::new(),
                next: since,
                peers: 0,
            };
        };
        room.last_active = now;
        if let Some(f) = from {
            if !f.is_empty() {
                room.members.insert(f, now);
            }
        }
        Snapshot {
            messages: room.after(since),
            next: room.messages().back().map_or(since, |m| m.seq),
            peers: room.peers(now),
        }
    }
}

/// Make room for a post of a message that costs `cost` into room `posting`, under the ceilings.
/// Returns whether it now fits. Called with the rooms lock held, before the message is pushed.
///
/// The total is summed here from the rooms; there is no second counter to drift. What the post
/// adds to the total is its cost less what the push will drop from the posting room anyway
/// (`Room::would_drop`, the rule `push` itself follows), so a post into a room already at its own
/// ceiling takes nothing from any other room. When it already fits, nothing moves. Otherwise space
/// is made in this order, stopping as soon as it fits:
///
/// 1. From IDLE rooms (nobody has posted to or polled them within `PEER_WINDOW`), other than the
///    posting one: the one idle longest first, and inside a room the oldest messages first, a room
///    emptied before the next is touched. The room itself stays, with its members and its
///    `next_seq`, so a device's cursor in it stays valid; only `ROOM_TTL` and `MAX_ROOMS` remove
///    a room.
/// 2. From ACTIVE rooms other than the posting one that hold more than `active_floor`: their
///    oldest messages, the room with the largest excess over the floor first (the one whose last
///    activity is oldest first when equal), each only down to the newest messages that total the
///    floor.
/// 3. The posting room's own oldest messages. The message being added is not in the room yet, so it
///    cannot be one of them.
///
/// THIS REOPENS A RULE. An active room used to be left whole however full the relay was. Now it is
/// protected down to the floor, which is sized so that one whole ceremony fits under it (see
/// `LARGEST_CEREMONY_BYTES`), and the ceilings are built so that, with every other room held at
/// the floor, a post of a room's worth still fits: no post is refused for want of room.
///
/// The refusal stays for ceilings that do not meet that bound. It is decided BEFORE anything moves:
/// what no step above can free is every other active room's newest messages up to the floor, and
/// if that and the post do not fit, this returns `false` and has changed nothing. A refused post
/// takes nothing from the room it was posted to, or from any other.
fn make_room(
    rooms: &mut HashMap<String, Room>,
    posting: &str,
    cost: usize,
    now: i64,
    ceilings: &Ceilings,
) -> bool {
    let (total_bytes, floor) = (ceilings.total_bytes, ceilings.active_floor);
    // How many bytes past the ceiling the relay would be, holding `held` and taking a post that
    // adds `growth`. Zero means it fits. Every "does it fit yet" below asks this, so there is one
    // answer to it.
    let over = |held: usize, growth: usize| (held + growth).saturating_sub(total_bytes);
    // What the post adds to the total once the push has dropped what it will from the posting room.
    let growth = |room: Option<&Room>| {
        room.map_or(cost, |r| {
            cost.saturating_sub(r.would_drop(cost, ceilings.room_bytes))
        })
    };

    let mut held: usize = rooms.values().map(Room::bytes).sum();
    let g = growth(rooms.get(posting));
    if over(held, g) == 0 {
        return true;
    }
    // What no step below can free: the newest messages of every other active room, up to the
    // floor. With the posting room emptied the post adds all of its cost.
    let pinned: usize = rooms
        .iter()
        .filter(|(id, r)| id.as_str() != posting && !r.idle(now))
        .map(|(_, r)| r.kept_at_floor(floor))
        .sum();
    if over(pinned, cost) > 0 {
        return false;
    }

    // 1. Idle rooms.
    let mut idle: Vec<(i64, String)> = rooms
        .iter()
        .filter(|(id, r)| id.as_str() != posting && r.idle(now))
        .map(|(id, r)| (r.last_active, id.clone()))
        .collect();
    idle.sort();
    for (_, id) in idle {
        if over(held, g) == 0 {
            break;
        }
        let Some(room) = rooms.get_mut(&id) else {
            continue;
        };
        if over(held, g) >= room.bytes() {
            // The whole room is needed: clear it in one step.
            held -= room.bytes();
            room.clear_messages();
        } else {
            while over(held, g) > 0 {
                let Some(freed) = room.drop_oldest() else {
                    break;
                };
                held -= freed;
            }
        }
    }

    // 2. Active rooms above the floor, the largest excess first.
    let mut above: Vec<(Reverse<usize>, i64, String)> = rooms
        .iter()
        .filter(|(id, r)| id.as_str() != posting && !r.idle(now) && r.bytes() > floor)
        .map(|(id, r)| (Reverse(r.bytes() - floor), r.last_active, id.clone()))
        .collect();
    above.sort();
    for (_, _, id) in above {
        if over(held, g) == 0 {
            break;
        }
        let Some(room) = rooms.get_mut(&id) else {
            continue;
        };
        while over(held, g) > 0 {
            let Some(freed) = room.drop_oldest_above(floor) else {
                break;
            };
            held -= freed;
        }
    }

    // 3. The posting room's own oldest messages. Counted against the full cost: a message dropped
    // here that the push would have dropped anyway changes nothing until the push would drop no
    // more, so this stops at the same message as counting what the post adds each time.
    if let Some(room) = rooms.get_mut(posting) {
        while over(held, cost) > 0 {
            let Some(freed) = room.drop_oldest() else {
                break;
            };
            held -= freed;
        }
    }
    over(held, growth(rooms.get(posting))) == 0
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
                (200, state.health_json(now_unix()))
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

    use super::room::{escaped_len, Msg};

    // ---- Byte ceilings (#400) -------------------------------------------------------------------
    //
    // The ceilings count MESSAGE bytes only: what a message takes in a poll answer, which is the
    // JSON-escaped size of its `data` and its `from` tag plus a fixed 64 for the object around
    // them (`message_cost`). The presence map, the rate-key map and per-message overhead are not
    // counted, and these tests count exactly what the rule counts. They go through `handle`, the
    // real request path, with small ceilings where the arithmetic has to be readable and with the
    // production ceilings where the numbers are the point. `now` moves between bursts so the
    // request limits above stay out of the way.

    /// A state with small ceilings and every active room protected whole (the floor is the room
    /// ceiling), so a test is about one rule at a time.
    fn small(room_bytes: usize, total_bytes: usize) -> RelayState {
        with_floor(room_bytes, total_bytes, room_bytes)
    }

    fn with_floor(room_bytes: usize, total_bytes: usize, active_floor: usize) -> RelayState {
        RelayState::with_ceilings(Ceilings {
            room_bytes,
            total_bytes,
            active_floor,
        })
    }

    /// POST one message that costs exactly `cost`: `tag` is the sender and the data, plain text
    /// with nothing to escape, fills the rest.
    fn put(st: &RelayState, room: &str, tag: &str, cost: usize, now: i64) -> (u16, String) {
        assert!(
            cost >= tag.len() + MESSAGE_FRAMING,
            "a message costs its tag and its framing at least"
        );
        let data = "d".repeat(cost - tag.len() - MESSAGE_FRAMING);
        put_raw(st, room, tag, &data, now)
    }

    fn put_raw(st: &RelayState, room: &str, tag: &str, data: &str, now: i64) -> (u16, String) {
        let path = format!("/api/relay/{room}");
        let body = serde_json::json!({ "from": tag, "data": data }).to_string();
        st.handle(&Method::Post, &path, &path, body.as_bytes(), now, &ADDR_A)
    }

    fn seq_of(answer: &(u16, String)) -> u64 {
        assert_eq!(answer.0, 200, "{}", answer.1);
        let v: serde_json::Value = serde_json::from_str(&answer.1).unwrap();
        v["seq"].as_u64().expect("an accepted post names its seq")
    }

    /// GET everything after `since`, as a member of the room would, as the raw answer body. This
    /// renews the room's activity, as any poll does.
    fn read_raw(st: &RelayState, room: &str, since: u64, now: i64) -> String {
        let path = format!("/api/relay/{room}");
        let raw = format!("{path}?since={since}&from=reader");
        let (status, body) = st.handle(&Method::Get, &path, &raw, b"", now, &ADDR_A);
        assert_eq!(status, 200);
        body
    }

    fn read(st: &RelayState, room: &str, since: u64, now: i64) -> serde_json::Value {
        serde_json::from_str(&read_raw(st, room, since, now)).unwrap()
    }

    fn seqs(v: &serde_json::Value) -> Vec<u64> {
        v["messages"]
            .as_array()
            .unwrap()
            .iter()
            .map(|m| m["seq"].as_u64().unwrap())
            .collect()
    }

    // The next four look at the rooms directly, so they do not renew a room's activity the way a
    // poll does.
    fn held(st: &RelayState, room: &str) -> Option<usize> {
        st.rooms.lock().unwrap().get(room).map(Room::bytes)
    }

    fn held_seqs(st: &RelayState, room: &str) -> Vec<u64> {
        let rooms = st.rooms.lock().unwrap();
        rooms[room].messages().iter().map(|m| m.seq).collect()
    }

    fn room_exists(st: &RelayState, room: &str) -> bool {
        st.rooms.lock().unwrap().contains_key(room)
    }

    fn total_held(st: &RelayState) -> usize {
        st.rooms.lock().unwrap().values().map(Room::bytes).sum()
    }

    fn health_at(st: &RelayState, now: i64) -> serde_json::Value {
        serde_json::from_str(&st.health_json(now)).unwrap()
    }

    #[test]
    fn a_room_never_holds_more_than_its_ceiling() {
        let st = small(1000, 1_000_000);
        let now = 10_000_000;
        // Exactly at the ceiling nothing leaves: ten messages of 100 bytes.
        for i in 1..=10 {
            assert_eq!(seq_of(&put(&st, "r", "t", 100, now)), i);
        }
        assert_eq!(held(&st, "r"), Some(1000));
        assert_eq!(
            seqs(&read(&st, "r", 0, now)),
            (1..=10).collect::<Vec<u64>>(),
            "a room exactly at its ceiling keeps everything"
        );
        // One more message of the same size takes it over: the oldest leaves, the newest stays.
        assert_eq!(seq_of(&put(&st, "r", "t", 100, now)), 11);
        assert_eq!(held(&st, "r"), Some(1000));
        assert_eq!(
            seqs(&read(&st, "r", 0, now)),
            (2..=11).collect::<Vec<u64>>()
        );
        // A larger message pushes out as many of the oldest as it needs: 450 bytes, five go.
        assert_eq!(seq_of(&put(&st, "r", "t", 450, now)), 12);
        assert_eq!(held(&st, "r"), Some(5 * 100 + 450));
        let rest = seqs(&read(&st, "r", 0, now));
        assert_eq!(rest, vec![7, 8, 9, 10, 11, 12], "oldest first, in order");
        assert!(rest.windows(2).all(|w| w[0] < w[1]), "seq stays increasing");
        // A cursor from before the eviction sees what is left after it.
        assert_eq!(seqs(&read(&st, "r", 9, now)), vec![10, 11, 12]);
    }

    /// The same rule at the production ceiling and the largest message a post may carry. A message
    /// that costs exactly 128 KiB makes 32 of them exactly the 4 MiB ceiling: the room holds all
    /// 32, so a cap on the poll answer anywhere under the room ceiling cuts it.
    #[test]
    fn a_stream_of_full_size_messages_stops_at_the_production_room_ceiling() {
        let st = RelayState::default();
        let now = 31_000_000;
        let cost = 128 * 1024;
        for i in 1..=33u64 {
            assert_eq!(seq_of(&put(&st, "sign", "t", cost, now)), i);
        }
        assert_eq!(held(&st, "sign"), Some(4 * 1024 * 1024));
        let v = read(&st, "sign", 0, now);
        assert_eq!(
            seqs(&v),
            (2..=33).collect::<Vec<u64>>(),
            "the oldest left, and one answer carries the other 32"
        );
        assert_eq!(v["next"].as_u64(), Some(33));
    }

    #[test]
    fn a_message_over_the_message_cap_is_still_refused_413() {
        let st = RelayState::default();
        let now = 32_000_000;
        let path = "/api/relay/r";
        let body = |len: usize| {
            serde_json::json!({ "from": "t", "data": "d".repeat(len) })
                .to_string()
                .into_bytes()
        };
        let over = st.handle(&Method::Post, path, path, &body(MAX_DATA + 1), now, &ADDR_A);
        assert_eq!(over, (413, r#"{"error":"message too large"}"#.to_string()));
        assert!(
            st.rooms.lock().unwrap().is_empty(),
            "a refused message stores nothing"
        );
        let at_cap = st.handle(&Method::Post, path, path, &body(MAX_DATA), now, &ADDR_A);
        assert_eq!(at_cap.0, 200, "exactly the cap is accepted");
    }

    /// A message the way a device sends one: JSON text, so it carries quotes, which the relay's
    /// cost counts escaped. `raw_len` is its length before escaping.
    fn json_text(kind: &str, raw_len: usize) -> String {
        let head = format!(r#"{{"type":"{kind}","x":""#);
        let fill = raw_len - head.len() - 2;
        format!(r#"{head}{}"}}"#, "A".repeat(fill))
    }

    /// The permanent replay test. A signing room is permanent, and a device that joins late, or
    /// reloads, reads the room's whole history with one `since=0` poll and treats everything in
    /// that first answer as history. 40 payments of signing traffic are 360 messages and about
    /// 2.7 MiB: one request of 69,434 bytes and eight of about 300 bytes each. The first poll has to
    /// return all of it, in one answer, in order. A cap on the answer below the room ceiling would
    /// split that history across several polls, and every poll after the first would read as live.
    #[test]
    fn a_since_zero_poll_returns_every_message_of_a_full_signing_room() {
        let st = RelayState::default();
        let mut now = 30_000_000;
        let mut sent: Vec<(String, String)> = Vec::new();
        for _payment in 0..40 {
            sent.push(("helper".to_string(), json_text("sealed", 69_434)));
            for k in 1..=8 {
                sent.push((format!("d{k}"), json_text("s1", 300)));
            }
            // Nine posts a payment, one request window apart.
            for (tag, data) in &sent[sent.len() - 9..] {
                assert_eq!(put_raw(&st, "sign", tag, data, now).0, 200);
            }
            now += RATE_WINDOW;
        }
        assert_eq!(sent.len(), 360);
        let total: usize = sent.iter().map(|(t, d)| message_cost(t, d)).sum();
        assert!(
            total < 4 * 1024 * 1024,
            "the premise is a room under its ceiling"
        );

        let v = read(&st, "sign", 0, now);
        assert_eq!(
            seqs(&v),
            (1..=360).collect::<Vec<u64>>(),
            "all 360, in order"
        );
        assert_eq!(v["next"].as_u64(), Some(360));
        for (m, (tag, data)) in v["messages"].as_array().unwrap().iter().zip(&sent) {
            assert_eq!(m["from"].as_str(), Some(tag.as_str()));
            assert_eq!(m["data"].as_str(), Some(data.as_str()));
        }
    }

    /// The same guard for the other limit a room has: the most messages it keeps. A room that
    /// reached it still answers a `since=0` poll whole, so a cap of 360, 400 or 500 messages on the
    /// answer is cut here and not only a cap below the replay above.
    #[test]
    fn a_since_zero_poll_returns_a_room_that_holds_the_most_messages_it_keeps() {
        let st = RelayState::default();
        let mut now = 33_000_000;
        let posts = MAX_MSGS + 20;
        for i in 0..posts {
            // eight device tags, a hundred posts a window: inside every request limit
            assert_eq!(put(&st, "sign", &format!("d{}", i % 8), 300, now).0, 200);
            if i % 100 == 99 {
                now += RATE_WINDOW;
            }
        }
        let v = read(&st, "sign", 0, now);
        assert_eq!(
            seqs(&v),
            (21..=posts as u64).collect::<Vec<u64>>(),
            "the newest MAX_MSGS, all of them, in one answer"
        );
        assert_eq!(v["next"].as_u64(), Some(posts as u64));
    }

    /// `next` is the room's last seq, also when the caller's cursor is past it: the coordinator
    /// continues from `next`.
    #[test]
    fn next_is_the_rooms_last_seq_even_past_the_cursor() {
        let st = small(1000, 1000);
        let now = 47_000_000;
        for _ in 0..3 {
            assert_eq!(put(&st, "r", "t", 100, now).0, 200);
        }
        assert_eq!(read(&st, "r", 9, now)["next"].as_u64(), Some(3));
    }

    #[test]
    fn pressure_clears_idle_rooms_oldest_first_and_keeps_their_shell() {
        // The rooms are in a HashMap, so the order the relay visits them in changes from state to
        // state. Running the scene on several fresh states keeps a missing sort from passing by
        // luck.
        for _ in 0..12 {
            pressure_scene();
        }
    }

    fn pressure_scene() {
        let st = small(400, 1200);
        let b = 20_000_000;
        // Four rooms of 300 bytes fill the relay exactly. Their last activity runs against the
        // order their names sort in: m-3 is the oldest, then m-1, m-4 and m-2.
        for (room, at) in [("m-3", 100), ("m-1", 110), ("m-4", 120), ("m-2", 130)] {
            for _ in 0..3 {
                assert_eq!(put(&st, room, "t", 100, b + at).0, 200);
            }
        }
        assert_eq!(
            total_held(&st),
            1200,
            "a relay exactly at its ceiling accepts"
        );

        // Every room has been quiet for longer than the peer window. 150 more bytes: the room with
        // the oldest activity gives up its oldest messages, two of its three, and nobody else does.
        let t = b + 300;
        assert_eq!(put(&st, "fresh-1", "t", 150, t).0, 200);
        assert_eq!(held_seqs(&st, "m-3"), vec![3]);
        assert_eq!(held(&st, "m-1"), Some(300));
        assert_eq!(held(&st, "m-4"), Some(300));
        assert_eq!(held(&st, "m-2"), Some(300));

        // 350 more: m-3 is cleared entirely before the next room is touched, then m-1 gives up
        // two of its three messages.
        assert_eq!(put(&st, "fresh-2", "t", 350, t + 1).0, 200);
        assert_eq!(
            held(&st, "m-3"),
            Some(0),
            "cleared, and the room is still there"
        );
        assert!(room_exists(&st, "m-3"));
        assert_eq!(held_seqs(&st, "m-1"), vec![3]);
        assert_eq!(held(&st, "m-4"), Some(300));
        assert_eq!(held(&st, "m-2"), Some(300));
        assert_eq!(held(&st, "fresh-1"), Some(150));
        assert_eq!(held(&st, "fresh-2"), Some(350));
        assert_eq!(total_held(&st), 1200);

        // A device holding the old cursor of the cleared room gets nothing, and the cursor does
        // not move backwards.
        let v = read(&st, "m-3", 3, t + 2);
        assert!(seqs(&v).is_empty());
        assert_eq!(v["next"].as_u64(), Some(3));
        // The next post to it carries on from where the room was.
        assert_eq!(seq_of(&put(&st, "m-3", "t", 100, t + 3)), 4);
    }

    #[test]
    fn pressure_never_evicts_a_room_active_within_the_peer_window() {
        let b = 21_000_000;
        // Quiet for exactly the peer window is still active; one second more is not.
        let st = small(400, 400);
        for _ in 0..4 {
            assert_eq!(put(&st, "busy", "t", 100, b).0, 200);
        }
        let refused = put(&st, "new", "t", 100, b + PEER_WINDOW);
        assert_eq!(refused, (503, r#"{"error":"relay_full"}"#.to_string()));
        assert_eq!(held_seqs(&st, "busy"), vec![1, 2, 3, 4]);
        assert!(!room_exists(&st, "new"));
        assert_eq!(seq_of(&put(&st, "new", "t", 100, b + PEER_WINDOW + 1)), 1);
        assert_eq!(held_seqs(&st, "busy"), vec![2, 3, 4]);

        // A poll renews a room: 40 s after one, the room is active however old its posts are.
        let st = small(400, 400);
        for _ in 0..4 {
            assert_eq!(put(&st, "busy", "t", 100, b).0, 200);
        }
        let _ = read(&st, "busy", 0, b + 40);
        assert_eq!(put(&st, "new", "t", 100, b + 80).0, 503);
        assert_eq!(held_seqs(&st, "busy"), vec![1, 2, 3, 4]);
        assert_eq!(put(&st, "new", "t", 100, b + 86).0, 200);
        assert_eq!(held_seqs(&st, "busy"), vec![2, 3, 4]);

        // So does a post.
        let st = small(400, 400);
        for _ in 0..3 {
            assert_eq!(put(&st, "busy", "t", 100, b).0, 200);
        }
        assert_eq!(put(&st, "busy", "t", 100, b + 40).0, 200);
        assert_eq!(put(&st, "new", "t", 100, b + 80).0, 503);
        assert_eq!(held_seqs(&st, "busy"), vec![1, 2, 3, 4]);
        assert_eq!(put(&st, "new", "t", 100, b + 86).0, 200);
        assert_eq!(held_seqs(&st, "busy"), vec![2, 3, 4]);
    }

    /// A poll that names no sender renews the room as well.
    #[test]
    fn a_poll_without_a_tag_keeps_a_room_active() {
        let st = small(400, 400);
        let b = 35_000_000;
        for _ in 0..4 {
            assert_eq!(put(&st, "busy", "t", 100, b).0, 200);
        }
        let path = "/api/relay/busy";
        let tagless = st.handle(
            &Method::Get,
            path,
            "/api/relay/busy?since=0",
            b"",
            b + 40,
            &ADDR_A,
        );
        assert_eq!(tagless.0, 200);
        assert_eq!(
            put(&st, "new", "t", 100, b + 80).0,
            503,
            "polled 40 s ago: still active"
        );
        assert_eq!(held_seqs(&st, "busy"), vec![1, 2, 3, 4]);
    }

    #[test]
    fn the_posting_room_is_not_treated_as_an_idle_room() {
        let st = small(1000, 600);
        let b = 21_500_000;
        for _ in 0..3 {
            assert_eq!(put(&st, "poster", "t", 100, b).0, 200);
        }
        for _ in 0..3 {
            assert_eq!(put(&st, "other", "t", 100, b + 10).0, 200);
        }
        // Both rooms are idle, and the poster has been idle longest. Room is made in the OTHER
        // room first; the poster keeps what it has.
        assert_eq!(seq_of(&put(&st, "poster", "t", 150, b + 100)), 4);
        assert_eq!(held_seqs(&st, "poster"), vec![1, 2, 3, 4]);
        assert_eq!(held_seqs(&st, "other"), vec![3]);
    }

    #[test]
    fn the_posting_room_drops_its_own_oldest_before_the_relay_is_full() {
        let st = small(800, 1000);
        let b = 22_000_000;
        for _ in 0..7 {
            assert_eq!(put(&st, "other", "t", 100, b).0, 200);
        }
        for _ in 0..3 {
            assert_eq!(put(&st, "mine", "t", 100, b).0, 200);
        }
        assert_eq!(total_held(&st), 1000);
        // `other` is active, so nothing else can give way: `mine` makes room for its own message
        // by dropping its own oldest, and the message just posted is the one that stays.
        assert_eq!(seq_of(&put(&st, "mine", "t", 100, b + 1)), 4);
        assert_eq!(held_seqs(&st, "mine"), vec![2, 3, 4]);
        assert_eq!(held(&st, "other"), Some(700));
        assert_eq!(health_at(&st, b + 2)["relay_full"].as_u64(), Some(0));
    }

    #[test]
    fn a_post_that_exactly_fills_the_relay_is_accepted_without_evicting() {
        let st = small(1000, 300);
        let b = 23_000_000;
        assert_eq!(put(&st, "a", "t", 100, b).0, 200);
        assert_eq!(put(&st, "a", "t", 100, b).0, 200);
        // 200 held, 100 more is exactly the ceiling.
        assert_eq!(put(&st, "b", "t", 100, b + 1).0, 200);
        assert_eq!(held_seqs(&st, "a"), vec![1, 2]);
        assert_eq!(total_held(&st), 300);
        // Any more is over it, and both rooms are active.
        assert_eq!(put(&st, "c", "t", 66, b + 2).0, 503);
    }

    #[test]
    fn a_post_that_fits_exactly_once_idle_rooms_are_cleared_is_accepted() {
        let st = small(1000, 300);
        let b = 23_500_000;
        assert_eq!(put(&st, "idle", "t", 100, b).0, 200);
        for _ in 0..2 {
            assert_eq!(put(&st, "active", "t", 100, b + 60).0, 200);
        }
        // 300 held. The active room's 200 and the new 100 are exactly the ceiling.
        assert_eq!(put(&st, "new", "t", 100, b + 70).0, 200);
        assert_eq!(held(&st, "idle"), Some(0));
        assert_eq!(held(&st, "active"), Some(200));
        assert_eq!(total_held(&st), 300);
        // One byte more than that does not fit, and the active room is still not touched.
        assert_eq!(put(&st, "newer", "t", 101, b + 71).0, 503);
        assert_eq!(held(&st, "active"), Some(200));
    }

    #[test]
    fn when_every_other_room_is_active_and_nothing_fits_the_answer_is_relay_full() {
        let st = small(500, 1000);
        let b = 24_000_000;
        for room in ["a", "b"] {
            for _ in 0..5 {
                assert_eq!(put(&st, room, "t", 100, b).0, 200);
            }
        }
        let refused = put(&st, "c", "t", 100, b + 1);
        assert_eq!(refused, (503, r#"{"error":"relay_full"}"#.to_string()));
        // Nothing was stored, and nothing else moved.
        assert!(!room_exists(&st, "c"));
        assert_eq!(held_seqs(&st, "a"), vec![1, 2, 3, 4, 5]);
        assert_eq!(held_seqs(&st, "b"), vec![1, 2, 3, 4, 5]);
        // The refusal is counted, and /health says how full the relay is.
        let h = health_at(&st, b + 100);
        assert_eq!(h["relay_full"].as_u64(), Some(1));
        assert_eq!(h["fill"].as_u64(), Some(100));
    }

    #[test]
    fn a_refused_post_changes_nothing_in_the_posting_room_either() {
        let st = small(500, 1000);
        let b = 25_000_000;
        for _ in 0..5 {
            assert_eq!(put(&st, "a", "t", 100, b).0, 200);
        }
        for _ in 0..3 {
            assert_eq!(put(&st, "b", "t", 100, b).0, 200);
        }
        assert_eq!(put(&st, "d", "t", 100, b).0, 200);
        // `d` could drop its one message, and 800 bytes in the other two rooms would still leave no
        // space for 400 more. The post is refused and `d` keeps what it had.
        assert_eq!(put(&st, "d", "t", 400, b + 1).0, 503);
        assert_eq!(held_seqs(&st, "d"), vec![1]);
        assert_eq!(held(&st, "a"), Some(500));
        assert_eq!(held(&st, "b"), Some(300));
        assert_eq!(health_at(&st, b + 100)["relay_full"].as_u64(), Some(1));
    }

    /// A refusal is decided before anything moves, so an idle room holding bytes at that moment
    /// keeps them.
    #[test]
    fn a_refused_post_leaves_idle_rooms_alone() {
        let st = small(1000, 1000);
        let b = 42_000_000;
        for _ in 0..3 {
            assert_eq!(put(&st, "idle", "t", 100, b).0, 200);
        }
        for _ in 0..7 {
            assert_eq!(put(&st, "act", "t", 100, b + 100).0, 200);
        }
        // 700 active + 400 new > 1000: refused, whatever the idle room could give up.
        assert_eq!(put(&st, "new", "t", 400, b + 101).0, 503);
        assert_eq!(held_seqs(&st, "idle"), vec![1, 2, 3]);
        assert_eq!(held(&st, "act"), Some(700));
    }

    /// A refused post does not renew the room it was posted to, nor seat its sender.
    #[test]
    fn a_refused_post_does_not_renew_the_posting_room() {
        let st = small(1000, 1000);
        let b = 43_000_000;
        for _ in 0..5 {
            assert_eq!(put(&st, "a", "t", 100, b).0, 200);
        }
        for _ in 0..5 {
            assert_eq!(put(&st, "d", "t", 100, b).0, 200);
        }
        assert_eq!(put(&st, "d", "x", 600, b + 1).0, 503);
        let rooms = st.rooms.lock().unwrap();
        assert_eq!(rooms["d"].last_active, b, "a refused post renewed the room");
        assert!(
            !rooms["d"].members.contains_key("x"),
            "a refused post seated its tag"
        );
    }

    /// The same, seen from the outside: the refused post leaves the room idle, so a later post
    /// can still have it cleared, and nobody is counted as present in it.
    #[test]
    fn a_refused_post_does_not_renew_its_room_or_record_its_sender() {
        let st = small(500, 1100);
        let b = 36_000_000;
        for room in ["a", "b"] {
            for _ in 0..5 {
                assert_eq!(put(&st, room, "t", 100, b).0, 200);
            }
        }
        assert_eq!(put(&st, "c", "t", 100, b).0, 200); // 1100 held: the relay is exactly full
        let _ = read(&st, "a", 0, b + 100);
        let _ = read(&st, "b", 0, b + 100);
        // 450 more for c cannot fit: a and b hold 1000 active bytes. The refusal must leave c alone.
        assert_eq!(put(&st, "c", "sender-of-the-refused", 450, b + 100).0, 503);
        let _ = read(&st, "a", 0, b + 130);
        let _ = read(&st, "b", 0, b + 130);
        // c was last active at b: 130 s later it is idle and a post that fits once c is cleared is
        // accepted. If the refusal had renewed c, this would be refused too.
        assert_eq!(put(&st, "d", "t", 100, b + 130).0, 200);
        assert_eq!(held(&st, "c"), Some(0));
        // A poll that names no sender, so that reading adds nobody to the count.
        let (status, body) = st.handle(
            &Method::Get,
            "/api/relay/c",
            "/api/relay/c?since=0",
            b"",
            b + 131,
            &ADDR_A,
        );
        assert_eq!(status, 200);
        let v: serde_json::Value = serde_json::from_str(&body).unwrap();
        assert_eq!(v["peers"].as_u64(), Some(0));
    }

    /// A post drops a room that has been quiet longer than the room lifetime.
    #[test]
    fn a_post_drops_a_room_past_its_ttl() {
        let st = small(1000, 1000);
        let b = 37_000_000;
        assert_eq!(put(&st, "old", "t", 300, b).0, 200);
        assert_eq!(put(&st, "new", "t", 100, b + ROOM_TTL + 1).0, 200);
        assert!(!room_exists(&st, "old"));
        assert_eq!(total_held(&st), 100);
    }

    // ---- /health: how full, never how much ------------------------------------------------------

    #[test]
    fn the_public_health_answer_carries_no_byte_figure() {
        let st = small(1000, 1000);
        let b = 26_000_000;
        assert_eq!(put(&st, "r", "t", 300, b).0, 200);
        let h = health_at(&st, b + 1);
        let obj = h.as_object().unwrap();
        let mut keys: Vec<&str> = obj.keys().map(String::as_str).collect();
        keys.sort_unstable();
        assert_eq!(
            keys,
            ["fill", "relay_full", "service", "source_digest", "status"]
        );
        assert_eq!(h["status"], "ok");
        assert_eq!(h["service"], "konclave-relay");
        assert_eq!(h["source_digest"], env!("KONCLAVE_SOURCE_DIGEST"));
        // No number in the answer is the exact total held.
        let exact = total_held(&st) as u64;
        assert_eq!(exact, 300);
        for (k, v) in obj {
            assert_ne!(v.as_u64(), Some(exact), "{k} carries the exact total");
        }
        assert!(!st.health_json(b + 1).contains("total_bytes"));
        assert_eq!(h["relay_full"].as_u64(), Some(0));
        assert_eq!(h["fill"].as_u64(), Some(30));
    }

    #[test]
    fn fill_is_a_whole_percentage_rounded_down_to_a_multiple_of_ten() {
        for (cost, expected) in [
            (99, 0),
            (100, 10),
            (199, 10),
            (200, 20),
            (999, 90),
            (1000, 100),
        ] {
            let st = small(1000, 1000);
            let b = 27_000_000;
            assert_eq!(put(&st, "r", "t", cost, b).0, 200);
            let fill = health_at(&st, b + 1)["fill"].as_u64().unwrap();
            assert_eq!(fill, expected, "{cost} of 1000 bytes held");
            assert_eq!(fill % 10, 0);
        }
    }

    #[test]
    fn the_fill_level_is_recomputed_at_most_once_a_minute() {
        let st = small(1000, 1000);
        let t0 = 28_000_000;
        assert_eq!(health_at(&st, t0)["fill"].as_u64(), Some(0));
        assert_eq!(put(&st, "r", "t", 500, t0 + 1).0, 200);
        assert_eq!(
            health_at(&st, t0 + 59)["fill"].as_u64(),
            Some(0),
            "inside the minute the level does not move"
        );
        assert_eq!(
            health_at(&st, t0 + 60)["fill"].as_u64(),
            Some(50),
            "after it, it does"
        );
        assert_eq!(put(&st, "s", "t", 300, t0 + 61).0, 200);
        assert_eq!(health_at(&st, t0 + 119)["fill"].as_u64(), Some(50));
        assert_eq!(health_at(&st, t0 + 120)["fill"].as_u64(), Some(80));
    }

    #[test]
    fn health_takes_the_rooms_lock_only_when_the_level_is_stale() {
        let st = small(1000, 1000);
        let t0 = 29_000_000;
        let _ = st.health_json(t0);
        let rooms = st.rooms.lock().unwrap();
        let answered = std::thread::scope(|s| {
            let (tx, rx) = std::sync::mpsc::channel();
            let st = &st;
            s.spawn(move || {
                let _ = tx.send(st.health_json(t0 + 10));
            });
            let got = rx.recv_timeout(std::time::Duration::from_secs(5)).is_ok();
            drop(rooms);
            got
        });
        assert!(
            answered,
            "a fresh level was served while the rooms were locked"
        );
    }

    // ---- The cost of a message: what it takes in a poll answer -----------------------------------

    #[test]
    fn the_escaped_length_is_what_serde_json_writes_between_the_quotes() {
        let mut corpus: Vec<String> = vec![String::new()];
        corpus.extend((0u32..=0x7f).map(|c| char::from_u32(c).unwrap().to_string()));
        corpus.extend(
            [
                "é",
                "ß",
                "€",
                "\u{2028}",
                "\u{ffff}",
                "😀",
                "\u{1F9E1}",
                "plain text",
                "a\"b\\c\nd\te\u{1}f\u{1f}g\u{7f}h",
                "{\"type\":\"s1\",\"commit\":\"AAAA\"}",
            ]
            .map(String::from),
        );
        for s in &corpus {
            assert_eq!(
                escaped_len(s),
                serde_json::to_string(s).unwrap().len() - 2,
                "{s:?}"
            );
        }
    }

    #[test]
    fn a_message_costs_what_it_takes_in_an_answer_plus_framing() {
        let big = "x".repeat(1000);
        let texts = [
            "",
            "plain",
            "{\"type\":\"s1\",\"commit\":\"AAAA\"}",
            "\u{1}\u{2}\"\\\n",
            "é€😀",
            big.as_str(),
        ];
        for from in ["t", "p-0123456789ab", "\u{1}\"x"] {
            for data in texts {
                for seq in [1u64, 999_999, u64::MAX] {
                    let m = Msg::new(seq, from.to_string(), data.to_string());
                    // The object as written, plus the comma after it in a list.
                    let written = serde_json::to_string(&m).unwrap().len() + 1;
                    assert!(
                        m.cost() >= written,
                        "cost {} below the {written} bytes it takes",
                        m.cost()
                    );
                    assert!(
                        m.cost() <= written + MESSAGE_FRAMING,
                        "cost {} is more than framing over the {written} bytes it takes",
                        m.cost()
                    );
                    assert_eq!(
                        m.cost(),
                        escaped_len(from) + escaped_len(data) + MESSAGE_FRAMING
                    );
                }
            }
        }
    }

    #[test]
    fn the_worst_case_message_costs_what_the_ceilings_are_checked_against() {
        let from = "\u{1}".repeat(MAX_FROM);
        let data = "\u{1}".repeat(MAX_DATA);
        assert_eq!(message_cost(&from, &data), MAX_MESSAGE_COST);
    }

    /// A room at its ceiling answers a `since=0` poll with a body no longer than the ceiling plus
    /// the object around the list, whatever the messages are made of.
    #[test]
    fn a_room_at_its_ceiling_answers_a_poll_within_the_ceiling() {
        let b = 38_500_000;
        let st = small(10_000, 100_000);
        type Maker = fn(usize) -> String;
        let makers: [(&str, Maker); 3] = [
            ("control characters", |n| "\u{1}".repeat(n)),
            ("quotes", |n| "\"".repeat(n)),
            ("plain text", |n| "p".repeat(n)),
        ];
        for (i, (name, make)) in makers.iter().enumerate() {
            let room = format!("room-{i}");
            for k in 0..40 {
                let tag = format!("t{k}");
                assert_eq!(
                    put_raw(&st, &room, &tag, &make(200 + k), b + (k as i64) / 20).0,
                    200
                );
            }
            let body = read_raw(&st, &room, 0, b + 5);
            assert!(
                body.len() <= 10_000 + 128,
                "{name}: an answer of {} bytes from a 10000 byte room",
                body.len()
            );
            assert!(held(&st, &room).unwrap() <= 10_000, "{name}");
        }
        // The extreme, at the production ceiling: messages of the largest size made of control
        // characters, six bytes written for each one stored.
        let st = RelayState::default();
        let data = "\u{1}".repeat(MAX_DATA);
        let mut now = b;
        for i in 0..7 {
            assert_eq!(put_raw(&st, "big", "t", &data, now).0, 200);
            if i % 3 == 2 {
                now += RATE_WINDOW;
            }
        }
        let body = read_raw(&st, "big", 0, now);
        assert!(
            body.len() <= 4 * 1024 * 1024 + 128,
            "an answer of {} bytes from a 4 MiB room",
            body.len()
        );
    }

    /// The `get` path hands back owned data and nothing that borrows the rooms: the answer is
    /// written out after the lock is released because the type allows nothing else.
    #[test]
    fn a_poll_snapshot_owns_what_it_holds() {
        fn owns<T: 'static>(_: &T) {}
        let st = small(1000, 1000);
        assert_eq!(put(&st, "r", "t", 100, 39_000_000).0, 200);
        let snap = st.snapshot("r", 0, Some("reader".to_string()), 39_000_001);
        owns(&snap);
        assert_eq!(snap.messages.len(), 1);
        assert_eq!(snap.next, 1);
        // With the snapshot in hand the rooms are free to be locked.
        assert!(st.rooms.try_lock().is_ok());
    }

    // ---- The room: bytes kept right ---------------------------------------------------------------

    /// Small, deterministic pseudo-random numbers: the sequence is fixed, so a failure repeats.
    struct Lcg(u64);

    impl Lcg {
        fn below(&mut self, n: u64) -> u64 {
            self.0 = self
                .0
                .wrapping_mul(6_364_136_223_846_793_005)
                .wrapping_add(1_442_695_040_888_963_407);
            (self.0 >> 33) % n
        }
    }

    fn cost_sum(room: &Room) -> usize {
        room.messages().iter().map(|m| m.cost()).sum()
    }

    #[test]
    fn room_bytes_equal_the_sum_of_message_costs() {
        let mut rng = Lcg(7);
        let mut room = Room::new(0);
        let mut last_seq = 0;
        for step in 0..4000 {
            match rng.below(100) {
                0..=84 => {
                    let from = "f".repeat(1 + rng.below(4) as usize);
                    let data = "x".repeat(rng.below(300) as usize);
                    // A ceiling that changes between pushes, from tight to out of reach.
                    let ceiling =
                        1 + rng.below(if step % 700 < 350 { 2_000 } else { 200_000 }) as usize;
                    let cost = message_cost(&from, &data);
                    let (before, count) = (room.bytes(), room.messages().len());
                    let would = room.would_drop(cost, ceiling);
                    let seq = room.push(from, data, ceiling);
                    assert!(seq > last_seq, "seq only increases, even across clears");
                    last_seq = seq;
                    assert_eq!(
                        room.bytes(),
                        before + cost - would,
                        "step {step}: push dropped other than what would_drop said ({count} held)"
                    );
                }
                85..=96 => {
                    let before = room.messages().front().map(|m| m.cost());
                    assert_eq!(room.drop_oldest(), before);
                }
                97 | 98 => {
                    let floor = rng.below(1500) as usize;
                    let kept = room.kept_at_floor(floor);
                    while room.drop_oldest_above(floor).is_some() {}
                    assert_eq!(room.bytes(), kept, "step {step}");
                }
                _ => room.clear_messages(),
            }
            assert_eq!(room.bytes(), cost_sum(&room), "step {step}");
            assert!(room.messages().len() <= MAX_MSGS);
        }
        assert!(last_seq > 1000, "the run pushed enough to mean something");
    }

    #[test]
    fn a_room_keeps_at_most_the_message_count_and_still_counts_bytes() {
        let mut room = Room::new(0);
        let cost = message_cost("t", &"x".repeat(9));
        for _ in 0..(MAX_MSGS + 90) {
            room.push("t".into(), "x".repeat(9), usize::MAX);
        }
        assert_eq!(room.messages().len(), MAX_MSGS);
        assert_eq!(room.bytes(), MAX_MSGS * cost);
        assert_eq!(room.messages().front().map(|m| m.seq), Some(91));
        // The count rule drops bytes too, and says so.
        assert_eq!(room.would_drop(cost, usize::MAX), cost);
    }

    #[test]
    fn the_newest_message_is_never_the_one_dropped() {
        let mut room = Room::new(0);
        // Larger than the ceiling: it stays, because it is the one just pushed.
        let big = message_cost("t", &"x".repeat(99));
        assert_eq!(room.push("t".into(), "x".repeat(99), 50), 1);
        assert_eq!(room.messages().len(), 1);
        assert_eq!(room.bytes(), big);
        assert_eq!(
            room.would_drop(10, 50),
            big,
            "the old one goes, not the new"
        );
        // The next message pushes the old one out, not itself.
        let next_cost = message_cost("t", &"x".repeat(9));
        assert_eq!(room.push("t".into(), "x".repeat(9), 50), 2);
        assert_eq!(
            room.messages().iter().map(|m| m.seq).collect::<Vec<_>>(),
            [2]
        );
        assert_eq!(room.bytes(), next_cost);
    }

    #[test]
    fn would_drop_is_what_a_push_drops() {
        let mut room = Room::new(0);
        assert_eq!(room.would_drop(450, 1000), 0, "an empty room drops nothing");
        for _ in 0..10 {
            room.push("t".into(), "x".repeat(100 - 1 - MESSAGE_FRAMING), 1000);
        }
        assert_eq!(room.bytes(), 1000);
        assert_eq!(room.would_drop(100, 1000), 100, "at the ceiling, one goes");
        assert_eq!(room.would_drop(450, 1000), 500, "a larger one pushes five");
        assert_eq!(room.would_drop(1, 1000), 100, "a byte over is a message");
        assert_eq!(
            room.would_drop(5000, 1000),
            1000,
            "all of it, never the new"
        );
        assert_eq!(room.would_drop(100, 1100), 0, "room for it: nothing goes");
        assert_eq!(room.would_drop(101, 1100), 100, "one byte short: one goes");
    }

    #[test]
    fn a_room_sheds_down_to_a_floor_by_whole_messages() {
        let mut room = Room::new(0);
        for _ in 0..5 {
            room.push(
                "t".into(),
                "x".repeat(100 - 1 - MESSAGE_FRAMING),
                usize::MAX,
            );
        }
        assert_eq!(
            room.kept_at_floor(500),
            500,
            "at the floor: nothing to shed"
        );
        assert_eq!(room.kept_at_floor(600), 500);
        assert_eq!(room.kept_at_floor(400), 400);
        assert_eq!(room.kept_at_floor(250), 200, "the newest messages that fit");
        assert_eq!(room.kept_at_floor(0), 0);
        assert_eq!(room.drop_oldest_above(500), None);
        assert_eq!(room.drop_oldest_above(250), Some(100));
        assert_eq!(room.drop_oldest_above(250), Some(100));
        assert_eq!(room.drop_oldest_above(250), Some(100));
        assert_eq!(room.drop_oldest_above(250), None);
        assert_eq!(room.bytes(), 200);
        assert_eq!(
            room.messages().iter().map(|m| m.seq).collect::<Vec<_>>(),
            [4, 5]
        );
    }

    /// Whatever the traffic, the relay's total is the sum of what its rooms hold, and it never
    /// exceeds the ceiling.
    fn traffic_run(st: &RelayState, room_bytes: usize, total_bytes: usize, seed: u64) -> usize {
        let mut rng = Lcg(seed);
        let mut now = 27_000_000;
        let mut refused = 0;
        for step in 0..1500 {
            now += 1 + rng.below(30) as i64;
            let room = format!("room-{}", rng.below(7));
            let cost = 66 + rng.below(300) as usize;
            match put(st, &room, "t", cost, now).0 {
                200 => {}
                503 => refused += 1,
                other => panic!("step {step}: status {other}"),
            }
            let rooms = st.rooms.lock().unwrap();
            let sum: usize = rooms.values().map(cost_sum).sum();
            let counted: usize = rooms.values().map(Room::bytes).sum();
            assert_eq!(counted, sum, "step {step}");
            assert!(counted <= total_bytes, "step {step}: {counted} bytes held");
            assert!(
                rooms.values().all(|r| r.bytes() <= room_bytes),
                "step {step}"
            );
        }
        refused
    }

    #[test]
    fn the_total_is_the_sum_of_the_rooms_whatever_the_traffic() {
        let refused = traffic_run(&small(600, 2000), 600, 2000, 11);
        assert!(refused > 0, "the run reached the ceiling");
    }

    /// With a floor and ceilings that keep the product of rooms and floor under the total, no post
    /// is ever refused: seven rooms of at most 150 and one post of at most 365 fit in 2000.
    #[test]
    fn with_a_floor_under_the_bound_no_post_is_refused_whatever_the_traffic() {
        let refused = traffic_run(&with_floor(600, 2000, 150), 600, 2000, 13);
        assert_eq!(refused, 0);
    }

    #[test]
    fn the_production_ceilings_are_the_decided_numbers() {
        assert_eq!(PRODUCTION.room_bytes, 4 * 1024 * 1024);
        assert_eq!(PRODUCTION.total_bytes, 256 * 1024 * 1024);
        assert_eq!(PRODUCTION.active_floor, 384 * 1024);
    }

    /// A maximal message (the largest data and tag a post may carry, every byte of them written
    /// as six) fits an empty room, and the next message fits beside it. The room ceiling is
    /// checked against the worst case at build time; this is the same fact through the request
    /// path, and it fails if the ceiling is ever set below one maximal message.
    #[test]
    fn a_maximal_message_and_the_next_one_both_stay_in_an_empty_room() {
        let st = RelayState::default();
        let tag = "\u{1}".repeat(MAX_FROM);
        let data = "\u{1}".repeat(MAX_DATA);
        let now = 38_000_000;
        assert_eq!(seq_of(&put_raw(&st, "r", &tag, &data, now)), 1);
        assert_eq!(seq_of(&put(&st, "r", "u", 100, now)), 2);
        assert_eq!(held_seqs(&st, "r"), vec![1, 2]);
        assert_eq!(held(&st, "r"), Some(MAX_MESSAGE_COST + 100));
    }

    /// A poll of a room nobody has written to answers empty and keeps nothing.
    #[test]
    fn a_poll_of_an_unknown_room_creates_nothing() {
        let st = RelayState::default();
        let v = read(&st, "nobody-wrote-here", 5, 29_500_000);
        assert!(seqs(&v).is_empty());
        assert_eq!(v["next"].as_u64(), Some(5));
        assert_eq!(v["peers"].as_u64(), Some(0));
        assert!(st.rooms.lock().unwrap().is_empty());
    }

    // ---- A post into a room that is full frees its own bytes ---------------------------------------

    /// When the posting room is at its own ceiling the push drops as many bytes as the post adds,
    /// so the total does not grow and no other room gives anything up for it.
    #[test]
    fn a_post_into_a_full_room_takes_nothing_from_idle_rooms() {
        let b = 40_000_000;
        // One idle room, one active, and the posting room full at the room ceiling.
        let st = small(400, 1200);
        for _ in 0..4 {
            assert_eq!(put(&st, "old", "t", 100, b).0, 200);
        }
        for room in ["busy", "full"] {
            for _ in 0..4 {
                assert_eq!(put(&st, room, "t", 100, b + 100).0, 200);
            }
        }
        assert_eq!(total_held(&st), 1200);
        assert_eq!(seq_of(&put(&st, "full", "t", 100, b + 101)), 5);
        assert_eq!(held(&st, "old"), Some(400), "the idle room kept its bytes");
        assert_eq!(held(&st, "busy"), Some(400));
        assert_eq!(held_seqs(&st, "full"), vec![2, 3, 4, 5]);
        assert_eq!(total_held(&st), 1200);

        // Two idle rooms and the posting room, all at a 300 byte ceiling.
        let st = small(300, 900);
        for room in ["idle-1", "idle-2"] {
            for _ in 0..3 {
                assert_eq!(put(&st, room, "t", 100, b).0, 200);
            }
        }
        for _ in 0..3 {
            assert_eq!(put(&st, "full", "t", 100, b + 100).0, 200);
        }
        assert_eq!(seq_of(&put(&st, "full", "t", 100, b + 101)), 4);
        assert_eq!(held(&st, "idle-1"), Some(300));
        assert_eq!(held(&st, "idle-2"), Some(300));
        assert_eq!(held_seqs(&st, "full"), vec![2, 3, 4]);
    }

    // ---- Active rooms are protected down to a floor ------------------------------------------------

    #[test]
    fn pressure_shrinks_the_largest_active_room_first_to_the_floor_and_not_below() {
        let b = 44_000_000;
        let st = with_floor(500, 1300, 100);
        for (room, count, at) in [("a", 5, 0), ("b", 4, 1), ("c", 3, 2)] {
            for _ in 0..count {
                assert_eq!(put(&st, room, "t", 100, b + at).0, 200);
            }
        }
        assert_eq!(total_held(&st), 1200);
        // 300 more with every room active: 200 over. The largest room gives up its two oldest.
        assert_eq!(put(&st, "d", "t", 300, b + 10).0, 200);
        assert_eq!(held_seqs(&st, "a"), vec![3, 4, 5]);
        assert_eq!(held(&st, "b"), Some(400));
        assert_eq!(held(&st, "c"), Some(300));
        assert_eq!(held(&st, "d"), Some(300));

        // 500 more: 500 over. `b` now has the largest excess over the floor and goes down to the
        // floor, not below it; then `a`, the oldest of three equal ones, goes down to the floor.
        assert_eq!(put(&st, "e", "t", 500, b + 11).0, 200);
        assert_eq!(held_seqs(&st, "b"), vec![4], "down to the floor");
        assert_eq!(held_seqs(&st, "a"), vec![5], "down to the floor");
        assert_eq!(held(&st, "c"), Some(300), "not needed, not touched");
        assert_eq!(held(&st, "d"), Some(300), "not needed, not touched");
        assert_eq!(held(&st, "e"), Some(500));
        assert_eq!(total_held(&st), 1300);
        assert_eq!(health_at(&st, b + 100)["relay_full"].as_u64(), Some(0));
    }

    #[test]
    fn the_newest_messages_of_an_active_room_survive_up_to_the_floor() {
        let b = 45_000_000;
        // A floor of 250 over messages of 100: the newest two or three fit under it.
        let build = || {
            let st = with_floor(1000, 1000, 250);
            for _ in 0..7 {
                assert_eq!(put(&st, "x", "t", 100, b).0, 200);
            }
            for _ in 0..3 {
                assert_eq!(put(&st, "y", "t", 100, b + 1).0, 200);
            }
            st
        };
        // 400 over: `x` gives up four and keeps its newest three, `y` is not needed.
        let st = build();
        assert_eq!(put(&st, "z", "t", 400, b + 5).0, 200);
        assert_eq!(held_seqs(&st, "x"), vec![5, 6, 7]);
        assert_eq!(held_seqs(&st, "y"), vec![1, 2, 3]);
        // 600 over: `x` goes as far as the floor lets it (the newest messages that total at most
        // 250), then `y` gives up one.
        let st = build();
        assert_eq!(put(&st, "z", "t", 600, b + 5).0, 200);
        assert_eq!(held_seqs(&st, "x"), vec![6, 7]);
        assert_eq!(held_seqs(&st, "y"), vec![2, 3]);
        assert_eq!(total_held(&st), 1000);
    }

    /// The bound the production numbers are built on, at its edge: three other rooms, each held
    /// to the floor, and one more post of a room ceiling.
    #[test]
    fn a_new_room_can_always_post_when_the_other_rooms_are_all_active_and_full() {
        let b = 46_000_000;
        // 3 rooms x floor 100 + room ceiling 300 = total 600.
        let st = with_floor(300, 600, 100);
        for (i, room) in ["r1", "r2", "r3"].iter().enumerate() {
            for _ in 0..3 {
                assert_eq!(put(&st, room, "t", 100, b + i as i64).0, 200);
            }
        }
        assert_eq!(total_held(&st), 600);
        assert_eq!(seq_of(&put(&st, "r4", "t", 300, b + 10)), 1);
        assert_eq!(held(&st, "r1"), Some(100));
        assert_eq!(held(&st, "r2"), Some(100));
        assert_eq!(held(&st, "r3"), Some(100));
        assert_eq!(held(&st, "r4"), Some(300));
        assert_eq!(total_held(&st), 600);
        assert_eq!(health_at(&st, b + 100)["relay_full"].as_u64(), Some(0));
    }

    #[test]
    fn the_posting_room_is_never_an_eviction_candidate_among_active_rooms() {
        let b = 47_500_000;
        let st = with_floor(800, 1300, 100);
        for _ in 0..6 {
            assert_eq!(put(&st, "mine", "t", 100, b).0, 200);
        }
        for _ in 0..6 {
            assert_eq!(put(&st, "other", "t", 100, b + 1).0, 200);
        }
        // `mine` is the older of two rooms with the same excess over the floor, and the one
        // posting: the other gives the 100 bytes up.
        assert_eq!(seq_of(&put(&st, "mine", "t", 200, b + 2)), 7);
        assert_eq!(held_seqs(&st, "mine"), vec![1, 2, 3, 4, 5, 6, 7]);
        assert_eq!(held(&st, "other"), Some(500));
    }

    #[test]
    fn idle_rooms_give_way_before_active_rooms_above_the_floor() {
        let b = 48_000_000;
        let st = with_floor(500, 1000, 100);
        for _ in 0..3 {
            assert_eq!(put(&st, "idle", "t", 100, b).0, 200);
        }
        for _ in 0..5 {
            assert_eq!(put(&st, "active", "t", 100, b + 100).0, 200);
        }
        assert_eq!(put(&st, "new", "t", 300, b + 101).0, 200);
        assert_eq!(held(&st, "idle"), Some(200));
        assert_eq!(
            held(&st, "active"),
            Some(500),
            "above the floor, not needed"
        );
    }

    /// Ceilings that do not keep the bound: the refusal is still there, still moves nothing, and
    /// is counted.
    #[test]
    fn with_ceilings_that_break_the_bound_the_refusal_still_works_and_moves_nothing() {
        let b = 49_000_000;
        let st = with_floor(500, 700, 200);
        for _ in 0..5 {
            assert_eq!(put(&st, "a", "t", 100, b).0, 200);
        }
        for _ in 0..2 {
            assert_eq!(put(&st, "b", "t", 100, b + 1).0, 200);
        }
        // a and b can be held to 200 each, which leaves 300: 500 more cannot fit.
        let refused = put(&st, "c", "t", 500, b + 2);
        assert_eq!(refused, (503, r#"{"error":"relay_full"}"#.to_string()));
        assert_eq!(held_seqs(&st, "a"), vec![1, 2, 3, 4, 5]);
        assert_eq!(held_seqs(&st, "b"), vec![1, 2]);
        assert!(!room_exists(&st, "c"));
        assert_eq!(health_at(&st, b + 100)["relay_full"].as_u64(), Some(1));
    }

    /// `from=` with nothing after it names no sender, as no `from` at all does: the poll seats
    /// nobody.
    #[test]
    fn a_poll_with_an_empty_tag_seats_nobody() {
        let st = small(400, 400);
        let b = 53_000_000;
        assert_eq!(put(&st, "r", "t", 100, b).0, 200);
        let (status, body) = st.handle(
            &Method::Get,
            "/api/relay/r",
            "/api/relay/r?since=0&from=",
            b"",
            b + 100,
            &ADDR_A,
        );
        assert_eq!(status, 200);
        let v: serde_json::Value = serde_json::from_str(&body).unwrap();
        assert_eq!(v["peers"].as_u64(), Some(0));
        assert!(!st.rooms.lock().unwrap()["r"].members.contains_key(""));
    }

    // ---- The edges, one byte either side --------------------------------------------------------

    #[test]
    fn a_room_one_byte_over_its_ceiling_drops_its_oldest_message() {
        let b = 50_000_000;
        for (cost, kept) in [(65, vec![1, 2, 3, 4]), (66, vec![2, 3, 4])] {
            let st = small(365, 10_000);
            for _ in 0..3 {
                assert_eq!(put(&st, "r", "t", 100, b).0, 200);
            }
            assert_eq!(seq_of(&put(&st, "r", "t", cost, b)), 4);
            assert_eq!(held_seqs(&st, "r"), kept, "a post of {cost} onto 300");
        }
    }

    #[test]
    fn a_post_one_byte_over_the_relay_ceiling_is_refused() {
        let b = 51_000_000;
        for (total, cost, accepted) in [(365, 65, true), (365, 66, false), (366, 66, true)] {
            let st = small(1000, total);
            for _ in 0..2 {
                assert_eq!(put(&st, "a", "t", 100, b).0, 200);
            }
            assert_eq!(put(&st, "b", "t", 100, b).0, 200);
            let status = put(&st, "c", "t", cost, b + 1).0;
            assert_eq!(
                status == 200,
                accepted,
                "a post of {cost} onto 300 under {total}"
            );
        }
    }

    /// A poll, like a post, drops a room that has been quiet longer than the room lifetime.
    #[test]
    fn a_poll_does_not_return_a_room_past_its_ttl() {
        let st = small(1000, 1000);
        let b = 52_000_000;
        assert_eq!(put(&st, "old", "t", 300, b).0, 200);
        let v = read(&st, "old", 0, b + ROOM_TTL + 1);
        assert!(seqs(&v).is_empty());
        assert!(!room_exists(&st, "old"));
    }

    // ---- The last audits: cost stored once, the cache not held, the edges they named --------------

    /// A message's cost is worked out once, when it is made. `make_room` asks every other active
    /// room what it keeps at the floor, and each answer walks that room's messages; if the walk
    /// read a message's bytes again to cost it, a post at the ceiling would read the whole relay
    /// while it holds the rooms lock (measured on the real binary: 42 ms a post against 0.8 ms).
    /// The bound is generous on purpose, for the debug profile tests run in: the walk over 31
    /// stored costs takes microseconds (5 us measured), reading the bytes of the same messages
    /// again takes most of a second (900 ms measured).
    #[test]
    fn asking_what_a_full_room_keeps_does_not_read_its_messages_again() {
        let mut room = Room::new(0);
        let data = "d".repeat(MAX_DATA);
        for _ in 0..40 {
            room.push("t".into(), data.clone(), 4 * 1024 * 1024);
        }
        assert!(room.bytes() > 4_000_000, "the room is full");
        let started = std::time::Instant::now();
        for _ in 0..20 {
            assert!(room.kept_at_floor(384 * 1024) <= 384 * 1024);
            assert!(room.would_drop(MAX_DATA, 4 * 1024 * 1024) > 0);
        }
        let took = started.elapsed();
        assert!(
            took < std::time::Duration::from_millis(100),
            "40 questions to a full room took {took:?}"
        );
    }

    /// A stale level is worked out without holding the cache: while one `/health` waits for the
    /// rooms, nothing else that wants the cache waits behind it.
    #[test]
    fn a_stale_level_is_worked_out_without_holding_the_cache() {
        let st = small(1000, 1000);
        let t0 = 29_100_000;
        let rooms = st.rooms.lock().unwrap();
        let free_meanwhile = std::thread::scope(|s| {
            let st = &st;
            let (tx, rx) = std::sync::mpsc::channel();
            s.spawn(move || {
                let _ = tx.send(());
                // Stale: nothing was ever worked out, so this waits for the rooms.
                let _ = st.health_json(t0 + 100);
            });
            rx.recv().unwrap();
            // Give the call time to reach the rooms lock, then ask for the cache.
            std::thread::sleep(std::time::Duration::from_millis(300));
            let free = st.fill_cache.try_lock().is_ok();
            drop(rooms);
            free
        });
        assert!(
            free_meanwhile,
            "the cache was held while the rooms were waited for"
        );
        assert_eq!(health_at(&st, t0 + 101)["fill"].as_u64(), Some(0));
    }

    /// A post one byte more than the active rooms leave room for is refused before anything
    /// moves: the idle room keeps every message. One byte less and the same post is accepted once
    /// the idle room has been cleared.
    #[test]
    fn a_post_one_byte_too_big_for_the_active_rooms_is_refused_and_moves_nothing() {
        let b = 60_500_000;
        let build = || {
            let st = small(1000, 1000);
            for _ in 0..3 {
                assert_eq!(put(&st, "idle", "t", 100, b).0, 200);
            }
            for _ in 0..7 {
                assert_eq!(put(&st, "act", "t", 100, b + 100).0, 200);
            }
            st
        };
        let st = build();
        // 700 active + 301 = 1001 > 1000: refused, whatever the idle room could give up.
        assert_eq!(put(&st, "new", "t", 301, b + 101).0, 503);
        assert_eq!(
            held_seqs(&st, "idle"),
            vec![1, 2, 3],
            "a refusal took the idle room's messages"
        );
        assert_eq!(held(&st, "act"), Some(700));
        assert!(!room_exists(&st, "new"));
        assert_eq!(health_at(&st, b + 200)["relay_full"].as_u64(), Some(1));
        // One byte less fits exactly, and costs the idle room everything.
        let st = build();
        assert_eq!(put(&st, "new", "t", 300, b + 101).0, 200);
        assert_eq!(held(&st, "idle"), Some(0));
        assert_eq!(total_held(&st), 1000);
    }

    /// The posting room could drop its own messages to make room, but even empty it could not make
    /// this post fit beside the other rooms' newest messages: the refusal leaves it whole.
    #[test]
    fn a_post_that_cannot_fit_even_beside_an_emptied_posting_room_leaves_that_room_whole() {
        let b = 61_500_000;
        let st = small(300, 600);
        for room in ["o1", "o2", "p"] {
            for _ in 0..2 {
                assert_eq!(put(&st, room, "t", 100, b).0, 200);
            }
        }
        assert_eq!(total_held(&st), 600);
        // o1 and o2 hold 400 and are active; 400 + 250 > 600 even with `p` emptied.
        assert_eq!(put(&st, "p", "t", 250, b + 1).0, 503);
        assert_eq!(
            held_seqs(&st, "p"),
            vec![1, 2],
            "the refused post emptied the posting room"
        );
        assert_eq!(held(&st, "o1"), Some(200));
        assert_eq!(held(&st, "o2"), Some(200));
        assert_eq!(health_at(&st, b + 100)["relay_full"].as_u64(), Some(1));
    }

    /// A post may empty its own room when that is what it takes. The other room pins 500 of 950;
    /// the posting room holds 300 and is asked for 450 more, and only by dropping all three of its
    /// messages does the post fit. Counting what the post adds before the room started to shrink
    /// would stop after one drop and refuse the post after taking a message for nothing.
    #[test]
    fn a_post_may_empty_its_own_room_when_that_is_what_it_takes() {
        let b = 64_500_000;
        let st = small(600, 950);
        for _ in 0..5 {
            assert_eq!(put(&st, "o", "t", 100, b).0, 200);
        }
        for _ in 0..3 {
            assert_eq!(put(&st, "p", "t", 100, b).0, 200);
        }
        assert_eq!(seq_of(&put(&st, "p", "t", 450, b + 1)), 4);
        assert_eq!(held_seqs(&st, "p"), vec![4]);
        assert_eq!(held(&st, "o"), Some(500));
        assert_eq!(total_held(&st), 950);
    }

    /// With ceilings that break the bound, the posting room near its own ceiling drops its oldest
    /// until the post fits counting the post whole, and the post is accepted.
    #[test]
    fn the_posting_room_counts_the_whole_post_once_it_drops_its_own() {
        let b = 61_000_000;
        let st = with_floor(600, 760, 200);
        assert_eq!(put(&st, "o", "t", 200, b).0, 200);
        for cost in [200, 200, 100] {
            assert_eq!(put(&st, "p", "t", cost, b).0, 200);
        }
        assert_eq!(seq_of(&put(&st, "p", "t", 300, b + 1)), 4);
        assert_eq!(held_seqs(&st, "p"), vec![3, 4]);
        assert_eq!(held(&st, "o"), Some(200));
    }

    /// Equal excess over the floor: the room whose last activity is older gives way first,
    /// whatever its name. The older room has the name that sorts last. The rooms are in a HashMap,
    /// so the scene runs on several fresh states and a missing sort cannot pass by luck.
    #[test]
    fn equal_excess_goes_to_the_older_room_not_the_first_name() {
        for _ in 0..12 {
            let b = 60_000_000;
            let st = with_floor(500, 700, 100);
            for _ in 0..3 {
                assert_eq!(put(&st, "zz-older", "t", 100, b).0, 200);
            }
            for _ in 0..3 {
                assert_eq!(put(&st, "aa-newer", "t", 100, b + 1).0, 200);
            }
            assert_eq!(put(&st, "new", "t", 200, b + 2).0, 200);
            assert_eq!(held_seqs(&st, "zz-older"), vec![2, 3]);
            assert_eq!(held_seqs(&st, "aa-newer"), vec![1, 2, 3]);
        }
    }

    /// The same, for the largest excess: the order of the rooms is by excess and not by luck.
    #[test]
    fn the_largest_excess_goes_first_whatever_order_the_rooms_are_kept_in() {
        for _ in 0..12 {
            let b = 65_000_000;
            let st = with_floor(900, 1500, 100);
            // Excess over the floor: big 500, mid 300, low 100. The one with the most is the one
            // most recently active, so neither the name nor the age gives the order away.
            for (room, count, at) in [("big", 6, 2), ("mid", 4, 1), ("low", 2, 0)] {
                for _ in 0..count {
                    assert_eq!(put(&st, room, "t", 100, b + at).0, 200);
                }
            }
            assert_eq!(total_held(&st), 1200);
            // 600 over: the biggest goes down to the floor (500) before the next is touched, and
            // the next gives the last 100.
            assert_eq!(put(&st, "new", "t", 900, b + 3).0, 200);
            assert_eq!(held(&st, "big"), Some(100));
            assert_eq!(held(&st, "mid"), Some(300));
            assert_eq!(held(&st, "low"), Some(200));
            assert_eq!(total_held(&st), 1500);
        }
    }

    /// The refusal count is since the process started: reading it does not reset it, nor does a
    /// later post that is accepted.
    #[test]
    fn the_refusal_count_survives_reads_and_successes() {
        let b = 62_000_000;
        let st = small(500, 1000);
        for room in ["a", "b"] {
            for _ in 0..5 {
                assert_eq!(put(&st, room, "t", 100, b).0, 200);
            }
        }
        assert_eq!(put(&st, "c", "t", 100, b + 1).0, 503);
        assert_eq!(health_at(&st, b + 2)["relay_full"].as_u64(), Some(1));
        assert_eq!(health_at(&st, b + 3)["relay_full"].as_u64(), Some(1));
        assert_eq!(put(&st, "a", "t", 100, b + 4).0, 200);
        assert_eq!(health_at(&st, b + 5)["relay_full"].as_u64(), Some(1));
    }

    /// The level is a share of the TOTAL ceiling. Every other `fill` test has a room ceiling equal
    /// to the total, which cannot tell the two apart.
    #[test]
    fn fill_is_a_share_of_the_total_ceiling_not_of_the_room_ceiling() {
        let b = 62_500_000;
        let st = small(500, 2000);
        assert_eq!(put(&st, "r", "t", 500, b).0, 200);
        assert_eq!(
            health_at(&st, b + 1)["fill"].as_u64(),
            Some(20),
            "500 of 2000 is 25 percent, rounded down"
        );
        let st = small(1000, 2000);
        assert_eq!(put(&st, "r", "t", 500, b).0, 200);
        assert_eq!(health_at(&st, b + 1)["fill"].as_u64(), Some(20));
    }

    /// A clock that steps back does not freeze the level until it catches up.
    #[test]
    fn a_clock_that_steps_back_recomputes_the_level() {
        let st = small(1000, 1000);
        let t0 = 63_000_000;
        assert_eq!(health_at(&st, t0)["fill"].as_u64(), Some(0));
        assert_eq!(put(&st, "r", "t", 500, t0 + 1).0, 200);
        assert_eq!(health_at(&st, t0 - 100)["fill"].as_u64(), Some(50));
    }

    /// The CHANGELOG names the framing: 64. The cost test only needs it to be at least 49 (what the
    /// object around a message takes at most), so 63 or 50 would pass; this pins the documented
    /// number.
    #[test]
    fn the_framing_is_the_sixty_four_the_changelog_names() {
        assert_eq!(MESSAGE_FRAMING, 64);
    }

    /// An accepted post counts its sender among the peers in its own answer.
    #[test]
    fn an_accepted_post_seats_its_sender() {
        let st = small(1000, 1000);
        let answer = put(&st, "r", "t", 100, 63_500_000);
        let v: serde_json::Value = serde_json::from_str(&answer.1).unwrap();
        assert_eq!(v["peers"].as_u64(), Some(1));
    }

    /// The cost stored in a message is not part of the answer: a message is written as
    /// `seq`, `from` and `data` and nothing else.
    #[test]
    fn a_message_is_written_as_seq_from_and_data_only() {
        let m = Msg::new(7, "t".to_string(), "hello".to_string());
        let v: serde_json::Value = serde_json::to_value(&m).unwrap();
        let mut keys: Vec<&str> = v.as_object().unwrap().keys().map(String::as_str).collect();
        keys.sort_unstable();
        assert_eq!(keys, ["data", "from", "seq"]);
        assert_eq!(m.cost(), message_cost("t", "hello"));
    }
}
