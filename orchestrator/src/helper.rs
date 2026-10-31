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
use crate::write_auth::{members_counted, same_member};

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
    /// The relay base URLs this coordinator may publish a signing request to (#270), from its own
    /// configuration and never from a request. Empty means none: every send is refused.
    pub relays: Vec<String>,
    /// The most a send waits for the devices' signatures, in polls (about a second each). The
    /// operator's setting (`KONCLAVE_SEND_MAX_POLLS`).
    pub send_max_polls: u32,
}

/// What a send waits for the devices when the operator has not said: five minutes.
pub const DEFAULT_SEND_MAX_POLLS: u32 = 300;

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
/// the FROST ceremony over the relay, and `send::net_prepare_send` never touches those
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

/// How long a wallet sync stays "fresh", per vault: within this window a read of the wallet (the
/// balance and the history alike) skips the slow sync and serves the last-synced state, so the
/// Dashboard's 12 s poll, the Add funds history's 15 s poll and bursts across screens share one sync
/// instead of each triggering a multi-second lightwalletd sync (#194). The promotion of mined
/// payments reads the wallet under the same duration, with its own stamp.
pub const SYNC_THROTTLE_SECS: u64 = 15;

/// Whether a stamp taken at `last` still covers `now` for a window of `window_secs`. ONE predicate
/// for every throttle in this crate (the sync window and the promotion's). A stamp from the FUTURE (a
/// clock that went back) is not a recent one: it covers nothing, so it cannot keep a deposit from
/// being seen, or a payment from being recorded, until the clock catches up.
pub(crate) fn inside_window(last: u64, now: u64, window_secs: u64) -> bool {
    last <= now && now - last < window_secs
}

fn last_sync_path(vaults_dir: &Path, vault: &str) -> PathBuf {
    vaults_dir.join(vault).join("last_sync")
}

/// True when the wallet should be re-synced: no recorded sync yet, or the last one is at least
/// `throttle_secs` old. Pure (takes `now`), so it is unit-testable.
pub(crate) fn should_sync(vaults_dir: &Path, vault: &str, throttle_secs: u64, now: u64) -> bool {
    match std::fs::read_to_string(last_sync_path(vaults_dir, vault))
        .ok()
        .and_then(|s| s.trim().parse::<u64>().ok())
    {
        Some(last) => !inside_window(last, now, throttle_secs),
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

/// The 8-character prefix of a vault id: the only form of an id that may reach a log. ONE function,
/// so the rule has no second copy (a source scan in the tests keeps it that way).
pub fn short_id(vault_id: &str) -> &str {
    vault_id.get(..8).unwrap_or(vault_id)
}

/// A text for ONE log line about a vault: the vault's id replaced by its 8-character prefix (the
/// engine's error text names the wallet's path, which holds the whole id) and line breaks flattened,
/// since some of that text comes from a server that is not ours. Every log line that can carry an
/// engine's error goes through this.
pub fn loggable(vault_id: &str, text: &str) -> String {
    let short = short_id(vault_id);
    let masked = if vault_id.is_empty() {
        text.to_string()
    } else {
        text.replace(vault_id, short)
    };
    masked.replace(['\r', '\n'], " ")
}

/// Migrate a vault's wallet database to the schema THIS engine expects, logging a failure under the
/// vault's 8-character prefix. A failed migration is logged, not fatal: the read that follows is what
/// reports a real schema problem. Called only by [`bring_current`], which every balance, history and
/// settling read comes through, so none of them can touch a wallet an older engine wrote without it.
fn upgrade_logged(devtool: &Path, wallet_dir: &str, vault_id: &str) {
    if let Err(e) = crate::wallet::upgrade(devtool, wallet_dir) {
        eprintln!(
            "vault {}: wallet upgrade failed: {}",
            short_id(vault_id),
            loggable(vault_id, &e.to_string())
        );
    }
}

/// What a freshly synced wallet says about the chain: its own tip and the txids it has recorded as
/// mined. Both are read AFTER the same forced sync, so a transaction mined at or below `tip` is in
/// `mined`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct WalletView {
    pub tip: u64,
    pub mined: Vec<String>,
    /// The height the wallet has SCANNED to, if the engine says. `balance --json` reports the tip the
    /// wallet knows and not what it scanned (CLAUDE.md section 11), so today this is `None`, and the
    /// epoch cap uses a named scan margin instead (`konclave_seal::epochs::SCAN_MARGIN`).
    pub scanned: Option<u64>,
}

/// How current a wallet has to be made before it is read.
#[derive(Clone, Copy, PartialEq, Eq)]
enum Freshness {
    /// Sync only if the last sync is older than the window ([`SYNC_THROTTLE_SECS`], per vault): the
    /// balance and the history, which are polled.
    IfStale,
    /// Sync now whatever the window says: settling a send must not be decided by a stale view.
    Always,
}

/// THE one place a vault's wallet is brought up to date: migrate its database to the schema THIS
/// engine expects (logged under the vault's 8-character prefix, never fatal), then sync it with
/// lightwalletd according to `freshness`, and stamp the window only after the sync succeeded, so a
/// failed sync is tried again by the next read. The balance, the history and the settling of a send all
/// come through here, so the window, the stamp and the migration have one implementation (#637: the
/// history read only listed what the wallet already knew, and a deposit showed on Add funds only after
/// the dashboard's balance read had synced it).
///
/// The caller holds the vault's WALLET lock, which is what keeps two reads from starting two engine
/// processes on one wallet: `with_the_wallet` for the balance and history reads, `serve` for a
/// proposal, a payroll or a send. This function neither takes it nor can check it.
fn bring_current(
    devtool: &Path,
    wallet_dir: &str,
    lightwalletd: &str,
    vaults_dir: &Path,
    vault_id: &str,
    freshness: Freshness,
) -> Result<(), ToolError> {
    // Once per read, and outside the sync window: a read on a wallet written by an older engine
    // fails even when the sync is skipped (in August: `no such table:
    // orchard_ironwood_migrations`).
    upgrade_logged(devtool, wallet_dir, vault_id);
    let now = now_secs();
    if freshness == Freshness::Always || should_sync(vaults_dir, vault_id, SYNC_THROTTLE_SECS, now)
    {
        crate::wallet::sync(devtool, wallet_dir, lightwalletd)?;
        mark_synced(vaults_dir, vault_id, now);
    }
    Ok(())
}

/// Bring the vault's wallet current and read what settling a send needs: [`bring_current`] with a
/// FORCED sync (the window would let a stale view decide), then the tip and the mined txids. The tip
/// is the wallet's own (`balance --json`), not a second lightwalletd call, so the two answers cannot
/// come from different backends. The one reader of mined txids is [`crate::wallet`]'s, the one
/// reconcile uses.
pub fn settle_wallet(
    devtool: &Path,
    wallet_dir: &str,
    lightwalletd: &str,
    vaults_dir: &Path,
    vault_id: &str,
) -> Result<WalletView, ToolError> {
    bring_current(
        devtool,
        wallet_dir,
        lightwalletd,
        vaults_dir,
        vault_id,
        Freshness::Always,
    )?;
    let tip = crate::wallet::balance(devtool, wallet_dir)?.chain_tip_height;
    let mined = crate::wallet::list_confirmed_txids(devtool, wallet_dir)?;
    Ok(WalletView {
        tip,
        mined,
        scanned: None,
    })
}

/// Bring a registered vault's wallet up to date before a read of chain state, under the window.
fn fresh_wallet(cfg: &HelperConfig, reg: &VaultRegistration) -> Result<(), ToolError> {
    bring_current(
        &cfg.devtool,
        &reg.wallet_dir,
        &cfg.lightwalletd,
        &cfg.vaults_dir,
        &reg.vault_id,
        Freshness::IfStale,
    )
}

/// Read a registered vault's shielded balance from its view-only wallet, after bringing the wallet up
/// to date ([`vault_balance`] and [`vault_transactions`] share that step). The helper owns the UFVK
/// (view-only), so this is a watcher's read - no share involved. A sync that fails is an error: a
/// balance that could not be refreshed is not served as current.
pub fn vault_balance(
    cfg: &HelperConfig,
    reg: &VaultRegistration,
) -> Result<VaultBalance, ToolError> {
    fresh_wallet(cfg, reg)?;
    let b = crate::wallet::balance(&cfg.devtool, &reg.wallet_dir)?;
    Ok(VaultBalance {
        orchard_spendable_zat: b.orchard_spendable.as_u64(),
        ironwood_spendable_zat: b.ironwood_spendable.as_u64(),
        shielded_spendable_zat: b.shielded_spendable().as_u64(),
        total_zat: b.total.as_u64(),
        chain_tip_height: b.chain_tip_height,
    })
}

/// The vault's on-chain transaction history (newest first) for the Add-funds record. It brings the
/// wallet up to date first, under the same window as the balance, so a deposit appears on the first
/// read whichever screen asked first, and it never moves funds. Amount/direction per tx is a
/// follow-up (#125).
///
/// Unlike the balance, a history whose sync FAILS (lightwalletd unreachable) still answers with what
/// the wallet already knows, and the failure is logged: the Add funds screen replaces its list with
/// "no transactions yet" on any error other than busy, so failing here would make a reachable outage
/// look like a vault that lost its history. The failed sync is not stamped, so the next read tries it
/// again.
pub fn vault_transactions(
    cfg: &HelperConfig,
    reg: &VaultRegistration,
) -> Result<Vec<crate::wallet::WalletTx>, ToolError> {
    if let Err(e) = fresh_wallet(cfg, reg) {
        log_vault(
            &reg.vault_id,
            &format!(
                "history served without a fresh sync: {}",
                loggable(&reg.vault_id, &e.to_string())
            ),
        );
    }
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
    // One write for the line and its newline: two writes can leave the line without its break when the
    // second one fails, and the next record would then be glued to it.
    f.write_all(format!("{line}\n").as_bytes())
        .map_err(ToolError::Io)?;
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
    /// Recompute the state from the votes / clock. `sent` sticks, and so does `expired` once its
    /// deadline has passed. `ready` once approvals reach the threshold; `refused` once refusals make
    /// the quorum unreachable (`total - refusals < threshold`), derived on every call, so a withdrawn
    /// refusal moves a proposal back out of it (#369); `expired` past the deadline.
    ///
    /// Votes are counted as MEMBERS of `roster`, the vault's current member list, not as strings
    /// (#575): see [`members_counted`]. The roster is a parameter rather than something this reads,
    /// so no caller can count without it. A vault with no roster counts every entry, as before.
    pub fn recompute(&mut self, now: u64, roster: &[String]) {
        if self.state == "sent" {
            return;
        }
        let approvals = members_counted(&self.approvals, roster);
        let refusals = members_counted(&self.refusals, roster);
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
            && (self.total as usize).saturating_sub(refusals) < self.threshold as usize
        {
            self.state = "refused".into();
            return;
        }
        if self.expiry_unix != 0 && now >= self.expiry_unix {
            self.state = "expired".into();
            return;
        }
        self.state = if self.threshold > 0 && approvals >= self.threshold as usize {
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
    pub fn vote(&mut self, member: &str, approve: bool, now: u64, roster: &[String]) -> bool {
        if self.state == "sent" || self.state == "expired" {
            return false;
        }
        // By member, not by exact string (#575): otherwise an entry recorded for this member under
        // another spelling outlives what they say now.
        self.approvals.retain(|m| !same_member(m, member));
        self.refusals.retain(|m| !same_member(m, member));
        if approve {
            self.approvals.push(member.to_string());
        } else {
            self.refusals.push(member.to_string());
        }
        self.recompute(now, roster);
        true
    }
}

/// The directory holding a vault's proposals: `<vaults_dir>/<vault>/proposals/`.
pub fn proposals_dir(vaults_dir: &Path, vault: &str) -> PathBuf {
    vaults_dir.join(vault).join("proposals")
}

/// The file stem a proposal id is stored under: the id with everything but letters, digits and `-`
/// removed. ONE function, used for the proposal's own file and for the send record keyed by it, so
/// two spellings of an id that load the same proposal can never reach two different records.
pub(crate) fn proposal_file_stem(id: &str) -> String {
    id.chars()
        .filter(|c| c.is_ascii_alphanumeric() || *c == '-')
        .collect()
}

fn proposal_path(vaults_dir: &Path, vault: &str, id: &str) -> PathBuf {
    // `id` is helper-generated (hex/dash), never attacker-controlled path input; still, keep only
    // the file name so a crafted id can never traverse out of the proposals dir.
    proposals_dir(vaults_dir, vault).join(format!("{}.json", proposal_file_stem(id)))
}

/// A temporary file name in `dir` that a process which died mid-write is unlikely to meet again: the
/// pid, the time and a counter. Shared by every write in this crate that goes through a temporary.
pub(crate) fn unique_tmp(dir: &Path, stem: &str, ext: &str) -> PathBuf {
    use std::sync::atomic::{AtomicU64, Ordering};
    static N: AtomicU64 = AtomicU64::new(0);
    let nanos = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_nanos())
        .unwrap_or(0);
    dir.join(format!(
        ".{stem}.{}.{nanos}.{}.{ext}",
        std::process::id(),
        N.fetch_add(1, Ordering::Relaxed)
    ))
}

/// Create `path` (it must not exist), write `bytes` and sync them to disk.
pub(crate) fn write_synced(path: &Path, bytes: &[u8]) -> std::io::Result<()> {
    use std::io::Write;
    let mut f = std::fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(path)?;
    f.write_all(bytes)?;
    f.sync_all()
}

#[cfg(unix)]
pub(crate) fn sync_dir(dir: &Path) -> std::io::Result<()> {
    std::fs::File::open(dir).and_then(|d| d.sync_all())
}
#[cfg(not(unix))]
pub(crate) fn sync_dir(_dir: &Path) -> std::io::Result<()> {
    Ok(())
}

/// Replace `path` with `bytes`, whole or not at all: the bytes go to a temporary file in `tmp_dir`
/// (written by `write_tmp`, so a cut write can be tested), which is then renamed over `path`. A
/// process that dies half way leaves the old file or the new one, never a truncated one, and the
/// temporary is removed on any error. The ONE way this crate replaces a file that other reads depend
/// on: a proposal that records a payment as sent, a device registry whose truncation would read as
/// "no write keys".
pub(crate) fn replace_file(
    path: &Path,
    tmp_dir: &Path,
    bytes: &[u8],
    write_tmp: impl Fn(&Path, &[u8]) -> std::io::Result<()>,
) -> std::io::Result<()> {
    let stem = path
        .file_name()
        .map(|n| n.to_string_lossy().into_owned())
        .unwrap_or_default();
    let tmp = unique_tmp(tmp_dir, &stem, "tmp");
    let done = write_tmp(&tmp, bytes).and_then(|()| std::fs::rename(&tmp, path));
    if done.is_err() {
        let _ = std::fs::remove_file(&tmp);
    }
    done
}

/// Persist (create or update) a proposal. Written to a temporary file in the VAULT's directory (not
/// in `proposals/`, which [`list_proposals`] reads whole), synced, then renamed over the proposal: a
/// process that dies mid-write leaves the old file or the new one, never a truncated one that
/// `load_proposal` would silently drop - and this is the write that records a payment as `sent`.
pub fn save_proposal(vaults_dir: &Path, p: &HelperProposal) -> Result<(), ToolError> {
    save_proposal_with(vaults_dir, p, write_synced)
}

/// [`save_proposal`] with the write of the temporary file as a parameter, so a write that is cut
/// half way can be tested: it must leave the proposal exactly as it was, and no temporary behind.
fn save_proposal_with(
    vaults_dir: &Path,
    p: &HelperProposal,
    write_tmp: impl Fn(&Path, &[u8]) -> std::io::Result<()>,
) -> Result<(), ToolError> {
    let path = proposal_path(vaults_dir, &p.vault_id, &p.id);
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent).map_err(ToolError::Io)?;
    }
    let json = serde_json::to_string(p).map_err(|e| ToolError::parse("proposal", e.to_string()))?;
    // The temporary lives beside `proposals/`, never in it: `list_proposals` reads every file there.
    replace_file(
        &path,
        &vaults_dir.join(&p.vault_id),
        json.as_bytes(),
        write_tmp,
    )
    .map_err(ToolError::Io)
}

/// Load one proposal by id (with its state recomputed against `now`, so a lapsed deadline reads as
/// `expired` even if it was persisted `pending`). `None` if absent/unreadable.
pub fn load_proposal(vaults_dir: &Path, vault: &str, id: &str, now: u64) -> Option<HelperProposal> {
    let json = std::fs::read_to_string(proposal_path(vaults_dir, vault, id)).ok()?;
    let mut p: HelperProposal = serde_json::from_str(&json).ok()?;
    p.recompute(now, &load_members(vaults_dir, vault));
    Some(p)
}

/// List a vault's proposals, newest first, each with its state recomputed against `now`.
pub fn list_proposals(vaults_dir: &Path, vault: &str, now: u64) -> Vec<HelperProposal> {
    let dir = proposals_dir(vaults_dir, vault);
    let Ok(entries) = std::fs::read_dir(&dir) else {
        return Vec::new();
    };
    let roster = load_members(vaults_dir, vault);
    let mut out: Vec<HelperProposal> = entries
        .flatten()
        .filter_map(|e| std::fs::read_to_string(e.path()).ok())
        .filter_map(|j| serde_json::from_str::<HelperProposal>(&j).ok())
        .map(|mut p| {
            p.recompute(now, &roster);
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
    save_members_with(vaults_dir, vault, names, write_synced)
}

fn save_members_with(
    vaults_dir: &Path,
    vault: &str,
    names: &[String],
    write_tmp: impl Fn(&Path, &[u8]) -> std::io::Result<()>,
) -> Result<(), ToolError> {
    let path = members_path(vaults_dir, vault);
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent).map_err(ToolError::Io)?;
    }
    let json =
        serde_json::to_string(names).map_err(|e| ToolError::parse("members", e.to_string()))?;
    // The temporary lives in the vault's directory and is renamed over the file: a write that is cut
    // leaves the old file whole.
    replace_file(&path, &vaults_dir.join(vault), json.as_bytes(), write_tmp).map_err(ToolError::Io)
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
            .all(|(a, b)| same_member(a, b));
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

/// One registered device: its #63 comms key, and - once it has registered one - the seat it holds
/// and the Ed25519 key it signs governance writes with (ADR-0011 D4).
///
/// It is ONE record, not two registries. Two files answering "which device belongs to this vault"
/// would drift, and the #63 consumer already reads this one.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct DeviceRecord {
    /// X25519 comms pubkey, hex. The seal-set for a SignRequest (#63).
    pub comms: String,
    /// The 1-based FROST seat this device holds. `None` until it registers a write key.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub seat: Option<u16>,
    /// Ed25519 write-verifying key, hex (#288 / ADR-0011). `None` until registered.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub write: Option<String>,
}

/// The device registry exists but cannot be read: not "no devices", which would leave the vault open
/// to unsigned writes, but a registry that is there and is not usable (a cut write, a bad edit, a
/// permission, a directory in its place). Everything that depends on the registry refuses on this
/// rather than falling back to open, and nothing rewrites it from empty.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RegistryUnreadable(pub String);

impl std::fmt::Display for RegistryUnreadable {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "the device registry cannot be read: {}", self.0)
    }
}
impl std::error::Error for RegistryUnreadable {}

/// Every device registered on this vault.
///
/// Reads BOTH shapes: the current list of records, and the original flat `["hex", ...]` array of
/// comms keys that the live vaults still carry. A flat entry becomes a record with no seat and no
/// write key, which is exactly what it is - a device that registered for sealing before write
/// authentication existed. Nothing on the volume has to be migrated for this to be read correctly.
///
/// ONLY a missing file is "no devices". `[]` is a registry with none. Anything else that does not
/// read - zero bytes (what a `write` cut after it truncated leaves), half a JSON document, garbage,
/// a mixed array, bad UTF-8, a permission error, a directory - is [`RegistryUnreadable`].
pub fn load_device_records(
    vaults_dir: &Path,
    vault: &str,
) -> Result<Vec<DeviceRecord>, RegistryUnreadable> {
    let json = match std::fs::read_to_string(device_keys_path(vaults_dir, vault)) {
        Ok(j) => j,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(Vec::new()),
        Err(e) => return Err(RegistryUnreadable(e.to_string())),
    };
    if let Ok(recs) = serde_json::from_str::<Vec<DeviceRecord>>(&json) {
        return Ok(recs);
    }
    serde_json::from_str::<Vec<String>>(&json)
        .map(|flat| {
            flat.into_iter()
                .map(|comms| DeviceRecord {
                    comms,
                    seat: None,
                    write: None,
                })
                .collect()
        })
        .map_err(|_| RegistryUnreadable("not a list of device records".into()))
}

/// The vault's registered device comms pubkeys (hex), the seal-set for a SignRequest (#63), or why
/// the registry cannot be read. Empty when none registered yet: [`request_recipients`] then decides
/// whether a send may be published unsealed at all.
pub fn load_device_keys(vaults_dir: &Path, vault: &str) -> Result<Vec<String>, RegistryUnreadable> {
    Ok(load_device_records(vaults_dir, vault)?
        .into_iter()
        .map(|r| r.comms)
        .collect())
}

/// Whether a registered comms key can be sealed to: the rule that decides it is the one that will
/// seal to it ([`crate::envelope::seal_to_devices`]), not a second table of bad keys, so a key of
/// small order is as unusable as one that is not hex.
pub fn device_key_usable(comms: &str) -> bool {
    crate::envelope::seal_to_devices("check", b"", &[comms.to_string()]).is_ok()
}

/// How many registered comms keys cannot be sealed to. Counted for the boot log and nowhere else: the
/// registry is NOT filtered by this. An entry taken out would lower the count of registered devices
/// below the seats, and a signed send would then go out unsealed, a quiet step down in privacy. Kept,
/// it refuses the vault's sealed sends with an error until the operator restores the entry
/// (`docs/RECOVERY.md`, G2), and the boot log says which vault.
pub fn unusable_device_keys(vaults_dir: &Path, vault: &str) -> usize {
    load_device_records(vaults_dir, vault)
        .map(|recs| recs.iter().filter(|r| !device_key_usable(&r.comms)).count())
        .unwrap_or(0)
}

/// What the registry says about whether this vault's governance writes must be signed.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum WriteGate {
    /// No device has registered a write key: the vault is open to unsigned writes (ADR-0011 D5), so a
    /// vault that has not migrated keeps working.
    Open,
    /// At least one seat has a write key: every governance write must be signed by the seat's key.
    Keys(Vec<crate::write_auth::WriteKey>),
    /// The registry cannot be read: writes are refused, because reading it as "open" would turn the
    /// gate off exactly for a vault whose keys it holds.
    Unreadable(RegistryUnreadable),
}

/// The ONE place that decides open, gated or unreadable. `authorize_write` stays free of I/O and is
/// handed the keys this returns.
pub fn write_gate(vaults_dir: &Path, vault: &str) -> WriteGate {
    match load_device_records(vaults_dir, vault) {
        Err(e) => WriteGate::Unreadable(e),
        Ok(recs) => {
            let keys: Vec<_> = recs
                .into_iter()
                .filter_map(|r| {
                    Some(crate::write_auth::WriteKey {
                        seat: r.seat?,
                        pubkey: r.write?,
                    })
                })
                .collect();
            if keys.is_empty() {
                WriteGate::Open
            } else {
                WriteGate::Keys(keys)
            }
        }
    }
}

/// The write keys registered on this vault. A convenience for tests that flattens "open" into an
/// empty list; the coordinator decides through [`write_gate`], which keeps open, gated and unreadable
/// apart, so this exists only for tests.
#[cfg(test)]
pub fn load_write_keys(
    vaults_dir: &Path,
    vault: &str,
) -> Result<Vec<crate::write_auth::WriteKey>, RegistryUnreadable> {
    match write_gate(vaults_dir, vault) {
        WriteGate::Open => Ok(Vec::new()),
        WriteGate::Keys(k) => Ok(k),
        WriteGate::Unreadable(e) => Err(e),
    }
}

/// Why a device registration did not go through. The coordinator maps each to one status; the
/// reasons carry no mechanism.
#[derive(Debug)]
pub enum DeviceError {
    /// The registration is not well formed or not acceptable as sent: 400.
    Invalid(String),
    /// A registration already on record would have to change: 409.
    Conflict(String),
    /// The registry is there and cannot be read, so nothing is written to it: 503.
    Unreadable(RegistryUnreadable),
    /// The registry could not be written: 500.
    Io(ToolError),
}

impl std::fmt::Display for DeviceError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            DeviceError::Invalid(m) | DeviceError::Conflict(m) => f.write_str(m),
            DeviceError::Unreadable(e) => e.fmt(f),
            DeviceError::Io(e) => e.fmt(f),
        }
    }
}
impl std::error::Error for DeviceError {}

/// 32 bytes as 64 LOWER-case hex digits: one spelling per key, read by the one decoder.
fn is_lower_hex_32(h: &str) -> Option<[u8; 32]> {
    if h.bytes().any(|b| b.is_ascii_uppercase()) {
        return None;
    }
    konclave_seal::hex::decode_exact(h)
}

/// A comms key the coordinator can actually seal to: 64 lower-case hex (one spelling per key) and
/// accepted by the SAME function that will later seal to it, `envelope::seal_to_devices`. A small-order
/// key, which would make every sealed send and `/ufvk` fail until the registry is edited by hand, is
/// refused here by the rule that would refuse it there, with no second table of bad points.
fn check_comms_key(comms: &str) -> Result<(), String> {
    if is_lower_hex_32(comms).is_none() {
        return Err("device_pub must be 64 lower-case hex characters".into());
    }
    crate::envelope::seal_to_devices("check", b"", &[comms.to_string()])
        .map(|_| ())
        .map_err(|_| "device_pub is not a valid device key".to_string())
}

/// A write key the coordinator can verify with: 64 lower-case hex that decode to an Ed25519 point,
/// not a small-order one, and written in its canonical encoding. The canonical check re-compresses
/// the decoded point: `VerifyingKey::to_bytes()` hands back the bytes it was given, so comparing
/// against that would pass anything that decodes.
fn check_write_key(write: &str) -> Result<(), String> {
    const BAD: &str = "write_pub is not a valid write key";
    let Some(bytes) = is_lower_hex_32(write) else {
        return Err("write_pub must be 64 lower-case hex characters".into());
    };
    let vk = ed25519_dalek::VerifyingKey::from_bytes(&bytes).map_err(|_| BAD.to_string())?;
    if vk.is_weak() || vk.to_edwards().compress().to_bytes() != bytes {
        return Err(BAD.into());
    }
    Ok(())
}

/// The ONE public door for registering a device: it validates, then binds. A caller cannot reach the
/// writer without the checks, because the writer is not part of the public surface a production path
/// uses (`upsert_device` takes no validation and is named so).
///
/// - `device_pub` must be a comms key the coordinator can seal to ([`check_comms_key`]);
/// - the seat and the write key travel together or not at all; the seat is in `1..=total` (a legacy
///   vault registered with `total == 0` keeps only `seat >= 1`), the key is canonical and strong;
/// - an existing record that is already bound to a seat and a key never changes either (see
///   [`upsert_device`]).
pub fn register_device(
    vaults_dir: &Path,
    vault: &str,
    total: u16,
    comms: &str,
    seat: Option<u16>,
    write_pub: Option<&str>,
) -> Result<bool, DeviceError> {
    let comms = comms.trim();
    check_comms_key(comms).map_err(DeviceError::Invalid)?;
    let write = match (seat, write_pub.map(str::trim)) {
        (None, None) => None,
        (Some(seat), Some(wp)) => {
            if seat == 0 || (total > 0 && seat > total) {
                return Err(DeviceError::Invalid(
                    "seat is outside this vault's seats".into(),
                ));
            }
            check_write_key(wp).map_err(DeviceError::Invalid)?;
            Some((seat, wp))
        }
        _ => {
            return Err(DeviceError::Invalid(
                "seat and write_pub must be sent together".into(),
            ))
        }
    };
    upsert_device(vaults_dir, vault, comms, write)
}

/// A send that no seat signed and that would have to be published unsealed. See [`request_recipients`].
#[derive(Debug, PartialEq, Eq)]
pub struct UnsealedRefused;

/// Who a signing request is sealed to, and whether it may be published unsealed at all. ONE rule,
/// asked once per send, and the handler adds nothing to it.
///
/// - Every seat has registered a device key: the request is sealed to all of them, and nothing has
///   to be signed for that.
/// - Otherwise a seat that has not registered would get no box and be locked out of its own vault, so
///   an unsealed request is allowed (the rollout never breaks a live vault, #63), but only for a
///   send a seat SIGNED (`signed`). An empty list in the answer means "unsealed", and is only ever
///   returned for a signed send.
pub fn request_recipients(
    total: u16,
    registered: &[String],
    signed: bool,
) -> Result<Vec<String>, UnsealedRefused> {
    if total > 0 && registered.len() >= total as usize {
        return Ok(registered.to_vec());
    }
    if signed {
        Ok(Vec::new())
    } else {
        Err(UnsealedRefused)
    }
}

#[cfg(test)]
mod recipients_tests {
    use super::*;

    fn keys(n: usize) -> Vec<String> {
        (0..n).map(|i| format!("{i:064x}")).collect()
    }

    #[test]
    fn every_seat_registered_seals_to_all_of_them_with_no_signature() {
        for signed in [false, true] {
            assert_eq!(request_recipients(3, &keys(3), signed), Ok(keys(3)));
            // Extra device records (a second device of one member) are sealed to as well.
            assert_eq!(request_recipients(3, &keys(4), signed), Ok(keys(4)));
        }
    }

    #[test]
    fn clear_text_is_only_for_a_send_a_seat_signed() {
        for registered in [0, 1, 2] {
            assert_eq!(
                request_recipients(3, &keys(registered), true),
                Ok(Vec::new()),
                "{registered} of 3 registered, signed: clear text, as the rollout needs"
            );
            assert_eq!(
                request_recipients(3, &keys(registered), false),
                Err(UnsealedRefused),
                "{registered} of 3 registered, unsigned: refused"
            );
        }
    }

    /// A legacy vault records no total. It cannot be "fully registered", so the same rule applies:
    /// clear text only for a signed send.
    #[test]
    fn a_vault_with_no_recorded_total_is_never_fully_registered() {
        assert_eq!(request_recipients(0, &[], false), Err(UnsealedRefused));
        assert_eq!(request_recipients(0, &keys(2), false), Err(UnsealedRefused));
        assert_eq!(request_recipients(0, &keys(2), true), Ok(Vec::new()));
    }
}

/// Register a device's PERSISTENT comms pubkey so the helper can SEAL the SignRequest to it. Tests
/// only: production registers through [`register_device`], which validates.
#[cfg(test)]
pub fn add_device_key(
    vaults_dir: &Path,
    vault: &str,
    device_pub: &str,
) -> Result<bool, DeviceError> {
    upsert_device(vaults_dir, vault, device_pub, None)
}

fn same_key(a: &str, b: &str) -> bool {
    a.eq_ignore_ascii_case(b)
}

/// Write a device record: its comms key, and optionally the seat + Ed25519 write key it will sign
/// governance writes with (ADR-0011 D4). Returns whether anything changed. **Does not validate** its
/// arguments: a production caller goes through [`register_device`], and a test pins that the only
/// non-test caller here is that one. The caller holds the vault's lock (`serve` does).
///
/// The binding is WRITE-ONCE. A device is found by its comms key - but every member can read every
/// device's comms key (the boxes of a sealed envelope are keyed by them), so presenting one proves
/// nothing about who holds the share. So:
/// - a record with no seat and no write key (it registered for sealing only, or is a legacy flat
///   entry) may gain its seat and key once;
/// - a record already bound keeps its seat and its key for good: the same pair is a no-op, any other
///   is a conflict, and a message with no write key at all (an older build re-sending its comms key)
///   changes nothing and conflicts with nothing;
/// - a seat held by ANOTHER comms key is a conflict, as it always was.
///
/// A rotation, if one is ever needed, must be signed by the key currently registered. An unreadable
/// registry is never written to: starting from empty would drop every other seat's key.
pub fn upsert_device(
    vaults_dir: &Path,
    vault: &str,
    comms: &str,
    write: Option<(u16, &str)>,
) -> Result<bool, DeviceError> {
    let comms = comms.trim();
    let mut recs = load_device_records(vaults_dir, vault).map_err(DeviceError::Unreadable)?;

    if let Some((seat, _)) = write {
        if recs
            .iter()
            .any(|r| r.seat == Some(seat) && !same_key(&r.comms, comms))
        {
            return Err(DeviceError::Conflict(
                "this seat is already registered to another device".into(),
            ));
        }
    }

    let mut changed = false;
    match recs.iter_mut().find(|r| same_key(&r.comms, comms)) {
        Some(existing) => {
            if let Some((seat, wk)) = write {
                let wk = wk.trim();
                let bound = existing.seat.is_some() || existing.write.is_some();
                if !bound {
                    existing.seat = Some(seat);
                    existing.write = Some(wk.to_string());
                    changed = true;
                } else if existing.seat != Some(seat) || existing.write.as_deref() != Some(wk) {
                    return Err(DeviceError::Conflict(
                        "this device is already registered and its registration cannot be changed"
                            .into(),
                    ));
                }
            }
        }
        None => {
            recs.push(DeviceRecord {
                comms: comms.to_string(),
                seat: write.map(|(s, _)| s),
                write: write.map(|(_, w)| w.trim().to_string()),
            });
            changed = true;
        }
    }
    if !changed {
        return Ok(false); // idempotent no-op
    }

    let path = device_keys_path(vaults_dir, vault);
    let dir = vaults_dir.join(vault);
    std::fs::create_dir_all(&dir).map_err(|e| DeviceError::Io(ToolError::Io(e)))?;
    let json = serde_json::to_string(&recs)
        .map_err(|e| DeviceError::Io(ToolError::parse("device-keys", e.to_string())))?;
    write_device_registry(&path, &dir, json.as_bytes())
        .map_err(|e| DeviceError::Io(ToolError::Io(e)))?;
    Ok(true)
}

/// The registry is replaced whole or not at all ([`replace_file`]): a write cut half way must not
/// leave a file that reads as "no write keys".
fn write_device_registry(path: &Path, dir: &Path, bytes: &[u8]) -> std::io::Result<()> {
    write_device_registry_with(path, dir, bytes, write_synced)
}

fn write_device_registry_with(
    path: &Path,
    dir: &Path,
    bytes: &[u8],
    write_tmp: impl Fn(&Path, &[u8]) -> std::io::Result<()>,
) -> std::io::Result<()> {
    replace_file(path, dir, bytes, write_tmp)?;
    sync_dir(dir)
}

fn write_nonces_path(vaults_dir: &Path, vault: &str) -> PathBuf {
    vaults_dir.join(vault).join("write-nonces.json")
}

/// Has this vault already accepted `nonce` on a governance write (#288)?
///
/// A signature is bound to its nonce, so accepting the same one twice is accepting the same write
/// twice - which is how a captured approve becomes two approves. Reading the file every time is
/// deliberate: the helper serves requests from a worker pool, so an in-memory set would be per
/// worker and a replay could simply land on a different one.
pub fn write_nonce_seen(vaults_dir: &Path, vault: &str, nonce: &str) -> bool {
    load_write_nonces(vaults_dir, vault)
        .iter()
        .any(|n| n == nonce)
}

fn load_write_nonces(vaults_dir: &Path, vault: &str) -> Vec<String> {
    std::fs::read_to_string(write_nonces_path(vaults_dir, vault))
        .ok()
        .and_then(|j| serde_json::from_str::<Vec<String>>(&j).ok())
        .unwrap_or_default()
}

/// Record `nonce` as used. Best-effort by design: the caller has already verified the signature,
/// and a write that succeeds but fails to burn its nonce is a replay window, not a lost vote - so
/// it must never fail the vote itself. Bounded, so a vault cannot be grown without limit by an
/// attacker who can reach the endpoint: the oldest entries fall off.
pub fn burn_write_nonce(vaults_dir: &Path, vault: &str, nonce: &str) -> Result<(), ToolError> {
    burn_write_nonce_with(vaults_dir, vault, nonce, write_synced)
}

fn burn_write_nonce_with(
    vaults_dir: &Path,
    vault: &str,
    nonce: &str,
    write_tmp: impl Fn(&Path, &[u8]) -> std::io::Result<()>,
) -> Result<(), ToolError> {
    const KEEP: usize = 2_000;
    let mut nonces = load_write_nonces(vaults_dir, vault);
    if nonces.iter().any(|n| n == nonce) {
        return Ok(());
    }
    nonces.push(nonce.to_string());
    if nonces.len() > KEEP {
        let drop = nonces.len() - KEEP;
        nonces.drain(0..drop);
    }
    let path = write_nonces_path(vaults_dir, vault);
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent).map_err(ToolError::Io)?;
    }
    let json = serde_json::to_string(&nonces)
        .map_err(|e| ToolError::parse("write-nonces", e.to_string()))?;
    // The temporary lives in the vault's directory and is renamed over the file: a write that is cut
    // leaves the old file whole.
    replace_file(&path, &vaults_dir.join(vault), json.as_bytes(), write_tmp).map_err(ToolError::Io)
}

fn read_key_path(vaults_dir: &Path, vault: &str) -> PathBuf {
    vaults_dir.join(vault).join("read-key.json")
}

/// The vault's registered read token (hex of `readKey = HKDF(S, "read")`), or `None`. It flattens
/// "no key" and "a key file that cannot be read" into one answer, so it exists for this crate's tests
/// only: the coordinator decides through [`read_key_state`] and [`read_authorized`].
#[cfg(test)]
pub fn load_read_key(vaults_dir: &Path, vault: &str) -> Option<String> {
    match read_key_state(vaults_dir, vault) {
        ReadKey::Set(key) => Some(key),
        ReadKey::Absent | ReadKey::Unreadable => None,
    }
}

/// What a vault's `read-key.json` says. The three answers stay apart, like [`WriteGate`]: a file
/// that is there and cannot be read must not be read as "no key", which is an open vault.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ReadKey {
    /// No file: the vault has not migrated to #388 and reads are open (per-vault compat).
    Absent,
    /// A key is registered.
    Set(String),
    /// The file is there and is not a key (cannot be opened, is empty, is not a JSON string).
    Unreadable,
}

/// The ONE place that decides absent, set or unreadable for a vault's read key.
pub fn read_key_state(vaults_dir: &Path, vault: &str) -> ReadKey {
    match std::fs::read_to_string(read_key_path(vaults_dir, vault)) {
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => ReadKey::Absent,
        Err(_) => ReadKey::Unreadable,
        Ok(json) => match serde_json::from_str::<String>(&json) {
            Ok(key) if !key.trim().is_empty() => ReadKey::Set(key),
            _ => ReadKey::Unreadable,
        },
    }
}

/// Register (or replace) the vault's read token. Called once at migration; from then on every read
/// must present exactly this value. This is a shared access secret (members + helper), not spendable
/// material - it gates WHO may ask the helper, and does not change that the helper is view-only.
pub fn set_read_key(vaults_dir: &Path, vault: &str, read_key: &str) -> Result<(), ToolError> {
    set_read_key_with(vaults_dir, vault, read_key, write_synced)
}

fn set_read_key_with(
    vaults_dir: &Path,
    vault: &str,
    read_key: &str,
    write_tmp: impl Fn(&Path, &[u8]) -> std::io::Result<()>,
) -> Result<(), ToolError> {
    let path = read_key_path(vaults_dir, vault);
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent).map_err(ToolError::Io)?;
    }
    let json = serde_json::to_string(read_key.trim())
        .map_err(|e| ToolError::parse("read-key", e.to_string()))?;
    // The temporary lives in the vault's directory and is renamed over the file: a write that is cut
    // leaves the old file whole.
    replace_file(&path, &vaults_dir.join(vault), json.as_bytes(), write_tmp).map_err(ToolError::Io)
}

/// Is this read authorized? A vault with no registered readKey is OPEN (pre-#388 compat). Once a
/// readKey is set, the read must present exactly it, compared in constant time so a guess learns
/// nothing from timing. A key file that is there and cannot be read refuses every read.
pub fn read_authorized(vaults_dir: &Path, vault: &str, presented: Option<&str>) -> bool {
    match read_key_state(vaults_dir, vault) {
        ReadKey::Absent => true, // not migrated: the gate is open
        // A key file that cannot be read refuses, as an unreadable device registry does.
        ReadKey::Unreadable => false,
        ReadKey::Set(expected) => {
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
/// taken by a DIFFERENT seat, compared the way votes are matched ([`same_member`]), nor recorded on
/// a payment under no seat; renaming a seat to its own current name is a no-op, allowed. Returns
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
    let taken = || ToolError::parse("members", "that name is already taken");
    // Taken is decided the way votes are matched (#575). By exact string, `"bob"` was free beside
    // a roster entry `"bob "`, and the member who took it then replaced bob's vote with each of
    // their own.
    if names.iter().any(|n| same_member(n, new) && n != old) {
        return Err(taken());
    }
    let proposals = list_proposals(vaults_dir, vault, now);
    // And a name a payment already records, under no seat, is taken too: it was planted while the
    // vault took unsigned writes, or left by an earlier spelling. Taking it would make its votes,
    // and its proposals, read as this member's - who never cast them (#575). A respelling of the
    // member's own name is theirs.
    if !same_member(old, new)
        && proposals.iter().any(|p| {
            std::iter::once(&p.proposer)
                .chain(&p.approvals)
                .chain(&p.refusals)
                .any(|n| same_member(n, new))
        })
    {
        return Err(ToolError::parse(
            "members",
            "that name is already recorded on a payment",
        ));
    }
    if old == new {
        return Ok(names); // no-op rename
    }
    // When another seat's name differs from this one only at the edges, an entry under either
    // could be either seat's. Identical names are renamed together below, so they are one name.
    let twin = names.iter().any(|n| same_member(n, old) && n != old);
    for n in names.iter_mut() {
        if n == old {
            *n = new.to_string();
        }
    }
    save_members(vaults_dir, vault, &names)?;

    // Migrate the name everywhere a vote references it, so quorum counting and the approvals list
    // stay coherent (no orphaned approval under the old name, no duplicate row for the new one).
    for mut p in proposals {
        let before = p.clone();
        if p.state == "sent" || p.state == "expired" {
            // A sent or expired payment is a record of what happened: the name moves, exactly as
            // it always did, and nothing is merged or removed.
            for n in std::iter::once(&mut p.proposer)
                .chain(p.approvals.iter_mut())
                .chain(p.refusals.iter_mut())
            {
                if n == old {
                    *n = new.to_string();
                }
            }
        } else if twin {
            // An approval under the shared name could be either seat's: carried, it could become
            // the renamed seat's while the other approves again, one member reading as two. It is
            // dropped, which only lowers the count, and both approve again. A refusal moves only
            // under this seat's exact spelling and is never dropped: dropping one could reopen a
            // payment the group refused, and moving one never adds an approval. The proposer is
            // left as recorded.
            p.approvals.retain(|a| !same_member(a, old));
            for r in p.refusals.iter_mut().filter(|r| *r == old) {
                *r = new.to_string();
            }
            p.recompute(now, &names);
        } else {
            if same_member(&p.proposer, old) {
                p.proposer = new.to_string();
            }
            carry_votes(&mut p.approvals, old, new);
            carry_votes(&mut p.refusals, old, new);
            // Counted against the roster as it now reads, with the votes now under the new name.
            p.recompute(now, &names);
        }
        if p != before {
            save_proposal(vaults_dir, &p)?;
        }
    }
    Ok(names)
}

/// One list of votes on a payment not yet decided by the clock or the chain, after `old` is renamed
/// to `new`: the member's entries, under whatever spelling they were recorded, become one entry
/// under `new`.
fn carry_votes(list: &mut Vec<String>, old: &str, new: &str) {
    let mut carried = false;
    list.retain_mut(|entry| {
        if !same_member(entry, old) {
            return true;
        }
        if carried {
            return false;
        }
        *entry = new.to_string();
        carried = true;
        true
    });
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
    /// The creation protocol (`cp`) the client that registered this vault declared, recorded ONCE at
    /// the registration that created the record and never overwritten by a later one (a known key
    /// registered again keeps what it had: the first registration is the one that made the vault).
    /// `None` on a record written before the field existed, and on one a client registered without
    /// it while the coordinator did not yet require it. It is self-declared - a modified client can
    /// send any number - so it is a record of what the client said, not proof of what it did.
    #[serde(default)]
    pub cp: Option<u32>,
    /// When this coordinator first registered the vault, in unix seconds. `registration.json`'s own
    /// file time is only "last written" (backfills and migrations rewrite the file), so it cannot
    /// say when a vault was created; this can, for every vault registered from now on.
    #[serde(default)]
    pub created_at_unix: Option<u64>,
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
    save_registration_with(vaults_dir, reg, write_synced)
}

fn save_registration_with(
    vaults_dir: &Path,
    reg: &VaultRegistration,
    write_tmp: impl Fn(&Path, &[u8]) -> std::io::Result<()>,
) -> Result<(), ToolError> {
    let path = registration_path(vaults_dir, &reg.vault_id);
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent).map_err(ToolError::Io)?;
    }
    let json =
        serde_json::to_string(reg).map_err(|e| ToolError::parse("registration", e.to_string()))?;
    // The temporary lives in the vault's directory and is renamed over the file: a write that is cut
    // leaves the old file whole.
    replace_file(
        &path,
        &vaults_dir.join(&reg.vault_id),
        json.as_bytes(),
        write_tmp,
    )
    .map_err(ToolError::Io)
}

/// What the volume says about a vault's registration. THREE states, because "there is none" and
/// "there is one and it cannot be read" are different facts: treating them alike let an unreadable
/// `registration.json` (a truncated write, an old non-atomic one) be overwritten by a NEW identity
/// for the vault, which destroys the only record of its address and viewing key.
#[derive(Debug)]
pub enum StoredRegistration {
    Loaded(VaultRegistration),
    /// No `registration.json` at all.
    Absent,
    /// Something is there and it is not a registration this build can read.
    Unreadable,
}

/// The ONE reader of `registration.json`: [`load_registration`], the registration guard and the boot
/// listings all ask this, so "no registration" means the same thing in each.
pub fn stored_registration(vaults_dir: &Path, group_key: &str) -> StoredRegistration {
    match std::fs::read_to_string(registration_path(vaults_dir, group_key)) {
        Ok(json) => match serde_json::from_str(&json) {
            Ok(reg) => StoredRegistration::Loaded(reg),
            Err(_) => StoredRegistration::Unreadable,
        },
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => StoredRegistration::Absent,
        Err(_) => StoredRegistration::Unreadable,
    }
}

/// Load a single persisted registration if present (used to make [`register_vault`] idempotent and
/// its address stable across restarts). Returns `None` when the file is absent or unreadable; a
/// caller that has to tell those apart asks [`stored_registration`].
pub fn load_registration(vaults_dir: &Path, group_key: &str) -> Option<VaultRegistration> {
    match stored_registration(vaults_dir, group_key) {
        StoredRegistration::Loaded(reg) => Some(reg),
        _ => None,
    }
}

/// Record the wallet birthday on every registration that is missing one, reading it from the
/// vault's own `wallet/keys.toml`. Returns how many were filled.
///
/// This exists because the number is **only** in `keys.toml`, and the documented ops backup
/// excludes `wallet/` (#434). Until it is copied into `registration.json` - the half that IS backed
/// up - a vault that loses its volume cannot have its wallet rebuilt at the right height, and there
/// is no rescan to fix that afterwards.
///
/// Run at BOOT rather than only when a vault is re-registered. `register_vault` backfills too, but
/// it is reached only when a browser registers again, which for a long-lived vault may be never -
/// so relying on it alone would be a migration that mostly does not run.
///
/// Safe to run against a live volume: it only ever ADDS a field to a registration that lacks it,
/// never touches `wallet/`, never rewrites one that already has a birthday, and is idempotent. A
/// vault whose wallet dir is gone is left alone - there is nothing to read, and inventing a height
/// would be worse than leaving the field absent.
pub fn backfill_birthdays(vaults_dir: &Path) -> usize {
    let mut n = 0;
    for mut reg in load_registrations(vaults_dir) {
        if reg.birthday.is_some() {
            continue;
        }
        let Some(b) = read_wallet_birthday(Path::new(&reg.wallet_dir)) else {
            log_vault(
                &reg.vault_id,
                "no birthday to record (no readable keys.toml); a rebuilt wallet would scan from now",
            );
            continue;
        };
        reg.birthday = Some(b);
        match save_registration(vaults_dir, &reg) {
            Ok(()) => {
                log_vault(&reg.vault_id, &format!("birthday {b} recorded"));
                n += 1;
            }
            Err(e) => log_vault(
                &reg.vault_id,
                &format!(
                    "could not record birthday ({:?}); retried at the next boot",
                    tool_error_kind(&e)
                ),
            ),
        }
    }
    n
}

/// Record the change receiver on every registration missing one, deriving it from that vault's own
/// UFVK (#476).
///
/// It exists for the same reason [`backfill_birthdays`] does, and against the same trap:
/// `register_vault` computes this field, but `register_vault` runs only when a browser registers.
/// For a vault that has been alive for weeks that may be never - so every vault on the production
/// volume still carries an empty one, and the #281 money gate has nothing to compare a device's
/// change against.
///
/// Safe on a live volume: it only ever ADDS the field to a registration that lacks it, never
/// rewrites one that has it, and is idempotent. A UFVK that does not decode is LEFT EMPTY on
/// purpose - an empty value means "unknown", which a device already treats as "do not judge",
/// while a wrong receiver would make the gate refuse the vault's own change.
pub fn backfill_change_receivers(vaults_dir: &Path, network: &str) -> usize {
    let mut n = 0;
    for mut reg in load_registrations(vaults_dir) {
        if !reg.change_receiver.is_empty() {
            continue;
        }
        let receiver = match change_receiver(&reg.ufvk, network) {
            Ok(r) => r,
            Err(e) => {
                log_vault(
                    &reg.vault_id,
                    &format!(
                        "no change receiver to record ({e:?}); the money gate stays unable to judge this vault's change"
                    ),
                );
                continue;
            }
        };
        reg.change_receiver = receiver;
        match save_registration(vaults_dir, &reg) {
            Ok(()) => {
                log_vault(&reg.vault_id, "change receiver recorded");
                n += 1;
            }
            Err(e) => log_vault(
                &reg.vault_id,
                &format!(
                    "could not record the change receiver ({:?}); retried at the next boot",
                    tool_error_kind(&e)
                ),
            ),
        }
    }
    n
}

/// What a booting helper needs from its volume: the registrations, with every migration ALREADY
/// applied (#482).
///
/// The order is the whole point, and getting it wrong is invisible. `main` used to seed the
/// in-memory registry from disk and then run the backfills, so the backfills corrected the FILES
/// while the running process kept serving the values it had already read - `/api/vault` returned an
/// empty change receiver and `/api/vault/ufvk` a null birthday, for the entire life of that
/// process, after a log line that said "recorded". It self-healed on the next restart, which is the
/// worst kind of bug: it looks fixed by the time anyone looks.
///
/// Fixing it by moving two lines in `main` would leave the next person free to move them back. This
/// makes the order a property of a function with a test in front of it.
pub fn boot_registry(vaults_dir: &Path, network: &str) -> (Vec<VaultRegistration>, usize, usize) {
    let birthdays = backfill_birthdays(vaults_dir);
    let receivers = backfill_change_receivers(vaults_dir, network);
    (load_registrations(vaults_dir), birthdays, receivers)
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
///
/// A registration that cannot be RECORDED is not a registration: the address in the answer would not
/// survive a restart (the identity is minted at random and cannot be derived again), so it fails
/// with [`RegisterError::NotPersisted`] and nothing is served. This used to discard the write's
/// result.
///
/// The caller serialises registrations of ONE vault: the coordinator's `serve` takes that vault's
/// write lock for a `POST /api/vault` that will reach this function, and answers the second request
/// from the registry the first one filled. The set-aside below relies on it ("this call created that
/// wallet"): two unserialised calls would let the loser, whose `init-fvk` is refused, move the
/// winner's wallet away.
pub fn register_vault(
    cfg: &HelperConfig,
    group_key: &str,
    name: &str,
    threshold: u16,
    total: u16,
    cp: Option<u32>,
) -> Result<VaultRegistration, RegisterError> {
    register_vault_with(
        cfg,
        group_key,
        name,
        threshold,
        total,
        cp,
        write_synced,
        |from, to| std::fs::rename(from, to),
    )
}

/// [`register_vault`] with the two things the volume can refuse as parameters (the write of the
/// registration's temporary file, and the rename that sets a wallet directory aside), so each failure
/// can be driven through every path that makes one.
#[allow(clippy::too_many_arguments)]
fn register_vault_with(
    cfg: &HelperConfig,
    group_key: &str,
    name: &str,
    threshold: u16,
    total: u16,
    cp: Option<u32>,
    write_tmp: impl Fn(&Path, &[u8]) -> std::io::Result<()>,
    rename: impl Fn(&Path, &Path) -> std::io::Result<()>,
) -> Result<VaultRegistration, RegisterError> {
    if !is_valid_group_key(group_key) {
        return Err(ToolError::parse(
            "helper",
            format!(
                "group key must be 64 hex chars, got {} chars",
                group_key.len()
            ),
        )
        .into());
    }
    // Persisted-registration shortcut: if this vault was registered before (surviving a restart),
    // return the STORED registration - no re-derivation, so the address stays stable and the
    // heavy wallet init is not repeated.
    let stored = stored_registration(&cfg.vaults_dir, group_key);
    if let StoredRegistration::Loaded(mut reg) = stored {
        // Backfill the birthday for a vault registered before the field existed (#434). The number
        // lives only in `wallet/keys.toml`, which the documented ops backup EXCLUDES, so a vault
        // that loses its volume before this runs cannot have its wallet rebuilt correctly. Reading
        // it here captures it into the half that IS backed up, on the next registration touch.
        // Idempotent, and it never fails a registration: the record that is served is the one that
        // was read, and a birthday that cannot be written is tried again by the boot backfill.
        if reg.birthday.is_none() {
            if let Some(b) = read_wallet_birthday(Path::new(&reg.wallet_dir)) {
                reg.birthday = Some(b);
                match record_birthday_with(&cfg.vaults_dir, &reg, &write_tmp) {
                    Ok(()) => log_vault(group_key, &format!("birthday {b} recorded from keys.toml")),
                    Err(kind) => log_vault(
                        group_key,
                        &format!(
                            "birthday {b} read from keys.toml but not recorded ({kind:?}); retried at the next boot"
                        ),
                    ),
                }
            }
        }
        return Ok(reg);
    }
    // Three refusals, all BEFORE the engine runs, so that nothing new is created:
    //
    // - a `registration.json` that is there and cannot be read. It is the only record of that
    //   vault's address and viewing key, and a new registration would write over it with a new
    //   identity. It is not touched (docs/RECOVERY.md, I).
    // - a wallet directory already in place with no registration. The engine refuses it itself
    //   (`init-fvk` opens `keys.toml` with `create_new(true)`), and as a 502 that would read as the
    //   request's fault for ever. It is NOT moved: it may be the only copy of the viewing key of a
    //   vault this coordinator served before the write was checked (docs/RECOVERY.md, I).
    // - three wallet directories already set aside for this vault, so a volume that cannot take a
    //   registration does not also grow by one directory per attempt.
    if matches!(stored, StoredRegistration::Unreadable) {
        log_vault(
            group_key,
            "registration refused: a registration is in place and cannot be read; it is not touched (docs/RECOVERY.md, I)",
        );
        return Err(RegisterError::CleanupFailed);
    }
    let wallet_dir = wallet_dir_for(&cfg.vaults_dir, group_key);
    if in_the_way(Path::new(&wallet_dir)) {
        log_vault(
            group_key,
            "registration refused: a wallet directory is in place with no registration; it is not touched (docs/RECOVERY.md, I)",
        );
        return Err(RegisterError::CleanupFailed);
    }
    let left = unpersisted_leftovers(&cfg.vaults_dir.join(group_key));
    if left >= MAX_UNPERSISTED_LEFTOVERS {
        log_vault(
            group_key,
            &format!(
                "registration refused: {left} wallet directories from earlier attempts are still in place; an operator has to clear them (docs/RECOVERY.md, I)"
            ),
        );
        return Err(RegisterError::CleanupFailed);
    }
    let (address, ufvk) = derive_identity(&cfg.zcash_sign, group_key, &cfg.network)?;
    // From here on the engine writes a wallet. Whatever stops it part way (the volume filling up
    // under the SQLite file is the likely one) must not leave that directory where the next attempt's
    // `init-fvk` trips on it, so a failure sets it aside like a failed write does. It is safe to move:
    // the check above proved this call is the one that created it.
    let account = match build_view_wallet(cfg, &wallet_dir, name, &ufvk) {
        Ok(account) => account,
        Err(e) => {
            let out_of_the_way = set_aside_logged(
                group_key,
                &wallet_dir,
                &format!("the engine failed ({:?})", tool_error_kind(&e)),
                &rename,
            );
            // The same answer as a failed write: when the directory could not be moved, the next
            // attempt cannot work until an operator acts, and the request is not what is wrong.
            return Err(if out_of_the_way {
                RegisterError::Engine(e)
            } else {
                RegisterError::CleanupFailed
            });
        }
    };
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
            log_vault(
                group_key,
                &format!("no change receiver derived ({e:?}); its money gate stays unarmed"),
            );
            String::new()
        }
    };
    // Read back what `init-fvk` actually used, rather than assuming the default it computes. This
    // is the number a rebuilt wallet has to be given, and `registration.json` is the half of a
    // vault that gets backed up (#434).
    let birthday = read_wallet_birthday(Path::new(&wallet_dir));
    if birthday.is_none() {
        log_vault(
            group_key,
            "no birthday read from keys.toml; a rebuilt wallet would scan from now",
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
        cp,
        created_at_unix: registration_time(now_secs()),
    };
    persist_new_registration_with(&cfg.vaults_dir, &reg, write_tmp, &rename)?;
    Ok(reg)
}

/// Build the vault's view-only wallet from its UFVK and read back its account.
fn build_view_wallet(
    cfg: &HelperConfig,
    wallet_dir: &str,
    name: &str,
    ufvk: &str,
) -> Result<String, ToolError> {
    run(
        &cfg.devtool,
        &[
            "wallet",
            "-w",
            wallet_dir,
            "init-fvk",
            "--name",
            name,
            "--fvk",
            ufvk,
            "-s",
            cfg.lightwalletd.as_str(),
            "--connection",
            "direct",
        ],
        None,
    )?;
    let listed = run_text_all(
        &cfg.devtool,
        &["wallet", "-w", wallet_dir, "list-addresses"],
        None,
    )?;
    parse_account_uuid(&listed)
}

/// Whether something is at `path`, or cannot be told not to be: a `stat` that fails for any reason
/// but "not found" counts as present, so a guard built on it fails closed, not open.
fn in_the_way(path: &Path) -> bool {
    match std::fs::symlink_metadata(path) {
        Ok(_) => true,
        Err(e) => e.kind() != std::io::ErrorKind::NotFound,
    }
}

/// Why a registration did not complete.
#[derive(Debug)]
pub enum RegisterError {
    /// The request, the key or the engine failed: nothing was recorded.
    Engine(ToolError),
    /// The identity was derived and the wallet built, but the registration could not be written.
    /// What the attempt created was set aside, so the same vault can be registered again.
    NotPersisted(ToolError),
    /// An operator has to act before another attempt can work: what a failed attempt left could not
    /// be set aside, three earlier attempts' leftovers are in place, or a wallet directory or an
    /// unreadable registration is there that is not this call's to touch.
    CleanupFailed,
}

impl From<ToolError> for RegisterError {
    fn from(e: ToolError) -> Self {
        RegisterError::Engine(e)
    }
}

/// What a person is told when the registration could not be saved. Plain, under the length the
/// screens show verbatim, and clear of the words they match on to classify a failure
/// (`SCREEN_KEYWORDS` in the helper server's tests); the operating-system text stays in the log.
pub const NOT_PERSISTED_TEXT: &str = "the vault could not be registered because its record could not be saved; nothing was created, try again in a moment";

/// What a person is told when an operator has to act before another attempt can work.
pub const CLEANUP_FAILED_TEXT: &str =
    "the vault could not be registered; the coordinator needs its operator before another attempt";

impl std::fmt::Display for RegisterError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            RegisterError::Engine(e) => write!(f, "{e}"),
            RegisterError::NotPersisted(_) => f.write_str(NOT_PERSISTED_TEXT),
            RegisterError::CleanupFailed => f.write_str(CLEANUP_FAILED_TEXT),
        }
    }
}

/// One log line about a vault: its 8-character prefix, never the id. EVERY line of the registration
/// path goes through this, so the rule has one implementation.
fn vault_log_line(vault_id: &str, what: &str) -> String {
    format!("vault {}: {what}", short_id(vault_id))
}

// Test builds can capture what a test makes the registration path log (per thread), so a test can
// say that no line carries a whole id, a path or the engine's text.
#[cfg(test)]
thread_local! {
    static LOG_SINK: std::cell::RefCell<Option<Vec<String>>> = const { std::cell::RefCell::new(None) };
}

fn log_vault(vault_id: &str, what: &str) {
    let line = vault_log_line(vault_id, what);
    #[cfg(test)]
    {
        let captured = LOG_SINK.with(|s| match s.borrow_mut().as_mut() {
            Some(lines) => {
                lines.push(line.clone());
                true
            }
            None => false,
        });
        if captured {
            return;
        }
    }
    eprintln!("{line}");
}

/// Write a birthday that was just read from `keys.toml` into the registration. A failure is
/// returned as its kind and never fails the registration; the boot backfill
/// ([`backfill_birthdays`]) retries it.
fn record_birthday_with(
    vaults_dir: &Path,
    reg: &VaultRegistration,
    write_tmp: impl Fn(&Path, &[u8]) -> std::io::Result<()>,
) -> Result<(), std::io::ErrorKind> {
    save_registration_with(vaults_dir, reg, write_tmp).map_err(|e| tool_error_kind(&e))
}

/// The kind of I/O failure behind a [`ToolError`], as the one word a log line may carry. Never the
/// message: free text, and the engine's own error text names the wallet's path, which holds the
/// whole vault id.
fn tool_error_kind(e: &ToolError) -> std::io::ErrorKind {
    match e {
        ToolError::Io(io) | ToolError::Spawn { source: io, .. } => io.kind(),
        _ => std::io::ErrorKind::Other,
    }
}

/// How many wallet directories a failed registration may leave for ONE vault before the next
/// attempt is refused.
const MAX_UNPERSISTED_LEFTOVERS: usize = 3;
const UNPERSISTED_PREFIX: &str = "wallet.unpersisted-";

/// The wallet directories earlier failed registrations of this vault set aside.
fn unpersisted_leftovers(vault_dir: &Path) -> usize {
    std::fs::read_dir(vault_dir)
        .map(|rd| {
            rd.flatten()
                .filter(|e| {
                    e.file_name()
                        .to_string_lossy()
                        .starts_with(UNPERSISTED_PREFIX)
                })
                .count()
        })
        .unwrap_or(0)
}

/// A name for a wallet directory being set aside that is not taken: `wallet.unpersisted-<stamp>`,
/// then `-1`, `-2`, ... for a second failure in the same second. A rename onto an existing
/// directory would fail, and a failure here is the one that blocks the vault.
fn free_aside_name(parent: &Path, stamp: u64) -> PathBuf {
    (0u32..)
        .map(|n| match n {
            0 => parent.join(format!("{UNPERSISTED_PREFIX}{stamp}")),
            n => parent.join(format!("{UNPERSISTED_PREFIX}{stamp}-{n}")),
        })
        .find(|p| !p.exists())
        .expect("an unbounded sequence has a free name")
}

/// Rename a wallet directory to a free `wallet.unpersisted-*` name next to it. `Ok(None)` when there
/// is no such directory, `Ok(Some(name))` when it was moved, the failure's kind otherwise. Nothing
/// is ever deleted.
fn set_wallet_aside(
    wallet: &Path,
    rename: impl Fn(&Path, &Path) -> std::io::Result<()>,
) -> Result<Option<String>, std::io::ErrorKind> {
    if !wallet.exists() {
        return Ok(None);
    }
    let parent = wallet.parent().unwrap_or_else(|| Path::new("."));
    let aside = free_aside_name(parent, now_secs());
    rename(wallet, &aside)
        .map(|()| {
            Some(
                aside
                    .file_name()
                    .and_then(|n| n.to_str())
                    .unwrap_or(UNPERSISTED_PREFIX)
                    .to_string(),
            )
        })
        .map_err(|e| e.kind())
}

/// [`set_wallet_aside`] with the ONE log line for it, used when an attempt fails after the engine
/// has started writing. Returns whether the directory is out of the way.
fn set_aside_logged(
    vault_id: &str,
    wallet_dir: &str,
    why: &str,
    rename: impl Fn(&Path, &Path) -> std::io::Result<()>,
) -> bool {
    match set_wallet_aside(Path::new(wallet_dir), rename) {
        Ok(None) => {
            log_vault(
                vault_id,
                &format!("registration not completed: {why}; no wallet directory to set aside"),
            );
            true
        }
        Ok(Some(name)) => {
            log_vault(vault_id, &format!("registration not completed: {why}; its wallet directory was set aside as {name}"));
            true
        }
        Err(kind) => {
            log_vault(vault_id, &format!("registration not completed: {why}; its wallet directory could NOT be set aside ({kind:?}) and blocks the next attempt until an operator moves it (docs/RECOVERY.md, I)"));
            false
        }
    }
}

/// Record a registration that was just created, or undo what creating it left behind.
///
/// When the write fails the vault must not be served, because the address in the answer would be
/// unrecoverable at the next restart. The wallet `init-fvk` just created is renamed to
/// `wallet.unpersisted-<unix>`: the engine refuses a directory that already holds a `keys.toml`
/// (`create_new(true)`), so leaving it would make every retry fail. Nothing is deleted, and nothing
/// that moves was ever served: [`register_vault_with`] refuses before the engine runs when a wallet
/// directory is already in place, so this call created that one.
///
/// ONE log line per failure, the vault by its 8-character prefix and the failure by its kind.
fn persist_new_registration_with(
    vaults_dir: &Path,
    reg: &VaultRegistration,
    write_tmp: impl Fn(&Path, &[u8]) -> std::io::Result<()>,
    rename: impl Fn(&Path, &Path) -> std::io::Result<()>,
) -> Result<(), RegisterError> {
    let e = match save_registration_with(vaults_dir, reg, write_tmp) {
        Ok(()) => return Ok(()),
        Err(e) => e,
    };
    let why = format!("its record was not written ({:?})", tool_error_kind(&e));
    if set_aside_logged(&reg.vault_id, &reg.wallet_dir, &why, rename) {
        Err(RegisterError::NotPersisted(e))
    } else {
        Err(RegisterError::CleanupFailed)
    }
}

/// Vault directories that need an operator's eye, by 8-character prefix: `.0` hold a `wallet/` and
/// NO registration (a vault this coordinator served before a failed write stopped being served would
/// look like this, its key in that wallet and nowhere else on the coordinator, and so would a failed
/// attempt that was not set aside); `.1` hold a registration that cannot be read. Nothing is touched;
/// this only says it is there. Both ask [`stored_registration`], the same reader the registration
/// guard uses.
pub fn registrations_needing_attention(vaults_dir: &Path) -> (Vec<String>, Vec<String>) {
    let (mut orphans, mut unreadable) = (Vec::new(), Vec::new());
    if let Ok(rd) = std::fs::read_dir(vaults_dir) {
        for e in rd.flatten() {
            let Some(name) = e.file_name().to_str().map(str::to_string) else {
                continue;
            };
            if !is_valid_group_key(&name) {
                continue;
            }
            match stored_registration(vaults_dir, &name) {
                StoredRegistration::Absent if e.path().join("wallet").is_dir() => {
                    orphans.push(short_id(&name).to_string());
                }
                StoredRegistration::Unreadable => unreadable.push(short_id(&name).to_string()),
                _ => {}
            }
        }
    }
    orphans.sort();
    unreadable.sort();
    (orphans, unreadable)
}

/// The time a registration is recorded as made. `now_secs()` is 0 when the clock cannot be read,
/// which is not a time: record nothing rather than a false date.
fn registration_time(now: u64) -> Option<u64> {
    (now > 0).then_some(now)
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
    // Built from the address bytes with `zcash_address`, not `UnifiedAddress::from_receivers`: that
    // constructor takes a different set of arguments depending on which pools other crates of the
    // workspace switch on (and, since zcash_keys 0.17, an expiry), so one call would not compile
    // under every feature set. This is the plain Revision 0 `u1` address, as before.
    use zcash_address::unified::{Address as Ua, Encoding, Receiver, Revision, Uitem};
    let ua = Ua::try_from_items(
        Revision::R0,
        vec![Uitem::Data(Receiver::Orchard(addr.to_raw_address_bytes()))],
    )
    .map_err(|_| {
        ToolError::parse(
            "change_receiver",
            "the change receiver is not a valid UA".to_string(),
        )
    })?;
    Ok(
        ua.encode(&zcash_protocol::consensus::Parameters::network_type(
            &params,
        )),
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
            .unwrap_or_else(|e| e.into_inner())
            .insert(reg.vault_id.clone(), reg);
    }

    /// The registration for a vault, if registered.
    pub fn get(&self, vault_id: &str) -> Option<VaultRegistration> {
        self.vaults
            .lock()
            .unwrap_or_else(|e| e.into_inner())
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
            .unwrap_or_else(|e| e.into_inner())
            .contains_key(vault_id)
    }

    pub fn len(&self) -> usize {
        self.vaults.lock().unwrap_or_else(|e| e.into_inner()).len()
    }

    pub fn is_empty(&self) -> bool {
        self.vaults
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .is_empty()
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

    /// A real, decodable mainnet UFVK, so `change_receiver` has something to derive from.
    const UFVK_FOR_BOOT: &str = "uview1z2nst9y9367acqqykyws80hrc3df87ffnwvtvx3ggf3tvx342sncxxfztdgfk67a0xk4c0wptspqyc4k59ucqrtxgdka96ktjudm5gr65d8aaq6js0jpwrfryrafzu82axyezm9e6y5r96z7hk8a04zpvs5896xeze9pmpwwymh5h7xeae79wscp2c08j";

    /// #482. The backfills must run BEFORE the registry is read, or the process serves the values
    /// it loaded first and the correction only appears after a restart - having already logged that
    /// it happened.
    #[test]
    fn boot_returns_registrations_with_the_backfills_already_applied() {
        let dir = std::env::temp_dir().join(format!("konclave-boot-{}", std::process::id()));
        std::fs::remove_dir_all(&dir).ok();
        std::fs::create_dir_all(&dir).unwrap();

        let id = "a".repeat(64);
        let mut r = reg(&id);
        r.birthday = None;
        r.change_receiver = String::new();
        r.ufvk = UFVK_FOR_BOOT.to_string();
        r.wallet_dir = dir
            .join(format!("{id}/wallet"))
            .to_string_lossy()
            .into_owned();
        std::fs::create_dir_all(&r.wallet_dir).unwrap();
        std::fs::write(
            Path::new(&r.wallet_dir).join("keys.toml"),
            "network = \"main\"\nbirthday = 3459814\n",
        )
        .unwrap();
        save_registration(&dir, &r).unwrap();

        let (regs, birthdays, receivers) = boot_registry(&dir, "main");
        assert_eq!((birthdays, receivers), (1, 1), "both migrations ran");
        let got = regs.iter().find(|x| x.vault_id == id).expect("loaded");
        assert_eq!(
            got.birthday,
            Some(3_459_814),
            "the registry a booting helper serves already HAS the birthday"
        );
        assert!(
            !got.change_receiver.is_empty(),
            "and the change receiver, rather than only the file on disk"
        );

        std::fs::remove_dir_all(&dir).ok();
    }

    /// The boot backfill (#434). It runs against the live production volume, so what matters as
    /// much as filling the field is everything it must NOT do.
    #[test]
    fn the_boot_backfill_fills_only_what_is_missing_and_leaves_the_rest_alone() {
        let dir = std::env::temp_dir().join(format!("konclave-bf-{}", std::process::id()));
        std::fs::remove_dir_all(&dir).ok();

        // Three vaults: one to fill, one already recorded, one whose wallet dir is gone.
        let (id_a, id_b, id_c) = ("a".repeat(64), "b".repeat(64), "c".repeat(64));
        let mut to_fill = reg(&id_a);
        to_fill.birthday = None;
        to_fill.wallet_dir = dir
            .join(format!("{id_a}/wallet"))
            .to_string_lossy()
            .into_owned();
        std::fs::create_dir_all(&to_fill.wallet_dir).unwrap();
        std::fs::write(
            Path::new(&to_fill.wallet_dir).join("keys.toml"),
            "network = \"main\"\nbirthday = 3459814\n",
        )
        .unwrap();

        let mut already = reg(&id_b);
        already.birthday = Some(111);
        already.wallet_dir = dir
            .join(format!("{id_b}/wallet"))
            .to_string_lossy()
            .into_owned();
        std::fs::create_dir_all(&already.wallet_dir).unwrap();
        std::fs::write(
            Path::new(&already.wallet_dir).join("keys.toml"),
            "network = \"main\"\nbirthday = 999\n",
        )
        .unwrap();

        let mut no_wallet = reg(&id_c);
        no_wallet.birthday = None;
        no_wallet.wallet_dir = dir
            .join(format!("{id_c}/wallet"))
            .to_string_lossy()
            .into_owned();

        for r in [&to_fill, &already, &no_wallet] {
            save_registration(&dir, r).unwrap();
        }

        assert_eq!(backfill_birthdays(&dir), 1, "only the one that was missing");

        let after = |id: &str| load_registration(&dir, id).expect("still loads");
        assert_eq!(
            after(&id_a).birthday,
            Some(3_459_814),
            "read from keys.toml"
        );
        assert_eq!(
            after(&id_b).birthday,
            Some(111),
            "an existing birthday is never rewritten, even when keys.toml disagrees"
        );
        assert_eq!(
            after(&id_c).birthday,
            None,
            "no wallet to read: leave it absent rather than invent a height"
        );
        // And nothing else about a registration is disturbed.
        assert_eq!(after(&id_a).ufvk, to_fill.ufvk);
        assert_eq!(after(&id_a).address, to_fill.address);

        // Idempotent: a second boot fills nothing and changes nothing.
        assert_eq!(backfill_birthdays(&dir), 0);
        assert_eq!(after(&id_a).birthday, Some(3_459_814));

        std::fs::remove_dir_all(&dir).ok();
    }

    /// ADR-0011 D4: the write key rides in the record that already exists, so there is never a
    /// second answer to "which device belongs to this vault". These cover the migration and the
    /// one place an attacker would push.
    /// The registry of vaults is shared by every request. A failure while one holds its lock must
    /// leave it usable for the next, as the vault locks are.
    #[test]
    fn the_registry_of_vaults_is_usable_after_a_failure_while_it_was_locked() {
        let st = HelperState::new();
        let failed = std::thread::scope(|scope| {
            scope
                .spawn(|| {
                    let _held = st.vaults.lock().unwrap();
                    panic!("a failure while the registry is locked");
                })
                .join()
        });
        assert!(failed.is_err());
        assert!(st.is_empty());
        assert_eq!(st.len(), 0);
        assert!(!st.contains("nobody"));
        assert!(st.get("nobody").is_none());
    }

    #[test]
    fn the_live_flat_device_key_file_still_reads() {
        // Every vault on the volume today carries `["hex", "hex"]`. If this stopped reading, the
        // #63 seal-set would come back empty and SignRequests would silently go out UNSEALED.
        let dir = std::env::temp_dir().join(format!("konclave-dev-flat-{}", std::process::id()));
        let v = "a".repeat(64);
        std::fs::create_dir_all(dir.join(&v)).unwrap();
        std::fs::write(dir.join(&v).join("device-keys.json"), r#"["aabb","ccdd"]"#).unwrap();

        assert_eq!(load_device_keys(&dir, &v).unwrap(), vec!["aabb", "ccdd"]);
        let recs = load_device_records(&dir, &v).unwrap();
        assert_eq!(recs.len(), 2);
        assert_eq!(recs[0].seat, None, "a flat entry has no seat");
        assert_eq!(recs[0].write, None, "and no write key - which is the truth");
        assert!(
            load_write_keys(&dir, &v).unwrap().is_empty(),
            "so the vault stays on the fail-open path, not frozen"
        );
        std::fs::remove_dir_all(&dir).ok();
    }

    /// An entry that is not a key stays in the registry (taking it out would make a signed send go
    /// out unsealed) and is counted, so the boot log can name the vault.
    #[test]
    fn registry_entries_that_are_not_keys_are_counted_and_kept() {
        let dir = std::env::temp_dir().join(format!("konclave-dev-bad-{}", std::process::id()));
        let v = "c".repeat(64);
        std::fs::create_dir_all(dir.join(&v)).unwrap();
        let good = "ab".repeat(32);
        let file = format!(
            r#"["{good}","aabb","{}","{}","{}","{}"]"#,
            "€".repeat(32),
            "zz".repeat(32),
            "00".repeat(32),
            good.to_uppercase()
        );
        std::fs::write(dir.join(&v).join("device-keys.json"), file).unwrap();

        assert_eq!(
            unusable_device_keys(&dir, &v),
            4,
            "short, non-ASCII, not hex, and a key of small order"
        );
        assert_eq!(
            load_device_keys(&dir, &v).unwrap().len(),
            6,
            "every entry is still a registered device"
        );
        assert_eq!(unusable_device_keys(&dir, "no-such-vault"), 0);
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn a_write_key_attaches_to_the_device_and_leaves_the_comms_set_intact() {
        let dir = std::env::temp_dir().join(format!("konclave-dev-up-{}", std::process::id()));
        let v = "b".repeat(64);
        std::fs::create_dir_all(dir.join(&v)).unwrap();
        std::fs::write(dir.join(&v).join("device-keys.json"), r#"["aabb","ccdd"]"#).unwrap();

        assert!(upsert_device(&dir, &v, "aabb", Some((1, "11"))).unwrap());
        assert_eq!(
            load_device_keys(&dir, &v).unwrap(),
            vec!["aabb", "ccdd"],
            "the #63 seal-set is unchanged"
        );
        assert_eq!(
            load_write_keys(&dir, &v).unwrap(),
            vec![crate::write_auth::WriteKey {
                seat: 1,
                pubkey: "11".into()
            }]
        );
        // Idempotent: the same registration again changes nothing.
        assert!(!upsert_device(&dir, &v, "aabb", Some((1, "11"))).unwrap());
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn another_device_cannot_take_a_seat_that_is_already_claimed() {
        // The attack this file is exposed to: register after the real holder and inherit the seat.
        // Refusing is the point - an overwrite would hand it over for free, which is the
        // rename-hijack (#288) wearing a different file.
        let dir = std::env::temp_dir().join(format!("konclave-dev-seat-{}", std::process::id()));
        let v = "c".repeat(64);
        std::fs::create_dir_all(dir.join(&v)).unwrap();

        upsert_device(&dir, &v, "alice", Some((1, "aa"))).unwrap();
        let err = upsert_device(&dir, &v, "mallory", Some((1, "ff")));
        assert!(err.is_err(), "seat 1 is taken");
        assert_eq!(
            load_write_keys(&dir, &v).unwrap(),
            vec![crate::write_auth::WriteKey {
                seat: 1,
                pubkey: "aa".into()
            }],
            "and the real holder still has it"
        );
        // A different seat is fine.
        assert!(upsert_device(&dir, &v, "mallory", Some((2, "ff"))).unwrap());
        std::fs::remove_dir_all(&dir).ok();
    }

    /// What each state of `device-keys.json` means. ONLY a missing file is "no devices"; everything
    /// else that does not read is a registry that is there and unusable.
    #[test]
    fn the_registry_file_reads_as_absent_empty_legacy_records_or_unreadable() {
        let dir = std::env::temp_dir().join(format!("konclave-reg-states-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        let v = "e".repeat(64);
        let vault = dir.join(&v);
        std::fs::create_dir_all(&vault).unwrap();
        let path = vault.join("device-keys.json");
        let read = || load_device_records(&dir, &v);

        // No file: no devices.
        assert_eq!(read(), Ok(vec![]));
        // `[]` is a registry with none; the legacy flat list still reads, as seatless records.
        std::fs::write(&path, "[]").unwrap();
        assert_eq!(read(), Ok(vec![]));
        std::fs::write(&path, r#"["aabb","ccdd"]"#).unwrap();
        let flat = read().unwrap();
        assert_eq!(flat.len(), 2);
        assert!(flat.iter().all(|r| r.seat.is_none() && r.write.is_none()));
        std::fs::write(&path, r#"[{"comms":"aa","seat":2,"write":"bb"}]"#).unwrap();
        assert_eq!(read().unwrap()[0].seat, Some(2));

        // Everything else is unreadable, not empty.
        let unreadable: [(&str, &[u8]); 9] = [
            ("zero bytes", b""),
            ("only spaces", b"  \n "),
            ("half a record", br#"[{"comms":"aa","seat":1,"wri"#),
            ("trailing garbage", br#"[{"comms":"aa"}] xx"#),
            ("a mixed array", br#"["aa",{"comms":"bb"}]"#),
            ("the wrong type", br#"{"comms":"aa"}"#),
            ("a byte-order mark", b"\xef\xbb\xbf[]"),
            ("invalid utf-8", b"\xff\xfe"),
            ("null", b"null"),
        ];
        for (name, bytes) in unreadable {
            std::fs::write(&path, bytes).unwrap();
            assert!(read().is_err(), "{name} must be unreadable");
        }
        // A directory in the file's place.
        std::fs::remove_file(&path).unwrap();
        std::fs::create_dir(&path).unwrap();
        assert!(read().is_err(), "a directory must be unreadable");
        std::fs::remove_dir_all(&dir).ok();
    }

    /// The one decision, open or gated or unreadable, as the coordinator takes it.
    #[test]
    fn the_write_gate_is_open_gated_or_unreadable() {
        let dir = std::env::temp_dir().join(format!("konclave-gate-states-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        let v = "f".repeat(64);
        std::fs::create_dir_all(dir.join(&v)).unwrap();
        let path = dir.join(&v).join("device-keys.json");

        assert_eq!(write_gate(&dir, &v), WriteGate::Open);
        // Comms-only records are still an open vault.
        std::fs::write(&path, r#"["aa"]"#).unwrap();
        assert_eq!(write_gate(&dir, &v), WriteGate::Open);
        std::fs::write(&path, r#"[{"comms":"aa","seat":1,"write":"bb"}]"#).unwrap();
        assert!(matches!(write_gate(&dir, &v), WriteGate::Keys(k) if k.len() == 1));
        std::fs::write(&path, b"").unwrap();
        assert!(matches!(write_gate(&dir, &v), WriteGate::Unreadable(_)));
        std::fs::remove_dir_all(&dir).ok();
    }

    /// A registry write that is cut half way leaves the OLD registry whole and no temporary: a
    /// truncated file would read as "no write keys" and open the vault.
    #[test]
    fn a_cut_registry_write_leaves_the_old_registry_and_no_temporary() {
        let dir = std::env::temp_dir().join(format!("konclave-cut-reg-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("device-keys.json");
        write_device_registry(&path, &dir, br#"[{"comms":"aa","seat":1,"write":"bb"}]"#).unwrap();

        let r = write_device_registry_with(&path, &dir, br#"[{"comms":"cc"}]"#, |tmp, bytes| {
            std::fs::write(tmp, &bytes[..bytes.len() / 2])?;
            Err(std::io::Error::other("cut"))
        });
        assert!(r.is_err());
        assert_eq!(
            std::fs::read_to_string(&path).unwrap(),
            r#"[{"comms":"aa","seat":1,"write":"bb"}]"#
        );
        let stray = std::fs::read_dir(&dir)
            .unwrap()
            .flatten()
            .filter(|e| e.file_name().to_string_lossy().ends_with(".tmp"))
            .count();
        assert_eq!(stray, 0);
        std::fs::remove_dir_all(&dir).ok();
    }

    /// An unreadable registry is never written to, by the writer itself.
    #[test]
    fn the_writer_refuses_an_unreadable_registry_and_leaves_it_alone() {
        let dir = std::env::temp_dir().join(format!("konclave-unread-w-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        let v = "9".repeat(64);
        std::fs::create_dir_all(dir.join(&v)).unwrap();
        let path = dir.join(&v).join("device-keys.json");
        std::fs::write(&path, b"{ half").unwrap();
        let r = upsert_device(&dir, &v, "alice", Some((1, "aa")));
        assert!(matches!(r, Err(DeviceError::Unreadable(_))), "{r:?}");
        assert_eq!(std::fs::read(&path).unwrap(), b"{ half");
        std::fs::remove_dir_all(&dir).ok();
    }

    /// The writer does not validate, so the only non-test caller of it must be the door that does.
    /// A new production caller fails this until someone decides it belongs.
    #[test]
    fn only_register_device_calls_the_unvalidated_writer() {
        fn walk(dir: &Path, out: &mut Vec<(String, usize)>) {
            let call = ["upsert", "_device("].concat();
            for entry in std::fs::read_dir(dir).unwrap().flatten() {
                let path = entry.path();
                if path.is_dir() {
                    walk(&path, out);
                } else if path.extension().and_then(|e| e.to_str()) == Some("rs") {
                    let text = std::fs::read_to_string(&path).unwrap();
                    // Production code only: everything before the file's test module.
                    let prod = text.split("#[cfg(test)]\nmod tests").next().unwrap_or("");
                    let n = prod.matches(call.as_str()).count();
                    if n > 0 {
                        out.push((path.file_name().unwrap().to_string_lossy().into_owned(), n));
                    }
                }
            }
        }
        let root = Path::new(env!("CARGO_MANIFEST_DIR")).join("..");
        let mut found = Vec::new();
        for crate_src in ["orchestrator/src", "helper-server/src"] {
            walk(&root.join(crate_src), &mut found);
        }
        found.sort();
        // `helper.rs`: the definition, the call inside `register_device`, and the call inside
        // `add_device_key`, which is `#[cfg(test)]` (so it never exists in a production build) but
        // sits above the test module this scan stops at.
        assert_eq!(found, vec![("helper.rs".to_string(), 3)], "{found:?}");
    }

    /// The production writer REPLACES the registry (new inode), it does not rewrite it in place: a hard
    /// link made beforehand keeps the OLD bytes. (The shipped cut test exercises `_with`, not the wrapper
    /// `upsert_device` reaches.)
    #[test]
    fn registering_replaces_the_registry_file_instead_of_rewriting_it() {
        let dir = std::env::temp_dir().join(format!("konclave-y1-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        let v = "7".repeat(64);
        std::fs::create_dir_all(dir.join(&v)).unwrap();
        upsert_device(&dir, &v, "alice", Some((1, "aa"))).unwrap();
        let path = device_keys_path(&dir, &v);
        let link = dir.join(&v).join("old-link.json");
        std::fs::hard_link(&path, &link).unwrap();
        let old = std::fs::read_to_string(&path).unwrap();
        upsert_device(&dir, &v, "bob", Some((2, "bb"))).unwrap();
        assert_ne!(
            std::fs::read_to_string(&path).unwrap(),
            old,
            "the new record is there"
        );
        assert_eq!(
            std::fs::read_to_string(&link).unwrap(),
            old,
            "the old inode was not touched"
        );
        std::fs::remove_dir_all(&dir).ok();
    }

    /// A registry write that fails (the directory cannot take a new file) leaves the old registry
    /// whole and no temporary, through the production door.
    #[cfg(unix)]
    #[test]
    fn a_failed_registration_write_leaves_the_old_registry_whole() {
        use std::os::unix::fs::PermissionsExt;
        let dir = std::env::temp_dir().join(format!("konclave-y2-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        let v = "6".repeat(64);
        std::fs::create_dir_all(dir.join(&v)).unwrap();
        upsert_device(&dir, &v, "alice", Some((1, "aa"))).unwrap();
        let path = device_keys_path(&dir, &v);
        let old = std::fs::read_to_string(&path).unwrap();
        std::fs::set_permissions(dir.join(&v), std::fs::Permissions::from_mode(0o500)).unwrap();
        if std::fs::File::create(dir.join(&v).join("probe")).is_ok() {
            std::fs::set_permissions(dir.join(&v), std::fs::Permissions::from_mode(0o700)).unwrap();
            eprintln!("a user that ignores directory modes: skipped");
            std::fs::remove_dir_all(&dir).ok();
            return;
        }
        let r = upsert_device(&dir, &v, "bob", Some((2, "bb")));
        std::fs::set_permissions(dir.join(&v), std::fs::Permissions::from_mode(0o700)).unwrap();
        assert!(matches!(r, Err(DeviceError::Io(_))), "{r:?}");
        assert_eq!(std::fs::read_to_string(&path).unwrap(), old);
        let stray = std::fs::read_dir(dir.join(&v))
            .unwrap()
            .flatten()
            .filter(|e| e.file_name().to_string_lossy().ends_with(".tmp"))
            .count();
        assert_eq!(stray, 0);
        std::fs::remove_dir_all(&dir).ok();
    }

    /// A registration that conflicts changes NOTHING on disk (bytes identical), for each refusal.
    #[test]
    fn a_refused_registration_leaves_the_file_byte_identical() {
        let dir = std::env::temp_dir().join(format!("konclave-y3-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        let v = "5".repeat(64);
        std::fs::create_dir_all(dir.join(&v)).unwrap();
        upsert_device(&dir, &v, "alice", Some((1, "aa"))).unwrap();
        upsert_device(&dir, &v, "bob", Some((2, "bb"))).unwrap();
        let path = device_keys_path(&dir, &v);
        let before = std::fs::read(&path).unwrap();
        for (comms, seat, key) in [
            ("alice", 1, "zz"),
            ("alice", 2, "aa"),
            ("alice", 3, "aa"),
            ("bob", 1, "bb"),
            ("carol", 1, "cc"),
            ("carol", 2, "cc"),
        ] {
            assert!(
                upsert_device(&dir, &v, comms, Some((seat, key))).is_err(),
                "{comms} {seat} {key}"
            );
            assert_eq!(
                std::fs::read(&path).unwrap(),
                before,
                "{comms} {seat} {key}"
            );
        }
        std::fs::remove_dir_all(&dir).ok();
    }

    /// The same key in another case is the same device: a bound record cannot be taken over by
    /// spelling it differently.
    #[test]
    fn a_bound_device_is_found_whatever_the_case_of_its_comms_key() {
        let dir = std::env::temp_dir().join(format!("konclave-case-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        let v = "4".repeat(64);
        std::fs::create_dir_all(dir.join(&v)).unwrap();
        upsert_device(&dir, &v, "ab12", Some((1, "aa"))).unwrap();
        assert!(upsert_device(&dir, &v, "AB12", Some((1, "bb"))).is_err());
        assert!(upsert_device(&dir, &v, "AB12", Some((2, "aa"))).is_err());
        assert!(
            !upsert_device(&dir, &v, "AB12", Some((1, "aa"))).unwrap(),
            "the same pair, a no-op"
        );
        assert_eq!(load_device_records(&dir, &v).unwrap().len(), 1);
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn a_device_cannot_rotate_its_own_write_key() {
        // The old rule said a device could, "because only that device can present its comms key".
        // Every member can read every device's comms key, so presenting it proves nothing: a bound
        // record never changes its seat or its write key (V1 and V2). A rotation, if one is ever
        // needed, must be signed by the key currently registered.
        let dir = std::env::temp_dir().join(format!("konclave-dev-rot-{}", std::process::id()));
        let v = "d".repeat(64);
        std::fs::create_dir_all(dir.join(&v)).unwrap();
        upsert_device(&dir, &v, "alice", Some((1, "aa"))).unwrap();
        assert!(
            upsert_device(&dir, &v, "alice", Some((1, "bb"))).is_err(),
            "V1"
        );
        assert!(
            upsert_device(&dir, &v, "alice", Some((2, "aa"))).is_err(),
            "V2"
        );
        assert_eq!(
            load_write_keys(&dir, &v).unwrap(),
            vec![crate::write_auth::WriteKey {
                seat: 1,
                pubkey: "aa".into()
            }]
        );
        // The same triple is still a no-op.
        assert!(!upsert_device(&dir, &v, "alice", Some((1, "aa"))).unwrap());
        std::fs::remove_dir_all(&dir).ok();
    }

    /// A fake `zcash-devtool` for the balance path. It appends each subcommand (`$4` in
    /// `wallet -w <dir> <subcommand> ...`) to `<dir>/calls.log`, prints a valid balance for
    /// `balance`, and, when `upgrade_fails`, exits 1 on `upgrade` the way a failed migration does.
    #[cfg(unix)]
    fn fake_balance_devtool(dir: &Path, upgrade_fails: bool) -> (PathBuf, PathBuf) {
        use std::os::unix::fs::PermissionsExt;
        let log = dir.join("calls.log");
        let fake = dir.join("fake-devtool");
        let mut script = String::from("#!/bin/sh\n[ \"$1\" = \"--probe\" ] && exit 0\n");
        script.push_str(&format!("echo \"$4\" >> \"{}\"\n", log.display()));
        if upgrade_fails {
            script.push_str(
                "if [ \"$4\" = upgrade ]; then echo 'migration failed' >&2; exit 1; fi\n",
            );
        }
        script.push_str(
            "if [ \"$4\" = balance ]; then echo '{\"chain_tip_height\":3400100,\"orchard_spendable\":0,\"sapling_spendable\":0,\"total\":100000,\"transparent_spendable\":0}'; fi\n",
        );
        std::fs::write(&fake, script).expect("write fake devtool");
        let mut p = std::fs::metadata(&fake).expect("stat").permissions();
        p.set_mode(0o755);
        std::fs::set_permissions(&fake, p).expect("chmod");
        exec_ready(&fake);
        (fake, log)
    }

    #[cfg(unix)]
    fn balance_cfg(devtool: PathBuf, vaults_dir: PathBuf) -> HelperConfig {
        HelperConfig {
            zcash_sign: PathBuf::from("/nonexistent/zcash-sign"),
            devtool,
            lightwalletd: "zec.rocks:443".into(),
            network: "main".into(),
            konclave_signer: PathBuf::from("/nonexistent/konclave-signer"),
            vaults_dir,
            relays: Vec::new(),
            send_max_polls: DEFAULT_SEND_MAX_POLLS,
        }
    }

    #[cfg(unix)]
    fn tmp(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("konclave-{name}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).expect("create temp dir");
        dir
    }

    #[cfg(unix)]
    fn calls(log: &Path) -> Vec<String> {
        std::fs::read_to_string(log)
            .expect("the fake devtool was invoked")
            .lines()
            .map(str::to_owned)
            .collect()
    }

    /// A stale wallet is migrated ONCE, then synced, then read. Migrating inside `sync` as well
    /// started a second ~98 MB devtool process under the vault lock on every synced read.
    #[cfg(unix)]
    #[test]
    fn a_stale_balance_read_migrates_once_then_syncs_then_reads() {
        let _serial = serial();
        let dir = tmp("balance-stale");
        let (fake, log) = fake_balance_devtool(&dir, false);
        let cfg = balance_cfg(fake, dir.join("vaults"));
        let r = reg("aaaa1111");

        vault_balance(&cfg, &r).expect("balance reads");

        assert_eq!(calls(&log), vec!["upgrade", "sync", "balance"]);
        std::fs::remove_dir_all(&dir).ok();
    }

    /// The read that the sync throttle skips still migrates first: `balance` reads the database
    /// unconditionally, and on a wallet written by an older engine it fails with
    /// `no such table: orchard_ironwood_migrations` unless the upgrade ran.
    #[cfg(unix)]
    #[test]
    fn a_throttled_balance_read_still_migrates_first() {
        let _serial = serial();
        let dir = tmp("balance-throttled");
        let (fake, log) = fake_balance_devtool(&dir, false);
        let cfg = balance_cfg(fake, dir.join("vaults"));
        let r = reg("bbbb2222");
        mark_synced(&cfg.vaults_dir, &r.vault_id, now_secs());

        vault_balance(&cfg, &r).expect("balance reads");

        assert_eq!(calls(&log), vec!["upgrade", "balance"]);
        std::fs::remove_dir_all(&dir).ok();
    }

    /// A failed migration does not by itself take the balance offline: the read goes ahead, and if
    /// the schema really is wrong the read is what fails. The failure is logged, not swallowed.
    #[cfg(unix)]
    #[test]
    fn a_failed_migration_does_not_block_a_readable_wallet() {
        let _serial = serial();
        let dir = tmp("balance-upgrade-fails");
        let (fake, log) = fake_balance_devtool(&dir, true);
        let cfg = balance_cfg(fake, dir.join("vaults"));
        let r = reg("cccc3333");

        let b = vault_balance(&cfg, &r).expect("a readable wallet still reads");

        assert_eq!(b.total_zat, 100_000);
        assert_eq!(calls(&log), vec!["upgrade", "sync", "balance"]);
        std::fs::remove_dir_all(&dir).ok();
    }

    /// One test at a time may write and run a fake devtool script: writing an executable and running it
    /// while another thread forks makes the kernel answer `Text file busy` (ETXTBSY) now and then, and
    /// the tests that count subprocess calls then fail with no defect behind them. Taken by every test
    /// in this module that uses a fake devtool. It REDUCES the flake and does not close it: a fork from
    /// a test that does not take it (the registration and engine-path tests have their own probe loop)
    /// can still hold the script's write handle for a moment.
    /// Wait until a script that was just written can be executed: the kernel answers `Text file busy`
    /// (ETXTBSY) while another thread's fork still holds the file's write handle. The fake devtools
    /// answer `--probe` without logging, so this changes nothing a test counts. This is what closes
    /// the race; `serial()` only reduces it.
    #[cfg(unix)]
    fn exec_ready(script: &Path) {
        for _ in 0..200 {
            match std::process::Command::new(script).arg("--probe").output() {
                Err(e) if e.raw_os_error() == Some(26) => {
                    std::thread::sleep(std::time::Duration::from_millis(10));
                }
                _ => break,
            }
        }
    }

    #[cfg(unix)]
    fn serial() -> std::sync::MutexGuard<'static, ()> {
        static LOCK: std::sync::Mutex<()> = std::sync::Mutex::new(());
        LOCK.lock().unwrap_or_else(|e| e.into_inner())
    }

    /// How the fake devtool's `sync` behaves.
    #[cfg(unix)]
    #[derive(Clone, Copy, PartialEq)]
    enum FakeSync {
        Works,
        Fails,
        /// Fails the first time and works after: a lightwalletd that comes back.
        FailsOnce,
    }

    /// A `zcash-devtool` whose wallet only learns of a deposit when it SYNCS: `list-tx` answers an empty
    /// history until `sync` has run, and a row for the deposit after. Logs each subcommand (`$4`) in
    /// `calls.log` and every argument in `calls.log.args`, so a test can see WHICH wallet and server
    /// were used, not only which subcommand ran.
    #[cfg(unix)]
    fn fake_chain_devtool(dir: &Path, sync: FakeSync) -> (PathBuf, PathBuf) {
        use std::os::unix::fs::PermissionsExt;
        let log = dir.join("calls.log");
        let synced = dir.join("synced");
        let tried = dir.join("tried");
        let fake = dir.join("fake-devtool");
        let mut script = String::from("#!/bin/sh\n[ \"$1\" = \"--probe\" ] && exit 0\n");
        script.push_str(&format!("echo \"$4\" >> \"{}\"\n", log.display()));
        script.push_str(&format!("echo \"$*\" >> \"{}.args\"\n", log.display()));
        match sync {
            FakeSync::Works => script.push_str(&format!(
                "if [ \"$4\" = sync ]; then touch \"{}\"; fi\n",
                synced.display()
            )),
            FakeSync::Fails => script.push_str(
                "if [ \"$4\" = sync ]; then echo \"lightwalletd unreachable ($3)\" >&2; exit 1; fi\n",
            ),
            FakeSync::FailsOnce => script.push_str(&format!(
                "if [ \"$4\" = sync ]; then if [ -e \"{t}\" ]; then touch \"{s}\"; else touch \"{t}\"; echo 'lightwalletd unreachable' >&2; exit 1; fi; fi\n",
                t = tried.display(),
                s = synced.display()
            )),
        }
        script.push_str(
            "if [ \"$4\" = balance ]; then echo '{\"chain_tip_height\":3400100,\"orchard_spendable\":0,\"sapling_spendable\":0,\"total\":100000,\"transparent_spendable\":0}'; fi\n",
        );
        script.push_str(&format!(
            "if [ \"$4\" = list-tx ]; then if [ -e \"{}\" ]; then echo '[{{\"txid\":\"{}\",\"mined_height\":null}}]'; else echo '[]'; fi; fi\n",
            synced.display(),
            "cd".repeat(32)
        ));
        std::fs::write(&fake, script).expect("write fake devtool");
        let mut p = std::fs::metadata(&fake).expect("stat").permissions();
        p.set_mode(0o755);
        std::fs::set_permissions(&fake, p).expect("chmod");
        exec_ready(&fake);
        (fake, log)
    }

    /// #637. A member who has just sent a deposit and waits on Add funds saw nothing arrive: that screen
    /// reads the history, the history read only listed what the wallet already knew, and the one read
    /// that syncs the wallet was the balance, which the dashboard calls and Add funds does not. The
    /// deposit is in the history of the FIRST history read, with no balance read before it - and the
    /// vault's OWN wallet and the coordinator's OWN server are the ones the engine is pointed at.
    #[cfg(unix)]
    #[test]
    fn a_deposit_is_in_the_history_without_a_balance_read_first() {
        let _serial = serial();
        let dir = tmp("history-fresh");
        let (fake, log) = fake_chain_devtool(&dir, FakeSync::Works);
        let cfg = balance_cfg(fake, dir.join("vaults"));
        let r = reg("eeee7777");

        let txs = vault_transactions(&cfg, &r).expect("history reads");

        assert_eq!(txs.len(), 1, "the deposit shows on the first history read");
        assert_eq!(calls(&log), vec!["upgrade", "sync", "list-tx"]);
        let args = std::fs::read_to_string(log.with_extension("log.args")).unwrap();
        assert!(args.contains("-w /tmp/eeee7777/wallet upgrade"), "{args}");
        assert!(
            args.contains("-w /tmp/eeee7777/wallet sync -s zec.rocks:443"),
            "{args}"
        );
        assert!(args.contains("-w /tmp/eeee7777/wallet list-tx"), "{args}");
        std::fs::remove_dir_all(&dir).ok();
    }

    /// One rule, one implementation: the balance and the history go through the same function, so
    /// they share ONE sync window. Three reads inside it start one sync, not three.
    #[cfg(unix)]
    #[test]
    fn the_balance_and_the_history_share_one_sync_window() {
        let _serial = serial();
        let dir = tmp("shared-window");
        let (fake, log) = fake_chain_devtool(&dir, FakeSync::Works);
        let cfg = balance_cfg(fake, dir.join("vaults"));
        let r = reg("ffff8888");

        vault_balance(&cfg, &r).expect("balance");
        vault_transactions(&cfg, &r).expect("history");
        vault_balance(&cfg, &r).expect("balance again");

        let ran = calls(&log);
        assert_eq!(ran.iter().filter(|c| *c == "sync").count(), 1, "{ran:?}");
        // Every read still migrates first, so a wallet written by an older engine reads either way.
        assert_eq!(ran.iter().filter(|c| *c == "upgrade").count(), 3, "{ran:?}");
        std::fs::remove_dir_all(&dir).ok();
    }

    /// Inside the window the history is read without a sync (the throttle still holds, #194), and it
    /// migrates first like every other read of the wallet.
    #[cfg(unix)]
    #[test]
    fn a_history_read_inside_the_window_does_not_sync_but_still_migrates() {
        let _serial = serial();
        let dir = tmp("history-throttled");
        let (fake, log) = fake_chain_devtool(&dir, FakeSync::Works);
        let cfg = balance_cfg(fake, dir.join("vaults"));
        let r = reg("99990000");
        mark_synced(&cfg.vaults_dir, &r.vault_id, now_secs());

        vault_transactions(&cfg, &r).expect("history reads");

        assert_eq!(calls(&log), vec!["upgrade", "list-tx"]);
        std::fs::remove_dir_all(&dir).ok();
    }

    /// The window is fifteen seconds and no more: a deposit must not wait a day. The constant itself is
    /// pinned (docs and changelog say 15), and a read just past the window syncs again.
    #[cfg(unix)]
    #[test]
    fn the_window_is_fifteen_seconds_and_a_read_after_it_syncs() {
        let _serial = serial();
        assert_eq!(SYNC_THROTTLE_SECS, 15);
        let dir = tmp("history-after-window");
        let (fake, log) = fake_chain_devtool(&dir, FakeSync::Works);
        let cfg = balance_cfg(fake, dir.join("vaults"));
        let r = reg("aaaa0002");
        mark_synced(
            &cfg.vaults_dir,
            &r.vault_id,
            now_secs() - SYNC_THROTTLE_SECS - 1,
        );

        vault_transactions(&cfg, &r).expect("history reads");

        assert_eq!(calls(&log), vec!["upgrade", "sync", "list-tx"]);
        std::fs::remove_dir_all(&dir).ok();
    }

    /// Each vault has its own window: reading vault A must not keep vault B's wallet from syncing (the
    /// coordinator serves many vaults and the dashboard polls each one).
    #[cfg(unix)]
    #[test]
    fn each_vault_has_its_own_sync_window() {
        let _serial = serial();
        let dir = tmp("windows-per-vault");
        let (fake, log) = fake_chain_devtool(&dir, FakeSync::Works);
        let cfg = balance_cfg(fake, dir.join("vaults"));

        vault_transactions(&cfg, &reg("aaaa0003")).expect("vault A");
        vault_transactions(&cfg, &reg("bbbb0004")).expect("vault B");

        let ran = calls(&log);
        assert_eq!(ran.iter().filter(|c| *c == "sync").count(), 2, "{ran:?}");
        std::fs::remove_dir_all(&dir).ok();
    }

    /// A history whose sync fails still answers with what the wallet knows (a deposit it had already
    /// synced), and says so in the log under the vault's prefix: the Add funds screen turns any error
    /// other than busy into "no transactions yet" and drops the list it had.
    #[cfg(unix)]
    #[test]
    fn a_history_read_whose_sync_fails_serves_the_last_known_list() {
        let _serial = serial();
        let dir = tmp("history-sync-fails");
        let (fake, log) = fake_chain_devtool(&dir, FakeSync::Fails);
        // The wallet had already synced a deposit before lightwalletd went away.
        std::fs::write(dir.join("synced"), "").unwrap();
        let cfg = balance_cfg(fake, dir.join("vaults"));
        let id = "ab".repeat(32);
        let mut r = reg(&id);
        r.wallet_dir = format!("/tmp/{id}/wallet");
        LOG_SINK.with(|s| *s.borrow_mut() = Some(Vec::new()));

        let txs = vault_transactions(&cfg, &r).expect("the history still answers");

        let lines = LOG_SINK.with(|s| s.borrow_mut().take().unwrap());
        assert_eq!(txs.len(), 1, "the last known list, not an empty one");
        let ran = calls(&log);
        assert!(
            ran.contains(&"sync".to_string()) && ran.contains(&"list-tx".to_string()),
            "{ran:?}"
        );
        let said = lines.join("\n");
        assert!(
            said.contains("history served without a fresh sync"),
            "{said}"
        );
        assert!(said.contains(short_id(&id)), "{said}");
        assert!(!said.contains(&id), "the whole id in the log: {said}");
        std::fs::remove_dir_all(&dir).ok();
    }

    /// A stamp from the FUTURE (a clock that went back) is not a recent sync: the history syncs, and
    /// the promotion's throttle ignores it the same way (one predicate, `inside_window`).
    #[test]
    fn a_stamp_from_the_future_does_not_cover_the_window() {
        assert!(inside_window(1000, 1000, 15));
        assert!(inside_window(1000, 1014, 15));
        assert!(!inside_window(1000, 1015, 15));
        assert!(
            !inside_window(2000, 1000, 15),
            "a future stamp covers nothing"
        );
        let dir =
            std::env::temp_dir().join(format!("konclave-future-stamp-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(dir.join("v")).unwrap();
        std::fs::write(dir.join("v").join("last_sync"), "5000").unwrap();
        assert!(
            should_sync(&dir, "v", 15, 1000),
            "a future stamp does not hold the sync back"
        );
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// A sync that failed is not recorded as done: the NEXT read tries it again, so a lightwalletd that
    /// comes back is picked up at once instead of after a window nobody earned.
    #[cfg(unix)]
    #[test]
    fn a_failed_sync_does_not_use_up_the_window() {
        let _serial = serial();
        let dir = tmp("history-retry");
        let (fake, log) = fake_chain_devtool(&dir, FakeSync::FailsOnce);
        let cfg = balance_cfg(fake, dir.join("vaults"));
        let r = reg("aaaa0005");

        let first = vault_transactions(&cfg, &r).expect("served without a fresh sync");
        let second = vault_transactions(&cfg, &r).expect("history reads");

        assert!(first.is_empty());
        assert_eq!(second.len(), 1, "the retry synced and found the deposit");
        let ran = calls(&log);
        assert_eq!(ran.iter().filter(|c| *c == "sync").count(), 2, "{ran:?}");
        std::fs::remove_dir_all(&dir).ok();
    }

    /// The balance, by contrast, is an error when its sync fails: it never serves a number it could not
    /// refresh as the current one.
    #[cfg(unix)]
    #[test]
    fn a_balance_read_whose_sync_fails_is_an_error() {
        let _serial = serial();
        let dir = tmp("balance-sync-fails");
        let (fake, log) = fake_chain_devtool(&dir, FakeSync::Fails);
        let cfg = balance_cfg(fake, dir.join("vaults"));
        let r = reg("aaaa0006");

        assert!(vault_balance(&cfg, &r).is_err());
        assert!(
            !calls(&log).contains(&"balance".to_string()),
            "no stale balance after a failed sync"
        );
        std::fs::remove_dir_all(&dir).ok();
    }

    /// ONE implementation of "bring the wallet current": the engine's `sync` is started, and its window
    /// stamped, in `bring_current` and nowhere else in this crate (outside tests). The balance, the
    /// history and the settling of a send all come through it; a second call site is how the history
    /// came to read a wallet nobody had synced (#637). The needles are assembled at run time so this
    /// test does not count itself.
    #[test]
    fn the_wallet_is_synced_and_stamped_in_one_place() {
        let sync_call = format!("{}{}", "wallet::", "sync");
        let stamp_call = format!("{}{}", "mark_", "synced(");
        let upgrade_call = format!("{}{}", "wallet::", "upgrade");
        let logged_call = format!("{}{}", "upgrade_", "logged(");
        let mut found = Vec::new();
        for entry in std::fs::read_dir(concat!(env!("CARGO_MANIFEST_DIR"), "/src")).unwrap() {
            let path = entry.unwrap().path();
            if path.extension().is_some_and(|e| e == "rs") {
                let text = std::fs::read_to_string(&path).unwrap();
                // The file without its top-level test modules (`#[cfg(test)]` + `mod x {` up to the
                // closing brace in column 0): production code can sit between and after them.
                let mut production = Vec::new();
                let mut lines = text.lines().peekable();
                while let Some(line) = lines.next() {
                    if line == "#[cfg(test)]" && lines.peek().is_some_and(|n| n.starts_with("mod "))
                    {
                        for skipped in lines.by_ref() {
                            if skipped == "}" {
                                break;
                            }
                        }
                        continue;
                    }
                    production.push(line);
                }
                for (needle, label) in [
                    (&sync_call, "sync"),
                    (&stamp_call, "stamp"),
                    (&upgrade_call, "upgrade"),
                    (&logged_call, "migration"),
                ] {
                    let n = production
                        .iter()
                        .filter(|l| !l.trim_start().starts_with("//"))
                        .filter(|l| l.contains(needle.as_str()) && !l.contains("fn "))
                        .count();
                    if n > 0 {
                        found.push((
                            path.file_name().unwrap().to_string_lossy().into_owned(),
                            label,
                            n,
                        ));
                    }
                }
            }
        }
        found.sort();
        assert_eq!(
            found,
            vec![
                ("helper.rs".to_string(), "migration", 1),
                ("helper.rs".to_string(), "stamp", 1),
                ("helper.rs".to_string(), "sync", 1),
                ("helper.rs".to_string(), "upgrade", 1),
            ],
            "{found:?}"
        );
    }

    /// Each vault has its own window even when two ids start the same: the stamp is keyed by the whole
    /// id, not by a prefix of it (the ids the other tests use are eight characters long, so a prefix
    /// would be the identity there).
    #[cfg(unix)]
    #[test]
    fn two_vaults_whose_ids_share_a_prefix_have_separate_windows() {
        let _serial = serial();
        let dir = tmp("windows-shared-prefix");
        let (fake, log) = fake_chain_devtool(&dir, FakeSync::Works);
        let cfg = balance_cfg(fake, dir.join("vaults"));
        let a = format!("abcd1234{:056x}", 1);
        let b = format!("abcd1234{:056x}", 2);

        vault_transactions(&cfg, &reg(&a)).expect("vault A");
        vault_transactions(&cfg, &reg(&b)).expect("vault B");

        let ran = calls(&log);
        assert_eq!(ran.iter().filter(|c| *c == "sync").count(), 2, "{ran:?}");
        std::fs::remove_dir_all(&dir).ok();
    }

    /// Only the failure of the SYNC is absorbed by the history. A wallet that cannot be LISTED is an
    /// error, never an empty list: the Add funds screen would show a vault with no deposits.
    #[cfg(unix)]
    #[test]
    fn a_history_that_cannot_be_listed_is_an_error_and_not_an_empty_list() {
        use std::os::unix::fs::PermissionsExt;
        let _serial = serial();
        let dir = tmp("history-list-fails");
        let fake = dir.join("fake-devtool");
        std::fs::write(
            &fake,
            "#!/bin/sh\n[ \"$1\" = \"--probe\" ] && exit 0\nif [ \"$4\" = list-tx ]; then echo 'database is locked' >&2; exit 1; fi\n",
        )
        .unwrap();
        std::fs::set_permissions(&fake, std::fs::Permissions::from_mode(0o755)).unwrap();
        exec_ready(&fake);
        let cfg = balance_cfg(fake, dir.join("vaults"));

        assert!(vault_transactions(&cfg, &reg("aaaa0007")).is_err());
        std::fs::remove_dir_all(&dir).ok();
    }

    /// The sync window and the promotion's are two stamps in two files. Writing one must not move the
    /// other: a promotion that just ran must not make the next history read skip its sync.
    #[test]
    fn the_sync_stamp_and_the_promotion_stamp_are_separate() {
        let dir = std::env::temp_dir().join(format!("konclave-stamps-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(dir.join("v")).unwrap();
        std::fs::write(dir.join("v").join("last_promote"), "999").unwrap();
        assert!(
            should_sync(&dir, "v", 15, 1000),
            "a promotion is not a sync"
        );
        mark_synced(&dir, "v", 1000);
        assert_eq!(
            std::fs::read_to_string(dir.join("v").join("last_promote")).unwrap(),
            "999",
            "a sync does not move the promotion's stamp"
        );
        assert!(!should_sync(&dir, "v", 15, 1000));
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// A fake `zcash-devtool` for settling a send: logs `$4`, answers `balance` and `list-tx`, and can
    /// fail `sync`.
    #[cfg(unix)]
    fn fake_settle_devtool(dir: &Path, sync_fails: bool) -> (PathBuf, PathBuf) {
        use std::os::unix::fs::PermissionsExt;
        let log = dir.join("calls.log");
        let fake = dir.join("fake-devtool");
        let mut script = String::from("#!/bin/sh\n[ \"$1\" = \"--probe\" ] && exit 0\n");
        script.push_str(&format!("echo \"$4\" >> \"{}\"\n", log.display()));
        script.push_str(&format!("echo \"$*\" >> \"{}.args\"\n", log.display()));
        if sync_fails {
            script.push_str(
                "if [ \"$4\" = sync ]; then echo 'lightwalletd unreachable' >&2; exit 1; fi\n",
            );
        }
        script.push_str(
            "if [ \"$4\" = balance ]; then echo '{\"chain_tip_height\":3400100,\"orchard_spendable\":0,\"sapling_spendable\":0,\"total\":100000,\"transparent_spendable\":0}'; fi\n",
        );
        script.push_str(&format!(
            "if [ \"$4\" = list-tx ]; then echo '[{{\"txid\":\"{}\",\"mined_height\":3400000}},{{\"txid\":\"{}\",\"mined_height\":null}}]'; fi\n",
            "aa".repeat(32),
            "bb".repeat(32)
        ));
        std::fs::write(&fake, script).expect("write fake devtool");
        let mut p = std::fs::metadata(&fake).expect("stat").permissions();
        p.set_mode(0o755);
        std::fs::set_permissions(&fake, p).expect("chmod");
        exec_ready(&fake);
        (fake, log)
    }

    /// Settling reads AFTER a forced sync, takes the tip from the wallet's own balance, and keeps only
    /// the transactions the wallet lists as mined. Each of these decides `Mined` or `Dead`.
    #[cfg(unix)]
    #[test]
    fn settling_syncs_first_then_reads_the_tip_and_the_mined_list() {
        let _serial = serial();
        let dir = tmp("settle-wallet");
        let (fake, log) = fake_settle_devtool(&dir, false);
        let vaults = dir.join("vaults");
        // A sync a second ago would let the balance read skip its own. Settling must not.
        mark_synced(&vaults, "dddd4444", now_secs());
        let view =
            settle_wallet(&fake, "/w", "zec.rocks:443", &vaults, "dddd4444").expect("settles");

        assert_eq!(calls(&log), vec!["upgrade", "sync", "balance", "list-tx"]);
        assert_eq!(view.tip, 3_400_100);
        assert_eq!(
            view.mined,
            vec!["aa".repeat(32)],
            "the unmined row is not mined"
        );
        // The right wallet and the right server reach the engine.
        let args = std::fs::read_to_string(log.with_extension("log.args")).unwrap();
        assert!(args.contains("-w /w sync -s zec.rocks:443"), "{args}");
        assert!(args.contains("-w /w list-tx"), "{args}");
        std::fs::remove_dir_all(&dir).ok();
    }

    /// The forced sync is written down, so the balance read's throttle knows the wallet is fresh and
    /// the next poll does not start a second sync.
    #[cfg(unix)]
    #[test]
    fn settling_records_the_sync_it_made() {
        let _serial = serial();
        let dir = tmp("settle-wallet-records");
        let (fake, _log) = fake_settle_devtool(&dir, false);
        let vaults = dir.join("vaults");
        assert!(should_sync(
            &vaults,
            "ffff6666",
            SYNC_THROTTLE_SECS,
            now_secs()
        ));
        settle_wallet(&fake, "/w", "zec.rocks:443", &vaults, "ffff6666").expect("settles");
        assert!(!should_sync(
            &vaults,
            "ffff6666",
            SYNC_THROTTLE_SECS,
            now_secs()
        ));
        std::fs::remove_dir_all(&dir).ok();
    }

    /// A sync past its deadline is an error, and nothing is read after it.
    #[cfg(unix)]
    #[test]
    fn a_sync_that_never_returns_is_an_error_within_its_deadline() {
        let _serial = serial();
        let dir = tmp("settle-wallet-sync-hangs");
        let (fake, log) = fake_settle_devtool(&dir, false);
        // The fake's sync waits 8 s (exec: the shell is replaced, so killing it ends the wait).
        let mut script = std::fs::read_to_string(&fake).unwrap();
        script = script.replacen(
            "echo \"$4\" >> ",
            "[ \"$4\" = sync ] && exec sleep 8\necho \"$4\" >> ",
            1,
        );
        std::fs::write(&fake, script).unwrap();
        crate::wallet::set_sync_within_for_test(Some(std::time::Duration::from_millis(400)));
        let started = std::time::Instant::now();
        let r = settle_wallet(
            &fake,
            "/w",
            "zec.rocks:443",
            &dir.join("vaults"),
            "ffff6666",
        );
        let took = started.elapsed();
        crate::wallet::set_sync_within_for_test(None);
        match r.err() {
            Some(ToolError::Io(e)) => assert_eq!(
                e.kind(),
                std::io::ErrorKind::TimedOut,
                "the sync was stopped by its deadline: {e}"
            ),
            other => panic!("a sync past its deadline is a timeout, not {other:?}"),
        }
        assert!(
            took < std::time::Duration::from_secs(4),
            "it returned in {took:?}"
        );
        let ran = calls(&log);
        assert!(
            !ran.contains(&"balance".to_string()) && !ran.contains(&"list-tx".to_string()),
            "nothing is read after a sync that did not finish: {ran:?}"
        );
        std::fs::remove_dir_all(&dir).ok();
    }

    #[cfg(unix)]
    #[test]
    fn a_sync_that_fails_is_an_error_and_never_a_stale_view() {
        let _serial = serial();
        let dir = tmp("settle-wallet-sync-fails");
        let (fake, log) = fake_settle_devtool(&dir, true);
        let r = settle_wallet(
            &fake,
            "/w",
            "zec.rocks:443",
            &dir.join("vaults"),
            "eeee5555",
        );
        assert!(r.is_err());
        let ran = calls(&log);
        assert!(
            !ran.contains(&"balance".to_string()) && !ran.contains(&"list-tx".to_string()),
            "{ran:?}"
        );
        std::fs::remove_dir_all(&dir).ok();
    }

    /// A proposal write that is cut half way leaves the proposal exactly as it was, and no temporary
    /// file: this is the write that records a payment as `sent`, and a truncated file would be
    /// dropped by `load_proposal` without a word.
    #[test]
    fn a_cut_proposal_write_leaves_the_old_proposal_and_no_temporary() {
        let dir = std::env::temp_dir().join(format!("konclave-cut-save-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        let mut p = mk_prop("cut00000", "p1");
        save_proposal(&dir, &p).unwrap();

        p.state = "sent".into();
        p.txid = Some("ab".repeat(32));
        let r = save_proposal_with(&dir, &p, |path, bytes| {
            std::fs::write(path, &bytes[..bytes.len() / 2])?;
            Err(std::io::Error::other("cut"))
        });
        assert!(r.is_err());

        let back = load_proposal(&dir, "cut00000", "p1", 0).expect("the old proposal still reads");
        assert_eq!((back.state.as_str(), back.txid), ("pending", None));
        let stray = std::fs::read_dir(dir.join("cut00000"))
            .unwrap()
            .flatten()
            .filter(|e| e.file_name().to_string_lossy().ends_with(".tmp"))
            .count();
        assert_eq!(stray, 0, "the half-written temporary is removed");
        std::fs::remove_dir_all(&dir).ok();
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
            cp: None,
            created_at_unix: None,
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
        p.recompute(200, &[]);
        assert_eq!(p.state, "pending"); // 1 of 2 approvals
        assert!(p.vote("bob", true, 200, &[])); // 2 of 2
        assert_eq!(p.state, "ready");
        // Idempotent re-vote does not double-count.
        assert!(p.vote("bob", true, 200, &[]));
        assert_eq!(p.approvals.len(), 2);
        // Expiry wins over ready.
        p.expiry_unix = 300;
        p.recompute(301, &[]);
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
        assert!(p.vote("bob", false, 100, &[]));
        assert!(p.vote("carol", false, 100, &[]));
        assert_eq!(p.state, "refused");

        // The deadline passes. The decision must survive it.
        p.recompute(301, &[]);
        assert_eq!(
            p.state, "refused",
            "the group refused this payment; a passed deadline must not rewrite that as a timeout"
        );

        // A proposal still in play, with no refusals, DOES expire - that branch is unaffected.
        let mut open = mk_prop("v", "p4");
        open.expiry_unix = 300;
        open.recompute(301, &[]);
        assert_eq!(open.state, "expired");
    }

    #[test]
    fn proposal_refusal_makes_quorum_unreachable() {
        // 2-of-3: two refusals leave only 1 possible approver, below the threshold -> refused.
        let mut p = mk_prop("v", "p2");
        p.approvals.clear();
        assert!(p.vote("bob", false, 100, &[]));
        assert_eq!(p.state, "pending");
        assert!(p.vote("carol", false, 100, &[]));
        assert_eq!(p.state, "refused");

        // This used to assert that a refused proposal rejects further votes. The expectation was
        // wrong, and #288 is why: `refused` is derived from the refusal count on every recompute,
        // not stamped once, and votes are unauthenticated - so treating it as terminal let one
        // request per seat, from anyone holding the vault id, brick a vault's governance with no
        // way back. A member withdrawing a refusal must bring the proposal back.
        assert!(
            p.vote("carol", true, 100, &[]),
            "a refusal is not a one-way door"
        );
        assert_ne!(p.state, "refused", "withdrawing it revives the proposal");
        assert!(p.refusals.iter().all(|m| m != "carol"));

        // What IS terminal stays terminal.
        p.state = "sent".into();
        assert!(
            !p.vote("alice", true, 100, &[]),
            "a sent payment takes no votes"
        );
        p.state = "expired".into();
        assert!(
            !p.vote("alice", true, 100, &[]),
            "an expired proposal takes no votes"
        );
    }

    /// #575, the other direction. A member's own vote has to replace whatever was recorded for them
    /// under another spelling, or the planted entry outlives what they actually said: here alice
    /// REFUSES, and an approval planted as `"alice "` while the vault took unsigned writes went on
    /// counting as hers, so bob alone took a 2-of-3 proposal to `ready`.
    #[test]
    fn a_members_vote_replaces_what_was_recorded_for_them_under_another_spelling() {
        let roster: Vec<String> = vec!["alice".into(), "bob".into(), "carol".into()];
        let mut p = mk_prop("v", "p1");
        p.approvals = vec!["alice ".into()];

        assert!(p.vote("alice", false, 200, &roster));
        assert!(p.vote("bob", true, 200, &roster));

        assert_eq!(
            p.approvals,
            vec!["bob".to_string()],
            "alice approves nothing"
        );
        assert_eq!(p.refusals, vec!["alice".to_string()]);
        assert_eq!(p.state, "pending", "one member approved, of the two needed");

        // And a vote under her own spelling replaces a planted one in the same list too, so the
        // record says alice once.
        let mut q = mk_prop("v", "p2");
        q.approvals = vec!["alice\u{00a0}".into()];
        assert!(q.vote("alice", true, 200, &roster));
        assert_eq!(q.approvals, vec!["alice".to_string()]);
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
            relays: Vec::new(),
            send_max_polls: DEFAULT_SEND_MAX_POLLS,
        };
        assert!(register_vault(&cfg, "not-a-valid-key", "demo", 2, 3, None).is_err());
    }

    fn send_cfg(network: &str) -> HelperConfig {
        HelperConfig {
            zcash_sign: PathBuf::from("/bin/zcash-sign"),
            devtool: PathBuf::from("/bin/zcash-devtool"),
            lightwalletd: "zec.rocks:443".into(),
            network: network.into(),
            konclave_signer: PathBuf::from("/bin/konclave-signer"),
            vaults_dir: PathBuf::from("/srv/vaults"),
            relays: Vec::new(),
            send_max_polls: DEFAULT_SEND_MAX_POLLS,
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

        assert!(
            load_device_keys(&dir, "v").unwrap().is_empty(),
            "starts empty"
        );

        assert!(add_device_key(&dir, "v", "aa11").unwrap(), "aa11 is new");
        assert!(add_device_key(&dir, "v", "bb22").unwrap(), "bb22 is new");
        assert!(
            !add_device_key(&dir, "v", "aa11").unwrap(),
            "a duplicate registration is not new (idempotent)",
        );

        let mut keys = load_device_keys(&dir, "v").unwrap();
        keys.sort();
        assert_eq!(
            keys,
            vec!["aa11".to_string(), "bb22".to_string()],
            "the set holds both distinct keys, the duplicate collapsed",
        );
        // A different vault has its own set.
        assert!(load_device_keys(&dir, "other").unwrap().is_empty());
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

    fn rename_dir(tag: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("konclave-{tag}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        dir
    }

    /// #575 through a rename. A name no seat held, planted while the vault took unsigned writes,
    /// counted for nobody - until a member renamed themselves to it, and its approval became theirs.
    /// Here bob never approved and the 2-of-2 would read `ready`. A recorded name is taken.
    #[test]
    fn a_rename_cannot_take_a_name_a_payment_records_under_no_seat() {
        let dir = rename_dir("rename-planted");
        save_members(&dir, "v", &["alice".into(), "bob".into()]).unwrap();
        let mut p = mk_prop("v", "p1");
        p.total = 2;
        p.approvals = vec!["alice".into(), "robert".into()];
        save_proposal(&dir, &p).unwrap();
        let mut q = mk_prop("v", "p2");
        q.proposer = "zed".into();
        q.refusals = vec!["kim".into()];
        save_proposal(&dir, &q).unwrap();

        for planted in ["robert", "robert ", "zed", "kim"] {
            let err = rename_member(&dir, "v", "bob", planted, 200).unwrap_err();
            assert!(
                err.to_string().contains("already recorded on a payment"),
                "{planted:?}: {err}"
            );
        }
        let got = load_proposal(&dir, "v", "p1", 200).unwrap();
        assert_eq!(got.state, "pending", "bob never approved");
        assert_eq!(load_members(&dir, "v"), vec!["alice", "bob"]);
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// Two seats under one name: an entry under it could be either seat's, so a rename of one of
    /// them must not carry it. Carried, seat 2's approval became seat 1's, seat 2 approved again,
    /// and one member took the 2-of-2 to `ready`. Dropped, both vote again.
    #[test]
    fn a_rename_of_one_of_two_seats_under_one_name_carries_no_vote() {
        let dir = rename_dir("rename-twin");
        save_members(&dir, "v", &["bob".into(), "bob ".into()]).unwrap();
        let mut p = mk_prop("v", "p1");
        p.total = 2;
        p.proposer = "bob ".into();
        p.approvals = vec!["bob ".into()];
        save_proposal(&dir, &p).unwrap();

        rename_member(&dir, "v", "bob", "robert", 200).unwrap();

        let mut got = load_proposal(&dir, "v", "p1", 200).unwrap();
        assert!(got.approvals.is_empty(), "{:?}", got.approvals);
        assert_eq!(got.proposer, "bob ", "nor the authorship");
        let roster = load_members(&dir, "v");
        assert!(got.vote("bob ", true, 200, &roster));
        assert_eq!(got.state, "pending", "one member, one approval");
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// A rename never reopens what the group decided. Two seats with the identical name are
    /// renamed together, so they are one name and their refusal moves with them; two whose names
    /// differ only at the edges keep the refusal where it was, since dropping it would bring a
    /// refused payment back to the desk.
    #[test]
    fn a_rename_never_reopens_a_refused_payment() {
        for (roster, refusals) in [
            (["bob", "bob", "carol"], vec!["bob", "carol"]),
            (["bob", "bob ", "carol"], vec!["bob ", "carol"]),
            // Both edge twins refusing, as a record from before this build can hold.
            (["bob", "bob ", "carol"], vec!["bob", "bob "]),
        ] {
            let dir = rename_dir("rename-refused");
            let roster: Vec<String> = roster.iter().map(|n| n.to_string()).collect();
            save_members(&dir, "v", &roster).unwrap();
            let mut p = mk_prop("v", "p1");
            p.approvals = vec![];
            p.refusals = refusals.iter().map(|n| n.to_string()).collect();
            save_proposal(&dir, &p).unwrap();
            assert_eq!(
                load_proposal(&dir, "v", "p1", 200).unwrap().state,
                "refused"
            );

            rename_member(&dir, "v", "bob", "robert", 200).unwrap();

            let got = load_proposal(&dir, "v", "p1", 200).unwrap();
            assert_eq!(got.state, "refused", "{roster:?}: {:?}", got.refusals);
            let _ = std::fs::remove_dir_all(&dir);
        }
    }

    /// The refusal of an edge twin who renames stays theirs: left under the shared spelling, the
    /// other seat's next vote replaced it, and one member's vote erased another's.
    #[test]
    fn a_renamed_twins_refusal_stays_theirs() {
        let dir = rename_dir("rename-twin-refusal");
        save_members(&dir, "v", &["bob".into(), "bob ".into()]).unwrap();
        let mut p = mk_prop("v", "p1");
        p.total = 2;
        p.approvals = vec![];
        p.refusals = vec!["bob".into()];
        save_proposal(&dir, &p).unwrap();

        let roster = rename_member(&dir, "v", "bob", "robert", 200).unwrap();
        let mut got = load_proposal(&dir, "v", "p1", 200).unwrap();
        assert!(got.vote("bob ", true, 200, &roster));
        assert_eq!(got.refusals, vec!["robert"]);
        assert_eq!(got.state, "refused");
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// An expired payment is a record too: a rename moves the name exactly and removes nothing,
    /// even where another seat shares the name.
    #[test]
    fn a_rename_moves_the_name_in_an_expired_payment_and_removes_nothing() {
        let dir = rename_dir("rename-expired");
        save_members(&dir, "v", &["bob".into(), "bob ".into()]).unwrap();
        let mut p = mk_prop("v", "p1");
        p.expiry_unix = 150;
        p.approvals = vec!["bob".into(), "bob ".into()];
        save_proposal(&dir, &p).unwrap();

        rename_member(&dir, "v", "bob", "robert", 200).unwrap();

        let got = load_proposal(&dir, "v", "p1", 200).unwrap();
        assert_eq!(got.approvals, vec!["robert", "bob "]);
        assert_eq!(got.state, "expired");
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// A sent payment is a record of what happened: a rename moves the name in it and removes
    /// nothing.
    #[test]
    fn a_rename_moves_the_name_in_a_sent_payment_and_removes_nothing() {
        let dir = rename_dir("rename-sent");
        save_members(&dir, "v", &["alice".into(), "bob".into()]).unwrap();
        let mut p = mk_prop("v", "p1");
        p.state = "sent".into();
        p.approvals = vec!["alice".into(), "bob".into(), "bob ".into()];
        save_proposal(&dir, &p).unwrap();

        rename_member(&dir, "v", "bob", "robert", 200).unwrap();

        let got = load_proposal(&dir, "v", "p1", 200).unwrap();
        assert_eq!(got.approvals, vec!["alice", "robert", "bob "]);
        assert_eq!(got.state, "sent");
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// A rename takes no name another seat holds, compared the way votes are. Otherwise carol, as
    /// `"bob"` beside a roster entry `"bob "`, would replace bob's vote with every vote of her own.
    #[test]
    fn a_rename_cannot_take_another_seats_name_under_another_spelling() {
        let dir = rename_dir("rename-taken");
        save_members(&dir, "v", &["alice".into(), "bob ".into(), "carol".into()]).unwrap();
        let err = rename_member(&dir, "v", "carol", "bob", 200).unwrap_err();
        assert!(err.to_string().contains("already taken"), "{err}");
        // Respelling your own name is still yours to do, even where your vote already reads as the
        // new spelling.
        let mut p = mk_prop("v", "p1");
        p.approvals = vec!["bob".into()];
        save_proposal(&dir, &p).unwrap();
        let roster = rename_member(&dir, "v", "bob ", "bob", 200).unwrap();
        assert_eq!(roster[1], "bob");
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// A rename carries every vote of its member, whatever spelling it was recorded under: an
    /// unsigned vote is recorded as sent, and a roster keeps names as they arrived.
    #[test]
    fn a_rename_carries_its_members_votes_under_any_spelling() {
        let dir = rename_dir("rename-spelling");
        save_members(&dir, "v", &["alice ".into(), "bob".into()]).unwrap();
        let mut p = mk_prop("v", "p1");
        p.total = 2;
        // Her proposal and her approval, under two spellings neither of which is the roster's.
        p.approvals = vec!["alice".into(), "bob".into(), "alice\u{a0}".into()];
        save_proposal(&dir, &p).unwrap();
        assert_eq!(load_proposal(&dir, "v", "p1", 200).unwrap().state, "ready");

        rename_member(&dir, "v", "alice ", "alicia", 200).unwrap();

        let got = load_proposal(&dir, "v", "p1", 200).unwrap();
        assert_eq!(got.approvals, vec!["alicia".to_string(), "bob".to_string()]);
        assert_eq!(got.proposer, "alicia");
        assert_eq!(got.state, "ready", "her approval still counts");
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// A record written before this build is counted as members when it is read, by every reader:
    /// `load_proposal`, which the send gate uses, and `list_proposals`, which the screens use.
    #[test]
    fn a_stored_record_is_counted_as_members_by_every_reader() {
        let dir = rename_dir("stored-record");
        save_members(&dir, "v", &["alice".into(), "bob".into(), "carol".into()]).unwrap();
        let mut p = mk_prop("v", "p1");
        p.state = "ready".into();
        p.approvals = vec!["alice ".into(), "alice".into()];
        // Two spellings of one refusal must not count as two, either: in a 2-of-3 that would make
        // the quorum unreachable and stamp the payment `refused`.
        p.refusals = vec!["bob ".into(), "bob".into(), "mallory".into()];
        save_proposal(&dir, &p).unwrap();

        assert_eq!(
            load_proposal(&dir, "v", "p1", 200).unwrap().state,
            "pending"
        );
        assert_eq!(list_proposals(&dir, "v", 200)[0].state, "pending");
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

    // ---- the files beside the registry: a cut write must leave the old file whole ---------------

    /// A write of the temporary file that is cut half way and fails.
    fn cut_write(tmp: &Path, bytes: &[u8]) -> std::io::Result<()> {
        std::fs::write(tmp, &bytes[..bytes.len() / 2])?;
        Err(std::io::Error::other("cut"))
    }

    fn no_stray_tmp(dir: &Path) -> bool {
        std::fs::read_dir(dir)
            .unwrap()
            .flatten()
            .all(|e| !e.file_name().to_string_lossy().ends_with(".tmp"))
    }

    fn fresh_vault(tag: &str) -> (PathBuf, String) {
        let dir = std::env::temp_dir().join(format!("konclave-sib-{tag}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        let v = "7".repeat(64);
        std::fs::create_dir_all(dir.join(&v)).unwrap();
        (dir, v)
    }

    /// The cut-write tests above call the `_with` variants, so they prove `replace_file`, not that
    /// each public function goes through it. A hard link to the old file keeps the old bytes only if
    /// the file was replaced and not rewritten in place.
    #[cfg(unix)]
    #[test]
    fn the_public_writers_replace_their_file_instead_of_rewriting_it() {
        use std::os::unix::fs::MetadataExt;
        let (dir, v) = fresh_vault("inode");
        let vault = dir.join(&v);
        let replaced = |name: &str, path: PathBuf, second: &dyn Fn()| {
            let link = vault.join(format!("old-{name}.link"));
            std::fs::hard_link(&path, &link).unwrap();
            let before = std::fs::read(&path).unwrap();
            let ino = std::fs::metadata(&path).unwrap().ino();
            second();
            assert_ne!(
                std::fs::read(&path).unwrap(),
                before,
                "{name}: the new content is there"
            );
            assert_eq!(
                std::fs::read(&link).unwrap(),
                before,
                "{name}: the old file was rewritten in place"
            );
            assert_ne!(
                std::fs::metadata(&path).unwrap().ino(),
                ino,
                "{name}: same file"
            );
        };
        set_read_key(&dir, &v, &"ab".repeat(32)).unwrap();
        replaced("read-key", read_key_path(&dir, &v), &|| {
            set_read_key(&dir, &v, &"cd".repeat(32)).unwrap()
        });
        save_members(&dir, &v, &["alice".into(), "bob".into()]).unwrap();
        replaced("members", members_path(&dir, &v), &|| {
            save_members(&dir, &v, &["carol".into(), "dave".into()]).unwrap()
        });
        burn_write_nonce(&dir, &v, "n1").unwrap();
        replaced("nonces", write_nonces_path(&dir, &v), &|| {
            burn_write_nonce(&dir, &v, "n2").unwrap()
        });
        let mut reg = VaultRegistration {
            vault_id: v.clone(),
            address: "u1old".into(),
            ufvk: "uview1old".into(),
            wallet_dir: "/w".into(),
            account: "acc".into(),
            threshold: 2,
            total: 3,
            change_receiver: "u1change".into(),
            birthday: Some(3_400_000),
            cp: None,
            created_at_unix: None,
        };
        save_registration(&dir, &reg).unwrap();
        reg.address = "u1new".into();
        replaced("registration", registration_path(&dir, &v), &|| {
            save_registration(&dir, &reg).unwrap()
        });
        let mk = |amount: u64| HelperProposal {
            id: "p1".into(),
            vault_id: v.clone(),
            kind: "payment".into(),
            to: "u1x".into(),
            amount_zat: amount,
            memo: None,
            lines: vec![],
            proposer: "alice".into(),
            state: "ready".into(),
            approvals: vec![],
            refusals: vec![],
            threshold: 2,
            total: 3,
            created_at_unix: 1_000,
            expiry_unix: 0,
            txid: None,
        };
        save_proposal(&dir, &mk(1_000)).unwrap();
        replaced("proposal", proposal_path(&dir, &v, "p1"), &|| {
            save_proposal(&dir, &mk(2_000)).unwrap()
        });
        std::fs::remove_dir_all(&dir).ok();
    }

    /// The comparison of a presented token with the key is bounded by length: an empty token, a prefix
    /// of the key and the key with something added must all be refused, and the key itself (with
    /// whitespace the app may add) accepted.
    #[test]
    fn a_read_token_must_be_exactly_the_key() {
        let (dir, v) = fresh_vault("tokenlen");
        let key = "ab".repeat(32);
        set_read_key(&dir, &v, &key).unwrap();
        assert!(read_authorized(&dir, &v, Some(&key)));
        assert!(read_authorized(&dir, &v, Some(&format!(" {key}\n"))));
        assert!(!read_authorized(&dir, &v, None));
        assert!(!read_authorized(&dir, &v, Some("")));
        assert!(!read_authorized(&dir, &v, Some(&key[..63])));
        assert!(!read_authorized(&dir, &v, Some(&key[..1])));
        assert!(!read_authorized(&dir, &v, Some(&format!("{key}0"))));
        assert!(!read_authorized(&dir, &v, Some(&"cd".repeat(32))));
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn a_cut_write_of_the_read_key_leaves_the_old_key() {
        let (dir, v) = fresh_vault("readkey");
        set_read_key(&dir, &v, &"ab".repeat(32)).unwrap();
        let r = set_read_key_with(&dir, &v, &"cd".repeat(32), cut_write);
        assert!(r.is_err());
        assert_eq!(load_read_key(&dir, &v), Some("ab".repeat(32)));
        assert!(no_stray_tmp(&dir.join(&v)));
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn a_cut_write_of_the_roster_leaves_the_old_roster() {
        let (dir, v) = fresh_vault("roster");
        let old = vec!["alice".to_string(), "bob".to_string()];
        save_members(&dir, &v, &old).unwrap();
        let r = save_members_with(
            &dir,
            &v,
            &["carol".to_string(), "dave".to_string()],
            cut_write,
        );
        assert!(r.is_err());
        assert_eq!(load_members(&dir, &v), old);
        assert!(no_stray_tmp(&dir.join(&v)));
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn a_cut_write_of_the_nonce_list_leaves_the_old_list() {
        let (dir, v) = fresh_vault("nonces");
        burn_write_nonce(&dir, &v, "n1").unwrap();
        let r = burn_write_nonce_with(&dir, &v, "n2", cut_write);
        assert!(r.is_err());
        assert_eq!(load_write_nonces(&dir, &v), vec!["n1".to_string()]);
        assert!(no_stray_tmp(&dir.join(&v)));
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn a_cut_write_of_the_registration_leaves_the_old_registration() {
        let (dir, v) = fresh_vault("registration");
        let mut reg = VaultRegistration {
            vault_id: v.clone(),
            address: "u1old".into(),
            ufvk: "uview1old".into(),
            wallet_dir: "/w".into(),
            account: "acc".into(),
            threshold: 2,
            total: 3,
            change_receiver: "u1change".into(),
            birthday: Some(3_400_000),
            cp: None,
            created_at_unix: None,
        };
        save_registration(&dir, &reg).unwrap();
        let before = std::fs::read(registration_path(&dir, &v)).unwrap();
        reg.address = "u1new".into();
        let r = save_registration_with(&dir, &reg, cut_write);
        assert!(r.is_err());
        assert_eq!(std::fs::read(registration_path(&dir, &v)).unwrap(), before);
        assert!(no_stray_tmp(&dir.join(&v)));
        std::fs::remove_dir_all(&dir).ok();
    }
}

#[cfg(test)]
mod change_receiver_tests {
    use super::{
        backfill_change_receivers, load_registration, save_registration, VaultRegistration,
    };

    fn creg(id: &str, ufvk: &str, change: &str) -> VaultRegistration {
        VaultRegistration {
            vault_id: id.to_string(),
            address: format!("u1addr{id}"),
            ufvk: ufvk.to_string(),
            wallet_dir: format!("/tmp/{id}/wallet"),
            account: "acct".into(),
            threshold: 2,
            total: 3,
            change_receiver: change.to_string(),
            birthday: Some(1),
            cp: None,
            created_at_unix: None,
        }
    }

    /// The boot backfill for the money gate (#281/#476). `register_vault` computes the change
    /// receiver, but only when a browser registers - which for a long-lived vault may be never, so
    /// every vault on the production volume still carries an empty one. The birthday hit exactly
    /// this and got a boot backfill in #445; this is the same fix for the same reason.
    ///
    /// Like that one it runs against a live volume, so what it must NOT do matters as much.
    #[test]
    fn the_change_receiver_backfill_fills_only_what_is_missing() {
        let dir = std::env::temp_dir().join(format!("konclave-cr-{}", std::process::id()));
        std::fs::remove_dir_all(&dir).ok();
        std::fs::create_dir_all(&dir).unwrap();

        let (a, b, c) = ("a".repeat(64), "b".repeat(64), "c".repeat(64));
        save_registration(&dir, &creg(&a, UFVK, "")).unwrap();
        save_registration(&dir, &creg(&b, UFVK, "u1already")).unwrap();
        // A UFVK that does not decode: there is nothing to derive, and inventing a receiver would
        // be worse than an empty one - an empty value means "unknown", which the device already
        // treats as "do not judge", while a wrong one would make the gate refuse real change.
        save_registration(&dir, &creg(&c, "uview1nonsense", "")).unwrap();

        assert_eq!(
            backfill_change_receivers(&dir, "main"),
            1,
            "only the derivable missing one"
        );

        let after = |id: &str| load_registration(&dir, id).expect("still loads");
        let filled = after(&a).change_receiver;
        assert!(!filled.is_empty(), "derived from the UFVK");
        assert_eq!(
            filled,
            change_receiver(UFVK, "main").unwrap(),
            "and it is THE change receiver"
        );
        assert_ne!(filled, after(&a).address, "never the receiving address");
        // Pinned by value: the string the implementation before the crate move (UnifiedAddress::from_receivers)
        // gave for this key, so rebuilding the address another way cannot change what a vault announces.
        assert_eq!(
            filled,
            "u1d06pafex5wdk529qnu4lnsdkukajnzncx27gn2t4a6mq7hj4tdx78xe4vl65n97hcq7n7tpu6dqz3kn49yrggdwh25ernx0sag0pvgn2",
        );
        assert_eq!(
            after(&b).change_receiver,
            "u1already",
            "an existing one is never rewritten"
        );
        assert_eq!(
            after(&c).change_receiver,
            "",
            "undecodable: left unknown, not invented"
        );

        // Nothing else about a registration is disturbed.
        assert_eq!(after(&a).ufvk, UFVK);
        assert_eq!(after(&a).birthday, Some(1));

        // Idempotent: a second boot fills nothing.
        assert_eq!(backfill_change_receivers(&dir, "main"), 0);
        assert_eq!(after(&a).change_receiver, filled);

        std::fs::remove_dir_all(&dir).ok();
    }

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

    // ---- REG-CREATION-MIN: what a registration records ------------------------------------------

    /// A `registration.json` written before the two fields existed must still load, with `None`
    /// for both: every vault on the volume is one of these.
    #[test]
    fn a_registration_written_before_cp_loads_with_none() {
        let old = r#"{"vault_id":"v","address":"u1x","ufvk":"uview","wallet_dir":"/w","account":"a",
            "threshold":2,"total":3,"change_receiver":"u1c","birthday":3400000}"#;
        let reg: VaultRegistration = serde_json::from_str(old).expect("an old record loads");
        assert_eq!(reg.cp, None);
        assert_eq!(reg.created_at_unix, None);
        // And the new fields survive a round trip.
        let mut reg = reg;
        reg.cp = Some(2);
        reg.created_at_unix = Some(1_791_000_000);
        let back: VaultRegistration =
            serde_json::from_str(&serde_json::to_string(&reg).unwrap()).unwrap();
        assert_eq!(
            (back.cp, back.created_at_unix),
            (Some(2), Some(1_791_000_000))
        );
    }

    /// The registration that creates a vault records the `cp` it declared and when it happened; a
    /// later registration of the same key keeps what the first one recorded.
    #[cfg(unix)]
    #[test]
    fn register_vault_records_cp_once() {
        use std::os::unix::fs::PermissionsExt;
        let dir = std::env::temp_dir().join(format!("konclave-register-cp-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).expect("create temp dir");
        let write_exe = |name: &str, body: &str| {
            let p = dir.join(name);
            std::fs::write(&p, body).unwrap();
            std::fs::set_permissions(&p, std::fs::Permissions::from_mode(0o755)).unwrap();
            p
        };
        let sign = write_exe(
            "fake-sign",
            "#!/bin/sh\necho 'Orchard-only unified address: \"u1fakeaddress\"'\necho 'Unified Full Viewing Key: \"uviewfake\"'\n",
        );
        let devtool = write_exe(
            "fake-devtool",
            "#!/bin/sh\ncase \"$4\" in\n  init-fvk) mkdir -p \"$3\"; printf 'network = \"main\"\\nbirthday = 3400000\\n' > \"$3/keys.toml\" ;;\n  list-addresses) echo 'Account AccountUuid(11111111-1111-1111-1111-111111111111)' ;;\nesac\n",
        );
        for p in [&sign, &devtool] {
            // See the helper-server twin of this test: a fork by another test thread can leave the
            // script "busy" for a moment after it is written.
            for _ in 0..200 {
                match std::process::Command::new(p).arg("--probe").output() {
                    Err(e) if e.raw_os_error() == Some(26) => {
                        std::thread::sleep(std::time::Duration::from_millis(10));
                    }
                    _ => break,
                }
            }
        }
        let cfg = HelperConfig {
            zcash_sign: sign,
            devtool,
            lightwalletd: "unused:443".into(),
            network: "main".into(),
            konclave_signer: PathBuf::from("/unused"),
            vaults_dir: dir.join("vaults"),
            relays: Vec::new(),
            send_max_polls: DEFAULT_SEND_MAX_POLLS,
        };
        let key = format!("{:064x}", 0xabc);
        let before = now_secs();
        let first = register_vault(&cfg, &key, "v", 2, 3, Some(2)).expect("registers");
        assert_eq!(first.cp, Some(2));
        let at = first.created_at_unix.expect("the time is recorded");
        assert!(at >= before && at <= now_secs() + 1, "{at}");
        // It is on disk, in the half of the vault that is backed up.
        let stored = load_registration(&cfg.vaults_dir, &key).expect("persisted");
        assert_eq!((stored.cp, stored.created_at_unix), (Some(2), Some(at)));
        // Registered again, by a client that declares nothing: the record is the one that made it.
        let again = register_vault(&cfg, &key, "v", 2, 3, None).expect("idempotent");
        assert_eq!((again.cp, again.created_at_unix), (Some(2), Some(at)));
        // Registered again by a client that declares a DIFFERENT one: still the first.
        let other = register_vault(&cfg, &key, "v", 2, 3, Some(9)).expect("idempotent");
        assert_eq!((other.cp, other.created_at_unix), (Some(2), Some(at)));
        assert_eq!(
            load_registration(&cfg.vaults_dir, &key).unwrap().cp,
            Some(2)
        );
        // A key registered with no cp records none, and still records when.
        let key2 = format!("{:064x}", 0xdef);
        let bare = register_vault(&cfg, &key2, "v", 2, 3, None).expect("registers");
        assert_eq!(bare.cp, None);
        assert!(bare.created_at_unix.is_some());
        let _ = std::fs::remove_dir_all(&dir);
    }

    // ---- a registration that cannot be recorded is not a registration ----------------------------

    /// Fake tools that behave like the real ones where it matters here: `init-fvk` REFUSES a wallet
    /// directory that already holds a `keys.toml` (zcash-devtool `config.rs`: `create_new(true)`),
    /// writes that file BEFORE the SQLite file (a file `init-fails` next to it makes it stop there,
    /// the way a full volume stops that one), a file `block-registration` makes a DIRECTORY appear at
    /// `registration.json` during the attempt (a write that then cannot succeed, with the real
    /// writer), `zcash-sign` answers a new
    /// address on every call (the identity is minted at random), and the signer leaves a marker so a
    /// test can tell whether the engine ran at all. A `--probe` run changes nothing.
    #[cfg(unix)]
    fn n1_fixture(name: &str) -> (HelperConfig, PathBuf) {
        use std::os::unix::fs::PermissionsExt;
        let dir = std::env::temp_dir().join(format!("konclave-n1-{}-{name}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).expect("create temp dir");
        let write_exe = |file: &str, body: &str| {
            let p = dir.join(file);
            std::fs::write(&p, body).unwrap();
            std::fs::set_permissions(&p, std::fs::Permissions::from_mode(0o755)).unwrap();
            for _ in 0..200 {
                match std::process::Command::new(&p).arg("--probe").output() {
                    Err(e) if e.raw_os_error() == Some(26) => {
                        std::thread::sleep(std::time::Duration::from_millis(10));
                    }
                    _ => break,
                }
            }
            p
        };
        let marker = dir.join("engine-ran");
        let counter = dir.join("identities");
        let sign = write_exe(
            "fake-sign",
            &format!(
                "#!/bin/sh\n[ \"$1\" = \"--probe\" ] && exit 0\ntouch '{m}'\nn=$(cat '{c}' 2>/dev/null || echo 0)\nn=$((n+1))\necho $n > '{c}'\necho \"Orchard-only unified address: \\\"u1fake$n\\\"\"\necho \"Unified Full Viewing Key: \\\"uviewfake$n\\\"\"\n",
                m = marker.display(),
                c = counter.display()
            ),
        );
        let devtool = write_exe(
            "fake-devtool",
            "#!/bin/sh\ncase \"$4\" in\n  init-fvk) mkdir -p \"$3\"; if [ -e \"$3/keys.toml\" ]; then echo 'File exists (os error 17)' >&2; exit 1; fi; printf 'network = \"main\"\\nbirthday = 3400000\\n' > \"$3/keys.toml\"; if [ -e \"$(dirname \"$0\")/block-registration\" ]; then mkdir -p \"$(dirname \"$3\")/registration.json\"; fi; if [ -e \"$(dirname \"$0\")/init-fails\" ]; then echo 'disk full' >&2; exit 1; fi ;;\n  list-addresses) echo 'Account AccountUuid(11111111-1111-1111-1111-111111111111)' ;;\nesac\n",
        );
        let cfg = HelperConfig {
            zcash_sign: sign,
            devtool,
            lightwalletd: "unused:443".into(),
            network: "main".into(),
            konclave_signer: PathBuf::from("/unused"),
            vaults_dir: dir.join("vaults"),
            relays: Vec::new(),
            send_max_polls: DEFAULT_SEND_MAX_POLLS,
        };
        (cfg, dir)
    }

    /// The names of the wallet directories a failed registration moved aside.
    #[cfg(unix)]
    fn n1_leftovers(vaults_dir: &Path, key: &str) -> Vec<String> {
        let mut out: Vec<String> = std::fs::read_dir(vaults_dir.join(key))
            .map(|rd| {
                rd.flatten()
                    .filter_map(|e| e.file_name().to_str().map(str::to_string))
                    .filter(|n| n.starts_with("wallet.unpersisted-"))
                    .collect()
            })
            .unwrap_or_default();
        out.sort();
        out
    }

    #[cfg(unix)]
    fn n1_registration(key: &str, wallet: &Path) -> VaultRegistration {
        VaultRegistration {
            vault_id: key.to_string(),
            address: "u1x".into(),
            ufvk: "uview".into(),
            wallet_dir: wallet.display().to_string(),
            account: "a".into(),
            threshold: 2,
            total: 3,
            change_receiver: "u1c".into(),
            birthday: None,
            cp: None,
            created_at_unix: None,
        }
    }

    /// THE HOLE. The registration used to be written with `let _ =`, so a write that failed (a full
    /// or read-only volume) still returned Ok: the vault was served from memory with an address that
    /// no restart would find. The writer is made to fail with the real one: a DIRECTORY appears at
    /// `registration.json` during the attempt, so the final rename cannot succeed (and, unlike a
    /// permission bit, this also fails when the tests run as root).
    #[cfg(unix)]
    #[test]
    fn a_registration_that_cannot_be_written_is_not_a_registration() {
        let (cfg, dir) = n1_fixture("unwritable");
        let key = format!("{:064x}", 0x1111);
        std::fs::write(dir.join("block-registration"), "").unwrap();

        let err = register_vault(&cfg, &key, "v", 2, 3, Some(2)).expect_err("must not be Ok");
        assert!(matches!(err, RegisterError::NotPersisted(_)), "{err:?}");
        // Nothing a restart could load, nothing served.
        assert!(load_registration(&cfg.vaults_dir, &key).is_none());
        // The attempt's wallet is set aside, not left where the next `init-fvk` would trip on it.
        assert!(!cfg.vaults_dir.join(&key).join("wallet").exists());
        assert_eq!(n1_leftovers(&cfg.vaults_dir, &key).len(), 1);
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// The retry has to be able to work: with an engine that refuses an existing wallet directory,
    /// leaving it in place would make every later attempt fail. After the volume heals, the same id
    /// registers, with a NEW identity (the first one was never served or stored).
    #[cfg(unix)]
    #[test]
    fn after_a_failed_write_the_same_vault_can_register_again_with_a_new_identity() {
        let (cfg, dir) = n1_fixture("retry");
        let key = format!("{:064x}", 0x2222);
        let blocker = cfg.vaults_dir.join(&key).join("registration.json");
        std::fs::write(dir.join("block-registration"), "").unwrap();
        assert!(register_vault(&cfg, &key, "v", 2, 3, None).is_err());

        // The volume is healthy again.
        std::fs::remove_file(dir.join("block-registration")).unwrap();
        std::fs::remove_dir(&blocker).unwrap();
        let reg = register_vault(&cfg, &key, "v", 2, 3, None).expect("the retry registers");
        assert_eq!(
            reg.address, "u1fake2",
            "a new identity, the first was never served"
        );
        let stored = load_registration(&cfg.vaults_dir, &key).expect("persisted this time");
        assert_eq!(stored.address, "u1fake2");
        assert!(cfg
            .vaults_dir
            .join(&key)
            .join("wallet")
            .join("keys.toml")
            .exists());
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// The seam: a failing writer is `NotPersisted`, nothing is written, the wallet is set aside.
    /// If the wallet cannot be set aside either, the answer says so and the directory stays put. If
    /// there is no wallet directory there is nothing to move, and moving is not even attempted.
    #[cfg(unix)]
    #[test]
    fn a_failed_write_sets_the_wallet_aside_and_says_so_when_it_cannot() {
        let (cfg, dir) = n1_fixture("seam");
        let key = format!("{:064x}", 0x3333);
        let wallet = cfg.vaults_dir.join(&key).join("wallet");
        std::fs::create_dir_all(&wallet).unwrap();
        let reg = n1_registration(&key, &wallet);
        let full = |_: &Path, _: &[u8]| -> std::io::Result<()> {
            Err(std::io::Error::new(
                std::io::ErrorKind::StorageFull,
                "no space left on device",
            ))
        };

        // The rename fails too: CleanupFailed, and the directory is where it was.
        let stuck = persist_new_registration_with(&cfg.vaults_dir, &reg, full, |_, _| {
            Err(std::io::Error::new(
                std::io::ErrorKind::PermissionDenied,
                "read-only",
            ))
        });
        assert!(
            matches!(stuck, Err(RegisterError::CleanupFailed)),
            "{stuck:?}"
        );
        assert!(wallet.exists());

        // The rename works: NotPersisted, and the wallet moved.
        let moved = persist_new_registration_with(&cfg.vaults_dir, &reg, full, |a, b| {
            std::fs::rename(a, b)
        });
        assert!(
            matches!(moved, Err(RegisterError::NotPersisted(_))),
            "{moved:?}"
        );
        assert!(!wallet.exists());
        assert_eq!(n1_leftovers(&cfg.vaults_dir, &key).len(), 1);
        assert!(load_registration(&cfg.vaults_dir, &key).is_none());

        // No wallet directory (the engine failed before making one): NotPersisted, and the rename
        // that would have failed is never called.
        let none = persist_new_registration_with(&cfg.vaults_dir, &reg, full, |_, _| {
            panic!("there is nothing to rename")
        });
        assert!(
            matches!(none, Err(RegisterError::NotPersisted(_))),
            "{none:?}"
        );
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// A second failure in the same second must not try to rename onto the first's directory.
    #[cfg(unix)]
    #[test]
    fn a_name_that_is_taken_is_skipped_when_a_wallet_is_set_aside() {
        let dir = std::env::temp_dir().join(format!("konclave-n1-{}-names", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        assert_eq!(
            free_aside_name(&dir, 100),
            dir.join("wallet.unpersisted-100")
        );
        std::fs::create_dir_all(dir.join("wallet.unpersisted-100")).unwrap();
        assert_eq!(
            free_aside_name(&dir, 100),
            dir.join("wallet.unpersisted-100-1")
        );
        std::fs::create_dir_all(dir.join("wallet.unpersisted-100-1")).unwrap();
        assert_eq!(
            free_aside_name(&dir, 100),
            dir.join("wallet.unpersisted-100-2")
        );
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// A volume that is full must not grow with every attempt: three leftovers per vault, and the
    /// fourth attempt is refused BEFORE the engine runs (so nothing new is created).
    #[cfg(unix)]
    #[test]
    fn leftovers_are_bounded_and_the_fourth_attempt_creates_nothing() {
        let (cfg, dir) = n1_fixture("bounded");
        let key = format!("{:064x}", 0x4444);
        let vault = cfg.vaults_dir.join(&key);
        for n in 1..=3 {
            std::fs::create_dir_all(vault.join(format!("wallet.unpersisted-{n}"))).unwrap();
        }
        let err = register_vault(&cfg, &key, "v", 2, 3, None).expect_err("refused");
        assert!(matches!(err, RegisterError::CleanupFailed), "{err:?}");
        assert!(!dir.join("engine-ran").exists(), "the engine did not run");
        assert!(!vault.join("wallet").exists());
        assert_eq!(n1_leftovers(&cfg.vaults_dir, &key).len(), 3);
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// The engine writes `keys.toml` first and can still fail after it (the volume filling up under
    /// the wallet's database). That attempt is the same as a failed write: its directory is set
    /// aside, so the vault is not locked out of registering by its own failed first try.
    #[cfg(unix)]
    #[test]
    fn an_engine_failure_after_the_wallet_was_started_does_not_lock_the_vault_out() {
        let (cfg, dir) = n1_fixture("engine-partial");
        let key = format!("{:064x}", 0x7777);
        std::fs::write(dir.join("init-fails"), "").unwrap();
        let err = register_vault(&cfg, &key, "v", 2, 3, None).expect_err("the engine failed");
        assert!(matches!(err, RegisterError::Engine(_)), "{err:?}");
        assert!(!cfg.vaults_dir.join(&key).join("wallet").exists());
        assert_eq!(n1_leftovers(&cfg.vaults_dir, &key).len(), 1);

        std::fs::remove_file(dir.join("init-fails")).unwrap();
        let reg = register_vault(&cfg, &key, "v", 2, 3, None).expect("the retry registers");
        assert_eq!(reg.address, "u1fake2");
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// A wallet directory with no registration may be the only copy of a served vault's viewing key
    /// (this coordinator served such vaults before a failed write was refused). It is refused, not
    /// moved and not initialised over, and the engine does not run.
    #[cfg(unix)]
    #[test]
    fn a_wallet_directory_with_no_registration_is_refused_and_left_alone() {
        let (cfg, dir) = n1_fixture("orphan");
        let key = format!("{:064x}", 0x8888);
        let wallet = cfg.vaults_dir.join(&key).join("wallet");
        std::fs::create_dir_all(&wallet).unwrap();
        std::fs::write(wallet.join("data.sqlite"), "THE ONLY COPY").unwrap();

        let err = register_vault(&cfg, &key, "v", 2, 3, None).expect_err("refused");
        assert!(matches!(err, RegisterError::CleanupFailed), "{err:?}");
        assert!(!dir.join("engine-ran").exists(), "the engine did not run");
        assert_eq!(
            std::fs::read_to_string(wallet.join("data.sqlite")).unwrap(),
            "THE ONLY COPY"
        );
        assert!(n1_leftovers(&cfg.vaults_dir, &key).is_empty());
        assert_eq!(
            registrations_needing_attention(&cfg.vaults_dir).0,
            vec![key[..8].to_string()]
        );
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// A birthday that is read from `keys.toml` but cannot be written does not fail a vault that is
    /// served from its stored record: the registration comes back with the birthday, the record on
    /// disk is as it was, and the boot backfill writes it later. Driven THROUGH `register_vault`
    /// (the write is the seam), so the call site is what is tested, not a wrapper of it.
    #[cfg(unix)]
    #[test]
    fn a_birthday_that_cannot_be_recorded_does_not_fail_a_stored_vault() {
        let (cfg, dir) = n1_fixture("birthday");
        let key = format!("{:064x}", 0x5555);
        let wallet = cfg.vaults_dir.join(&key).join("wallet");
        std::fs::create_dir_all(&wallet).unwrap();
        std::fs::write(
            wallet.join("keys.toml"),
            "network = \"main\"\nbirthday = 3400000\n",
        )
        .unwrap();
        save_registration(&cfg.vaults_dir, &n1_registration(&key, &wallet)).unwrap();
        let full = |_: &Path, _: &[u8]| -> std::io::Result<()> {
            Err(std::io::Error::new(std::io::ErrorKind::StorageFull, "full"))
        };

        let reg = register_vault_with(&cfg, &key, "v", 2, 3, None, full, |a, b| {
            std::fs::rename(a, b)
        })
        .expect("a stored vault is still returned");
        assert_eq!(reg.birthday, Some(3_400_000));
        assert_eq!(
            load_registration(&cfg.vaults_dir, &key).unwrap().birthday,
            None
        );
        // The boot backfill picks it up, and the engine never ran.
        assert_eq!(backfill_birthdays(&cfg.vaults_dir), 1);
        assert_eq!(
            load_registration(&cfg.vaults_dir, &key).unwrap().birthday,
            Some(3_400_000)
        );
        assert!(!dir.join("engine-ran").exists());
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// Every line of the registration path names a vault by its 8-character prefix.
    #[test]
    fn a_registration_log_line_names_the_vault_by_its_prefix_only() {
        let key = format!("{:0<64}", "abcdef12");
        let line = vault_log_line(&key, "registration refused");
        assert!(
            line.contains("abcdef12") && !line.contains("abcdef120"),
            "{line}"
        );
        assert!(line.contains(short_id(&key)), "{line}");
        assert!(!line.contains(&key), "{line}");
        // And the registration function has no bare `eprintln!`: a line goes through `log_vault`.
        let src = include_str!("helper.rs");
        let from = src.find("fn register_vault_with(").expect("the function");
        let to = from
            + src[from..]
                .find("/// Build the vault's view-only wallet")
                .expect("its end");
        assert_eq!(
            src[from..to].matches("eprintln!(").count(),
            0,
            "a log line in the registration path goes through `log_vault`"
        );
    }

    /// A dangling symlink where `wallet/` goes is "in the way": it cannot be told not to be there.
    #[cfg(unix)]
    #[test]
    fn a_dangling_symlink_at_wallet_is_refused_before_the_engine() {
        let (cfg, dir) = n1_fixture("symlink");
        let key = format!("{:064x}", 0xa301);
        let vault = cfg.vaults_dir.join(&key);
        std::fs::create_dir_all(&vault).unwrap();
        std::os::unix::fs::symlink("/nonexistent-konclave-target", vault.join("wallet")).unwrap();
        let err = register_vault(&cfg, &key, "v", 2, 3, None).expect_err("refused");
        assert!(matches!(err, RegisterError::CleanupFailed), "{err:?}");
        assert!(!dir.join("engine-ran").exists(), "the engine did not run");
        assert!(
            vault.join("wallet").symlink_metadata().is_ok(),
            "left alone"
        );
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// A vault directory with no registration and no wallet (members, proposals, a bare directory) is
    /// not an orphan, and neither is one with a FILE named wallet.
    #[cfg(unix)]
    #[test]
    fn a_vault_directory_without_a_wallet_directory_is_not_listed_as_an_orphan() {
        let (cfg, dir) = n1_fixture("nowallet");
        let key = format!("{:0<64}", "dddddddd");
        std::fs::create_dir_all(cfg.vaults_dir.join(&key).join("proposals")).unwrap();
        std::fs::write(cfg.vaults_dir.join(&key).join("members.json"), "{}").unwrap();
        let key2 = format!("{:0<64}", "eeeeeeee");
        std::fs::create_dir_all(cfg.vaults_dir.join(&key2)).unwrap();
        std::fs::write(cfg.vaults_dir.join(&key2).join("wallet"), "x").unwrap();
        let (orphans, unreadable) = registrations_needing_attention(&cfg.vaults_dir);
        assert!(orphans.is_empty(), "{orphans:?}");
        assert!(unreadable.is_empty(), "{unreadable:?}");
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// "Set aside" means MOVED, never deleted: what was in the wallet is in the leftover.
    #[cfg(unix)]
    #[test]
    fn a_set_aside_wallet_keeps_its_contents() {
        let (cfg, dir) = n1_fixture("keeps");
        let key = format!("{:064x}", 0xc601);
        let wallet = cfg.vaults_dir.join(&key).join("wallet");
        std::fs::create_dir_all(&wallet).unwrap();
        std::fs::write(wallet.join("data.sqlite"), "VIEWING DATA").unwrap();
        let reg = n1_registration(&key, &wallet);
        let full = |_: &Path, _: &[u8]| -> std::io::Result<()> {
            Err(std::io::Error::new(std::io::ErrorKind::StorageFull, "full"))
        };
        let r = persist_new_registration_with(&cfg.vaults_dir, &reg, full, |a, b| {
            std::fs::rename(a, b)
        });
        assert!(matches!(r, Err(RegisterError::NotPersisted(_))));
        let left = n1_leftovers(&cfg.vaults_dir, &key);
        assert_eq!(left.len(), 1);
        assert_eq!(
            std::fs::read_to_string(cfg.vaults_dir.join(&key).join(&left[0]).join("data.sqlite"))
                .unwrap(),
            "VIEWING DATA"
        );
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// Two leftovers do not lock the vault: the cap is three, and a healthy volume registers.
    #[cfg(unix)]
    #[test]
    fn two_leftovers_do_not_block_a_healthy_registration() {
        let (cfg, dir) = n1_fixture("two");
        let key = format!("{:064x}", 0xb201);
        for n in 1..=2 {
            std::fs::create_dir_all(
                cfg.vaults_dir
                    .join(&key)
                    .join(format!("wallet.unpersisted-{n}")),
            )
            .unwrap();
        }
        let reg = register_vault(&cfg, &key, "v", 2, 3, None).expect("two leftovers are allowed");
        assert_eq!(reg.address, "u1fake1");
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// Two failures in the same second are both set aside: the second takes a `-1` name, through the
    /// real call site and not only through `free_aside_name`.
    #[cfg(unix)]
    #[test]
    fn a_second_failure_in_the_same_second_is_set_aside_too() {
        let (cfg, dir) = n1_fixture("samesec");
        let key = format!("{:064x}", 0xc901);
        let full = |_: &Path, _: &[u8]| -> std::io::Result<()> {
            Err(std::io::Error::new(std::io::ErrorKind::StorageFull, "full"))
        };
        // This second's bare name and the next second's (the clock may roll over).
        let t = now_secs();
        for s in [t, t + 1] {
            std::fs::create_dir_all(
                cfg.vaults_dir
                    .join(&key)
                    .join(format!("wallet.unpersisted-{s}")),
            )
            .unwrap();
        }
        let e = register_vault_with(&cfg, &key, "v", 2, 3, None, full, |a, b| {
            std::fs::rename(a, b)
        })
        .expect_err("failing");
        assert!(matches!(e, RegisterError::NotPersisted(_)), "{e:?}");
        assert_eq!(n1_leftovers(&cfg.vaults_dir, &key).len(), 3);
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// On a healthy volume a stored vault gets its birthday written (the success path of the
    /// shortcut, which the failing-write test cannot see).
    #[cfg(unix)]
    #[test]
    fn a_stored_vault_gets_its_birthday_recorded_on_a_healthy_volume() {
        let (cfg, dir) = n1_fixture("birthday-ok");
        let key = format!("{:064x}", 0x5a55);
        let wallet = cfg.vaults_dir.join(&key).join("wallet");
        std::fs::create_dir_all(&wallet).unwrap();
        std::fs::write(
            wallet.join("keys.toml"),
            "network = \"main\"\nbirthday = 3400000\n",
        )
        .unwrap();
        save_registration(&cfg.vaults_dir, &n1_registration(&key, &wallet)).unwrap();
        let reg = register_vault(&cfg, &key, "v", 2, 3, None).unwrap();
        assert_eq!(reg.birthday, Some(3_400_000));
        assert_eq!(
            load_registration(&cfg.vaults_dir, &key).unwrap().birthday,
            Some(3_400_000)
        );
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// No raw print macro on the registration path or in the boot backfills, outside `log_vault`
    /// itself: a new line goes through the one function that names a vault by its prefix.
    #[test]
    fn the_registration_path_and_the_boot_backfills_print_only_through_log_vault() {
        let src = include_str!("helper.rs");
        let production = src
            .split("\n#[cfg(test)]\nmod change_receiver_tests")
            .next()
            .unwrap();
        let mut spans: Vec<&str> = Vec::new();
        // The two boot backfills (birthday and change receiver), whole.
        let from = production
            .find("pub fn backfill_birthdays(")
            .expect("backfill_birthdays");
        let to = from
            + production[from..]
                .find("/// What a booting helper needs from its volume")
                .expect("end of the backfills");
        spans.push(&production[from..to]);
        // The registration path, without `log_vault`'s own body.
        let from = production
            .find("fn register_vault_with(")
            .expect("register_vault_with");
        let to = from
            + production[from..]
                .find("/// The time a registration is recorded as made")
                .expect("end of the registration path");
        let whole = &production[from..to];
        let lv = whole.find("fn log_vault(").expect("log_vault");
        let lv_end = lv + whole[lv..].find("\n}\n").expect("end of log_vault");
        spans.push(&whole[..lv]);
        spans.push(&whole[lv_end..]);
        for span in spans {
            for m in ["eprintln!(", "eprint!(", "println!(", "print!(", "dbg!("] {
                assert_eq!(span.matches(m).count(), 0, "{m} outside log_vault");
            }
        }
    }

    /// Every line the registration path logs for a failure names the vault by its prefix and carries
    /// neither a path (the wallet's holds the whole id) nor the engine's own text.
    #[cfg(unix)]
    #[test]
    fn registration_log_lines_carry_no_whole_id_no_path_and_no_engine_text() {
        let (cfg, dir) = n1_fixture("sink");
        let full = |_: &Path, _: &[u8]| -> std::io::Result<()> {
            Err(std::io::Error::new(
                std::io::ErrorKind::StorageFull,
                "no space left on device",
            ))
        };
        let denied = |_: &Path, _: &Path| -> std::io::Result<()> {
            Err(std::io::Error::new(
                std::io::ErrorKind::PermissionDenied,
                "read-only",
            ))
        };
        LOG_SINK.with(|s| *s.borrow_mut() = Some(Vec::new()));
        let k1 = format!("{:064x}", 0xfeed_0001u64);
        let k2 = format!("{:064x}", 0xfeed_0002u64);
        let k3 = format!("{:064x}", 0xfeed_0003u64);
        let k4 = format!("{:064x}", 0xfeed_0004u64);
        let k5 = format!("{:064x}", 0xfeed_0005u64);
        let k6 = format!("{:064x}", 0xfeed_0006u64);
        // The write fails, then the set-aside works / fails.
        let _ = register_vault_with(&cfg, &k1, "v", 2, 3, None, full, |a, b| {
            std::fs::rename(a, b)
        });
        let _ = register_vault_with(&cfg, &k2, "v", 2, 3, None, full, denied);
        // The engine fails, then the set-aside works / fails.
        std::fs::write(dir.join("init-fails"), "").unwrap();
        let _ = register_vault_with(&cfg, &k3, "v", 2, 3, None, write_synced, |a, b| {
            std::fs::rename(a, b)
        });
        let _ = register_vault_with(&cfg, &k4, "v", 2, 3, None, write_synced, denied);
        // A stored vault whose birthday cannot be written.
        let wallet = cfg.vaults_dir.join(&k5).join("wallet");
        std::fs::create_dir_all(&wallet).unwrap();
        std::fs::write(
            wallet.join("keys.toml"),
            "network = \"main\"\nbirthday = 3400000\n",
        )
        .unwrap();
        save_registration(&cfg.vaults_dir, &n1_registration(&k5, &wallet)).unwrap();
        let _ = register_vault_with(&cfg, &k5, "v", 2, 3, None, full, |a, b| {
            std::fs::rename(a, b)
        });
        // Refused before the engine: a wallet in place, an unreadable record, the cap.
        std::fs::create_dir_all(cfg.vaults_dir.join(&k6).join("wallet")).unwrap();
        let _ = register_vault(&cfg, &k6, "v", 2, 3, None);
        let lines = LOG_SINK.with(|s| s.borrow_mut().take().unwrap());
        assert!(lines.len() >= 7, "{lines:#?}");
        for line in &lines {
            for k in [&k1, &k2, &k3, &k4, &k5, &k6] {
                assert!(!line.contains(k.as_str()), "a whole id in {line}");
            }
            assert!(!line.contains("disk full"), "the engine's text in {line}");
            assert!(
                !line.contains("no space left"),
                "the system's text in {line}"
            );
            assert!(!line.contains("konclave-n1-"), "a path in {line}");
            assert!(!line.contains("NonZero"), "an error dump in {line}");
        }
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// The texts carry the fixed words and nothing the operating system said.
    #[test]
    fn the_registration_failure_texts_carry_no_operating_system_text() {
        let io = std::io::Error::new(std::io::ErrorKind::StorageFull, "no space left on device");
        assert_eq!(
            RegisterError::NotPersisted(ToolError::Io(io)).to_string(),
            NOT_PERSISTED_TEXT
        );
        assert_eq!(
            RegisterError::CleanupFailed.to_string(),
            CLEANUP_FAILED_TEXT
        );
    }

    /// Wallets with no registration are listed by prefix, a vault with one is not, and a
    /// registration that cannot be read is listed apart (it is not "no registration": a new one
    /// would write over it).
    #[cfg(unix)]
    #[test]
    fn the_listing_tells_a_missing_registration_from_an_unreadable_one() {
        let (cfg, dir) = n1_fixture("orphans");
        let with = format!("{:0<64}", "aaaaaaaa");
        let without = format!("{:0<64}", "bbbbbbbb");
        let broken = format!("{:0<64}", "cccccccc");
        for key in [&with, &without, &broken] {
            std::fs::create_dir_all(cfg.vaults_dir.join(key).join("wallet")).unwrap();
        }
        save_registration(
            &cfg.vaults_dir,
            &n1_registration(&with, &cfg.vaults_dir.join(&with).join("wallet")),
        )
        .unwrap();
        std::fs::write(
            cfg.vaults_dir.join(&broken).join("registration.json"),
            "{\"vault_id\":\"ccc",
        )
        .unwrap();
        let (orphans, unreadable) = registrations_needing_attention(&cfg.vaults_dir);
        assert_eq!(orphans, vec!["bbbbbbbb".to_string()]);
        assert_eq!(unreadable, vec!["cccccccc".to_string()]);
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// A `registration.json` that is there and cannot be read is the only record of that vault's
    /// address and viewing key. It is refused, byte for byte as it was, with or without a wallet
    /// directory beside it, and the engine does not run. (Before, the one WITHOUT a wallet was
    /// overwritten by a new identity.)
    #[cfg(unix)]
    #[test]
    fn an_unreadable_registration_is_refused_and_never_overwritten() {
        let (cfg, dir) = n1_fixture("unreadable");
        // Truncated JSON with and without a wallet beside it, and a path that cannot be read at all
        // (a directory where the file should be: the read fails, it is not "not found").
        for (n, with_wallet, as_dir) in [
            (0x9991, false, false),
            (0x9992, true, false),
            (0x9993, false, true),
        ] {
            let key = format!("{:064x}", n);
            let vault = cfg.vaults_dir.join(&key);
            std::fs::create_dir_all(&vault).unwrap();
            let broken =
                b"{\"vault_id\":\"00000000000000000000000000000000000000000000000000000000";
            if as_dir {
                std::fs::create_dir_all(vault.join("registration.json")).unwrap();
            } else {
                std::fs::write(vault.join("registration.json"), broken).unwrap();
            }
            if with_wallet {
                std::fs::create_dir_all(vault.join("wallet")).unwrap();
            }
            let err = register_vault(&cfg, &key, "v", 2, 3, None).expect_err("refused");
            assert!(matches!(err, RegisterError::CleanupFailed), "{err:?}");
            if as_dir {
                assert!(vault.join("registration.json").is_dir());
            } else {
                assert_eq!(
                    std::fs::read(vault.join("registration.json")).unwrap(),
                    broken
                );
            }
            assert!(!dir.join("engine-ran").exists(), "the engine did not run");
            assert!(n1_leftovers(&cfg.vaults_dir, &key).is_empty());
        }
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// When the engine fails part way AND the directory cannot be moved, the answer is the same one
    /// a failed write gives: an operator has to act (it is not a 502 that reads as the request's
    /// fault, with the next attempt refused anyway).
    #[cfg(unix)]
    #[test]
    fn an_engine_failure_that_cannot_be_cleaned_up_asks_for_the_operator() {
        let (cfg, dir) = n1_fixture("engine-stuck");
        let key = format!("{:064x}", 0x7778);
        std::fs::write(dir.join("init-fails"), "").unwrap();
        let err = register_vault_with(&cfg, &key, "v", 2, 3, None, write_synced, |_, _| {
            Err(std::io::Error::new(
                std::io::ErrorKind::PermissionDenied,
                "read-only",
            ))
        })
        .expect_err("stuck");
        assert!(matches!(err, RegisterError::CleanupFailed), "{err:?}");
        assert!(cfg.vaults_dir.join(&key).join("wallet").exists());
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// An unreadable clock is not a registration time.
    #[test]
    fn a_zero_clock_is_not_recorded_as_a_registration_time() {
        assert_eq!(registration_time(0), None);
        assert_eq!(registration_time(1_791_000_000), Some(1_791_000_000));
    }
}
