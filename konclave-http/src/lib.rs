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

/// A fixed-window limiter: at most `max` requests per window, per key.
///
/// It was written for the relay (#64) and lived in the relay's own file. The coordinator had none
/// (#558), for the reason this crate exists: the rule was somewhere only one of the two servers
/// could reach. It is dependency-free, O(1) amortized, and takes `now` instead of reading a clock,
/// so a test can move time rather than sleep through it.
///
/// A key is whatever the caller wants to count by. A client address is the robust one, since a
/// flooding source cannot cheaply change it; anything the client chooses (a tag, a name) can be
/// rotated to dodge the limit.
pub struct RateLimiter {
    window_secs: i64,
    max_keys: usize,
    // key -> (window_start, count_in_window)
    seen: std::sync::Mutex<std::collections::HashMap<String, (i64, u32)>>,
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
    pub fn allow(&self, key: &str, now: i64, max: u32) -> bool {
        // A panic while holding this lock must not wedge every later request behind a poisoned
        // mutex: the counts are advisory, so the inner value is still the right thing to use.
        let mut seen = self.seen.lock().unwrap_or_else(|e| e.into_inner());
        if seen.len() > self.max_keys {
            let window = self.window_secs;
            seen.retain(|_, (start, _)| now.saturating_sub(*start) < window);
        }
        let entry = seen.entry(key.to_string()).or_insert((now, 0));
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
/// Takes strings, not a request, so this crate stays free of any HTTP library.
pub fn client_address(forwarded_for: Option<&str>, remote: Option<&str>) -> String {
    let first_hop = forwarded_for
        .and_then(|v| v.split(',').next())
        .map(str::trim)
        .filter(|hop| !hop.is_empty());
    first_hop
        .or_else(|| remote.map(str::trim).filter(|r| !r.is_empty()))
        .unwrap_or("unknown")
        .to_string()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_request_past_the_limit_is_refused_and_the_next_window_starts_over() {
        let l = RateLimiter::new(10, 64);
        let now = 1_000_000;
        for i in 0..5 {
            assert!(l.allow("k", now, 5), "request {i} is within the limit");
        }
        assert!(
            !l.allow("k", now, 5),
            "the 6th in the same window is refused"
        );
        assert!(
            !l.allow("k", now + 9, 5),
            "and still refused inside the window"
        );
        assert!(l.allow("k", now + 10, 5), "a new window starts over");
    }

    #[test]
    fn keys_are_counted_separately() {
        let l = RateLimiter::new(10, 64);
        let now = 2_000_000;
        for _ in 0..6 {
            let _ = l.allow("a", now, 5);
        }
        assert!(!l.allow("a", now, 5), "a is over its limit");
        assert!(l.allow("b", now, 5), "and b has its own");
    }

    /// The map must not grow without bound under many distinct sources. Past `max_keys`, windows
    /// that have ended are reclaimed; windows still open are kept, because dropping one would hand
    /// its source a fresh allowance.
    #[test]
    fn ended_windows_are_reclaimed_and_open_ones_are_kept() {
        let l = RateLimiter::new(10, 4);
        for i in 0..5 {
            let _ = l.allow(&format!("old-{i}"), 1_000, 5);
        }
        assert_eq!(l.tracked(), 5);
        // One more, a window later: the five old windows have ended and go.
        assert!(l.allow("new", 1_010, 5));
        assert_eq!(l.tracked(), 1, "only the open window remains");

        // Open windows survive a reclaim, and a source over its limit stays refused.
        let l = RateLimiter::new(10, 2);
        for _ in 0..6 {
            let _ = l.allow("flooder", 2_000, 5);
        }
        let _ = l.allow("x", 2_000, 5);
        let _ = l.allow("y", 2_000, 5);
        let _ = l.allow("z", 2_001, 5);
        assert!(
            !l.allow("flooder", 2_002, 5),
            "a reclaim must not hand a flooding source a fresh allowance"
        );
    }

    #[test]
    fn the_first_forwarded_hop_is_the_client() {
        assert_eq!(
            client_address(Some("203.0.113.7, 10.0.0.1, 10.0.0.2"), Some("10.0.0.2")),
            "203.0.113.7"
        );
        assert_eq!(
            client_address(Some("  203.0.113.7  "), Some("10.0.0.2")),
            "203.0.113.7",
            "surrounding space is not part of the address"
        );
    }

    #[test]
    fn without_a_forwarded_header_the_socket_is_the_client() {
        assert_eq!(client_address(None, Some("198.51.100.9")), "198.51.100.9");
        assert_eq!(
            client_address(Some(""), Some("198.51.100.9")),
            "198.51.100.9",
            "an empty header is an absent one"
        );
        assert_eq!(
            client_address(Some(" , 10.0.0.1"), Some("198.51.100.9")),
            "198.51.100.9",
            "an empty first hop is not an address"
        );
    }

    /// Every unknown client shares one key. That is deliberate: a request with no address at all
    /// must still be limited, and must not get a key of its own to be counted alone under.
    #[test]
    fn a_client_with_no_address_at_all_is_still_a_key() {
        assert_eq!(client_address(None, None), "unknown");
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
