//! Building blocks for the hosted blind helper (ADR-0006, Rung A): the pieces that let a
//! service operate a vault from **public / view-only** material only, never a share. It starts
//! with deriving a vault's Orchard address + UFVK from its FROST group verifying key, so a blind
//! helper can register a vault knowing only its group key (which the browser already shows on
//! `/net`). More of the hosted-helper surface (per-vault view-only wallets, the Architecture-B
//! send path) lands on this module as Rung A is built.

use std::path::{Path, PathBuf};

use zcash_protocol::consensus::NetworkType;

use crate::address::{validate_recipient_on, AddressError};
use crate::send::{SendConfig, SpendPlan};
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
    /// `konclave-signer` binary (extracts the sighash the devices sign; injects their
    /// aggregate FROST signatures back into the PCZT). Needed for the Architecture-B send.
    pub konclave_signer: PathBuf,
    /// Base directory under which each vault's view-only wallet lives (`<vaults_dir>/<vault_id>/wallet`).
    pub vaults_dir: PathBuf,
}

impl HelperConfig {
    /// The `NetworkType` for `network` (defaults to mainnet for any non-"test" value; the
    /// send/register paths reject a truly bad network at the `zcash-sign` boundary).
    pub fn network_type(&self) -> NetworkType {
        if self.network == "test" {
            NetworkType::Test
        } else {
            NetworkType::Main
        }
    }
}

/// Why a send request was rejected before any engine ran. Maps to a `400` at the boundary:
/// these are all caller-fixable (bad destination, zero amount), not helper faults.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum SendReject {
    /// The destination failed authoritative decode / pool / network validation.
    Address(AddressError),
    /// The destination decoded but cannot receive shielded Orchard funds (Sapling-only /
    /// transparent-only) — Konclave is shielded-first and refuses to lock funds (§8).
    NotOrchard,
    /// The amount was zero (nothing to send).
    ZeroAmount,
}

impl std::fmt::Display for SendReject {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            SendReject::Address(e) => write!(f, "{e}"),
            SendReject::NotOrchard => {
                write!(f, "this address cannot receive shielded Orchard funds")
            }
            SendReject::ZeroAmount => write!(f, "amount must be greater than zero"),
        }
    }
}

/// Validate a single-payment destination + amount and build the `SpendPlan` the helper spends.
/// Authoritative: the recipient is decoded with `zcash_address` on the helper's network and must
/// be able to receive Orchard (shielded-first, §8 — a Sapling/transparent-only address would lock
/// funds). Rejections are caller-fixable (`SendReject`) and happen before any engine runs.
pub fn payment_plan(
    to: &str,
    amount_zat: u64,
    memo: Option<String>,
    network: NetworkType,
) -> Result<SpendPlan, SendReject> {
    if amount_zat == 0 {
        return Err(SendReject::ZeroAmount);
    }
    let report = validate_recipient_on(to, network).map_err(SendReject::Address)?;
    if !report.orchard {
        return Err(SendReject::NotOrchard);
    }
    Ok(SpendPlan::Payment {
        to: to.to_string(),
        value_zat: amount_zat,
        memo,
    })
}

/// Build the `SendConfig` for an Architecture-B send from a registered vault. Only the
/// build/prove/extract/inject/broadcast fields are populated — the ceremony fields (members,
/// frostd, certs, threshold) are left empty on purpose: in Architecture B the **browsers** run
/// the FROST ceremony over the relay, and `send::net_orchestrate_send` never touches those
/// fields. The helper is blind to shares; it only assembles the PCZT and broadcasts the
/// signature the devices return. `work_dir` is a scratch directory for the intermediate PCZTs.
pub fn send_config_for(
    cfg: &HelperConfig,
    reg: &VaultRegistration,
    work_dir: String,
) -> SendConfig {
    SendConfig {
        devtool: cfg.devtool.clone(),
        wallet_dir: reg.wallet_dir.clone(),
        lightwalletd: cfg.lightwalletd.clone(),
        account: reg.account.clone(),
        konclave_signer: cfg.konclave_signer.clone(),
        // Ceremony fields: unused on the Architecture-B path (browsers sign). Kept empty.
        frostd: PathBuf::new(),
        frost_client: PathBuf::new(),
        members: Vec::new(),
        threshold: 0,
        group: reg.vault_id.clone(),
        frostd_cert: String::new(),
        frostd_key: String::new(),
        frostd_ip: "127.0.0.1".into(),
        frostd_port: 2744,
        server_url: String::new(),
        work_dir,
        sealing_key_file: None,
        sealing_keychain_id: None,
        zcash_sign: Some(cfg.zcash_sign.clone()),
        vaults_dir: Some(cfg.vaults_dir.display().to_string()),
    }
}

/// A vault registered with the helper: its public identity plus where its view-only wallet lives.
/// `vault_id` equals the group verifying key hex (the same id the browser shows on `/net`).
#[derive(Debug, Clone)]
pub struct VaultRegistration {
    pub vault_id: String,
    pub address: String,
    pub ufvk: String,
    pub wallet_dir: String,
    /// The wallet account uuid the view-only wallet created (the PCZT spends from it).
    pub account: String,
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
            format!(
                "group key must be 64 hex chars, got {} chars",
                group_key.len()
            ),
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
    let listed = run_text_all(
        &cfg.devtool,
        &["wallet", "-w", wallet_dir.as_str(), "list-addresses"],
        None,
    )?;
    let account = parse_account_uuid(&listed)?;
    Ok(VaultRegistration {
        vault_id: group_key.to_string(),
        address,
        ufvk,
        wallet_dir,
        account,
    })
}

/// Pull the wallet account uuid from `zcash-devtool wallet list-addresses` output
/// (the line `Account AccountUuid(<uuid>)`).
fn parse_account_uuid(out: &str) -> Result<String, ToolError> {
    const MARK: &str = "AccountUuid(";
    for line in out.lines() {
        if let Some(i) = line.find(MARK) {
            let rest = &line[i + MARK.len()..];
            if let Some(j) = rest.find(')') {
                return Ok(rest[..j].to_string());
            }
        }
    }
    Err(ToolError::parse(
        "zcash-devtool",
        "no AccountUuid in list-addresses output",
    ))
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
            account: format!("acct-{id}"),
        }
    }

    #[test]
    fn account_uuid_parse() {
        let out = "Account AccountUuid(2d11d2b2-3e15-49f2-9178-3f856af5050b)\n     Default Address: utest1r6jhrp5\n";
        assert_eq!(
            parse_account_uuid(out).unwrap(),
            "2d11d2b2-3e15-49f2-9178-3f856af5050b"
        );
        assert!(parse_account_uuid("no account here").is_err());
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
            konclave_signer: PathBuf::from("/nonexistent/konclave-signer"),
            vaults_dir: PathBuf::from("/tmp/konclave-helper-vaults"),
        };
        assert!(register_vault(&cfg, "not-a-valid-key", "demo").is_err());
    }

    fn send_cfg(network: &str) -> HelperConfig {
        HelperConfig {
            zcash_sign: PathBuf::from("/bin/zcash-sign"),
            devtool: PathBuf::from("/bin/zcash-devtool"),
            lightwalletd: "zec.rocks:443".into(),
            network: network.into(),
            konclave_signer: PathBuf::from("/bin/konclave-signer"),
            vaults_dir: PathBuf::from("/srv/vaults"),
        }
    }

    // A real mainnet Orchard-capable unified address (from the slice vault).
    const MAIN_ORCHARD_UA: &str = "u1vjgxlvz4ewnt43rkq6fzexpl639745spx369tc4j9n9l0qnt9rufxdt2pxe3jtku7lqv4gtzfqafxtf7gal5y9gmz84nkza6z5d406dr";
    // A mainnet transparent-only address (cannot receive Orchard).
    const MAIN_TRANSPARENT: &str = "t1Hsc1LR8yKnbbe3twRp88p6vFfC5t7DLbs";

    #[test]
    fn payment_plan_accepts_orchard_and_carries_memo() {
        let plan = payment_plan(
            MAIN_ORCHARD_UA,
            100_000,
            Some("hi".into()),
            NetworkType::Main,
        )
        .unwrap();
        match plan {
            SpendPlan::Payment {
                to,
                value_zat,
                memo,
            } => {
                assert_eq!(to, MAIN_ORCHARD_UA);
                assert_eq!(value_zat, 100_000);
                assert_eq!(memo.as_deref(), Some("hi"));
            }
            _ => panic!("expected a payment plan"),
        }
    }

    #[test]
    fn payment_plan_rejects_zero_amount_before_decode() {
        // Zero is caught first, so even a garbage address never reaches the decoder.
        assert_eq!(
            payment_plan("garbage", 0, None, NetworkType::Main).err(),
            Some(SendReject::ZeroAmount)
        );
    }

    #[test]
    fn payment_plan_rejects_transparent_only_and_wrong_network() {
        // Shielded-first: a transparent-only destination is refused (would not land in Orchard).
        assert_eq!(
            payment_plan(MAIN_TRANSPARENT, 50_000, None, NetworkType::Main).err(),
            Some(SendReject::NotOrchard)
        );
        // A mainnet address on a testnet helper is a network mismatch, not accepted.
        assert!(matches!(
            payment_plan(MAIN_ORCHARD_UA, 50_000, None, NetworkType::Test),
            Err(SendReject::Address(_))
        ));
        // Outright garbage is a malformed-address rejection.
        assert!(matches!(
            payment_plan("not-an-address", 50_000, None, NetworkType::Main),
            Err(SendReject::Address(_))
        ));
    }

    #[test]
    fn send_config_maps_public_fields_and_leaves_ceremony_empty() {
        let cfg = send_cfg("main");
        let r = reg("abcd");
        let sc = send_config_for(&cfg, &r, "/tmp/work-abcd".into());
        // Send-path fields come from the vault + helper tooling.
        assert_eq!(sc.wallet_dir, r.wallet_dir);
        assert_eq!(sc.account, r.account);
        assert_eq!(sc.group, r.vault_id);
        assert_eq!(sc.lightwalletd, "zec.rocks:443");
        assert_eq!(sc.konclave_signer, PathBuf::from("/bin/konclave-signer"));
        assert_eq!(sc.work_dir, "/tmp/work-abcd");
        // Architecture B: the browsers sign, so the helper carries no ceremony material.
        assert!(sc.members.is_empty());
        assert_eq!(sc.threshold, 0);
        assert!(sc.frostd_cert.is_empty());
        assert!(sc.server_url.is_empty());
    }

    #[test]
    fn network_type_maps_main_and_test() {
        assert_eq!(send_cfg("test").network_type(), NetworkType::Test);
        assert_eq!(send_cfg("main").network_type(), NetworkType::Main);
        // Anything unexpected defaults to mainnet (the safe, production default).
        assert_eq!(send_cfg("regtest").network_type(), NetworkType::Main);
    }
}
