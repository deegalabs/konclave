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
//! everything that CHANGES one vault is serialised on that vault's own lock. The vault locked has to
//! be the vault the handler acts on, which is why a request naming two is refused (#576).
//!
//! What this deliberately does NOT do is make a send fast. A send still holds its vault for as long
//! as the quorum takes to sign, and that vault's other WRITES wait behind it. What changes is the
//! blast radius: every OTHER vault, liveness and, since S3, every READ of the same vault keep
//! answering (a read takes no write lock; the wallet is a second lock that readers only try, or wait
//! a few seconds for when nothing is sending).
//! Removing the five-minute hold itself is a different change (a queued job with a status endpoint)
//! and a different contract.

use std::collections::HashMap;
use std::sync::{Arc, Mutex, MutexGuard, TryLockError};
use std::time::Instant;

/// Which vault a request is about: `Ok(None)` for one that touches no vault (health, 404s), and
/// `Err` for one whose vault cannot be read with certainty.
///
/// Pure so the routing table's shape is unit-testable: the id arrives three different ways, and a
/// request whose vault we fail to read would run unserialised, which is exactly the case that
/// corrupts a directory. Reading the body here costs one extra JSON parse per request against
/// handlers that already shell out to the engine.
///
/// Two rules, both from #576, and both refuse rather than guess:
///
/// - EVERY place a request names a vault has to agree. This used to pick one: the query first, then
///   `vault` in the body, then `group_key`. The handlers do not pick the same way - a GET reads the
///   first `vault=` of the query, most POSTs read `vault` in the body, and the registration routes
///   read `group_key` - so a request naming one vault in the query and another in the body was
///   locked on the first and acted on the second, and a vote racing a rename recorded one member's
///   approval twice. An empty `vault=` beside a real one is a disagreement too, so the first value,
///   which is what a GET handler reads, is always the one locked.
/// - A body has to be EMPTY or a JSON OBJECT this function can read by name. The handlers read the
///   same bytes with serde's derived deserializers, which accept a JSON array by position and skip
///   values a `serde_json::Value` refuses (a number like `1e400`, nesting past 128, a lone
///   surrogate, invalid UTF-8). Before, any such body read as "no vault here" and ran with no lock
///   at all, while its handler found the vault and acted on it. Every route takes an object, and the
///   app sends nothing else.
///
/// Requiring agreement over every named field of an object, rather than teaching this function
/// which field each route reads, keeps the rule in one place: whichever of them a handler reads, it
/// is the vault that was locked. A routing table here would be a second copy of the router, and the
/// first route added without updating it would reopen this.
pub fn request_vault(query: &str, body: &[u8]) -> Result<Option<String>, Unlockable> {
    let in_query = query.split('&').filter_map(|kv| {
        let (k, v) = kv.split_once('=')?;
        (k == "vault").then_some(v)
    });
    let fields = if body.iter().all(u8::is_ascii_whitespace) {
        None
    } else {
        match serde_json::from_slice(body) {
            Ok(serde_json::Value::Object(fields)) => Some(fields),
            _ => return Err(Unlockable::NotAnObject),
        }
    };
    // `vault` on every operation route; `group_key` on registration, which names the same thing.
    let in_body = ["vault", "group_key"]
        .into_iter()
        .filter_map(|key| fields.as_ref()?.get(key)?.as_str());

    let mut named: Option<&str> = None;
    for v in in_query.chain(in_body) {
        match named {
            None => named = Some(v),
            Some(n) if n == v => {}
            Some(_) => return Err(Unlockable::TwoVaults),
        }
    }
    // An empty id is absent rather than a vault: otherwise every malformed request would
    // serialise against every other one.
    Ok(named.filter(|v| !v.is_empty()).map(str::to_string))
}

/// A request with no right vault to lock for. It is refused before any lock is taken.
#[derive(Debug, PartialEq, Eq)]
pub enum Unlockable {
    /// Two places in the request name different vaults.
    TwoVaults,
    /// The body is neither empty nor a JSON object, so the vault it names cannot be read by name.
    NotAnObject,
}

impl Unlockable {
    /// The reason, for the 400 the caller sends.
    pub fn message(&self) -> &'static str {
        match self {
            Unlockable::TwoVaults => "the request names more than one vault",
            Unlockable::NotAnObject => "the request body must be a JSON object",
        }
    }
}

/// One lock per vault, created on first use.
///
/// The registry itself is only ever held long enough to hand out an `Arc` - never across the
/// request - so a five-minute send blocks its own vault and nothing else.
#[derive(Default)]
pub struct VaultLocks {
    /// The WRITE lock: a send, a vote, a rename, a registration. Held for the whole request.
    locks: Mutex<HashMap<String, Arc<Mutex<()>>>>,
    /// The WALLET lock: held while an engine process may touch the vault's wallet database. A write
    /// that uses the wallet (a send, a proposal, a payroll) holds it for the request; a read of the
    /// balance or the transactions TRIES it: busy at once while a send is marked, and for anything
    /// else a wait of a few seconds (two readers at most).
    wallets: Mutex<HashMap<String, Arc<Mutex<()>>>>,
    /// A send in progress, by vault: shown to readers instead of making them wait.
    sending: Mutex<HashMap<String, Sending>>,
    /// How many wallet reads are waiting a moment for the wallet lock, by vault (bounded).
    waiting: Mutex<HashMap<String, usize>>,
}

/// The most wallet reads that may wait for one vault's wallet at a time. A reader waits only for
/// another reader (seconds), so a few waiting is enough, and the bound is what keeps a flood from
/// parking the worker pool.
const MAX_WAITING_PER_VAULT: usize = 2;

/// A place in the (short) queue for a vault's wallet; released when dropped.
pub struct WaitSlot<'a> {
    locks: &'a VaultLocks,
    vault: String,
}

impl Drop for WaitSlot<'_> {
    fn drop(&mut self) {
        let mut map = self.locks.waiting.lock().unwrap_or_else(|e| e.into_inner());
        if let Some(n) = map.get_mut(&self.vault) {
            *n = n.saturating_sub(1);
            if *n == 0 {
                map.remove(&self.vault);
            }
        }
    }
}

/// A send that holds its vault: which proposal, and since when.
#[derive(Clone)]
struct Sending {
    proposal: String,
    since: Instant,
}

/// Holds the "sending" marker of one vault and clears it when dropped, including when the send
/// unwinds from a panic.
pub struct SendingMark<'a> {
    locks: &'a VaultLocks,
    vault: String,
}

impl Drop for SendingMark<'_> {
    fn drop(&mut self) {
        let mut map = self.locks.sending.lock().unwrap_or_else(|e| e.into_inner());
        map.remove(&self.vault);
    }
}

/// Take `lock`, waiting up to `within` in short steps, and give up at once when `give_up()` says so
/// (a send is going on: waiting for it would be minutes, not seconds).
pub fn acquire_within<'a>(
    lock: &'a Mutex<()>,
    within: std::time::Duration,
    give_up: impl Fn() -> bool,
) -> Option<MutexGuard<'a, ()>> {
    let start = Instant::now();
    loop {
        if let Some(guard) = try_acquire(lock) {
            return Some(guard);
        }
        if give_up() || start.elapsed() >= within {
            return None;
        }
        std::thread::sleep(std::time::Duration::from_millis(25));
    }
}

/// Take `lock` if it is free RIGHT NOW. A poisoned lock (a handler panicked while holding it) is
/// taken anyway, as everywhere else here: the mutex guards nothing, the work it orders is on disk.
pub fn try_acquire(lock: &Mutex<()>) -> Option<MutexGuard<'_, ()>> {
    match lock.try_lock() {
        Ok(guard) => Some(guard),
        Err(TryLockError::Poisoned(p)) => Some(p.into_inner()),
        Err(TryLockError::WouldBlock) => None,
    }
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

    /// The wallet lock for `vault`. Always taken AFTER the write lock when both are needed, and a
    /// reader never blocks on it (it tries, or polls for a bounded time while holding nothing), so
    /// no ordering can deadlock.
    pub fn wallet_for_vault(&self, vault: &str) -> Arc<Mutex<()>> {
        let mut map = self.wallets.lock().unwrap_or_else(|e| e.into_inner());
        map.entry(vault.to_string())
            .or_insert_with(|| Arc::new(Mutex::new(())))
            .clone()
    }

    /// A place among the (at most two) wallet reads waiting for `vault`, or `None` if they are taken.
    pub fn wait_slot(&self, vault: &str) -> Option<WaitSlot<'_>> {
        let mut map = self.waiting.lock().unwrap_or_else(|e| e.into_inner());
        let n = map.entry(vault.to_string()).or_insert(0);
        if *n >= MAX_WAITING_PER_VAULT {
            return None;
        }
        *n += 1;
        Some(WaitSlot {
            locks: self,
            vault: vault.to_string(),
        })
    }

    /// Say that `proposal` is being sent from `vault` until the returned mark is dropped.
    pub fn mark_sending(&self, vault: &str, proposal: &str) -> SendingMark<'_> {
        let mut map = self.sending.lock().unwrap_or_else(|e| e.into_inner());
        map.insert(
            vault.to_string(),
            Sending {
                proposal: proposal.to_string(),
                since: Instant::now(),
            },
        );
        SendingMark {
            locks: self,
            vault: vault.to_string(),
        }
    }

    /// The proposal being sent from `vault` and for how many seconds, if any.
    pub fn sending(&self, vault: &str) -> Option<(String, u64)> {
        let map = self.sending.lock().unwrap_or_else(|e| e.into_inner());
        map.get(vault)
            .map(|s| (s.proposal.clone(), s.since.elapsed().as_secs()))
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

    /// How many vaults have a wallet lock. Test-only.
    #[cfg(test)]
    pub fn wallet_len(&self) -> usize {
        self.wallets.lock().unwrap_or_else(|e| e.into_inner()).len()
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
        assert_eq!(request_vault("vault=abc&x=1", b""), Ok(Some("abc".into())));
        assert_eq!(request_vault("x=1&vault=abc", b""), Ok(Some("abc".into())));
    }

    #[test]
    fn reads_the_vault_from_the_body_when_the_query_has_none() {
        assert_eq!(
            request_vault("", br#"{"vault":"deadbeef","to":"u1..."}"#),
            Ok(Some("deadbeef".into()))
        );
    }

    #[test]
    fn reads_registration_by_its_own_field_name() {
        // `POST /api/vault` calls the same thing `group_key`, and it must serialise with the rest:
        // registering runs the engine against the vault's directory.
        assert_eq!(
            request_vault("", br#"{"group_key":"ff00","name":"treasury"}"#),
            Ok(Some("ff00".into()))
        );
    }

    #[test]
    fn accepts_a_request_that_names_its_vault_in_several_places_consistently() {
        assert_eq!(
            request_vault("vault=abc", br#"{"vault":"abc","group_key":"abc"}"#),
            Ok(Some("abc".into()))
        );
        assert_eq!(
            request_vault("vault=abc&vault=abc", b""),
            Ok(Some("abc".into()))
        );
    }

    /// #576. Each of these was locked on one vault and acted on the other. The first is the case
    /// reproduced against the real binary: a vote and a rename of one vault, each carrying a
    /// different `?vault=`, ran concurrently and recorded one member's approval twice.
    #[test]
    fn refuses_a_request_that_names_two_vaults() {
        use Unlockable::TwoVaults;
        // The query against the body: the POST handlers read the body.
        assert_eq!(
            request_vault("vault=fromquery", br#"{"vault":"frombody"}"#),
            Err(TwoVaults)
        );
        // Inside the body: the registration routes read `group_key`, the lock preferred `vault`.
        assert_eq!(
            request_vault("", br#"{"vault":"a","group_key":"b"}"#),
            Err(TwoVaults)
        );
        assert_eq!(
            request_vault("vault=a", br#"{"group_key":"b"}"#),
            Err(TwoVaults)
        );
        // Inside the query: the reads take the first `vault=`, so the lock must not take another.
        assert_eq!(request_vault("vault=a&vault=b", b""), Err(TwoVaults));
        // An empty one beside a real one: a read takes the first, which would be the empty one.
        assert_eq!(request_vault("vault=&vault=a", b""), Err(TwoVaults));
        assert_eq!(request_vault("vault=", br#"{"vault":"a"}"#), Err(TwoVaults));
    }

    /// #576, the same defect by another door: the handlers read the body with serde's derived
    /// deserializers, and each of these got past `serde_json::Value` as "names no vault", ran with
    /// no lock, and was acted on by a handler that found the vault in it.
    #[test]
    fn refuses_a_body_it_cannot_read_by_name() {
        use Unlockable::NotAnObject;
        let deep = format!(
            r#"{{"vault":"a","pad":{}0{}}}"#,
            "[".repeat(200),
            "]".repeat(200)
        );
        for body in [
            br#"["a","bob"]"#.as_slice(),
            br#"{"vault":"a","pad":1e400}"#,
            deep.as_bytes(),
            br#"{"vault":"a","pad":"\ud800"}"#,
            b"{\"vault\":\"a\",\"pad\":\"\xff\"}",
            br#""a""#,
            b"42",
            b"null",
            b"not json",
        ] {
            assert_eq!(
                request_vault("", body),
                Err(NotAnObject),
                "{}",
                String::from_utf8_lossy(body)
            );
            // And a query that names a vault does not make an unreadable body lockable.
            assert_eq!(request_vault("vault=a", body), Err(NotAnObject));
        }
    }

    #[test]
    fn is_none_for_a_request_that_touches_no_vault() {
        // Health is the one that matters: it must never queue behind anything.
        assert_eq!(request_vault("", b""), Ok(None));
        assert_eq!(request_vault("other=1", b""), Ok(None));
        assert_eq!(request_vault("", b" \n"), Ok(None));
        assert_eq!(request_vault("", br#"{"unrelated":true}"#), Ok(None));
    }

    #[test]
    fn treats_an_empty_id_as_absent_rather_than_locking_on_the_empty_string() {
        // Otherwise every malformed request would serialise against every other one.
        assert_eq!(request_vault("vault=", b""), Ok(None));
        assert_eq!(request_vault("", br#"{"vault":""}"#), Ok(None));
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

    #[test]
    fn try_acquire_never_waits_and_takes_a_poisoned_lock() {
        let m = Arc::new(Mutex::new(()));
        assert!(try_acquire(&m).is_some(), "a free lock is taken");
        let held = m.lock().unwrap();
        // On another thread, with a deadline: waiting here would hang the test, not fail it.
        let (tx, rx) = std::sync::mpsc::channel();
        let m3 = Arc::clone(&m);
        std::thread::spawn(move || {
            let _ = tx.send(try_acquire(&m3).is_none());
        });
        assert_eq!(
            rx.recv_timeout(std::time::Duration::from_secs(2)),
            Ok(true),
            "a held lock is not waited for"
        );
        drop(held);
        let m2 = Arc::clone(&m);
        let _ = std::thread::spawn(move || {
            let _g = m2.lock().unwrap();
            panic!("poison it");
        })
        .join();
        assert!(
            try_acquire(&m).is_some(),
            "a poisoned lock is taken, as everywhere else"
        );
    }

    #[test]
    fn the_wallet_lock_is_per_vault_and_not_the_write_lock() {
        let locks = VaultLocks::new();
        let write = locks.for_vault("a");
        let wallet_a = locks.wallet_for_vault("a");
        let wallet_b = locks.wallet_for_vault("b");
        assert!(!Arc::ptr_eq(&write, &wallet_a), "two different locks");
        assert!(Arc::ptr_eq(&wallet_a, &locks.wallet_for_vault("a")));
        let _held = wallet_a.lock().unwrap();
        assert!(
            try_acquire(&wallet_b).is_some(),
            "another vault's wallet is free"
        );
        assert!(
            try_acquire(&write).is_some(),
            "the write lock is not the wallet lock"
        );
    }

    #[test]
    fn the_sending_mark_names_the_proposal_and_is_cleared_when_it_is_dropped() {
        let locks = VaultLocks::new();
        assert!(locks.sending("v").is_none());
        {
            let _mark = locks.mark_sending("v", "p9");
            let (proposal, _secs) = locks.sending("v").expect("marked");
            assert_eq!(proposal, "p9");
            assert!(locks.sending("other").is_none(), "per vault");
        }
        assert!(locks.sending("v").is_none());
    }

    #[test]
    fn the_sending_mark_is_cleared_when_the_send_panics() {
        let locks = VaultLocks::new();
        let r = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
            let _mark = locks.mark_sending("v", "p1");
            assert!(locks.sending("v").is_some());
            panic!("the send unwinds");
        }));
        assert!(r.is_err());
        assert!(
            locks.sending("v").is_none(),
            "a panic leaves no mark behind"
        );
    }

    /// Two vaults sending at once: one finishing must not clear the other's mark.
    #[test]
    fn one_vaults_mark_survives_another_vaults_end() {
        // Several times over, with a fresh table each: the order a map keeps its keys in changes
        // from one table to the next, and a drop that clears "some" entry must be caught.
        for _ in 0..16 {
            let locks = VaultLocks::new();
            let a = locks.mark_sending("a", "pa");
            let b = locks.mark_sending("b", "pb");
            drop(a);
            assert_eq!(locks.sending("b").map(|s| s.0), Some("pb".to_string()));
            assert!(locks.sending("a").is_none());
            drop(b);
            assert!(locks.sending("b").is_none());
        }
    }

    /// `since_secs` is seconds: 0 at the start, then whole seconds as time passes.
    #[test]
    fn the_sending_mark_counts_seconds() {
        let locks = VaultLocks::new();
        let _mark = locks.mark_sending("a", "pa");
        assert_eq!(locks.sending("a").unwrap().1, 0);
        std::thread::sleep(std::time::Duration::from_millis(1100));
        let secs = locks.sending("a").unwrap().1;
        assert!((1..=2).contains(&secs), "since_secs = {secs}");
    }

    /// Runs `acquire_within` on another thread while this one holds `lock`, so a call that does not
    /// give up fails the test (after `deadline`) instead of hanging it. Returns whether it got the
    /// lock and how long it took.
    fn acquire_while_held(
        lock: &Mutex<()>,
        within: std::time::Duration,
        give_up: bool,
        release_after: Option<std::time::Duration>,
    ) -> Option<(bool, std::time::Duration)> {
        let held = lock.lock().unwrap();
        let (tx, rx) = std::sync::mpsc::channel();
        std::thread::scope(|scope| {
            let worker = scope.spawn(|| {
                let started = Instant::now();
                let got = acquire_within(lock, within, || give_up).is_some();
                let _ = tx.send((got, started.elapsed()));
            });
            let mut held = Some(held);
            if let Some(after) = release_after {
                std::thread::sleep(after);
                held.take();
            }
            let answer = rx.recv_timeout(std::time::Duration::from_secs(4)).ok();
            held.take();
            worker.join().unwrap();
            answer
        })
    }

    #[test]
    fn acquire_within_takes_a_lock_that_is_given_back_during_the_wait() {
        let lock = Mutex::new(());
        let (got, _) = acquire_while_held(
            &lock,
            std::time::Duration::from_secs(3),
            false,
            Some(std::time::Duration::from_millis(100)),
        )
        .expect("answered");
        assert!(got, "the lock was given back inside the bound");
    }

    #[test]
    fn acquire_within_gives_up_after_its_bound() {
        let lock = Mutex::new(());
        let (got, took) =
            acquire_while_held(&lock, std::time::Duration::from_millis(200), false, None)
                .expect("answered inside four seconds");
        assert!(!got, "the lock was held the whole time");
        assert!(took >= std::time::Duration::from_millis(200), "{took:?}");
        assert!(took < std::time::Duration::from_secs(2), "{took:?}");
    }

    #[test]
    fn acquire_within_gives_up_at_once_when_told_to() {
        let lock = Mutex::new(());
        let (got, took) = acquire_while_held(&lock, std::time::Duration::from_secs(30), true, None)
            .expect("answered inside four seconds");
        assert!(!got);
        assert!(took < std::time::Duration::from_secs(1), "{took:?}");
    }

    #[test]
    fn at_most_two_readers_wait_for_one_vaults_wallet() {
        let locks = VaultLocks::new();
        let a = locks.wait_slot("v").expect("first");
        let _b = locks.wait_slot("v").expect("second");
        assert!(locks.wait_slot("v").is_none(), "the third is turned away");
        assert!(locks.wait_slot("other").is_some(), "per vault");
        drop(a);
        assert!(locks.wait_slot("v").is_some(), "a freed slot is reusable");
    }
}
