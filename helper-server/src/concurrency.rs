//! Serving more than one request at a time, without letting two of them fight over a vault.
//!
//! The helper used to handle requests in a serial loop, so a single send - which polls the relay
//! for the browsers' signatures for up to five minutes - made the whole service indistinguishable
//! from dead, `/api/health` included. That took the vault down on 2026-08-27 (#375).
//!
//! Concurrency alone would trade an outage for something worse. Each vault owns a directory on the
//! durable volume - a view-only wallet, its proposals, its member roster - and the handlers reach
//! it through subprocesses. Two requests for the SAME vault running at once would write over each
//! other there. So the fix is two pieces that only work together: requests run in parallel, and
//! everything touching one vault is serialised on that vault's own lock.
//!
//! What this deliberately does NOT do is make a send fast. A send still holds its vault for as long
//! as the quorum takes to sign, and that vault's other requests wait behind it. What changes is the
//! blast radius: every OTHER vault, and liveness, keep answering. Removing the five-minute hold
//! itself is a different change (a queued job with a status endpoint) and a different contract.

use std::collections::HashMap;
use std::sync::{Arc, Mutex};

/// Which vault a request is about, or `None` for one that touches no vault (health, 404s).
///
/// Pure so the routing table's shape is unit-testable: the id arrives three different ways, and a
/// request whose vault we fail to read would run unserialised, which is exactly the case that
/// corrupts a directory. Reading the body here costs one extra JSON parse per request against
/// handlers that already shell out to the engine.
pub fn request_vault(query: &str, body: &[u8]) -> Option<String> {
    if let Some(v) = query_vault(query) {
        return Some(v.to_string());
    }
    let v: serde_json::Value = serde_json::from_slice(body).ok()?;
    // `vault` on every operation route; `group_key` on registration, which names the same thing.
    for key in ["vault", "group_key"] {
        if let Some(s) = v.get(key).and_then(|x| x.as_str()) {
            if !s.is_empty() {
                return Some(s.to_string());
            }
        }
    }
    None
}

fn query_vault(query: &str) -> Option<&str> {
    query.split('&').find_map(|kv| {
        let (k, v) = kv.split_once('=')?;
        (k == "vault" && !v.is_empty()).then_some(v)
    })
}

/// One lock per vault, created on first use.
///
/// The registry itself is only ever held long enough to hand out an `Arc` - never across the
/// request - so a five-minute send blocks its own vault and nothing else.
#[derive(Default)]
pub struct VaultLocks {
    locks: Mutex<HashMap<String, Arc<Mutex<()>>>>,
}

impl VaultLocks {
    pub fn new() -> Self {
        Self::default()
    }

    /// The lock for `vault`. Callers hold the returned `Arc` for as long as they hold its guard.
    pub fn for_vault(&self, vault: &str) -> Arc<Mutex<()>> {
        let mut map = self.locks.lock().unwrap_or_else(|e| e.into_inner());
        map.entry(vault.to_string())
            .or_insert_with(|| Arc::new(Mutex::new(())))
            .clone()
    }

    /// How many vaults have a lock. Test-only: nothing in the service reads it, and an unused
    /// public method would fail CI's `clippy -D warnings`.
    #[cfg(test)]
    pub fn len(&self) -> usize {
        self.locks.lock().unwrap_or_else(|e| e.into_inner()).len()
    }

    #[cfg(test)]
    pub fn is_empty(&self) -> bool {
        self.len() == 0
    }
}

/// How many requests may be served at once.
///
/// A send occupies a worker for as long as the quorum takes, so the pool has to be wide enough that
/// several concurrent ceremonies still leave room for reads and for liveness. It is not a
/// throughput dial: the work is subprocesses and network waiting, not CPU.
pub fn worker_count(env: Option<&str>, parallelism: usize) -> usize {
    if let Some(n) = env.and_then(|s| s.trim().parse::<usize>().ok()) {
        if n > 0 {
            return n.min(256);
        }
    }
    (parallelism * 4).clamp(16, 64)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reads_the_vault_from_the_query_string() {
        assert_eq!(request_vault("vault=abc&x=1", b""), Some("abc".into()));
        assert_eq!(request_vault("x=1&vault=abc", b""), Some("abc".into()));
    }

    #[test]
    fn reads_the_vault_from_the_body_when_the_query_has_none() {
        assert_eq!(
            request_vault("", br#"{"vault":"deadbeef","to":"u1..."}"#),
            Some("deadbeef".into())
        );
    }

    #[test]
    fn reads_registration_by_its_own_field_name() {
        // `POST /api/vault` calls the same thing `group_key`, and it must serialise with the rest:
        // registering runs the engine against the vault's directory.
        assert_eq!(
            request_vault("", br#"{"group_key":"ff00","name":"treasury"}"#),
            Some("ff00".into())
        );
    }

    #[test]
    fn prefers_the_query_string_over_the_body() {
        assert_eq!(
            request_vault("vault=fromquery", br#"{"vault":"frombody"}"#),
            Some("fromquery".into())
        );
    }

    #[test]
    fn is_none_for_a_request_that_touches_no_vault() {
        // Health is the one that matters: it must never queue behind anything.
        assert_eq!(request_vault("", b""), None);
        assert_eq!(request_vault("other=1", b"not json"), None);
        assert_eq!(request_vault("", br#"{"unrelated":true}"#), None);
    }

    #[test]
    fn treats_an_empty_id_as_absent_rather_than_locking_on_the_empty_string() {
        // Otherwise every malformed request would serialise against every other one.
        assert_eq!(request_vault("vault=", b""), None);
        assert_eq!(request_vault("", br#"{"vault":""}"#), None);
    }

    #[test]
    fn hands_out_the_same_lock_for_the_same_vault_and_different_ones_otherwise() {
        let locks = VaultLocks::new();
        assert!(locks.is_empty(), "a fresh registry holds no locks");
        let a1 = locks.for_vault("a");
        let a2 = locks.for_vault("a");
        let b = locks.for_vault("b");
        assert!(Arc::ptr_eq(&a1, &a2));
        assert!(!Arc::ptr_eq(&a1, &b));
        assert_eq!(locks.len(), 2);
    }

    #[test]
    fn a_held_vault_lock_does_not_block_another_vault() {
        let locks = Arc::new(VaultLocks::new());
        let a = locks.for_vault("a");
        let held = a.lock().expect("lock a");

        let l2 = locks.clone();
        let done = std::thread::spawn(move || {
            let b = l2.for_vault("b");
            let _g = b.lock().expect("lock b");
            true
        });
        // Vault b must not wait on vault a: this join would hang if the registry were held across
        // the request, which is the bug this whole change exists to avoid reintroducing.
        assert!(done.join().expect("thread b"));
        drop(held);
    }

    #[test]
    fn two_requests_for_the_same_vault_never_overlap() {
        // The point of the lock, asserted as behaviour rather than as pointer identity: without it
        // two sends would run the engine against one wallet directory at the same time.
        use std::sync::atomic::{AtomicUsize, Ordering};
        let locks = Arc::new(VaultLocks::new());
        let inside = Arc::new(AtomicUsize::new(0));
        let max_seen = Arc::new(AtomicUsize::new(0));

        let workers: Vec<_> = (0..8)
            .map(|_| {
                let (locks, inside, max_seen) = (locks.clone(), inside.clone(), max_seen.clone());
                std::thread::spawn(move || {
                    for _ in 0..10 {
                        let m = locks.for_vault("same-vault");
                        let _g = m.lock().unwrap_or_else(|e| e.into_inner());
                        let n = inside.fetch_add(1, Ordering::SeqCst) + 1;
                        max_seen.fetch_max(n, Ordering::SeqCst);
                        // The critical section has to LAST, or the threads simply never meet and
                        // the test passes with the lock removed - which it did, the first time.
                        std::thread::sleep(std::time::Duration::from_millis(2));
                        inside.fetch_sub(1, Ordering::SeqCst);
                    }
                })
            })
            .collect();
        for w in workers {
            w.join().expect("worker");
        }
        assert_eq!(
            max_seen.load(Ordering::SeqCst),
            1,
            "two requests were inside the same vault at once"
        );
    }

    #[test]
    fn worker_count_honours_the_environment_then_falls_back_to_the_machine() {
        assert_eq!(worker_count(Some("7"), 8), 7);
        assert_eq!(worker_count(Some(" 12 "), 8), 12);
        // Garbage and zero fall through to the computed value rather than serving nothing.
        assert_eq!(worker_count(Some("0"), 4), 16);
        assert_eq!(worker_count(Some("abc"), 4), 16);
        assert_eq!(worker_count(None, 1), 16); // a one-core container still serves in parallel
        assert_eq!(worker_count(None, 8), 32);
        assert_eq!(worker_count(None, 64), 64); // capped
        assert_eq!(worker_count(Some("99999"), 8), 256); // capped
    }
}
