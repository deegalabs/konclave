//! Whether a request may be handled at all (#558).
//!
//! The relay has refused floods since #64. The coordinator had no limit of any kind, because the
//! limiter lived in the relay's own file; it is in `konclave-http` now and both servers read it.
//!
//! Two limits, per client address:
//!
//! - **a flood limit** on every route but health, with the relay's numbers
//! - **a limit on NEW vaults**, because registering a group key the coordinator has never seen
//!   spawns the engine and writes a wallet to the durable volume, and had no ceiling
//!
//! The second one counts VAULTS, not requests, and the difference is the whole design. Every device
//! of a group registers the vault when its key generation finishes, at the same moment, before the
//! first registration has returned - so the coordinator sees several registrations of one unknown
//! key from one address. The first version of this counted each of them as a new vault: a group of
//! six behind one office address could not create its first vault, and the device that was refused
//! could not save its share. Counting the distinct group keys an address brings, and allowing each
//! one a generous number of attempts, limits what costs something without limiting a group.
//!
//! Pure: no I/O, no clock, no HTTP types. The caller supplies the address, the route and `now`.

use std::collections::HashMap;
use std::sync::Mutex;

use konclave_http::RateLimiter;

/// Requests one client address may make per window, on every route but health. These are the
/// relay's numbers. Read from the app: one member with one tab sends about 4 requests per 10
/// seconds, and an office of five members with two tabs each about 42, or about 120 if every tab
/// reloads at once.
pub const FLOOD_WINDOW_SECS: i64 = 10;
pub const FLOOD_MAX: u32 = 300;

/// Distinct NEW vaults one client address may register per window.
pub const NEW_VAULT_WINDOW_SECS: i64 = 3600;
pub const NEW_VAULTS_MAX: usize = 5;

/// Registrations of ONE new vault from one address per window. Every device of the vault sends
/// one, and a device retries when the engine is slow, so this is set well above the largest group
/// and far below what would let one key be used to spawn the engine without end.
pub const ATTEMPTS_PER_VAULT_MAX: u32 = 32;

/// Distinct client addresses tracked at once, per limiter, before ended windows are reclaimed.
pub const MAX_RATE_KEYS: usize = 4096;

/// Why a request was refused. Both answer 429; the sentence says which limit it was.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Refused {
    Flood,
    TooManyNewVaults,
}

impl Refused {
    pub fn message(self) -> &'static str {
        match self {
            Refused::Flood => "rate limited",
            Refused::TooManyNewVaults => "too many new vaults from this address, try again later",
        }
    }
}

pub struct Limits {
    flood: RateLimiter,
    new_vaults: NewVaults,
}

impl Limits {
    pub fn new() -> Self {
        Limits {
            flood: RateLimiter::new(FLOOD_WINDOW_SECS, MAX_RATE_KEYS),
            new_vaults: NewVaults::default(),
        }
    }

    /// A registration that WILL reach the engine: a well-formed body naming a group key the
    /// coordinator does not know. The caller decides that; this only counts.
    pub fn new_vault(&self, client: &str, group_key: &str, now: i64) -> Result<(), Refused> {
        if self.new_vaults.admit(client, group_key, now) {
            Ok(())
        } else {
            Err(Refused::TooManyNewVaults)
        }
    }
}

/// The flood check, which needs nothing but the address and the route, so it runs before a byte of
/// the body is read.
///
/// Health is how anyone tells "busy" from "dead" (2026-08-27). It is never refused and never
/// counted, so a monitor cannot be locked out and cannot use up the allowance of whoever shares its
/// address.
pub fn refuse_flood(limits: &Limits, client: &str, path: &str, now: i64) -> Option<Refused> {
    let (route, _) = path.split_once('?').unwrap_or((path, ""));
    if route == "/api/health" {
        return None;
    }
    if limits.flood.allow(client, now, FLOOD_MAX) {
        None
    } else {
        Some(Refused::Flood)
    }
}

/// What one address has registered in the current window: each new vault, and how many times.
struct Window {
    start: i64,
    vaults: HashMap<String, u32>,
}

#[derive(Default)]
struct NewVaults {
    seen: Mutex<HashMap<String, Window>>,
}

impl NewVaults {
    fn admit(&self, client: &str, group_key: &str, now: i64) -> bool {
        // The counts are advisory, so a poisoned lock must not wedge registration for everyone.
        let mut seen = self.seen.lock().unwrap_or_else(|e| e.into_inner());
        if seen.len() > MAX_RATE_KEYS {
            seen.retain(|_, w| now.saturating_sub(w.start) < NEW_VAULT_WINDOW_SECS);
        }
        let window = seen.entry(client.to_string()).or_insert_with(|| Window {
            start: now,
            vaults: HashMap::new(),
        });
        if now.saturating_sub(window.start) >= NEW_VAULT_WINDOW_SECS {
            window.start = now;
            window.vaults.clear();
        }
        // A vault this address already brought: another of its devices, or a retry.
        if let Some(attempts) = window.vaults.get_mut(group_key) {
            *attempts = attempts.saturating_add(1);
            return *attempts <= ATTEMPTS_PER_VAULT_MAX;
        }
        // A vault it has not. It is only RECORDED when it is admitted, so a refused vault stays
        // refused on every retry instead of being waved through as "already seen".
        if window.vaults.len() >= NEW_VAULTS_MAX {
            return false;
        }
        window.vaults.insert(group_key.to_string(), 1);
        true
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const T0: i64 = 1_800_000_000;
    const OFFICE: &str = "203.0.113.7";

    fn vault(n: u32) -> String {
        format!("{n:064x}")
    }

    /// The case the first version got wrong, and the one that would have broken the product: every
    /// device of a vault registers it, together, from one office.
    #[test]
    fn every_device_of_one_vault_registers_and_it_counts_as_one_vault() {
        let l = Limits::new();
        for device in 0..8 {
            assert_eq!(
                l.new_vault(OFFICE, &vault(1), T0),
                Ok(()),
                "device {device} of the same vault"
            );
        }
        // Eight registrations, one vault: four more vaults still fit in the hour.
        for n in 2..=5 {
            assert_eq!(l.new_vault(OFFICE, &vault(n), T0), Ok(()), "vault {n}");
        }
        assert_eq!(
            l.new_vault(OFFICE, &vault(6), T0),
            Err(Refused::TooManyNewVaults),
            "the sixth distinct vault in the hour"
        );
    }

    /// A refused vault must not get in on the second try. Recording it on refusal would have made
    /// the retry look like "a vault this address already brought".
    #[test]
    fn a_refused_vault_stays_refused_when_it_retries() {
        let l = Limits::new();
        for n in 1..=5 {
            assert_eq!(l.new_vault(OFFICE, &vault(n), T0), Ok(()));
        }
        for attempt in 0..3 {
            assert_eq!(
                l.new_vault(OFFICE, &vault(6), T0 + attempt),
                Err(Refused::TooManyNewVaults),
                "attempt {attempt}"
            );
        }
        // And the vaults it WAS allowed keep registering their other devices.
        assert_eq!(l.new_vault(OFFICE, &vault(3), T0 + 5), Ok(()));
    }

    /// One unknown key must not be a way to spawn the engine without end.
    #[test]
    fn one_vault_cannot_be_registered_without_end() {
        let l = Limits::new();
        for attempt in 0..ATTEMPTS_PER_VAULT_MAX {
            assert_eq!(
                l.new_vault(OFFICE, &vault(1), T0),
                Ok(()),
                "attempt {attempt}"
            );
        }
        assert_eq!(
            l.new_vault(OFFICE, &vault(1), T0),
            Err(Refused::TooManyNewVaults)
        );
    }

    #[test]
    fn another_address_is_not_made_to_pay_and_the_next_hour_starts_over() {
        let l = Limits::new();
        for n in 1..=5 {
            assert_eq!(l.new_vault(OFFICE, &vault(n), T0), Ok(()));
        }
        assert_eq!(
            l.new_vault(OFFICE, &vault(6), T0),
            Err(Refused::TooManyNewVaults)
        );
        assert_eq!(l.new_vault("198.51.100.9", &vault(6), T0), Ok(()));
        assert_eq!(
            l.new_vault(OFFICE, &vault(6), T0 + NEW_VAULT_WINDOW_SECS),
            Ok(())
        );
    }

    #[test]
    fn a_flood_from_one_address_is_refused_and_the_next_window_starts_over() {
        let l = Limits::new();
        let read = "/api/vault/balance?vault=zzzz";
        for i in 0..FLOOD_MAX {
            assert_eq!(refuse_flood(&l, OFFICE, read, T0), None, "request {i}");
        }
        assert_eq!(refuse_flood(&l, OFFICE, read, T0), Some(Refused::Flood));
        assert_eq!(refuse_flood(&l, "198.51.100.9", read, T0), None);
        assert_eq!(refuse_flood(&l, OFFICE, read, T0 + FLOOD_WINDOW_SECS), None);
    }

    /// A monitor polling health must never be refused, and must not use up the allowance of
    /// whoever shares its address.
    #[test]
    fn health_is_never_limited_and_never_counted() {
        let l = Limits::new();
        for i in 0..(FLOOD_MAX * 3) {
            assert_eq!(
                refuse_flood(&l, OFFICE, "/api/health", T0),
                None,
                "health check {i}"
            );
        }
        for i in 0..FLOOD_MAX {
            assert_eq!(
                refuse_flood(&l, OFFICE, "/api/vault?vault=zzzz", T0),
                None,
                "the whole allowance is still there, request {i}"
            );
        }
    }

    /// The query string is not the route. A health check with parameters is still a health check,
    /// and a read that merely mentions health in its query is not one.
    #[test]
    fn only_the_health_route_itself_is_exempt() {
        let l = Limits::new();
        for _ in 0..(FLOOD_MAX + 1) {
            let _ = refuse_flood(&l, OFFICE, "/api/vault?x=/api/health", T0);
        }
        assert_eq!(
            refuse_flood(&l, OFFICE, "/api/vault?x=/api/health", T0),
            Some(Refused::Flood),
            "a query that mentions health is counted like any other read"
        );
        assert_eq!(refuse_flood(&l, OFFICE, "/api/health?verbose=1", T0), None);
    }
}
