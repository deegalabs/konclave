//! Building blocks for the hosted blind helper (ADR-0006, Rung A): the pieces that let a
//! service operate a vault from **public / view-only** material only, never a share. It starts
//! with deriving a vault's Orchard address + UFVK from its FROST group verifying key, so a blind
//! helper can register a vault knowing only its group key (which the browser already shows on
//! `/net`). More of the hosted-helper surface (per-vault view-only wallets, the Architecture-B
//! send path) lands on this module as Rung A is built.

use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};
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

/// A vault's Orchard balance as the helper reports it to the browsers. Orchard-only and minimal:
/// spendable (confirmed, ready to send) plus total (including notes still confirming). Internal
/// transparency for the members — the helper reads it from its view-only wallet.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct VaultBalance {
    pub orchard_spendable_zat: u64,
    pub total_zat: u64,
}

/// Sync a registered vault's view-only wallet against lightwalletd and read its Orchard balance.
/// The helper owns the UFVK (view-only), so this is a watcher's read — no share involved. Network
/// + engine I/O, so it is exercised live, not in unit tests.
pub fn vault_balance(
    cfg: &HelperConfig,
    reg: &VaultRegistration,
) -> Result<VaultBalance, ToolError> {
    crate::wallet::sync(&cfg.devtool, &reg.wallet_dir, &cfg.lightwalletd)?;
    let b = crate::wallet::balance(&cfg.devtool, &reg.wallet_dir)?;
    Ok(VaultBalance {
        orchard_spendable_zat: b.orchard_spendable.as_u64(),
        total_zat: b.total.as_u64(),
    })
}

/// A record of one signing ceremony the helper drove for a vault (ZecSafe-inspired reproducible
/// evidence): what was signed, by whom cryptographically (the aggregate FROST signature), and the
/// resulting on-chain txid. Every field is PUBLIC and independently checkable — anyone can verify
/// each `signatures` entry under the vault's group verifying key for `sighash` (off-chain), and
/// confirm `txid` on a block explorer (on-chain). Persisted per vault so the trail is auditable
/// and survives restarts. Contains no share and no secret.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CeremonyRecord {
    pub vault_id: String,
    /// The shielded sighash the quorum signed (hex).
    pub sighash: String,
    /// The aggregate FROST signature(s), one hex per real spend (64 bytes each).
    pub signatures: Vec<String>,
    /// The broadcast txid, or `None` on a dry-run (signed, not broadcast).
    pub txid: Option<String>,
    pub dry_run: bool,
    /// Unix seconds when the helper recorded the ceremony.
    pub created_at_unix: u64,
}

/// Where a vault's ceremony trail lives: `<vaults_dir>/<vault_id>/ceremonies.jsonl` (one JSON
/// record per line, append-only).
pub fn ceremonies_path(vaults_dir: &Path, group_key: &str) -> PathBuf {
    vaults_dir.join(group_key).join("ceremonies.jsonl")
}

/// Append a ceremony record to the vault's trail (creating the dir/file as needed). Best-effort at
/// the call site: a persistence failure must not undo a completed send.
pub fn append_ceremony(vaults_dir: &Path, rec: &CeremonyRecord) -> Result<(), ToolError> {
    use std::io::Write;
    let path = ceremonies_path(vaults_dir, &rec.vault_id);
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent).map_err(ToolError::Io)?;
    }
    let line =
        serde_json::to_string(rec).map_err(|e| ToolError::parse("ceremony", e.to_string()))?;
    let mut f = std::fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(&path)
        .map_err(ToolError::Io)?;
    writeln!(f, "{line}").map_err(ToolError::Io)?;
    Ok(())
}

/// Load a vault's ceremony trail (newest last), skipping any unparseable line. Empty when there
/// is no trail yet.
pub fn load_ceremonies(vaults_dir: &Path, group_key: &str) -> Vec<CeremonyRecord> {
    let path = ceremonies_path(vaults_dir, group_key);
    let Ok(text) = std::fs::read_to_string(path) else {
        return Vec::new();
    };
    text.lines()
        .filter(|l| !l.trim().is_empty())
        .filter_map(|l| serde_json::from_str(l).ok())
        .collect()
}

/// A payment proposal on a browser-native vault. It is PUBLIC coordination data (internal
/// transparency): a member proposes a spend, members vote, and at quorum the browsers run the FROST
/// ceremony (Architecture B) which the helper broadcasts.
///
/// SECURITY MODEL (audit): the helper is a public service, so these vote endpoints are
/// **unauthenticated** in this iteration — anyone who knows the vault_id could POST a proposal or a
/// vote. That is a coordination/spam surface, NOT a fund-safety hole: the real money gate is the
/// FROST ceremony, which needs `threshold` REAL browser shares to produce a valid signature. A
/// forged vote only changes the displayed approval count; it cannot move funds. The hardening
/// follow-up is votes SIGNED by each member's device key and verified against the DKG roster.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct HelperProposal {
    pub id: String,
    pub vault_id: String,
    /// Destination address (authoritatively validated by the create endpoint before this is built).
    pub to: String,
    pub amount_zat: u64,
    pub memo: Option<String>,
    pub proposer: String,
    /// `pending` | `ready` | `sent` | `refused` | `expired`.
    pub state: String,
    pub approvals: Vec<String>,
    pub refusals: Vec<String>,
    /// Quorum inherited from the vault at creation (not spoofable per-proposal). See the money-gate
    /// note above: this only drives the `ready` display; the ceremony enforces the real threshold.
    pub threshold: u16,
    pub total: u16,
    pub created_at_unix: u64,
    /// `0` when no expiry is set.
    pub expiry_unix: u64,
    pub txid: Option<String>,
}

impl HelperProposal {
    /// Recompute the state from the votes / clock. Terminal states (`sent`, `refused`, `expired`)
    /// stick. `ready` once approvals reach the threshold; `refused` once refusals make the quorum
    /// unreachable (`total - refusals < threshold`); `expired` past the deadline.
    pub fn recompute(&mut self, now: u64) {
        if self.state == "sent" {
            return;
        }
        if self.expiry_unix != 0 && now >= self.expiry_unix {
            self.state = "expired".into();
            return;
        }
        if self.total > 0
            && self.threshold > 0
            && (self.total as usize).saturating_sub(self.refusals.len()) < self.threshold as usize
        {
            self.state = "refused".into();
            return;
        }
        self.state = if self.threshold > 0 && self.approvals.len() >= self.threshold as usize {
            "ready".into()
        } else {
            "pending".into()
        };
    }

    /// Record a vote (dedup across both lists), then recompute. Returns false if the proposal is
    /// already terminal (`sent`/`refused`/`expired`) and cannot take votes.
    pub fn vote(&mut self, member: &str, approve: bool, now: u64) -> bool {
        if self.state == "sent" || self.state == "refused" || self.state == "expired" {
            return false;
        }
        self.approvals.retain(|m| m != member);
        self.refusals.retain(|m| m != member);
        if approve {
            self.approvals.push(member.to_string());
        } else {
            self.refusals.push(member.to_string());
        }
        self.recompute(now);
        true
    }
}

/// The directory holding a vault's proposals: `<vaults_dir>/<vault>/proposals/`.
pub fn proposals_dir(vaults_dir: &Path, vault: &str) -> PathBuf {
    vaults_dir.join(vault).join("proposals")
}

fn proposal_path(vaults_dir: &Path, vault: &str, id: &str) -> PathBuf {
    // `id` is helper-generated (hex/dash), never attacker-controlled path input; still, keep only
    // the file name so a crafted id can never traverse out of the proposals dir.
    let safe: String = id
        .chars()
        .filter(|c| c.is_ascii_alphanumeric() || *c == '-')
        .collect();
    proposals_dir(vaults_dir, vault).join(format!("{safe}.json"))
}

/// Persist (create or update) a proposal.
pub fn save_proposal(vaults_dir: &Path, p: &HelperProposal) -> Result<(), ToolError> {
    let path = proposal_path(vaults_dir, &p.vault_id, &p.id);
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent).map_err(ToolError::Io)?;
    }
    let json = serde_json::to_string(p).map_err(|e| ToolError::parse("proposal", e.to_string()))?;
    std::fs::write(&path, json).map_err(ToolError::Io)?;
    Ok(())
}

/// Load one proposal by id (with its state recomputed against `now`, so a lapsed deadline reads as
/// `expired` even if it was persisted `pending`). `None` if absent/unreadable.
pub fn load_proposal(vaults_dir: &Path, vault: &str, id: &str, now: u64) -> Option<HelperProposal> {
    let json = std::fs::read_to_string(proposal_path(vaults_dir, vault, id)).ok()?;
    let mut p: HelperProposal = serde_json::from_str(&json).ok()?;
    p.recompute(now);
    Some(p)
}

/// List a vault's proposals, newest first, each with its state recomputed against `now`.
pub fn list_proposals(vaults_dir: &Path, vault: &str, now: u64) -> Vec<HelperProposal> {
    let dir = proposals_dir(vaults_dir, vault);
    let Ok(entries) = std::fs::read_dir(&dir) else {
        return Vec::new();
    };
    let mut out: Vec<HelperProposal> = entries
        .flatten()
        .filter_map(|e| std::fs::read_to_string(e.path()).ok())
        .filter_map(|j| serde_json::from_str::<HelperProposal>(&j).ok())
        .map(|mut p| {
            p.recompute(now);
            p
        })
        .collect();
    out.sort_by_key(|p| std::cmp::Reverse(p.created_at_unix));
    out
}

/// One RFC-4180 CSV field: wrap in quotes and double any embedded quote when it contains a comma,
/// quote, or newline. Prevents CSV injection of stray columns from a memo/address.
fn csv_field(s: &str) -> String {
    if s.contains([',', '"', '\n', '\r']) {
        format!("\"{}\"", s.replace('"', "\"\""))
    } else {
        s.to_string()
    }
}

/// Render sent proposals as an accounting ledger CSV (the vault's confirmed, governed payments).
/// One row per proposal: date, amount (zat and ZEC), destination, memo, proposer, approvers, txid.
/// Direct (non-proposal) sends are not here; they live in the ceremony trail.
pub fn ledger_csv(sent: &[HelperProposal]) -> String {
    let mut out =
        String::from("created_at_unix,amount_zat,amount_zec,to,memo,proposer,approvals,txid\n");
    for p in sent {
        let zec = format!(
            "{}.{:08}",
            p.amount_zat / 100_000_000,
            p.amount_zat % 100_000_000
        );
        let row = [
            p.created_at_unix.to_string(),
            p.amount_zat.to_string(),
            zec,
            csv_field(&p.to),
            csv_field(p.memo.as_deref().unwrap_or("")),
            csv_field(&p.proposer),
            csv_field(&p.approvals.join(" ")),
            csv_field(p.txid.as_deref().unwrap_or("")),
        ];
        out.push_str(&row.join(","));
        out.push('\n');
    }
    out
}

/// A vault registered with the helper: its public identity plus where its view-only wallet lives.
/// `vault_id` equals the group verifying key hex (the same id the browser shows on `/net`).
/// Serializable so it can be persisted to disk (see [`save_registration`]) — the FS is a redeploy-
/// durable cache of PUBLIC / view-only material (address + UFVK + wallet dir), never a share.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct VaultRegistration {
    pub vault_id: String,
    pub address: String,
    pub ufvk: String,
    pub wallet_dir: String,
    /// The wallet account uuid the view-only wallet created (the PCZT spends from it).
    pub account: String,
    /// The vault's approval quorum (`threshold`-of-`total`), passed by the browser at register time
    /// (it knows `t`/`n` from the DKG). Proposals inherit this quorum, so it is a vault property, not
    /// per-proposal (which a proposer could spoof). `0` means unknown (a legacy or minimal register).
    /// NOTE: this is the PRODUCT quorum for showing "Ready"; the real money gate is the FROST
    /// ceremony, which needs `threshold` real browser shares regardless of the recorded approvals.
    #[serde(default)]
    pub threshold: u16,
    #[serde(default)]
    pub total: u16,
}

/// Where a vault's persisted registration lives: `<vaults_dir>/<vault_id>/registration.json`.
pub fn registration_path(vaults_dir: &Path, group_key: &str) -> PathBuf {
    vaults_dir.join(group_key).join("registration.json")
}

/// Persist a registration next to its view-only wallet, so a helper restart / redeploy keeps the
/// vault (and its ALREADY-derived address — no re-derivation, so the address stays stable). Writes
/// only public / view-only fields.
pub fn save_registration(vaults_dir: &Path, reg: &VaultRegistration) -> Result<(), ToolError> {
    let path = registration_path(vaults_dir, &reg.vault_id);
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent).map_err(ToolError::Io)?;
    }
    let json =
        serde_json::to_string(reg).map_err(|e| ToolError::parse("registration", e.to_string()))?;
    std::fs::write(&path, json).map_err(ToolError::Io)?;
    Ok(())
}

/// Load a single persisted registration if present (used to make [`register_vault`] idempotent and
/// its address stable across restarts). Returns `None` when the file is absent or unreadable.
pub fn load_registration(vaults_dir: &Path, group_key: &str) -> Option<VaultRegistration> {
    let path = registration_path(vaults_dir, group_key);
    let json = std::fs::read_to_string(path).ok()?;
    serde_json::from_str(&json).ok()
}

/// Load every persisted registration under `vaults_dir` (one `<id>/registration.json` each), so a
/// restarting helper reseeds its in-memory registry from disk. Skips anything unreadable.
pub fn load_registrations(vaults_dir: &Path) -> Vec<VaultRegistration> {
    let mut out = Vec::new();
    let Ok(entries) = std::fs::read_dir(vaults_dir) else {
        return out;
    };
    for entry in entries.flatten() {
        if let Some(name) = entry.file_name().to_str() {
            if is_valid_group_key(name) {
                if let Some(reg) = load_registration(vaults_dir, name) {
                    out.push(reg);
                }
            }
        }
    }
    out
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
    threshold: u16,
    total: u16,
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
    // Persisted-registration shortcut: if this vault was registered before (surviving a restart),
    // return the STORED registration — no re-derivation, so the address stays stable and the
    // heavy wallet init is not repeated.
    if let Some(reg) = load_registration(&cfg.vaults_dir, group_key) {
        return Ok(reg);
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
    let reg = VaultRegistration {
        vault_id: group_key.to_string(),
        address,
        ufvk,
        wallet_dir,
        account,
        threshold,
        total,
    };
    // Persist so a restart keeps the vault + its now-fixed address. Best-effort: a write failure
    // (e.g. read-only FS) must not fail the registration — the in-memory state still serves it.
    let _ = save_registration(&cfg.vaults_dir, &reg);
    Ok(reg)
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
            threshold: 2,
            total: 3,
        }
    }

    fn mk_prop(vault: &str, id: &str) -> HelperProposal {
        HelperProposal {
            id: id.into(),
            vault_id: vault.into(),
            to: "utest1dest".into(),
            amount_zat: 1000,
            memo: None,
            proposer: "alice".into(),
            state: "pending".into(),
            approvals: vec!["alice".into()],
            refusals: vec![],
            threshold: 2,
            total: 3,
            created_at_unix: 100,
            expiry_unix: 0,
            txid: None,
        }
    }

    #[test]
    fn proposal_state_machine() {
        let mut p = mk_prop("v", "p1");
        p.recompute(200);
        assert_eq!(p.state, "pending"); // 1 of 2 approvals
        assert!(p.vote("bob", true, 200)); // 2 of 2
        assert_eq!(p.state, "ready");
        // Idempotent re-vote does not double-count.
        assert!(p.vote("bob", true, 200));
        assert_eq!(p.approvals.len(), 2);
        // Expiry wins over ready.
        p.expiry_unix = 300;
        p.recompute(301);
        assert_eq!(p.state, "expired");
    }

    #[test]
    fn proposal_refusal_makes_quorum_unreachable() {
        // 2-of-3: two refusals leave only 1 possible approver, below the threshold -> refused.
        let mut p = mk_prop("v", "p2");
        p.approvals.clear();
        assert!(p.vote("bob", false, 100));
        assert_eq!(p.state, "pending");
        assert!(p.vote("carol", false, 100));
        assert_eq!(p.state, "refused");
        // A terminal proposal rejects further votes.
        assert!(!p.vote("alice", true, 100));
    }

    #[test]
    fn proposals_persist_list_and_reload() {
        let dir = std::env::temp_dir().join(format!("konclave-prop-test-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        assert!(list_proposals(&dir, "v", 100).is_empty());
        save_proposal(&dir, &mk_prop("v", "p1")).unwrap();
        let mut later = mk_prop("v", "p2");
        later.created_at_unix = 200;
        save_proposal(&dir, &later).unwrap();
        let all = list_proposals(&dir, "v", 250);
        assert_eq!(all.len(), 2);
        assert_eq!(all[0].id, "p2"); // newest first
        assert_eq!(
            load_proposal(&dir, "v", "p1", 250).unwrap().amount_zat,
            1000
        );
        // A path-traversal id can never escape the proposals dir.
        assert!(load_proposal(&dir, "v", "../../etc/passwd", 250).is_none());
        let _ = std::fs::remove_dir_all(&dir);
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
        assert!(register_vault(&cfg, "not-a-valid-key", "demo", 2, 3).is_err());
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
    fn registration_persists_and_reloads_round_trip() {
        // A unique temp dir per run (pid-based) so parallel test runs don't collide.
        let dir = std::env::temp_dir().join(format!("konclave-helper-test-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        let a = reg("1111111111111111111111111111111111111111111111111111111111111111");
        let b = reg("2222222222222222222222222222222222222222222222222222222222222222");
        save_registration(&dir, &a).unwrap();
        save_registration(&dir, &b).unwrap();

        // Single reload returns the same public fields.
        let back = load_registration(&dir, &a.vault_id).unwrap();
        assert_eq!(back.address, a.address);
        assert_eq!(back.account, a.account);
        assert_eq!(back.ufvk, a.ufvk);

        // Bulk load finds both; a non-vault dir name is ignored.
        std::fs::create_dir_all(dir.join("not-a-group-key")).unwrap();
        let mut ids: Vec<String> = load_registrations(&dir)
            .into_iter()
            .map(|r| r.vault_id)
            .collect();
        ids.sort();
        assert_eq!(ids, vec![a.vault_id.clone(), b.vault_id.clone()]);

        // Missing / empty dirs degrade to empty, never panic.
        assert!(load_registration(
            &dir,
            "3333333333333333333333333333333333333333333333333333333333333333"
        )
        .is_none());
        assert!(load_registrations(&dir.join("nope")).is_empty());
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn ceremony_trail_appends_and_loads_in_order() {
        let dir =
            std::env::temp_dir().join(format!("konclave-ceremony-test-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        let id = "4444444444444444444444444444444444444444444444444444444444444444";
        let mk = |txid: Option<&str>, ts: u64| CeremonyRecord {
            vault_id: id.into(),
            sighash: "aa".into(),
            signatures: vec!["bb".into()],
            txid: txid.map(String::from),
            dry_run: txid.is_none(),
            created_at_unix: ts,
        };
        // Empty trail loads as empty (no file yet).
        assert!(load_ceremonies(&dir, id).is_empty());
        append_ceremony(&dir, &mk(None, 100)).unwrap();
        append_ceremony(&dir, &mk(Some("txid-1"), 200)).unwrap();
        let recs = load_ceremonies(&dir, id);
        assert_eq!(recs.len(), 2);
        // Append order preserved (newest last).
        assert_eq!(recs[0].created_at_unix, 100);
        assert!(recs[0].dry_run);
        assert_eq!(recs[1].txid.as_deref(), Some("txid-1"));
        assert!(!recs[1].dry_run);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn ledger_csv_escapes_and_formats() {
        let mut p = mk_prop("v", "p1");
        p.amount_zat = 150_000_000; // 1.5 ZEC
        p.to = "utest1abc".into();
        p.memo = Some("rent, may".into()); // comma -> must be quoted
        p.proposer = "alice".into();
        p.approvals = vec!["alice".into(), "bob".into()];
        p.txid = Some("deadbeef".into());
        let csv = ledger_csv(std::slice::from_ref(&p));
        let lines: Vec<&str> = csv.lines().collect();
        assert!(lines[0].starts_with("created_at_unix,amount_zat,amount_zec"));
        assert!(lines[1].contains(",150000000,1.50000000,"));
        assert!(lines[1].contains("\"rent, may\"")); // comma-bearing memo is quoted
        assert!(lines[1].contains("alice bob")); // approvers space-joined
        assert!(lines[1].ends_with("deadbeef"));
        // A memo trying to inject a quote is doubled, not broken out.
        let mut q = mk_prop("v", "p2");
        q.memo = Some("a\"b".into());
        assert!(ledger_csv(std::slice::from_ref(&q)).contains("\"a\"\"b\""));
    }

    #[test]
    fn network_type_maps_main_and_test() {
        assert_eq!(send_cfg("test").network_type(), NetworkType::Test);
        assert_eq!(send_cfg("main").network_type(), NetworkType::Main);
        // Anything unexpected defaults to mainnet (the safe, production default).
        assert_eq!(send_cfg("regtest").network_type(), NetworkType::Main);
    }
}
