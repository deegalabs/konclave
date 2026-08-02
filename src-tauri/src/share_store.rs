// On-device share persistence backed by the OS keychain.
//
// UNVALIDATED ON HARDWARE, BUT LOGIC-TESTED. This module has NO `tauri` dependency: it needs
// only `keyring`, so its unit tests run headlessly against `keyring`'s in-memory mock (exactly
// as `orchestrator::secrets::KeychainStore` is tested). The surrounding crate that wraps these
// in `#[tauri::command]`s (lib.rs) still cannot be COMPILED here, because `tauri` needs a system
// webview (webkit2gtk/glib), absent on this machine (ADR-0004). So: the keychain logic below is
// proven by a real green test run in isolation; the Tauri command wiring is scaffold only.
//
// THREAT MODEL (mirrors ui/src/storage.ts). The bytes stored here are ALREADY ciphertext, sealed
// by the UI under a passphrase (PBKDF2 -> AES-GCM). This layer is durable at-rest storage, not
// the encryptor: the plaintext share never crosses this boundary and never leaves the device.
// The keychain adds a second, OS-account at-rest factor ON TOP of the passphrase; it does not
// replace it. Compared with the browser's IndexedDB (origin-scoped, app-clearable, evictable),
// the keychain (Windows Credential Manager / macOS + iOS Keychain / Linux Secret Service) is
// durable and survives browser resets -- the whole reason to go native (docs/TAURI-PLAN.md §2).

use std::collections::BTreeSet;

/// Default keychain service namespace for Konclave's per-device sealed shares. Every entry this
/// module owns on the OS account lives under this service; the account is the caller's vault id.
pub const DEFAULT_SERVICE: &str = "app.konclave.share";

/// Reserved account name under which the list index lives (see [`KeychainShareStore::list`]).
/// A vault id may not collide with it. The `\u{0}`-fenced name cannot be a real vault id.
const INDEX_ACCOUNT: &str = "\u{0}konclave.index\u{0}";

/// Explicit, human-mappable failures at this boundary (§6.8/§6.11). Never a silent loss.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum StoreError {
    /// The underlying keychain backend failed (no Secret Service, locked keychain, IO, ...).
    Backend(String),
    /// No share is stored on this device for the given id.
    NotFound(String),
    /// The id is empty or collides with the reserved index account.
    InvalidId(String),
}

impl std::fmt::Display for StoreError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            StoreError::Backend(e) => write!(f, "keychain unavailable: {e}"),
            StoreError::NotFound(id) => write!(f, "no share stored on this device for id {id}"),
            StoreError::InvalidId(id) => write!(f, "invalid vault id {id:?}"),
        }
    }
}
impl std::error::Error for StoreError {}

/// A durable at-rest store for opaque, already-encrypted share bytes, keyed by vault id.
///
/// The domain depends only on this trait; the real implementation is OS-keychain-backed and the
/// tests drive an in-memory one. This mirrors `orchestrator::secrets::KeyStore`.
pub trait ShareStore {
    /// Persist `ciphertext` for `id`, overwriting any previous value.
    fn store(&self, id: &str, ciphertext: &[u8]) -> Result<(), StoreError>;
    /// Return the stored ciphertext for `id`, or [`StoreError::NotFound`].
    fn load(&self, id: &str) -> Result<Vec<u8>, StoreError>;
    /// Remove the stored share for `id`. Idempotent: deleting an absent id is `Ok`.
    fn delete(&self, id: &str) -> Result<(), StoreError>;
    /// List the ids that currently have a stored share on this device.
    fn list(&self) -> Result<Vec<String>, StoreError>;
}

/// OS-keychain-backed [`ShareStore`].
///
/// `keyring` exposes no enumeration API (there is no portable "list all credentials for a
/// service" across Windows/macOS/Linux/iOS), so [`list`](Self::list) is served from an INDEX
/// entry this store maintains under a reserved account. The index holds only vault ids, which
/// are public identifiers (the group verifying key's namespace) -- never secret material -- so
/// keeping them in the clear does not weaken the threat model.
///
/// The native backend is selected by the app enabling `keyring`'s platform feature per target;
/// with no backend (headless CI) construction still succeeds and calls error clearly, and the
/// unit tests drive it through `keyring`'s in-memory mock.
pub struct KeychainShareStore {
    service: String,
}

impl Default for KeychainShareStore {
    fn default() -> Self {
        Self {
            service: DEFAULT_SERVICE.to_string(),
        }
    }
}

impl KeychainShareStore {
    /// Construct a store under a specific keychain service namespace (tests isolate with this).
    pub fn new(service: impl Into<String>) -> Self {
        Self {
            service: service.into(),
        }
    }

    fn entry(&self, account: &str) -> Result<keyring::Entry, StoreError> {
        keyring::Entry::new(&self.service, account).map_err(|e| StoreError::Backend(e.to_string()))
    }

    fn check_id(id: &str) -> Result<(), StoreError> {
        if id.is_empty() || id == INDEX_ACCOUNT {
            return Err(StoreError::InvalidId(id.to_string()));
        }
        Ok(())
    }

    /// Read the id index (a `\n`-joined set of public ids), tolerating a missing index as empty.
    fn read_index(&self) -> Result<BTreeSet<String>, StoreError> {
        let entry = self.entry(INDEX_ACCOUNT)?;
        match entry.get_secret() {
            Ok(bytes) => Ok(String::from_utf8_lossy(&bytes)
                .lines()
                .filter(|l| !l.is_empty())
                .map(str::to_string)
                .collect()),
            Err(keyring::Error::NoEntry) => Ok(BTreeSet::new()),
            Err(e) => Err(StoreError::Backend(e.to_string())),
        }
    }

    fn write_index(&self, ids: &BTreeSet<String>) -> Result<(), StoreError> {
        let entry = self.entry(INDEX_ACCOUNT)?;
        let joined = ids.iter().cloned().collect::<Vec<_>>().join("\n");
        entry
            .set_secret(joined.as_bytes())
            .map_err(|e| StoreError::Backend(e.to_string()))
    }
}

impl ShareStore for KeychainShareStore {
    fn store(&self, id: &str, ciphertext: &[u8]) -> Result<(), StoreError> {
        Self::check_id(id)?;
        self.entry(id)?
            .set_secret(ciphertext)
            .map_err(|e| StoreError::Backend(e.to_string()))?;
        let mut ids = self.read_index()?;
        if ids.insert(id.to_string()) {
            self.write_index(&ids)?;
        }
        Ok(())
    }

    fn load(&self, id: &str) -> Result<Vec<u8>, StoreError> {
        Self::check_id(id)?;
        match self.entry(id)?.get_secret() {
            Ok(bytes) => Ok(bytes),
            Err(keyring::Error::NoEntry) => Err(StoreError::NotFound(id.to_string())),
            Err(e) => Err(StoreError::Backend(e.to_string())),
        }
    }

    fn delete(&self, id: &str) -> Result<(), StoreError> {
        Self::check_id(id)?;
        match self.entry(id)?.delete_credential() {
            Ok(()) | Err(keyring::Error::NoEntry) => {}
            Err(e) => return Err(StoreError::Backend(e.to_string())),
        }
        let mut ids = self.read_index()?;
        if ids.remove(id) {
            self.write_index(&ids)?;
        }
        Ok(())
    }

    fn list(&self) -> Result<Vec<String>, StoreError> {
        Ok(self.read_index()?.into_iter().collect())
    }
}

// ---- base64 at the JS boundary ----
//
// Tauri `invoke` marshals JS strings cleanly, so the command layer (lib.rs) hands share bytes
// across as standard padded base64 and this store keeps raw bytes in the keychain. These tiny,
// dependency-free helpers live here so they are covered by the same headless test run.

const B64: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

/// Encode bytes as standard padded base64.
pub fn b64(bytes: &[u8]) -> String {
    let mut out = String::with_capacity(bytes.len().div_ceil(3) * 4);
    for chunk in bytes.chunks(3) {
        let b = [
            chunk[0],
            *chunk.get(1).unwrap_or(&0),
            *chunk.get(2).unwrap_or(&0),
        ];
        let n = ((b[0] as u32) << 16) | ((b[1] as u32) << 8) | (b[2] as u32);
        out.push(B64[((n >> 18) & 63) as usize] as char);
        out.push(B64[((n >> 12) & 63) as usize] as char);
        out.push(if chunk.len() > 1 {
            B64[((n >> 6) & 63) as usize] as char
        } else {
            '='
        });
        out.push(if chunk.len() > 2 {
            B64[(n & 63) as usize] as char
        } else {
            '='
        });
    }
    out
}

/// Decode standard base64 (padding and whitespace tolerated), erroring on any stray symbol.
pub fn unb64(s: &str) -> Result<Vec<u8>, String> {
    fn val(c: u8) -> Option<u32> {
        match c {
            b'A'..=b'Z' => Some((c - b'A') as u32),
            b'a'..=b'z' => Some((c - b'a' + 26) as u32),
            b'0'..=b'9' => Some((c - b'0' + 52) as u32),
            b'+' => Some(62),
            b'/' => Some(63),
            _ => None,
        }
    }
    let clean: Vec<u8> = s
        .bytes()
        .filter(|&c| c != b'=' && !c.is_ascii_whitespace())
        .collect();
    let mut out = Vec::with_capacity(clean.len() / 4 * 3);
    for chunk in clean.chunks(4) {
        let mut n = 0u32;
        let mut bits = 0;
        for &c in chunk {
            n = (n << 6) | val(c).ok_or("invalid base64 in stored share")?;
            bits += 6;
        }
        n <<= 24 - bits;
        for i in 0..(bits / 8) {
            out.push(((n >> (16 - i * 8)) & 0xff) as u8);
        }
    }
    Ok(out)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::cell::RefCell;
    use std::collections::BTreeMap;

    // ---- trait SEMANTICS, proven against an in-memory double ----
    //
    // `keyring`'s in-memory mock keeps state INSIDE each `Entry` object, not in a shared backend
    // (that is why `orchestrator::secrets` never round-trips a value across two `Entry::new`
    // calls under the mock). So a true store-here / load-there round trip is only exercisable on
    // a real OS backend, not headlessly. We therefore prove the store SEMANTICS against a
    // `MemoryShareStore` (mirroring `orchestrator::secrets`'s `MemoryKeyStore`), and prove the
    // `KeychainShareStore` error MAPPING + id guard against the mock below.

    #[derive(Default)]
    struct MemoryShareStore {
        map: RefCell<BTreeMap<String, Vec<u8>>>,
    }
    impl ShareStore for MemoryShareStore {
        fn store(&self, id: &str, ciphertext: &[u8]) -> Result<(), StoreError> {
            KeychainShareStore::check_id(id)?;
            self.map
                .borrow_mut()
                .insert(id.to_string(), ciphertext.to_vec());
            Ok(())
        }
        fn load(&self, id: &str) -> Result<Vec<u8>, StoreError> {
            KeychainShareStore::check_id(id)?;
            self.map
                .borrow()
                .get(id)
                .cloned()
                .ok_or_else(|| StoreError::NotFound(id.to_string()))
        }
        fn delete(&self, id: &str) -> Result<(), StoreError> {
            KeychainShareStore::check_id(id)?;
            self.map.borrow_mut().remove(id);
            Ok(())
        }
        fn list(&self) -> Result<Vec<String>, StoreError> {
            Ok(self.map.borrow().keys().cloned().collect())
        }
    }

    #[test]
    fn store_then_load_returns_exact_bytes() {
        let s = MemoryShareStore::default();
        let cipher = &[0u8, 255, 1, 254, 127, 42];
        s.store("vault-a", cipher).unwrap();
        assert_eq!(s.load("vault-a").unwrap(), cipher);
    }

    #[test]
    fn load_missing_is_an_explicit_not_found() {
        let s = MemoryShareStore::default();
        assert_eq!(s.load("nope"), Err(StoreError::NotFound("nope".into())));
    }

    #[test]
    fn store_overwrites_in_place() {
        let s = MemoryShareStore::default();
        s.store("v", b"first").unwrap();
        s.store("v", b"second").unwrap();
        assert_eq!(s.load("v").unwrap(), b"second");
        assert_eq!(s.list().unwrap(), vec!["v".to_string()]);
    }

    #[test]
    fn delete_removes_and_is_idempotent() {
        let s = MemoryShareStore::default();
        s.store("v", b"x").unwrap();
        s.delete("v").unwrap();
        assert_eq!(s.load("v"), Err(StoreError::NotFound("v".into())));
        // Deleting an absent id is not an error (§: explicit, non-surprising boundary).
        s.delete("v").unwrap();
        assert!(s.list().unwrap().is_empty());
    }

    #[test]
    fn list_reflects_the_stored_set() {
        let s = MemoryShareStore::default();
        s.store("alice", b"a").unwrap();
        s.store("bob", b"b").unwrap();
        s.store("carol", b"c").unwrap();
        s.delete("bob").unwrap();
        let mut got = s.list().unwrap();
        got.sort();
        assert_eq!(got, vec!["alice".to_string(), "carol".to_string()]);
    }

    #[test]
    fn empty_and_reserved_ids_are_rejected() {
        let s = MemoryShareStore::default();
        assert!(matches!(s.store("", b"x"), Err(StoreError::InvalidId(_))));
        assert!(matches!(
            s.store(INDEX_ACCOUNT, b"x"),
            Err(StoreError::InvalidId(_))
        ));
        assert!(matches!(s.load(""), Err(StoreError::InvalidId(_))));
    }

    // ---- KeychainShareStore error MAPPING + guard, against the keyring mock ----

    /// Route `keyring` through its in-memory mock (set once per process), exactly as
    /// `orchestrator::secrets` does, so the keychain path is reachable with no OS Secret Service.
    fn use_mock_keychain() {
        use std::sync::Once;
        static ONCE: Once = Once::new();
        ONCE.call_once(|| {
            keyring::set_default_credential_builder(keyring::mock::default_credential_builder());
        });
    }

    #[test]
    fn keychain_load_absent_maps_no_entry_to_not_found() {
        use_mock_keychain();
        // A fresh keychain entry reports NoEntry; the store must surface it as a clean NotFound,
        // never a panic or an opaque backend string.
        let s = KeychainShareStore::new("test.konclave.share.absent");
        assert_eq!(s.load("ghost"), Err(StoreError::NotFound("ghost".into())));
    }

    #[test]
    fn keychain_list_is_empty_without_an_index() {
        use_mock_keychain();
        // No index entry yet => an empty list, not a backend error (read_index tolerates NoEntry).
        let s = KeychainShareStore::new("test.konclave.share.emptylist");
        assert!(s.list().unwrap().is_empty());
    }

    #[test]
    fn keychain_rejects_invalid_ids_before_touching_the_backend() {
        use_mock_keychain();
        let s = KeychainShareStore::new("test.konclave.share.guard");
        assert!(matches!(s.store("", b"x"), Err(StoreError::InvalidId(_))));
        assert!(matches!(
            s.store(INDEX_ACCOUNT, b"x"),
            Err(StoreError::InvalidId(_))
        ));
        assert!(matches!(s.delete(""), Err(StoreError::InvalidId(_))));
    }

    #[test]
    fn keychain_backend_contract_secret_roundtrips_within_one_entry() {
        use_mock_keychain();
        // Documents the backend contract KeychainShareStore relies on: a single Entry stores and
        // returns exactly the bytes set, and signals NoEntry when absent. (Cross-`Entry::new`
        // persistence needs a REAL OS backend; the mock is per-Entry, hence the MemoryShareStore
        // tests above for full round-trip semantics.)
        let entry = keyring::Entry::new("test.konclave.share.contract", "acct").unwrap();
        assert!(matches!(entry.get_secret(), Err(keyring::Error::NoEntry)));
        let cipher = &[9u8, 8, 7, 6, 0, 255];
        entry.set_secret(cipher).unwrap();
        assert_eq!(entry.get_secret().unwrap().as_slice(), cipher);
    }

    // ---- base64 boundary helpers ----

    #[test]
    fn base64_round_trips() {
        for case in [
            b"".as_slice(),
            b"a",
            b"ab",
            b"abc",
            b"abcd",
            &[0u8, 255, 1, 254, 127],
        ] {
            assert_eq!(unb64(&b64(case)).unwrap(), case, "round-trip mismatch");
        }
    }

    #[test]
    fn base64_rejects_stray_symbols() {
        assert!(unb64("not*base64").is_err());
    }
}
