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
//! No clock and no HTTP types: the caller supplies the address, the route and `now`. The one read of
//! the outside world is the volume's free space before a NEW vault, through a reader `Limits::new`
//! builds and a test replaces (`Limits::with_free_space`).

use std::collections::HashMap;
use std::sync::Mutex;

use konclave_http::{ClientAddress, RateKey, RateLimiter};

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

/// NEW vaults the coordinator accepts per window, from every address together, on top of the
/// per-address limit. Each one is an engine run and a wallet on the volume. Honest use is a few
/// vaults a day.
pub const NEW_VAULTS_GLOBAL_MAX: usize = 60;

/// Free space the volume must keep before a NEW vault is accepted. Below it, new vaults wait;
/// everything else (existing vaults, sends, reads, devices joining a vault) goes on.
pub const NEW_VAULT_MIN_FREE_BYTES: u64 = 5 * 1024 * 1024 * 1024;

/// Reads the free bytes of the volume that holds the vaults. `None` when it cannot tell, which
/// counts as "not enough" for new vaults only.
pub type FreeSpace = Box<dyn Fn() -> Option<u64> + Send + Sync>;

/// Why a request was refused. All answer 429; the sentence says which limit it was.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Refused {
    Flood,
    TooManyNewVaults,
    NewVaultsPaused,
}

impl Refused {
    pub fn message(self) -> &'static str {
        match self {
            Refused::Flood => "rate limited",
            Refused::TooManyNewVaults => "too many new vaults from this address, try again later",
            Refused::NewVaultsPaused => {
                "the coordinator is not accepting new vaults right now, try again later"
            }
        }
    }
}

pub struct Limits {
    flood: RateLimiter,
    new_vaults: NewVaults,
    free_space: FreeSpace,
}

impl Limits {
    /// The limits the server runs with. Built once at boot; it says in the log whether the
    /// free-space floor is on and for which directory.
    pub fn new() -> Self {
        // Tests never read the developer's environment: a test run with the variable exported must
        // not meet a floor it did not ask for.
        let dir = if cfg!(test) {
            None
        } else {
            std::env::var_os("KONCLAVE_VAULTS_DIR").map(std::path::PathBuf::from)
        };
        match &dir {
            Some(d) => {
                let free = free_space_of(Some(d.clone()))();
                eprintln!(
                    "new vaults: at most {NEW_VAULTS_GLOBAL_MAX} an hour in all; paused while {} has less than {} GiB free ({}{})",
                    d.display(),
                    NEW_VAULT_MIN_FREE_BYTES >> 30,
                    free.map_or("free space unknown".to_string(), |f| format!("{} GiB free now", f >> 30)),
                    if free.is_some_and(|f| f >= NEW_VAULT_MIN_FREE_BYTES) { "" } else { ", PAUSED" }
                )
            }
            None => eprintln!(
                "new vaults: at most {NEW_VAULTS_GLOBAL_MAX} an hour in all; no free-space floor (KONCLAVE_VAULTS_DIR unset)"
            ),
        }
        Self::with_free_space(free_space_of(dir))
    }

    /// The limits with a given reader of the volume's free space (the real one in `new`).
    pub fn with_free_space(free_space: FreeSpace) -> Self {
        Limits {
            flood: RateLimiter::new(FLOOD_WINDOW_SECS, MAX_RATE_KEYS),
            new_vaults: NewVaults::default(),
            free_space,
        }
    }

    /// A registration that WILL reach the engine: a well-formed body naming a group key the
    /// coordinator does not know. The caller decides that; this only counts.
    pub fn new_vault(
        &self,
        client: &ClientAddress,
        group_key: &str,
        now: i64,
    ) -> Result<(), Refused> {
        let has_room = || (self.free_space)().is_some_and(|free| free >= NEW_VAULT_MIN_FREE_BYTES);
        self.new_vaults.admit(client, group_key, now, &has_room)
    }
}

/// The free bytes of the filesystem holding `dir`. With no directory configured (tests, a local run)
/// there is no floor to keep, so it answers "plenty".
pub fn free_space_of(dir: Option<std::path::PathBuf>) -> FreeSpace {
    let Some(dir) = dir else {
        return Box::new(|| Some(u64::MAX));
    };
    Box::new(move || statvfs_free(&dir))
}

#[cfg(unix)]
fn statvfs_free(dir: &std::path::Path) -> Option<u64> {
    use std::os::unix::ffi::OsStrExt;
    let path = std::ffi::CString::new(dir.as_os_str().as_bytes()).ok()?;
    let mut st = std::mem::MaybeUninit::<libc::statvfs>::uninit();
    // SAFETY: `path` is a NUL-terminated string that outlives the call, and `st` is written by
    // statvfs before it is read; it is read only when the call reports success.
    if unsafe { libc::statvfs(path.as_ptr(), st.as_mut_ptr()) } != 0 {
        return None;
    }
    let st = unsafe { st.assume_init() };
    // fsblkcnt_t and c_ulong vary in width between platforms; both casts widen.
    #[allow(clippy::unnecessary_cast)]
    let (blocks, size) = (st.f_bavail as u64, st.f_frsize as u64);
    blocks.checked_mul(size)
}

/// Not a platform the coordinator runs on: no reading, so new vaults wait (the floor fails closed).
#[cfg(not(unix))]
fn statvfs_free(_dir: &std::path::Path) -> Option<u64> {
    None
}

/// The flood check, which needs nothing but the address and the route, so it runs before a byte of
/// the body is read.
///
/// Health is how anyone tells "busy" from "dead" (2026-08-27). It is never refused and never
/// counted, so a monitor cannot be locked out and cannot use up the allowance of whoever shares its
/// address.
pub fn refuse_flood(
    limits: &Limits,
    client: &ClientAddress,
    path: &str,
    now: i64,
) -> Option<Refused> {
    let (route, _) = path.split_once('?').unwrap_or((path, ""));
    if route == "/api/health" {
        return None;
    }
    if limits
        .flood
        .allow(&RateKey::address(client), now, FLOOD_MAX)
    {
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
    // Keyed by the address itself, so two spellings of one address are one entry. The second field
    // is the total across every address.
    seen: Mutex<(HashMap<ClientAddress, Window>, Total)>,
}

/// The new vaults admitted in the current window from every address together, by group key (so a
/// vault whose devices register from several addresses counts once), and why new vaults are paused,
/// if they are, so the log says when that starts and when it ends.
#[derive(Default)]
struct Total {
    start: i64,
    vaults: std::collections::HashSet<String>,
    paused: Option<&'static str>,
}

impl Total {
    fn pause(&mut self, why: &'static str) {
        if self.paused != Some(why) {
            eprintln!("new vaults: paused ({why})");
            self.paused = Some(why);
        }
    }

    fn resume(&mut self) {
        if self.paused.take().is_some() {
            eprintln!("new vaults: accepting again");
        }
    }
}

impl NewVaults {
    fn admit(
        &self,
        client: &ClientAddress,
        group_key: &str,
        now: i64,
        has_room: &dyn Fn() -> bool,
    ) -> Result<(), Refused> {
        // The counts are advisory, so a poisoned lock must not wedge registration for everyone.
        let mut guard = self.seen.lock().unwrap_or_else(|e| e.into_inner());
        let (seen, total) = &mut *guard;
        if seen.len() > MAX_RATE_KEYS {
            seen.retain(|_, w| now.saturating_sub(w.start) < NEW_VAULT_WINDOW_SECS);
        }
        let window = seen.entry(*client).or_insert_with(|| Window {
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
            return if *attempts <= ATTEMPTS_PER_VAULT_MAX {
                Ok(())
            } else {
                Err(Refused::TooManyNewVaults)
            };
        }
        // A vault it has not. It is only RECORDED when it is admitted, so a refused vault stays
        // refused on every retry instead of being waved through as "already seen".
        if window.vaults.len() >= NEW_VAULTS_MAX {
            return Err(Refused::TooManyNewVaults);
        }
        // The total across every address, and the volume's free space. A vault already admitted
        // from another address is not a new vault: another of its devices, behind another address.
        if now.saturating_sub(total.start) >= NEW_VAULT_WINDOW_SECS {
            total.start = now;
            total.vaults.clear();
        }
        if !total.vaults.contains(group_key) {
            if total.vaults.len() >= NEW_VAULTS_GLOBAL_MAX {
                total.pause("the hourly bound is reached");
                return Err(Refused::NewVaultsPaused);
            }
            if !has_room() {
                total.pause("the volume is below its free-space floor");
                return Err(Refused::NewVaultsPaused);
            }
            total.vaults.insert(group_key.to_string());
            total.resume();
        }
        window.vaults.insert(group_key.to_string(), 1);
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::net::{IpAddr, Ipv4Addr};

    const T0: i64 = 1_800_000_000;
    const OFFICE: ClientAddress = ClientAddress::from_ip(IpAddr::V4(Ipv4Addr::new(203, 0, 113, 7)));
    const NEIGHBOUR: ClientAddress =
        ClientAddress::from_ip(IpAddr::V4(Ipv4Addr::new(198, 51, 100, 9)));

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
                l.new_vault(&OFFICE, &vault(1), T0),
                Ok(()),
                "device {device} of the same vault"
            );
        }
        // Eight registrations, one vault: four more vaults still fit in the hour.
        for n in 2..=5 {
            assert_eq!(l.new_vault(&OFFICE, &vault(n), T0), Ok(()), "vault {n}");
        }
        assert_eq!(
            l.new_vault(&OFFICE, &vault(6), T0),
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
            assert_eq!(l.new_vault(&OFFICE, &vault(n), T0), Ok(()));
        }
        for attempt in 0..3 {
            assert_eq!(
                l.new_vault(&OFFICE, &vault(6), T0 + attempt),
                Err(Refused::TooManyNewVaults),
                "attempt {attempt}"
            );
        }
        // And the vaults it WAS allowed keep registering their other devices.
        assert_eq!(l.new_vault(&OFFICE, &vault(3), T0 + 5), Ok(()));
    }

    /// One unknown key must not be a way to spawn the engine without end.
    #[test]
    fn one_vault_cannot_be_registered_without_end() {
        let l = Limits::new();
        for attempt in 0..ATTEMPTS_PER_VAULT_MAX {
            assert_eq!(
                l.new_vault(&OFFICE, &vault(1), T0),
                Ok(()),
                "attempt {attempt}"
            );
        }
        assert_eq!(
            l.new_vault(&OFFICE, &vault(1), T0),
            Err(Refused::TooManyNewVaults)
        );
    }

    #[test]
    fn another_address_is_not_made_to_pay_and_the_next_hour_starts_over() {
        let l = Limits::new();
        for n in 1..=5 {
            assert_eq!(l.new_vault(&OFFICE, &vault(n), T0), Ok(()));
        }
        assert_eq!(
            l.new_vault(&OFFICE, &vault(6), T0),
            Err(Refused::TooManyNewVaults)
        );
        assert_eq!(l.new_vault(&NEIGHBOUR, &vault(6), T0), Ok(()));
        assert_eq!(
            l.new_vault(&OFFICE, &vault(6), T0 + NEW_VAULT_WINDOW_SECS),
            Ok(())
        );
    }

    #[test]
    fn a_flood_from_one_address_is_refused_and_the_next_window_starts_over() {
        let l = Limits::new();
        let read = "/api/vault/balance?vault=zzzz";
        for i in 0..FLOOD_MAX {
            assert_eq!(refuse_flood(&l, &OFFICE, read, T0), None, "request {i}");
        }
        assert_eq!(refuse_flood(&l, &OFFICE, read, T0), Some(Refused::Flood));
        assert_eq!(refuse_flood(&l, &NEIGHBOUR, read, T0), None);
        assert_eq!(
            refuse_flood(&l, &OFFICE, read, T0 + FLOOD_WINDOW_SECS),
            None
        );
    }

    /// One client is one budget however its address is written. The text of an address reaches the
    /// limits only through `request_client_address`, which hands back the canonical value, so the two
    /// spellings share the flood allowance and the new-vault one. The first pair is an IPv4 client
    /// written as an IPv4-mapped IPv6 address in a forwarded header and as plain IPv4 on the
    /// socket, which only `to_canonical` joins; the second differs in the case of a hex digit.
    #[test]
    fn two_spellings_of_one_address_share_one_budget() {
        let pairs = [
            (
                konclave_http::request_client_address(["::ffff:203.0.113.7"], None),
                konclave_http::request_client_address([] as [&str; 0], Some("203.0.113.7")),
            ),
            (
                konclave_http::request_client_address(["2001:DB8::1"], None),
                konclave_http::request_client_address(["2001:db8::1"], None),
            ),
        ];
        for (first, second) in pairs {
            assert_eq!(first, second, "the two spellings are one value");

            let l = Limits::new();
            let read = "/api/vault/balance?vault=zzzz";
            for i in 0..FLOOD_MAX {
                assert_eq!(refuse_flood(&l, &first, read, T0), None, "request {i}");
            }
            assert_eq!(
                refuse_flood(&l, &second, read, T0),
                Some(Refused::Flood),
                "the other spelling of the same address has no allowance of its own"
            );

            for n in 1..=5 {
                assert_eq!(l.new_vault(&first, &vault(n), T0), Ok(()), "vault {n}");
            }
            assert_eq!(
                l.new_vault(&second, &vault(6), T0),
                Err(Refused::TooManyNewVaults),
                "nor does it get a second set of new vaults"
            );
        }
    }

    /// A monitor polling health must never be refused, and must not use up the allowance of
    /// whoever shares its address.
    #[test]
    fn health_is_never_limited_and_never_counted() {
        let l = Limits::new();
        for i in 0..(FLOOD_MAX * 3) {
            assert_eq!(
                refuse_flood(&l, &OFFICE, "/api/health", T0),
                None,
                "health check {i}"
            );
        }
        for i in 0..FLOOD_MAX {
            assert_eq!(
                refuse_flood(&l, &OFFICE, "/api/vault?vault=zzzz", T0),
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
            let _ = refuse_flood(&l, &OFFICE, "/api/vault?x=/api/health", T0);
        }
        assert_eq!(
            refuse_flood(&l, &OFFICE, "/api/vault?x=/api/health", T0),
            Some(Refused::Flood),
            "a query that mentions health is counted like any other read"
        );
        assert_eq!(refuse_flood(&l, &OFFICE, "/api/health?verbose=1", T0), None);
    }

    fn address(n: u32) -> ClientAddress {
        ClientAddress::from_ip(IpAddr::V4(Ipv4Addr::from(0x0A00_0000 + n)))
    }

    /// Many addresses, one vault each, inside one hour: before this bound every one was admitted,
    /// each an engine run and a wallet on the volume.
    #[test]
    fn many_addresses_cannot_create_vaults_without_a_total_bound() {
        let l = Limits::with_free_space(Box::new(|| Some(u64::MAX)));
        let admitted = (0..1000)
            .filter(|n| l.new_vault(&address(*n), &vault(*n), T0 + i64::from(*n % 60)) == Ok(()))
            .count();
        assert_eq!(admitted, NEW_VAULTS_GLOBAL_MAX);
        assert_eq!(
            l.new_vault(&address(5000), &vault(5000), T0 + 100),
            Err(Refused::NewVaultsPaused)
        );
        // The next hour starts over.
        assert_eq!(
            l.new_vault(&address(5001), &vault(5001), T0 + NEW_VAULT_WINDOW_SECS),
            Ok(())
        );
    }

    /// The total counts vaults, as the per-address limit does: another device of a vault already
    /// admitted, or a retry, is not a new vault and still gets in when the total is spent.
    #[test]
    fn a_vault_already_admitted_keeps_registering_when_the_total_is_spent() {
        let l = Limits::with_free_space(Box::new(|| Some(u64::MAX)));
        for n in 0..NEW_VAULTS_GLOBAL_MAX as u32 {
            assert_eq!(l.new_vault(&address(n), &vault(n), T0), Ok(()));
        }
        assert_eq!(
            l.new_vault(&address(9999), &vault(9999), T0),
            Err(Refused::NewVaultsPaused)
        );
        assert_eq!(l.new_vault(&address(3), &vault(3), T0 + 1), Ok(()));
    }

    /// A vault whose devices register from several addresses is one vault in the total.
    #[test]
    fn one_vault_from_several_addresses_counts_once_in_the_total() {
        let l = Limits::with_free_space(Box::new(|| Some(u64::MAX)));
        for device in 0..10 {
            assert_eq!(
                l.new_vault(&address(device), &vault(1), T0),
                Ok(()),
                "device {device}"
            );
        }
        for n in 2..=NEW_VAULTS_GLOBAL_MAX as u32 {
            assert_eq!(
                l.new_vault(&address(100 + n), &vault(n), T0),
                Ok(()),
                "vault {n}"
            );
        }
        assert_eq!(
            l.new_vault(&address(9000), &vault(9000), T0),
            Err(Refused::NewVaultsPaused)
        );
        // Another device of vault 1, from yet another address, still gets in.
        assert_eq!(l.new_vault(&address(9001), &vault(1), T0), Ok(()));
    }

    /// A vault refused by the total or the floor is not recorded, so its retry is still a new vault
    /// and is still refused (recording it would let the retry in as "a vault this address brought").
    #[test]
    fn a_vault_paused_by_the_total_stays_paused_when_it_retries() {
        let l = Limits::with_free_space(Box::new(|| Some(u64::MAX)));
        for n in 0..NEW_VAULTS_GLOBAL_MAX as u32 {
            assert_eq!(l.new_vault(&address(n), &vault(n), T0), Ok(()));
        }
        for attempt in 0..3 {
            assert_eq!(
                l.new_vault(&OFFICE, &vault(7777), T0 + attempt),
                Err(Refused::NewVaultsPaused),
                "attempt {attempt}"
            );
        }
        let low = Limits::with_free_space(Box::new(|| Some(0)));
        for attempt in 0..3 {
            assert_eq!(
                low.new_vault(&OFFICE, &vault(1), T0 + attempt),
                Err(Refused::NewVaultsPaused),
                "attempt {attempt} below the floor"
            );
        }
    }

    /// Below the floor no new vault is accepted, and a reader that cannot tell counts as below.
    /// Vaults already admitted keep registering their devices.
    #[test]
    fn new_vaults_wait_when_the_volume_is_nearly_full() {
        let low = Limits::with_free_space(Box::new(|| Some(NEW_VAULT_MIN_FREE_BYTES - 1)));
        assert_eq!(
            low.new_vault(&OFFICE, &vault(1), T0),
            Err(Refused::NewVaultsPaused)
        );
        let unknown = Limits::with_free_space(Box::new(|| None));
        assert_eq!(
            unknown.new_vault(&OFFICE, &vault(1), T0),
            Err(Refused::NewVaultsPaused)
        );
        let enough = Limits::with_free_space(Box::new(|| Some(NEW_VAULT_MIN_FREE_BYTES)));
        assert_eq!(enough.new_vault(&OFFICE, &vault(1), T0), Ok(()));

        let space = std::sync::Arc::new(std::sync::atomic::AtomicU64::new(u64::MAX));
        let reader = space.clone();
        let l = Limits::with_free_space(Box::new(move || {
            Some(reader.load(std::sync::atomic::Ordering::Relaxed))
        }));
        assert_eq!(l.new_vault(&OFFICE, &vault(1), T0), Ok(()));
        space.store(0, std::sync::atomic::Ordering::Relaxed);
        assert_eq!(
            l.new_vault(&OFFICE, &vault(1), T0 + 1),
            Ok(()),
            "another device of vault 1"
        );
        assert_eq!(
            l.new_vault(&OFFICE, &vault(2), T0 + 1),
            Err(Refused::NewVaultsPaused)
        );
    }

    /// The real reader measures the filesystem that holds the directory; with no directory there
    /// is no floor.
    #[test]
    fn the_real_reader_measures_the_directory_and_has_no_floor_without_one() {
        assert_eq!(free_space_of(None)(), Some(u64::MAX));
        let here = free_space_of(Some(std::env::temp_dir()))();
        assert!(matches!(here, Some(n) if n < u64::MAX), "{here:?}");
        assert_eq!(
            free_space_of(Some(std::path::PathBuf::from("/no/such/directory/here")))(),
            None
        );
    }
}
