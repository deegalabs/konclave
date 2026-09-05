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
    /// transparent-only) - Konclave is shielded-first and refuses to lock funds (§8).
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
/// be able to receive Orchard (shielded-first, §8 - a Sapling/transparent-only address would lock
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
/// build/prove/extract/inject/broadcast fields are populated - the ceremony fields (members,
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

/// A vault's shielded balance as the helper reports it to the browsers. Since NU6.3 the spendable
/// funds live in the Ironwood pool (Orchard is withdrawal-only), so we report both pools plus the
/// combined `shielded_spendable_zat` the UI means by "spendable", and `total_zat` (including notes
/// still confirming). Internal transparency for the members - read from the view-only wallet.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct VaultBalance {
    pub orchard_spendable_zat: u64,
    pub ironwood_spendable_zat: u64,
    /// Orchard + Ironwood: what the vault can actually spend.
    pub shielded_spendable_zat: u64,
    pub total_zat: u64,
    pub chain_tip_height: u64,
}

/// Sync a registered vault's view-only wallet against lightwalletd and read its shielded balance.
/// The helper owns the UFVK (view-only), so this is a watcher's read - no share involved. Network +
/// engine I/O, so it is exercised live, not in unit tests.
/// How long a wallet sync stays "fresh": within this window, a balance read skips the (slow) sync
/// and serves the last-synced state, so the Dashboard's 12s poll (and bursts across screens) share
/// one sync instead of each triggering a multi-second lightwalletd sync (#194).
pub const SYNC_THROTTLE_SECS: u64 = 15;

fn last_sync_path(vaults_dir: &Path, vault: &str) -> PathBuf {
    vaults_dir.join(vault).join("last_sync")
}

/// True when the wallet should be re-synced: no recorded sync yet, or the last one is at least
/// `throttle_secs` old. Pure (takes `now`), so it is unit-testable.
pub fn should_sync(vaults_dir: &Path, vault: &str, throttle_secs: u64, now: u64) -> bool {
    match std::fs::read_to_string(last_sync_path(vaults_dir, vault))
        .ok()
        .and_then(|s| s.trim().parse::<u64>().ok())
    {
        Some(last) => now.saturating_sub(last) >= throttle_secs,
        None => true,
    }
}

fn mark_synced(vaults_dir: &Path, vault: &str, now: u64) {
    let path = last_sync_path(vaults_dir, vault);
    if let Some(p) = path.parent() {
        let _ = std::fs::create_dir_all(p);
    }
    let _ = std::fs::write(&path, now.to_string());
}

fn now_secs() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0)
}

pub fn vault_balance(
    cfg: &HelperConfig,
    reg: &VaultRegistration,
) -> Result<VaultBalance, ToolError> {
    // Throttle the sync: only hit lightwalletd if the last sync for this vault is stale. A fresh
    // deposit still lands within SYNC_THROTTLE_SECS, but rapid balance reads no longer each block on
    // a full sync (#194). The balance below reflects whatever the wallet last synced.
    let now = now_secs();
    if should_sync(&cfg.vaults_dir, &reg.vault_id, SYNC_THROTTLE_SECS, now) {
        crate::wallet::sync(&cfg.devtool, &reg.wallet_dir, &cfg.lightwalletd)?;
        mark_synced(&cfg.vaults_dir, &reg.vault_id, now);
    }
    let b = crate::wallet::balance(&cfg.devtool, &reg.wallet_dir)?;
    Ok(VaultBalance {
        orchard_spendable_zat: b.orchard_spendable.as_u64(),
        ironwood_spendable_zat: b.ironwood_spendable.as_u64(),
        shielded_spendable_zat: b.shielded_spendable().as_u64(),
        total_zat: b.total.as_u64(),
        chain_tip_height: b.chain_tip_height,
    })
}

/// The vault's on-chain transaction history (newest first) for the Add-funds record. Read-only:
/// reads the wallet's current `list-tx` view (the balance poll keeps it synced), so it is fast and
/// never moves funds. Amount/direction per tx is a follow-up (#125).
pub fn vault_transactions(
    cfg: &HelperConfig,
    reg: &VaultRegistration,
) -> Result<Vec<crate::wallet::WalletTx>, ToolError> {
    crate::wallet::list_transactions(&cfg.devtool, &reg.wallet_dir)
}

/// A record of one signing ceremony the helper drove for a vault (ZecSafe-inspired reproducible
/// evidence): what was signed, by whom cryptographically (the aggregate FROST signature), and the
/// resulting on-chain txid. Every field is PUBLIC and independently checkable - anyone can verify
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
/// **unauthenticated** in this iteration - anyone who knows the vault_id could POST a proposal or a
/// vote. That is a coordination/spam surface, NOT a fund-safety hole: the real money gate is the
/// FROST ceremony, which needs `threshold` REAL browser shares to produce a valid signature. A
/// forged vote only changes the displayed approval count; it cannot move funds. The hardening
/// follow-up is votes SIGNED by each member's device key and verified against the DKG roster.
/// One beneficiary of a payroll proposal: a private Orchard payment inside a single tx.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct PayrollLine {
    /// Optional human label (who the line is for); display-only.
    #[serde(default)]
    pub label: String,
    pub to: String,
    pub amount_zat: u64,
    #[serde(default)]
    pub memo: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct HelperProposal {
    pub id: String,
    pub vault_id: String,
    /// `payment` (single) or `payroll` (N lines). Default keeps old records as single payments.
    #[serde(default = "kind_payment")]
    pub kind: String,
    /// Destination address for a single payment (empty for payroll). Authoritatively validated by
    /// the create endpoint before this is built.
    pub to: String,
    /// The single-payment amount, or the payroll TOTAL (sum of the lines).
    pub amount_zat: u64,
    pub memo: Option<String>,
    /// Payroll beneficiaries (empty for a single payment).
    #[serde(default)]
    pub lines: Vec<PayrollLine>,
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

fn kind_payment() -> String {
    "payment".into()
}

impl HelperProposal {
    /// Recompute the state from the votes / clock. Terminal states (`sent`, `refused`, `expired`)
    /// stick. `ready` once approvals reach the threshold; `refused` once refusals make the quorum
    /// unreachable (`total - refusals < threshold`); `expired` past the deadline.
    pub fn recompute(&mut self, now: u64) {
        if self.state == "sent" {
            return;
        }
        // ORDER MATTERS, and it is not chronological: refusal is evaluated BEFORE expiry.
        //
        // A refusal is a DECISION the group made; an expiry is a deadline nobody met. When both
        // hold of the same proposal, the record must report the decision - otherwise the ledger
        // says "nobody got round to it" about a payment that was actually voted down, and the
        // governance trail lies about what happened.
        //
        // This was a LIVE defect, not a hypothetical: while the web path sent `expiry_unix: 0` the
        // expiry branch never fired and the bug slept; #328 started sending a real 72h deadline and
        // woke it. Do not "tidy" these two branches back into time order.
        //
        // Withdrawal still works (#369): `refused` is derived from the refusal count on every call,
        // so if a member takes their refusal back this branch stops matching and an open proposal
        // past its deadline correctly falls through to `expired` below.
        if self.total > 0
            && self.threshold > 0
            && (self.total as usize).saturating_sub(self.refusals.len()) < self.threshold as usize
        {
            self.state = "refused".into();
            return;
        }
        if self.expiry_unix != 0 && now >= self.expiry_unix {
            self.state = "expired".into();
            return;
        }
        self.state = if self.threshold > 0 && self.approvals.len() >= self.threshold as usize {
            "ready".into()
        } else {
            "pending".into()
        };
    }

    /// Record a vote (dedup across both lists), then recompute. Returns false only when the
    /// proposal is genuinely finished.
    ///
    /// `sent` and `expired` are facts: money moved, or a deadline passed. Nothing revises them.
    ///
    /// `refused` is NOT one of those. Look at `recompute`: it is DERIVED from the refusal count on
    /// every call, not stamped once. Refusing this state as terminal made a single refusal
    /// unrecoverable, and votes are unauthenticated (#288) - so one request per seat, from anyone
    /// holding the vault id, left the group with a proposal it could not revive. Accepting a vote
    /// here lets a member withdraw a refusal, and `recompute` moves the proposal back out of
    /// `refused` on its own. The refusal is still recorded; it just stops being a one-way door.
    pub fn vote(&mut self, member: &str, approve: bool, now: u64) -> bool {
        if self.state == "sent" || self.state == "expired" {
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

/// Where a vault's member names live: `<vaults_dir>/<vault>/members.json` (a JSON array of names,
/// seat order). PUBLIC coordination data (who the members are), never a share.
fn members_path(vaults_dir: &Path, vault: &str) -> PathBuf {
    vaults_dir.join(vault).join("members.json")
}

/// Persist the vault's member names (seat order). Overwrites the whole list.
pub fn save_members(vaults_dir: &Path, vault: &str, names: &[String]) -> Result<(), ToolError> {
    let path = members_path(vaults_dir, vault);
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent).map_err(ToolError::Io)?;
    }
    let json =
        serde_json::to_string(names).map_err(|e| ToolError::parse("members", e.to_string()))?;
    std::fs::write(&path, json).map_err(ToolError::Io)?;
    Ok(())
}

/// What a roster write did.
#[derive(Debug, PartialEq, Eq)]
pub enum RosterWrite {
    /// There was no roster; this one is now the vault's.
    Claimed,
    /// The same roster was already there. Every device writes it at DKG completion, so a repeat
    /// is the normal case, not an error.
    Unchanged,
    /// A roster exists and this one differs. Refused.
    Refused,
}

/// Claim the vault's roster, once.
///
/// `save_members` overwrites, and the endpoint that reaches it is unauthenticated: anyone holding a
/// vault id could replace the member list with names of their own and then vote as them, which is
/// what made the roster check on votes cosmetic (#288). The roster is decided by the DKG and never
/// changes wholesale afterwards - later edits are one seat at a time through `rename_member`, which
/// migrates that member's votes. So the honest rule is write-once.
///
/// Idempotent on an identical list because that is the real flow: at DKG completion every device
/// posts the same self-declared roster, and the second device must not get an error.
///
/// Names are compared trimmed, so a roster written with stray whitespace still matches itself.
///
/// This does NOT authenticate the first writer. A vault that has no roster yet - one registered
/// before rosters were recorded - can still have one claimed by whoever asks first. Closing that
/// needs the per-vault capability in #267 / the device-key handshake in #63.
pub fn claim_members(
    vaults_dir: &Path,
    vault: &str,
    names: &[String],
) -> Result<RosterWrite, ToolError> {
    let existing = load_members(vaults_dir, vault);
    if existing.is_empty() {
        save_members(vaults_dir, vault, names)?;
        return Ok(RosterWrite::Claimed);
    }
    let same = existing.len() == names.len()
        && existing
            .iter()
            .zip(names.iter())
            .all(|(a, b)| a.trim() == b.trim());
    Ok(if same {
        RosterWrite::Unchanged
    } else {
        RosterWrite::Refused
    })
}

/// Load the vault's member names (empty when none were set yet).
pub fn load_members(vaults_dir: &Path, vault: &str) -> Vec<String> {
    std::fs::read_to_string(members_path(vaults_dir, vault))
        .ok()
        .and_then(|j| serde_json::from_str(&j).ok())
        .unwrap_or_default()
}

fn device_keys_path(vaults_dir: &Path, vault: &str) -> PathBuf {
    vaults_dir.join(vault).join("device-keys.json")
}

/// The vault's registered device comms pubkeys (hex), the seal-set for a SignRequest (#63). Empty
/// when none registered yet - in which case the request is posted UNSEALED (compat during rollout).
pub fn load_device_keys(vaults_dir: &Path, vault: &str) -> Vec<String> {
    std::fs::read_to_string(device_keys_path(vaults_dir, vault))
        .ok()
        .and_then(|j| serde_json::from_str::<Vec<String>>(&j).ok())
        .unwrap_or_default()
}

/// Register a device's PERSISTENT comms pubkey (hex of its X25519 public, derived from its share) so
/// the helper can SEAL the SignRequest to it, keeping recipient + amount off the relay (H2 / ADR-0007
/// I3). Idempotent: registering the same key again is a no-op. Returns whether the key was NEW.
///
/// This is public material (a pubkey), and registration is NOT yet authenticated: an outsider holding
/// the vault id could register a key of their own and receive a sealed copy - but such a holder can
/// read the cleartext request TODAY (the vault-id capability, #388). So sealing is a strict gain
/// against the relay operator and a room-holder who lacks the group key; authenticating the registrant
/// is the #392/#288 layer, tracked separately.
pub fn add_device_key(vaults_dir: &Path, vault: &str, device_pub: &str) -> Result<bool, ToolError> {
    let device_pub = device_pub.trim();
    let mut keys = load_device_keys(vaults_dir, vault);
    if keys.iter().any(|k| k == device_pub) {
        return Ok(false); // already registered: idempotent no-op
    }
    keys.push(device_pub.to_string());
    let path = device_keys_path(vaults_dir, vault);
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent).map_err(ToolError::Io)?;
    }
    let json =
        serde_json::to_string(&keys).map_err(|e| ToolError::parse("device-keys", e.to_string()))?;
    std::fs::write(&path, json).map_err(ToolError::Io)?;
    Ok(true)
}

fn read_key_path(vaults_dir: &Path, vault: &str) -> PathBuf {
    vaults_dir.join(vault).join("read-key.json")
}

/// The vault's registered read token (hex of `readKey = HKDF(S, "read")`), or `None` when the vault
/// has not migrated to #388. While `None`, reads are accepted untokened (per-vault compat).
pub fn load_read_key(vaults_dir: &Path, vault: &str) -> Option<String> {
    std::fs::read_to_string(read_key_path(vaults_dir, vault))
        .ok()
        .and_then(|j| serde_json::from_str::<String>(&j).ok())
}

/// Register (or replace) the vault's read token. Called once at migration; from then on every read
/// must present exactly this value. This is a shared access secret (members + helper), not spendable
/// material - it gates WHO may ask the helper, and does not change that the helper is view-only.
pub fn set_read_key(vaults_dir: &Path, vault: &str, read_key: &str) -> Result<(), ToolError> {
    let path = read_key_path(vaults_dir, vault);
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent).map_err(ToolError::Io)?;
    }
    let json = serde_json::to_string(read_key.trim())
        .map_err(|e| ToolError::parse("read-key", e.to_string()))?;
    std::fs::write(&path, json).map_err(ToolError::Io)?;
    Ok(())
}

/// Is this read authorized? A vault with no registered readKey is OPEN (pre-#388 compat). Once a
/// readKey is set, the read must present exactly it, compared in constant time so a guess learns
/// nothing from timing.
pub fn read_authorized(vaults_dir: &Path, vault: &str, presented: Option<&str>) -> bool {
    match load_read_key(vaults_dir, vault) {
        None => true, // not migrated: the gate is open
        Some(expected) => {
            presented.is_some_and(|p| ct_eq(p.trim().as_bytes(), expected.as_bytes()))
        }
    }
}

/// Constant-time byte-string equality (reveals only the length). Keeps a token guess from learning,
/// via timing, how many leading bytes were right.
fn ct_eq(a: &[u8], b: &[u8]) -> bool {
    if a.len() != b.len() {
        return false;
    }
    let mut diff = 0u8;
    for (x, y) in a.iter().zip(b.iter()) {
        diff |= x ^ y;
    }
    diff == 0
}

/// Rename ONE member seat (`old` -> `new`) and MIGRATE every proposal's votes so the rename never
/// orphans an approval into a "ghost" member. Because votes are recorded by member NAME (the seat's
/// public label), a bulk overwrite of the roster used to leave the old name attached to past
/// approvals while the new name showed as still-awaiting - the same person counted twice. This walks
/// every proposal and rewrites the name in `proposer`/`approvals`/`refusals` in lockstep with the
/// roster, so identity stays consistent across a rename.
///
/// Guards: the `old` name must be an existing seat, and `new` must be non-empty and not already
/// taken by a DIFFERENT seat (renaming a seat to its own current name is a no-op, allowed). Returns
/// the updated roster.
pub fn rename_member(
    vaults_dir: &Path,
    vault: &str,
    old: &str,
    new: &str,
    now: u64,
) -> Result<Vec<String>, ToolError> {
    let new = new.trim();
    if new.is_empty() {
        return Err(ToolError::parse("members", "a member name cannot be empty"));
    }
    let mut names = load_members(vaults_dir, vault);
    if !names.iter().any(|n| n == old) {
        return Err(ToolError::parse("members", "no such member to rename"));
    }
    if names.iter().any(|n| n == new && n != old) {
        return Err(ToolError::parse("members", "that name is already taken"));
    }
    if old == new {
        return Ok(names); // no-op rename
    }
    for n in names.iter_mut() {
        if n == old {
            *n = new.to_string();
        }
    }
    save_members(vaults_dir, vault, &names)?;

    // Migrate the name everywhere a vote references it, so quorum counting and the approvals list
    // stay coherent (no orphaned approval under the old name, no duplicate row for the new one).
    for mut p in list_proposals(vaults_dir, vault, now) {
        let mut changed = false;
        if p.proposer == old {
            p.proposer = new.to_string();
            changed = true;
        }
        for a in p.approvals.iter_mut() {
            if a == old {
                *a = new.to_string();
                changed = true;
            }
        }
        for r in p.refusals.iter_mut() {
            if r == old {
                *r = new.to_string();
                changed = true;
            }
        }
        if changed {
            save_proposal(vaults_dir, &p)?;
        }
    }
    Ok(names)
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
/// Serializable so it can be persisted to disk (see [`save_registration`]) - the FS is a redeploy-
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
    /// The vault's **internal** (change) receiver, from [`change_receiver`]. Public, view-only, and
    /// FIXED for the vault's life (`address_at(0, Scope::Internal)`).
    ///
    /// It exists so a signing device can tell its own change from an attacker's output (#281). The
    /// device cannot derive it - the addresses come from a random `sk` that `zcash-sign` discards -
    /// so it is captured here once and stored on the device, which then refuses any later deviation.
    /// Empty on registrations written before this field existed; those need a one-time backfill,
    /// and an empty value must be treated as "unknown", never as "matches nothing".
    #[serde(default)]
    pub change_receiver: String,
    /// The block height the view-only wallet scans from, as WRITTEN by `init-fvk` (#434).
    ///
    /// It is read back from `<wallet_dir>/keys.toml` rather than assumed, because `init-fvk`
    /// derives its own value (`chain_tip - 100` by default, then adjusted by
    /// `get_wallet_birthday`) - so what we asked for and what it used are not the same thing.
    ///
    /// It lives here because `registration.json` is the half of a vault that gets BACKED UP, while
    /// `wallet/` is excluded as "rebuildable". Rebuilding it needs this number: an `init-fvk` run
    /// without it starts scanning from *now* and every note the vault already holds becomes
    /// invisible, with no rescan to undo it. `None` on registrations written before this field, and
    /// backfilled from `keys.toml` when the wallet dir is still there.
    #[serde(default)]
    pub birthday: Option<u64>,
}

/// Where a vault's persisted registration lives: `<vaults_dir>/<vault_id>/registration.json`.
pub fn registration_path(vaults_dir: &Path, group_key: &str) -> PathBuf {
    vaults_dir.join(group_key).join("registration.json")
}

/// Persist a registration next to its view-only wallet, so a helper restart / redeploy keeps the
/// vault (and its ALREADY-derived address - no re-derivation, so the address stays stable). Writes
/// only public / view-only fields.
/// The birthday `init-fvk` wrote into a view-only wallet, from `<wallet_dir>/keys.toml` (#434).
///
/// That file is two lines - `network` and `birthday` - so this parses the one line it needs rather
/// than taking a TOML dependency for it. `None` when the file is missing, unreadable, or carries no
/// birthday: not knowing is its own answer here, and must never be confused with a height of 0,
/// which would ask a rebuild to rescan the entire chain.
pub fn read_wallet_birthday(wallet_dir: &Path) -> Option<u64> {
    let text = std::fs::read_to_string(wallet_dir.join("keys.toml")).ok()?;
    text.lines()
        .filter_map(|l| l.split_once('='))
        .find(|(k, _)| k.trim() == "birthday")
        .and_then(|(_, v)| v.trim().trim_matches('"').parse::<u64>().ok())
}

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
    // return the STORED registration - no re-derivation, so the address stays stable and the
    // heavy wallet init is not repeated.
    if let Some(mut reg) = load_registration(&cfg.vaults_dir, group_key) {
        // Backfill the birthday for a vault registered before the field existed (#434). The number
        // lives only in `wallet/keys.toml`, which the documented ops backup EXCLUDES, so a vault
        // that loses its volume before this runs cannot have its wallet rebuilt correctly. Reading
        // it here captures it into the half that IS backed up, on the next registration touch.
        // Idempotent, and best-effort: it never fails a registration.
        if reg.birthday.is_none() {
            if let Some(b) = read_wallet_birthday(Path::new(&reg.wallet_dir)) {
                reg.birthday = Some(b);
                let _ = save_registration(&cfg.vaults_dir, &reg);
                eprintln!("vault {group_key}: birthday {b} recorded from keys.toml");
            }
        }
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
    // Derived, not fetched: the change receiver comes from the UFVK we just generated, in the same
    // breath, so it is impossible for it to disagree with the wallet this registration describes.
    //
    // A derivation failure must not fail the registration - the vault still works, its money gate
    // just stays unarmed - so it degrades to empty, which downstream reads as "unknown" and never
    // as "matches nothing". But it degrades OUT LOUD. Swallowing the reason is the defect #307 was
    // about (a result requested and discarded), and an empty field with no explanation would leave
    // whoever debugs an unarmed gate with nothing to go on. The vault is named because the failure
    // is per-vault: one bad UFVK must not read as the whole helper being broken.
    let change_receiver = match change_receiver(&ufvk, &cfg.network) {
        Ok(addr) => addr,
        Err(e) => {
            eprintln!(
                "vault {group_key}: no change receiver derived ({e:?}); its money gate stays unarmed"
            );
            String::new()
        }
    };
    // Read back what `init-fvk` actually used, rather than assuming the default it computes. This
    // is the number a rebuilt wallet has to be given, and `registration.json` is the half of a
    // vault that gets backed up (#434).
    let birthday = read_wallet_birthday(Path::new(&wallet_dir));
    if birthday.is_none() {
        eprintln!(
            "vault {group_key}: no birthday read from keys.toml; a rebuilt wallet would scan from now"
        );
    }
    let reg = VaultRegistration {
        vault_id: group_key.to_string(),
        address,
        ufvk,
        wallet_dir,
        account,
        threshold,
        total,
        change_receiver,
        birthday,
    };
    // Persist so a restart keeps the vault + its now-fixed address. Best-effort: a write failure
    // (e.g. read-only FS) must not fail the registration - the in-memory state still serves it.
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

/// The vault's **internal** (change) Orchard receiver, derived from its UFVK.
///
/// Why this has to exist at all: a signing device holds only its FROST share and the group's public
/// key. The vault's addresses come from a `sk` that `zcash-sign generate` draws at RANDOM and throws
/// away (its own doc-comment: *"different calls will generate different FullViewingKeys"*), so the
/// device **cannot** derive them. Without being told, it reads the change output of every honest
/// send as an unrecognised destination, and the money gate (#281) refuses real payments.
///
/// The diversifier is not a choice made here. `zcash_client_backend` sends change to
/// `address_at(0u32, Scope::Internal)` (`data_api/wallet.rs:1684`), the only internal-scope
/// derivation in that crate, so this reproduces what the wallet will actually do. That is also why
/// the value is safe to capture once and store: it is fixed for the life of the vault, not rotated
/// per send.
///
/// View-only throughout - a UFVK cannot spend, and nothing here touches a share.
pub fn change_receiver(ufvk: &str, network: &str) -> Result<String, ToolError> {
    use zcash_keys::keys::UnifiedFullViewingKey;
    use zcash_protocol::consensus::Network;

    let params = match network {
        "main" | "mainnet" => Network::MainNetwork,
        "test" | "testnet" => Network::TestNetwork,
        other => {
            return Err(ToolError::parse(
                "change_receiver",
                format!("network must be \"main\" or \"test\", got {other:?}"),
            ))
        }
    };

    let ufvk = UnifiedFullViewingKey::decode(&params, ufvk)
        .map_err(|e| ToolError::parse("change_receiver", format!("UFVK does not decode: {e}")))?;
    let fvk = ufvk.orchard().ok_or_else(|| {
        ToolError::parse(
            "change_receiver",
            "the UFVK carries no Orchard key".to_string(),
        )
    })?;

    let addr = fvk.address_at(0u32, orchard::keys::Scope::Internal);
    Ok(
        zcash_keys::address::UnifiedAddress::from_receivers(Some(addr), None)
            .ok_or_else(|| {
                ToolError::parse(
                    "change_receiver",
                    "the change receiver is not a valid UA".to_string(),
                )
            })?
            .encode(&params),
    )
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

    // There is deliberately NO `ids()` / list-all here. The registry is looked up BY id, never
    // enumerated: the id is the group verifying key, and handing out the list of ids hands out read
    // access to every vault the helper knows (#267). If you need to count them for ops, use `len()`
    // and keep the count on the server.
    pub fn contains(&self, vault_id: &str) -> bool {
        self.vaults
            .lock()
            .expect("helper state mutex")
            .contains_key(vault_id)
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

    /// #434: the birthday lives ONLY in `wallet/keys.toml`, and the documented ops backup excludes
    /// `wallet/` as "rebuildable". Rebuilding needs this number, so it has to be read back and kept
    /// in `registration.json`, which IS backed up. These cover the read itself.
    #[test]
    fn the_wallet_birthday_is_read_back_from_keys_toml() {
        let dir = std::env::temp_dir().join(format!("konclave-bday-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        // The real shape, copied from a live vault's wallet: two lines, no quotes on the number.
        std::fs::write(
            dir.join("keys.toml"),
            "network = \"main\"\nbirthday = 3459814\n",
        )
        .unwrap();
        assert_eq!(read_wallet_birthday(&dir), Some(3_459_814));
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn a_missing_or_birthdayless_keys_toml_reads_as_unknown_not_zero() {
        // Zero would be a catastrophic default: it asks a rebuilt wallet to scan the entire chain,
        // and worse, it reads as a real answer. Not knowing must stay not knowing.
        let dir = std::env::temp_dir().join(format!("konclave-bday-none-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        assert_eq!(read_wallet_birthday(&dir), None, "no keys.toml at all");
        std::fs::write(dir.join("keys.toml"), "network = \"main\"\n").unwrap();
        assert_eq!(read_wallet_birthday(&dir), None, "no birthday line");
        std::fs::write(
            dir.join("keys.toml"),
            "network = \"main\"\nbirthday = later\n",
        )
        .unwrap();
        assert_eq!(read_wallet_birthday(&dir), None, "unparseable birthday");
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn a_registration_written_before_the_field_still_loads() {
        // The 8 live vaults look exactly like this. If `birthday` were required, every one of them
        // would fail to load on the next deploy and the helper would serve nothing.
        let json = r#"{"vault_id":"ab","address":"u1ab","ufvk":"uview1ab","wallet_dir":"/tmp/ab",
                       "account":"acct","threshold":2,"total":3}"#;
        let reg: VaultRegistration = serde_json::from_str(json).expect("legacy registration loads");
        assert_eq!(reg.birthday, None);
        assert_eq!(reg.change_receiver, "");
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
            change_receiver: format!("u1change{id}"),
            birthday: Some(3_400_000),
        }
    }

    fn mk_prop(vault: &str, id: &str) -> HelperProposal {
        HelperProposal {
            id: id.into(),
            vault_id: vault.into(),
            kind: "payment".into(),
            to: "utest1dest".into(),
            amount_zat: 1000,
            memo: None,
            lines: vec![],
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

    /// #289: a refusal is a DECISION; an expiry is a TIMEOUT. When both are true of the same
    /// proposal, the record must say what the group actually did.
    ///
    /// `recompute` checked expiry first and returned early, so a proposal the group had refused
    /// read `expired` once its deadline passed - the ledger said "nobody got round to it" about a
    /// payment that was voted down. The defect was latent while the web path sent `expiry_unix: 0`
    /// (the branch never fired) and went LIVE when #328 started sending a real 72h deadline.
    #[test]
    fn a_refused_proposal_stays_refused_past_its_deadline() {
        let mut p = mk_prop("v", "p3");
        p.approvals.clear();
        p.expiry_unix = 300;

        // 2-of-3: two refusals leave one possible approver, below the threshold.
        assert!(p.vote("bob", false, 100));
        assert!(p.vote("carol", false, 100));
        assert_eq!(p.state, "refused");

        // The deadline passes. The decision must survive it.
        p.recompute(301);
        assert_eq!(
            p.state, "refused",
            "the group refused this payment; a passed deadline must not rewrite that as a timeout"
        );

        // A proposal still in play, with no refusals, DOES expire - that branch is unaffected.
        let mut open = mk_prop("v", "p4");
        open.expiry_unix = 300;
        open.recompute(301);
        assert_eq!(open.state, "expired");
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

        // This used to assert that a refused proposal rejects further votes. The expectation was
        // wrong, and #288 is why: `refused` is derived from the refusal count on every recompute,
        // not stamped once, and votes are unauthenticated - so treating it as terminal let one
        // request per seat, from anyone holding the vault id, brick a vault's governance with no
        // way back. A member withdrawing a refusal must bring the proposal back.
        assert!(
            p.vote("carol", true, 100),
            "a refusal is not a one-way door"
        );
        assert_ne!(p.state, "refused", "withdrawing it revives the proposal");
        assert!(p.refusals.iter().all(|m| m != "carol"));

        // What IS terminal stays terminal.
        p.state = "sent".into();
        assert!(!p.vote("alice", true, 100), "a sent payment takes no votes");
        p.state = "expired".into();
        assert!(
            !p.vote("alice", true, 100),
            "an expired proposal takes no votes"
        );
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
    fn members_persist_and_reload() {
        let dir =
            std::env::temp_dir().join(format!("konclave-members-test-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        assert!(load_members(&dir, "v").is_empty());
        let names = vec!["Alice".to_string(), "Bob".to_string(), "Carol".to_string()];
        save_members(&dir, "v", &names).unwrap();
        assert_eq!(load_members(&dir, "v"), names);
        // Overwrites, not appends.
        save_members(&dir, "v", &["Dave".to_string()]).unwrap();
        assert_eq!(load_members(&dir, "v"), vec!["Dave".to_string()]);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn device_keys_register_idempotently_as_a_set() {
        // #63 Passo 2: the helper collects each device's comms pubkey so it can seal to the set.
        let dir = std::env::temp_dir().join(format!("konclave-devkey-test-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);

        assert!(load_device_keys(&dir, "v").is_empty(), "starts empty");

        assert!(add_device_key(&dir, "v", "aa11").unwrap(), "aa11 is new");
        assert!(add_device_key(&dir, "v", "bb22").unwrap(), "bb22 is new");
        assert!(
            !add_device_key(&dir, "v", "aa11").unwrap(),
            "a duplicate registration is not new (idempotent)",
        );

        let mut keys = load_device_keys(&dir, "v");
        keys.sort();
        assert_eq!(
            keys,
            vec!["aa11".to_string(), "bb22".to_string()],
            "the set holds both distinct keys, the duplicate collapsed",
        );
        // A different vault has its own set.
        assert!(load_device_keys(&dir, "other").is_empty());
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn read_gate_opens_until_a_key_is_set_then_requires_it() {
        // #388 Passo 2: reads are gated by a per-vault readKey = HKDF(S, "read"). A vault with no
        // readKey keeps accepting reads untokened (compat during migration); once a readKey is set,
        // a read must present exactly it.
        let dir =
            std::env::temp_dir().join(format!("konclave-readkey-test-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);

        // No key yet: the gate is OPEN, with or without a presented token.
        assert!(load_read_key(&dir, "v").is_none(), "starts with no readKey");
        assert!(read_authorized(&dir, "v", None), "open when no key is set");
        assert!(
            read_authorized(&dir, "v", Some("whatever")),
            "open ignores any token when no key"
        );

        // Set the key: now a read must present it.
        set_read_key(&dir, "v", "deadbeef").unwrap();
        assert_eq!(load_read_key(&dir, "v").as_deref(), Some("deadbeef"));
        assert!(
            read_authorized(&dir, "v", Some("deadbeef")),
            "the right token passes"
        );
        assert!(
            !read_authorized(&dir, "v", Some("wrong")),
            "a wrong token is refused"
        );
        assert!(
            !read_authorized(&dir, "v", None),
            "a migrated vault refuses an untokened read"
        );

        // The gate is per-vault: another vault with no key is still open.
        assert!(
            read_authorized(&dir, "other", None),
            "a different vault has its own gate"
        );
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn a_roster_is_claimed_once_and_a_stranger_cannot_replace_it() {
        let dir = std::env::temp_dir().join(format!("konclave-claim-test-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        let roster: Vec<String> = vec!["Alice".into(), "Bob".into(), "Carol".into()];

        // First writer wins: the DKG decided this list.
        assert_eq!(
            claim_members(&dir, "v", &roster).unwrap(),
            RosterWrite::Claimed
        );
        assert_eq!(load_members(&dir, "v"), roster);

        // Every device posts the same list at DKG completion, so a repeat is normal, not an error.
        assert_eq!(
            claim_members(&dir, "v", &roster).unwrap(),
            RosterWrite::Unchanged
        );
        // Stray whitespace still matches itself.
        let spaced: Vec<String> = vec![" Alice".into(), "Bob ".into(), "Carol".into()];
        assert_eq!(
            claim_members(&dir, "v", &spaced).unwrap(),
            RosterWrite::Unchanged
        );

        // The attack this exists to stop: replace the roster, then vote as one of the new names.
        let hostile: Vec<String> = vec!["Mallory".into()];
        assert_eq!(
            claim_members(&dir, "v", &hostile).unwrap(),
            RosterWrite::Refused
        );
        assert_eq!(
            load_members(&dir, "v"),
            roster,
            "the roster must not have moved"
        );

        // Emptying it is refused too: an empty roster is what makes voting fail open.
        assert_eq!(claim_members(&dir, "v", &[]).unwrap(), RosterWrite::Refused);
        assert_eq!(load_members(&dir, "v"), roster);

        // Adding a name is a different roster, not an append.
        let grown: Vec<String> = vec!["Alice".into(), "Bob".into(), "Carol".into(), "Dave".into()];
        assert_eq!(
            claim_members(&dir, "v", &grown).unwrap(),
            RosterWrite::Refused
        );
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn rename_member_migrates_votes_no_ghost() {
        // The reported bug: renaming a member left their past approval attached to the OLD name while
        // the roster showed the NEW name still awaiting - one person shown as two rows in a 2-of-2.
        let dir = std::env::temp_dir().join(format!("konclave-rename-test-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        save_members(&dir, "v", &["Michael".into(), "zcashbrazil".into()]).unwrap();
        let mut p = mk_prop("v", "p1");
        p.proposer = "Michael".into();
        p.approvals = vec!["Michael".into(), "zcashbrazil".into()]; // both approved
        save_proposal(&dir, &p).unwrap();

        let roster = rename_member(&dir, "v", "zcashbrazil", "Daniel", 200).unwrap();
        assert_eq!(roster, vec!["Michael".to_string(), "Daniel".to_string()]);

        // The proposal's approval moved with the rename: still exactly 2 approvers, now Daniel not
        // zcashbrazil - no orphan, no ghost row.
        let got = load_proposal(&dir, "v", "p1", 200).unwrap();
        assert_eq!(
            got.approvals,
            vec!["Michael".to_string(), "Daniel".to_string()]
        );
        assert!(!got.approvals.iter().any(|a| a == "zcashbrazil"));
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn sync_throttle_shares_a_sync() {
        let dir =
            std::env::temp_dir().join(format!("konclave-sync-throttle-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        // No record yet -> must sync.
        assert!(should_sync(&dir, "v", 15, 1000));
        mark_synced(&dir, "v", 1000);
        // Within the window -> skip (serve the last-synced state).
        assert!(!should_sync(&dir, "v", 15, 1005));
        assert!(!should_sync(&dir, "v", 15, 1014));
        // At/after the window -> sync again.
        assert!(should_sync(&dir, "v", 15, 1015));
        assert!(should_sync(&dir, "v", 15, 2000));
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn rename_member_guards() {
        let dir =
            std::env::temp_dir().join(format!("konclave-rename-guard-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        save_members(&dir, "v", &["Alice".into(), "Bob".into()]).unwrap();
        // Unknown seat.
        assert!(rename_member(&dir, "v", "Nobody", "X", 0).is_err());
        // Collision with a different seat.
        assert!(rename_member(&dir, "v", "Alice", "Bob", 0).is_err());
        // Empty new name.
        assert!(rename_member(&dir, "v", "Alice", "  ", 0).is_err());
        // No-op (rename to self) is allowed and leaves the roster intact.
        assert_eq!(
            rename_member(&dir, "v", "Alice", "Alice", 0).unwrap(),
            vec!["Alice".to_string(), "Bob".to_string()]
        );
        // A real rename trims and persists.
        let roster = rename_member(&dir, "v", "Alice", " Alicia ", 0).unwrap();
        assert_eq!(roster, vec!["Alicia".to_string(), "Bob".to_string()]);
        assert_eq!(load_members(&dir, "v"), roster);
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

#[cfg(test)]
mod change_receiver_tests {
    use super::*;

    // A real UFVK, produced by `zcash-sign generate --ak <group key> --network main`. The pair is
    // what registration stores for a vault, so the test operates on exactly the shape production
    // holds.
    const UFVK: &str = "uview1z2nst9y9367acqqykyws80hrc3df87ffnwvtvx3ggf3tvx342sncxxfztdgfk67a0xk4c0wptspqyc4k59ucqrtxgdka96ktjudm5gr65d8aaq6js0jpwrfryrafzu82axyezm9e6y5r96z7hk8a04zpvs5896xeze9pmpwwymh5h7xeae79wscp2c08j";
    const EXTERNAL: &str = "u1cl9hwu3v580lgfuz9z9u8wp9scpy4c2yzcre7kvghtfuyyvsan33g0fgmkyx246mtq6s5x2qzraetalqfhkmul2agejjxynqxvz5e3el";

    #[test]
    fn the_change_receiver_is_not_the_address_funds_are_received_at() {
        // The whole reason this exists: change comes back to the INTERNAL scope, an address the
        // signing device has never seen and cannot derive. Reading change as "an output we do not
        // recognise" is what made the money gate refuse every legitimate send (#281).
        let change = change_receiver(UFVK, "main").expect("a real UFVK yields a change receiver");
        assert_ne!(
            change, EXTERNAL,
            "internal scope must not collapse onto the external address"
        );
        assert!(
            change.starts_with("u1"),
            "a mainnet unified address, got {change}"
        );
    }

    #[test]
    fn the_same_vault_always_gets_the_same_change_receiver() {
        // Load-bearing for the plan's decision to CAPTURE this once and store it immutably: if the
        // derivation drifted between calls, a stored value would start rejecting real sends.
        // librustzcash pins the diversifier (`address_at(0u32, Scope::Internal)`,
        // zcash_client_backend/src/data_api/wallet.rs:1684), so this is fixed, not merely stable.
        let a = change_receiver(UFVK, "main").unwrap();
        let b = change_receiver(UFVK, "main").unwrap();
        assert_eq!(a, b);
    }

    #[test]
    fn a_ufvk_that_does_not_decode_is_an_error_not_a_guess() {
        assert!(
            change_receiver("uview1x2w3", "main").is_err(),
            "a truncated UFVK must not resolve"
        );
        assert!(change_receiver("", "main").is_err());
    }

    #[test]
    fn the_network_must_be_declared_and_must_match_the_key() {
        assert!(
            change_receiver(UFVK, "bogus").is_err(),
            "an unknown network must be rejected"
        );
        // A mainnet UFVK is not decodable under testnet parameters: the HRP differs, so a mismatch
        // fails loudly instead of silently producing an address for the wrong chain.
        assert!(
            change_receiver(UFVK, "test").is_err(),
            "a mainnet key must not decode as testnet"
        );
    }
}
