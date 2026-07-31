//! Building blocks for the hosted blind helper (ADR-0006, Rung A): the pieces that let a
//! service operate a vault from **public / view-only** material only, never a share. It starts
//! with deriving a vault's Orchard address + UFVK from its FROST group verifying key, so a blind
//! helper can register a vault knowing only its group key (which the browser already shows on
//! `/net`). More of the hosted-helper surface (per-vault view-only wallets, the Architecture-B
//! send path) lands on this module as Rung A is built.

use std::path::{Path, PathBuf};

use crate::tools::{run, run_text_all, ToolError};

/// What a hosted blind helper needs to operate vaults. All of it is public tooling and view-only
/// material: there is no share and no seed anywhere in here, by construction.
#[derive(Debug, Clone)]
pub struct HelperConfig {
    /// `zcash-sign` binary (derives address + UFVK from a group key).
    pub zcash_sign: PathBuf,
    /// `zcash-devtool` binary (view-only wallet init/sync, PCZT).
    pub devtool: PathBuf,
    /// lightwalletd endpoint, e.g. "testnet.zec.rocks:443".
    pub lightwalletd: String,
    /// "main" or "test".
    pub network: String,
    /// Base directory under which each vault's view-only wallet lives (`<vaults_dir>/<vault_id>/wallet`).
    pub vaults_dir: PathBuf,
}

/// A vault registered with the helper: its public identity plus where its view-only wallet lives.
/// `vault_id` equals the group verifying key hex (the same id the browser shows on `/net`).
#[derive(Debug, Clone)]
pub struct VaultRegistration {
    pub vault_id: String,
    pub address: String,
    pub ufvk: String,
    pub wallet_dir: String,
}

/// True for a well-formed FROST group verifying key: 64 lowercase-or-upper hex chars (32 bytes).
pub fn is_valid_group_key(s: &str) -> bool {
    s.len() == 64 && s.bytes().all(|b| b.is_ascii_hexdigit())
}

/// The view-only wallet directory a helper uses for a given vault.
pub fn wallet_dir_for(vaults_dir: &Path, group_key: &str) -> String {
    format!("{}/{}/wallet", vaults_dir.display(), group_key)
}

/// Register a vault with the helper by its FROST group key: derive its Orchard address + UFVK
/// (public material only), then initialise a **view-only** wallet from the UFVK. The helper thus
/// knows only what a watcher knows; it never sees or stores a share. Rejects a malformed group key
/// before running anything.
pub fn register_vault(
    cfg: &HelperConfig,
    group_key: &str,
    name: &str,
) -> Result<VaultRegistration, ToolError> {
    if !is_valid_group_key(group_key) {
        return Err(ToolError::parse(
            "helper",
            format!("group key must be 64 hex chars, got {} chars", group_key.len()),
        ));
    }
    let (address, ufvk) = derive_identity(&cfg.zcash_sign, group_key, &cfg.network)?;
    let wallet_dir = wallet_dir_for(&cfg.vaults_dir, group_key);
    run(
        &cfg.devtool,
        &[
            "wallet",
            "-w",
            wallet_dir.as_str(),
            "init-fvk",
            "--name",
            name,
            "--fvk",
            ufvk.as_str(),
            "-s",
            cfg.lightwalletd.as_str(),
            "--connection",
            "direct",
        ],
        None,
    )?;
    Ok(VaultRegistration {
        vault_id: group_key.to_string(),
        address,
        ufvk,
        wallet_dir,
    })
}

/// Derive a vault's Orchard-only receive address and its UFVK from the FROST group verifying key,
/// via `zcash-sign generate --ak <group> --network <network>`. Only **public** material is used
/// (no share), which is exactly what a blind helper is allowed to touch. `network` is `"main"` or
/// `"test"`; anything else is rejected before any process runs.
pub fn derive_identity(
    zcash_sign: &Path,
    group_key: &str,
    network: &str,
) -> Result<(String, String), ToolError> {
    if network != "main" && network != "test" {
        return Err(ToolError::parse(
            "zcash-sign",
            format!("network must be \"main\" or \"test\", got {network:?}"),
        ));
    }
    let out = run_text_all(
        zcash_sign,
        &["generate", "--ak", group_key, "--network", network],
        None,
    )?;
    parse_generate(&out)
}

/// In-memory registry of the vaults a hosted helper is operating, keyed by vault_id (the group
/// key). Thread-safe. It holds only each vault's public / view-only `VaultRegistration`, never a
/// share, so a dump of this state leaks nothing spendable.
#[derive(Default)]
pub struct HelperState {
    vaults: std::sync::Mutex<std::collections::HashMap<String, VaultRegistration>>,
}

impl HelperState {
    pub fn new() -> Self {
        Self::default()
    }

    /// Insert or replace a vault's registration.
    pub fn insert(&self, reg: VaultRegistration) {
        self.vaults
            .lock()
            .expect("helper state mutex")
            .insert(reg.vault_id.clone(), reg);
    }

    /// The registration for a vault, if registered.
    pub fn get(&self, vault_id: &str) -> Option<VaultRegistration> {
        self.vaults
            .lock()
            .expect("helper state mutex")
            .get(vault_id)
            .cloned()
    }

    pub fn contains(&self, vault_id: &str) -> bool {
        self.vaults
            .lock()
            .expect("helper state mutex")
            .contains_key(vault_id)
    }

    /// Registered vault ids, sorted (stable for listing).
    pub fn ids(&self) -> Vec<String> {
        let m = self.vaults.lock().expect("helper state mutex");
        let mut ids: Vec<String> = m.keys().cloned().collect();
        ids.sort();
        ids
    }

    pub fn len(&self) -> usize {
        self.vaults.lock().expect("helper state mutex").len()
    }

    pub fn is_empty(&self) -> bool {
        self.vaults.lock().expect("helper state mutex").is_empty()
    }
}

/// Parse `zcash-sign generate`'s output into (orchard address, ufvk).
fn parse_generate(out: &str) -> Result<(String, String), ToolError> {
    let addr = extract_quoted(out, "unified address:")?;
    let ufvk = extract_quoted(out, "Viewing Key:")?;
    Ok((addr, ufvk))
}

/// Pull the value inside the last pair of quotes on the first line containing `after`.
fn extract_quoted(out: &str, after: &str) -> Result<String, ToolError> {
    for line in out.lines() {
        if let Some(idx) = line.find(after) {
            let rest = &line[idx + after.len()..];
            if let (Some(a), Some(b)) = (rest.find('"'), rest.rfind('"')) {
                if b > a {
                    return Ok(rest[a + 1..b].to_string());
                }
            }
        }
    }
    Err(ToolError::parse(
        "zcash-sign",
        format!("no quoted value found after '{after}'"),
    ))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_mainnet_address_and_ufvk() {
        let out = "Orchard-only unified address: \"u14g48z7mn\"\nUnified Full Viewing Key: \"uview1x2w3\"\n";
        let (a, u) = parse_generate(out).unwrap();
        assert_eq!(a, "u14g48z7mn");
        assert_eq!(u, "uview1x2w3");
    }

    #[test]
    fn parses_testnet_address_and_ufvk() {
        let out = "Orchard-only unified address: \"utest1r6jhrp5\"\nUnified Full Viewing Key: \"uviewtest1y53lp3\"\n";
        let (a, u) = parse_generate(out).unwrap();
        assert_eq!(a, "utest1r6jhrp5");
        assert_eq!(u, "uviewtest1y53lp3");
    }

    #[test]
    fn missing_quoted_value_is_an_error() {
        assert!(parse_generate("nothing quoted here").is_err());
        assert!(parse_generate("Orchard-only unified address: no quotes").is_err());
    }

    #[test]
    fn rejects_unknown_network_before_running_anything() {
        // The network guard fires before exec, so the bogus binary path is never touched.
        let e = derive_identity(Path::new("/nonexistent/zcash-sign"), "deadbeef", "regtest");
        assert!(e.is_err());
    }

    #[test]
    fn group_key_validation() {
        let good = "6ed62d0ba95e25668f80104425723a57d2be9ae525b28535f04850e4456edd1b";
        assert!(is_valid_group_key(good));
        assert_eq!(good.len(), 64);
        assert!(!is_valid_group_key("6ed62d0b")); // too short
        assert!(!is_valid_group_key(&"z".repeat(64))); // non-hex
        assert!(!is_valid_group_key("")); // empty
    }

    #[test]
    fn wallet_dir_path() {
        let d = wallet_dir_for(Path::new("/srv/vaults"), "abcd");
        assert_eq!(d, "/srv/vaults/abcd/wallet");
    }

    fn reg(id: &str) -> VaultRegistration {
        VaultRegistration {
            vault_id: id.into(),
            address: format!("u1{id}"),
            ufvk: format!("uview1{id}"),
            wallet_dir: format!("/tmp/{id}/wallet"),
        }
    }

    #[test]
    fn helper_state_registry() {
        let st = HelperState::new();
        assert!(st.is_empty());
        st.insert(reg("aaaa"));
        st.insert(reg("bbbb"));
        st.insert(reg("aaaa")); // replace, not duplicate
        assert_eq!(st.len(), 2);
        assert!(st.contains("aaaa"));
        assert!(!st.contains("cccc"));
        assert_eq!(st.get("bbbb").unwrap().address, "u1bbbb");
        assert!(st.get("cccc").is_none());
        assert_eq!(st.ids(), vec!["aaaa".to_string(), "bbbb".to_string()]);
    }

    #[test]
    fn register_vault_rejects_bad_group_key_before_exec() {
        // A malformed group key is rejected before any binary runs, so the bogus paths are safe.
        let cfg = HelperConfig {
            zcash_sign: PathBuf::from("/nonexistent/zcash-sign"),
            devtool: PathBuf::from("/nonexistent/zcash-devtool"),
            lightwalletd: "testnet.zec.rocks:443".into(),
            network: "test".into(),
            vaults_dir: PathBuf::from("/tmp/konclave-helper-vaults"),
        };
        assert!(register_vault(&cfg, "not-a-valid-key", "demo").is_err());
    }
}
