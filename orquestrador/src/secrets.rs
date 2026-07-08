//! At-rest protection for FROST shares — the security debt from the slice.
//!
//! `frost-client` writes the config (which contains the private share) in clear. We
//! never leave that on disk: the config is **sealed** with XChaCha20-Poly1305 under a
//! 32-byte key held in the OS keychain, and only ever **unsealed** into a short-lived
//! file (0600, in tmpfs when available) for the moment a tool needs it.
//!
//! Crypto is a vetted library (`chacha20poly1305`), never hand-rolled. The keychain
//! is abstracted behind [`KeyStore`] so the domain logic is testable with a fake and
//! the real OS-backed store is wired at the Tauri layer (Windows Credential Manager /
//! macOS Keychain / Linux Secret Service).

use std::path::{Path, PathBuf};

use chacha20poly1305::aead::{Aead, KeyInit};
use chacha20poly1305::{Key, XChaCha20Poly1305, XNonce};

const NONCE_LEN: usize = 24;

#[derive(Debug, PartialEq, Eq)]
pub enum SecretError {
    /// The OS RNG failed.
    Rng,
    /// Encryption failed.
    Seal,
    /// Decryption/authentication failed — wrong key or tampered ciphertext.
    Unseal,
    /// The sealed blob is too short to contain a nonce.
    Malformed,
    /// The key store could not provide a key.
    KeyStore(String),
    /// An I/O error handling the unsealed material.
    Io(String),
    /// Key derivation from the passphrase failed.
    Kdf,
}

impl std::fmt::Display for SecretError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            SecretError::Rng => write!(f, "the operating system RNG failed"),
            SecretError::Seal => write!(f, "failed to encrypt secret"),
            SecretError::Unseal => {
                write!(f, "failed to decrypt secret (wrong key or tampered data)")
            }
            SecretError::Malformed => write!(f, "sealed blob is malformed"),
            SecretError::KeyStore(e) => write!(f, "key store error: {e}"),
            SecretError::Io(e) => write!(f, "io error: {e}"),
            SecretError::Kdf => write!(f, "failed to derive key from passphrase"),
        }
    }
}

impl std::error::Error for SecretError {}

fn random(buf: &mut [u8]) -> Result<(), SecretError> {
    getrandom::getrandom(buf).map_err(|_| SecretError::Rng)
}

/// Seal `plaintext` under `key`, returning `nonce || ciphertext+tag`.
pub fn seal(plaintext: &[u8], key: &[u8; 32]) -> Result<Vec<u8>, SecretError> {
    let cipher = XChaCha20Poly1305::new(Key::from_slice(key));
    let mut nonce = [0u8; NONCE_LEN];
    random(&mut nonce)?;
    let ciphertext = cipher
        .encrypt(XNonce::from_slice(&nonce), plaintext)
        .map_err(|_| SecretError::Seal)?;
    let mut out = Vec::with_capacity(NONCE_LEN + ciphertext.len());
    out.extend_from_slice(&nonce);
    out.extend_from_slice(&ciphertext);
    Ok(out)
}

/// Unseal a `nonce || ciphertext+tag` blob under `key`. Authentication failure
/// (wrong key or tampering) is an explicit error.
pub fn unseal(sealed: &[u8], key: &[u8; 32]) -> Result<Vec<u8>, SecretError> {
    if sealed.len() < NONCE_LEN {
        return Err(SecretError::Malformed);
    }
    let (nonce, ciphertext) = sealed.split_at(NONCE_LEN);
    let cipher = XChaCha20Poly1305::new(Key::from_slice(key));
    cipher
        .decrypt(XNonce::from_slice(nonce), ciphertext)
        .map_err(|_| SecretError::Unseal)
}

/// Somewhere to keep the per-vault sealing key. The real implementation is backed by
/// the OS keychain and lives at the Tauri layer; the domain depends only on this trait.
pub trait KeyStore {
    /// Fetch the vault's 32-byte sealing key, creating and persisting it on first use.
    fn get_or_create_key(&self, vault_id: &str) -> Result<[u8; 32], SecretError>;
}

/// Generate a fresh random 32-byte key.
pub fn generate_key() -> Result<[u8; 32], SecretError> {
    let mut k = [0u8; 32];
    random(&mut k)?;
    Ok(k)
}

// ---- vault passphrase ("palavra do cofre") ----
//
// The passphrase derives the sealing key (Argon2id, memory-hard) with a per-vault salt.
// Without the word, the sealed shares do not open — no sealing key sits on disk. This is
// a product access-lock strengthened by a real KDF, distinct from the FROST quorum
// guarantee (§14): losing the word means the sealed share on this device is unrecoverable.

/// Salt length for [`derive_key`] (Argon2 requires ≥ 8 bytes).
pub const SALT_LEN: usize = 16;
/// How many words a generated passphrase has.
pub const PASSPHRASE_WORDS: usize = 4;
/// Known plaintext sealed under the derived key so a passphrase can be *verified*
/// (on "unlock") without opening a real share.
const VERIFY_MAGIC: &[u8] = b"konclave-vault-unlock-v1";

/// Derive the 32-byte sealing key from a passphrase + per-vault salt (Argon2id).
/// Deterministic: same inputs → same key; any change → a key that cannot unseal.
pub fn derive_key(passphrase: &str, salt: &[u8]) -> Result<[u8; 32], SecretError> {
    let mut key = [0u8; 32];
    argon2::Argon2::default()
        .hash_password_into(passphrase.as_bytes(), salt, &mut key)
        .map_err(|_| SecretError::Kdf)?;
    Ok(key)
}

/// A fresh random salt for a new vault's passphrase.
pub fn generate_salt() -> Result<[u8; SALT_LEN], SecretError> {
    let mut s = [0u8; SALT_LEN];
    random(&mut s)?;
    Ok(s)
}

/// Generate a memorable passphrase: `PASSPHRASE_WORDS` words joined by '-' (no accents,
/// easy to write down and type). Shown once at vault creation.
pub fn generate_passphrase() -> Result<String, SecretError> {
    let mut idx = [0u8; PASSPHRASE_WORDS];
    random(&mut idx)?;
    let words: Vec<&str> = idx
        .iter()
        .map(|b| WORDLIST[*b as usize % WORDLIST.len()])
        .collect();
    Ok(words.join("-"))
}

/// Seal a fixed marker under `key` so the passphrase can later be verified.
pub fn make_verifier(key: &[u8; 32]) -> Result<Vec<u8>, SecretError> {
    seal(VERIFY_MAGIC, key)
}

/// True when `key` opens `verifier` (i.e. the passphrase that derived `key` is correct).
pub fn verify(key: &[u8; 32], verifier: &[u8]) -> bool {
    matches!(unseal(verifier, key), Ok(m) if m == VERIFY_MAGIC)
}

/// 128 simple, accent-free Portuguese words — enough to be memorable; the memory-hard
/// KDF does the heavy lifting against guessing. (Product lock, not the FROST guarantee.)
const WORDLIST: &[&str] = &[
    "cedro",
    "barco",
    "pedra",
    "chave",
    "monte",
    "folha",
    "vento",
    "praia",
    "campo",
    "porto",
    "livro",
    "ponte",
    "nuvem",
    "trigo",
    "areia",
    "lagoa",
    "serra",
    "coral",
    "manga",
    "cacau",
    "prata",
    "ouro",
    "ferro",
    "vidro",
    "linho",
    "seda",
    "lenha",
    "carvao",
    "raiz",
    "galho",
    "flor",
    "fruto",
    "mel",
    "sal",
    "cera",
    "corda",
    "rede",
    "vela",
    "remo",
    "mastro",
    "farol",
    "cais",
    "duna",
    "gruta",
    "cume",
    "vale",
    "rio",
    "fonte",
    "poco",
    "trilha",
    "mapa",
    "bussola",
    "norte",
    "sul",
    "leste",
    "oeste",
    "aurora",
    "brisa",
    "orvalho",
    "geada",
    "raio",
    "trovao",
    "chuva",
    "neve",
    "gelo",
    "brasa",
    "chama",
    "fumaca",
    "cinza",
    "faisca",
    "tigre",
    "lobo",
    "raposa",
    "coruja",
    "falcao",
    "gaviao",
    "garca",
    "cisne",
    "pato",
    "ganso",
    "abelha",
    "formiga",
    "grilo",
    "besouro",
    "libelula",
    "aranha",
    "cobra",
    "lagarto",
    "sapo",
    "peixe",
    "baleia",
    "golfinho",
    "polvo",
    "camarao",
    "ostra",
    "concha",
    "estrela",
    "medusa",
    "alga",
    "musgo",
    "roble",
    "faia",
    "pinho",
    "salgueiro",
    "bambu",
    "junco",
    "espiga",
    "grao",
    "farinha",
    "massa",
    "queijo",
    "leite",
    "manteiga",
    "azeite",
    "cacto",
    "palma",
    "figo",
    "uva",
    "amora",
    "pinha",
    "castanha",
    "avela",
    "noz",
    "amendoa",
    "canela",
    "cravo",
    "gengibre",
    "pimenta",
];

/// A short-lived file holding unsealed plaintext, removed on drop (best-effort) so it
/// cannot outlive the operation even on panic.
struct EphemeralFile {
    path: PathBuf,
}

impl EphemeralFile {
    fn create(contents: &[u8]) -> Result<EphemeralFile, SecretError> {
        // Prefer tmpfs (never touches disk) when available.
        let dir = if Path::new("/dev/shm").is_dir() {
            PathBuf::from("/dev/shm")
        } else {
            std::env::temp_dir()
        };
        let mut suffix = [0u8; 8];
        random(&mut suffix)?;
        let name = format!(
            "konclave-{}.tmp",
            suffix
                .iter()
                .map(|b| format!("{b:02x}"))
                .collect::<String>()
        );
        let path = dir.join(name);

        write_private(&path, contents).map_err(|e| SecretError::Io(e.to_string()))?;
        Ok(EphemeralFile { path })
    }
}

impl Drop for EphemeralFile {
    fn drop(&mut self) {
        let _ = std::fs::remove_file(&self.path);
    }
}

#[cfg(unix)]
fn write_private(path: &Path, contents: &[u8]) -> std::io::Result<()> {
    use std::io::Write;
    use std::os::unix::fs::OpenOptionsExt;
    let mut f = std::fs::OpenOptions::new()
        .create_new(true)
        .write(true)
        .mode(0o600)
        .open(path)?;
    f.write_all(contents)
}

#[cfg(not(unix))]
fn write_private(path: &Path, contents: &[u8]) -> std::io::Result<()> {
    // On Windows the file lands in the user profile temp dir (per-user ACL) and is
    // removed immediately after use. ACL hardening is applied at the Tauri layer.
    std::fs::write(path, contents)
}

/// Unseal `sealed` under `key` into a short-lived 0600 file, run `op` with its path,
/// then delete the file. The plaintext never persists beyond `op`.
pub fn with_unsealed_file<T>(
    sealed: &[u8],
    key: &[u8; 32],
    op: impl FnOnce(&Path) -> T,
) -> Result<T, SecretError> {
    let plaintext = unseal(sealed, key)?;
    let file = EphemeralFile::create(&plaintext)?;
    let result = op(&file.path);
    // `file` drops here, removing the plaintext.
    Ok(result)
}

/// An unsealed secret materialized as a short-lived 0600 file, removed when dropped.
/// Use this when several unsealed files must live at once (e.g. one config per FROST
/// signer for the whole ceremony) — hold the guards, use their paths, let them drop.
pub struct UnsealedFile {
    file: EphemeralFile,
}

impl UnsealedFile {
    /// Path to the ephemeral plaintext file (valid until this guard drops).
    pub fn path(&self) -> &Path {
        &self.file.path
    }
}

/// Unseal into a short-lived 0600 file and return a guard that deletes it on drop.
pub fn unseal_to_file(sealed: &[u8], key: &[u8; 32]) -> Result<UnsealedFile, SecretError> {
    let plaintext = unseal(sealed, key)?;
    Ok(UnsealedFile {
        file: EphemeralFile::create(&plaintext)?,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::cell::RefCell;
    use std::collections::HashMap;

    /// In-memory KeyStore for tests (the real one is OS-keychain-backed).
    #[derive(Default)]
    struct MemoryKeyStore {
        keys: RefCell<HashMap<String, [u8; 32]>>,
    }
    impl KeyStore for MemoryKeyStore {
        fn get_or_create_key(&self, vault_id: &str) -> Result<[u8; 32], SecretError> {
            let mut keys = self.keys.borrow_mut();
            if let Some(k) = keys.get(vault_id) {
                Ok(*k)
            } else {
                let k = generate_key()?;
                keys.insert(vault_id.to_string(), k);
                Ok(k)
            }
        }
    }

    #[test]
    fn seal_unseal_roundtrip() {
        let key = generate_key().unwrap();
        let secret = b"private FROST share material";
        let sealed = seal(secret, &key).unwrap();
        assert_ne!(&sealed[24..], secret, "ciphertext must not equal plaintext");
        assert_eq!(unseal(&sealed, &key).unwrap(), secret);
    }

    #[test]
    fn wrong_key_fails_to_unseal() {
        let key = generate_key().unwrap();
        let other = generate_key().unwrap();
        let sealed = seal(b"share", &key).unwrap();
        assert_eq!(unseal(&sealed, &other), Err(SecretError::Unseal));
    }

    #[test]
    fn tampering_is_detected() {
        let key = generate_key().unwrap();
        let mut sealed = seal(b"share", &key).unwrap();
        let last = sealed.len() - 1;
        sealed[last] ^= 0x01; // flip a ciphertext/tag bit
        assert_eq!(unseal(&sealed, &key), Err(SecretError::Unseal));
    }

    #[test]
    fn malformed_blob_is_rejected() {
        let key = generate_key().unwrap();
        assert_eq!(unseal(&[0u8; 10], &key), Err(SecretError::Malformed));
    }

    #[test]
    fn nonces_differ_between_seals() {
        let key = generate_key().unwrap();
        let a = seal(b"same", &key).unwrap();
        let b = seal(b"same", &key).unwrap();
        assert_ne!(a[..24], b[..24], "each seal must use a fresh nonce");
    }

    #[test]
    fn keystore_is_stable_per_vault() {
        let ks = MemoryKeyStore::default();
        let k1 = ks.get_or_create_key("vault-1").unwrap();
        let k1_again = ks.get_or_create_key("vault-1").unwrap();
        let k2 = ks.get_or_create_key("vault-2").unwrap();
        assert_eq!(k1, k1_again, "same vault => same key");
        assert_ne!(k1, k2, "different vaults => different keys");
    }

    #[test]
    fn unsealed_file_has_content_and_is_removed_after() {
        let key = generate_key().unwrap();
        let sealed = seal(b"credentials.toml bytes", &key).unwrap();

        let mut captured_path = PathBuf::new();
        let content = with_unsealed_file(&sealed, &key, |p| {
            captured_path = p.to_path_buf();
            let read = std::fs::read(p).unwrap();
            #[cfg(unix)]
            {
                use std::os::unix::fs::PermissionsExt;
                let mode = std::fs::metadata(p).unwrap().permissions().mode() & 0o777;
                assert_eq!(mode, 0o600, "unsealed file must be private (0600)");
            }
            read
        })
        .unwrap();

        assert_eq!(content, b"credentials.toml bytes");
        assert!(
            !captured_path.exists(),
            "plaintext must be removed after use"
        );
    }

    #[test]
    fn derive_key_is_stable_and_input_sensitive() {
        let salt = generate_salt().unwrap();
        let k = derive_key("cedro-barco-pedra-chave", &salt).unwrap();
        // Same passphrase + salt => same key (so the vault reopens next session).
        assert_eq!(k, derive_key("cedro-barco-pedra-chave", &salt).unwrap());
        // A different passphrase => a different key.
        assert_ne!(k, derive_key("cedro-barco-pedra-monte", &salt).unwrap());
        // A different salt => a different key (defeats precomputation across vaults).
        let salt2 = generate_salt().unwrap();
        assert_ne!(k, derive_key("cedro-barco-pedra-chave", &salt2).unwrap());
    }

    #[test]
    fn passphrase_unseals_share_but_wrong_word_does_not() {
        let salt = generate_salt().unwrap();
        let key = derive_key("cedro-barco-pedra-chave", &salt).unwrap();
        let sealed = seal(b"credentials.toml (private share)", &key).unwrap();

        // Right passphrase re-derives the key and opens the share.
        let right = derive_key("cedro-barco-pedra-chave", &salt).unwrap();
        assert_eq!(
            unseal(&sealed, &right).unwrap(),
            b"credentials.toml (private share)"
        );
        // Wrong passphrase derives a different key — the share stays closed.
        let wrong = derive_key("cedro-barco-pedra-monte", &salt).unwrap();
        assert_eq!(unseal(&sealed, &wrong), Err(SecretError::Unseal));
    }

    #[test]
    fn verifier_accepts_right_passphrase_only() {
        let salt = generate_salt().unwrap();
        let key = derive_key("serra-coral-manga-cacau", &salt).unwrap();
        let verifier = make_verifier(&key).unwrap();
        assert!(verify(&key, &verifier), "right key verifies");
        let wrong = derive_key("serra-coral-manga-prata", &salt).unwrap();
        assert!(!verify(&wrong, &verifier), "wrong key must not verify");
    }

    #[test]
    fn generated_passphrase_has_the_expected_shape() {
        let p = generate_passphrase().unwrap();
        let words: Vec<&str> = p.split('-').collect();
        assert_eq!(words.len(), PASSPHRASE_WORDS);
        assert!(words.iter().all(|w| !w.is_empty()));
    }

    #[test]
    fn unseal_to_file_guard_removes_on_drop() {
        let key = generate_key().unwrap();
        let sealed = seal(b"alice.toml share", &key).unwrap();
        let path;
        {
            let uf = unseal_to_file(&sealed, &key).unwrap();
            path = uf.path().to_path_buf();
            assert_eq!(std::fs::read(uf.path()).unwrap(), b"alice.toml share");
        } // guard drops here
        assert!(
            !path.exists(),
            "plaintext must be removed when the guard drops"
        );
    }
}
