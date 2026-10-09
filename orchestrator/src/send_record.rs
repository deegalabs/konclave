//! The record of a send, written BEFORE the transaction can leave.
//!
//! A real send used to broadcast first and record `sent` after, and the record's write errors were
//! dropped. A process that died, a disk that failed or a write that errored between those two steps left
//! the proposal `ready` with no txid, and the next Send built a second payment for the same approved
//! lines. Here the order is the other way round and the rule lives in ONE place:
//!
//! 1. the quorum's signature is in and verified (`prepare`), and the transaction's id and expiry are read;
//! 2. a record of the attempt is written durably - and if that write fails, nothing is broadcast;
//! 3. only then is the transaction broadcast;
//! 4. then the proposal is marked `sent`. A failure of THIS write can no longer cause a second payment,
//!    because the record already says the first one may be on the network, and it is never silent.
//!
//! A later send for the same proposal is refused until the earlier attempt is SETTLED against the chain:
//! the transaction is mined (the proposal becomes `sent`), or it can no longer be mined (the attempt is
//! archived and the vault may send again). "Can no longer be mined" is judged against the expiry the
//! signed transaction itself carries, never against an assumed number of blocks. A transaction found
//! mined is also promoted to `sent` when the vault's proposals are READ ([`promote_mined_attempts`]),
//! because a held proposal can outlive its own deadline and then nobody presses Send again.
//!
//! The record is a file per proposal under `<vaults_dir>/<vault>/send-attempts/`, separate from the
//! proposal's own file: no proposal state or wire shape changes, an older coordinator ignores the
//! directory, and the record holds public data only - never a share, a memo or a payroll line.

use std::path::{Path, PathBuf};
use std::time::Duration;

use serde::{Deserialize, Serialize};

use crate::helper::{
    append_ceremony, load_ceremonies, load_proposal, loggable, proposal_file_stem, replace_file,
    save_proposal, sync_dir, unique_tmp, write_synced, CeremonyRecord, HelperProposal, WalletView,
};
use crate::send::{broadcast_signed, net_prepare_send, SendConfig, SignedSend, SpendPlan};
use crate::tools::ToolError;

/// Blocks added to a transaction's expiry before it is called dead, so a short reorg cannot return a
/// transaction to a mempool after the vault has been told it is gone.
pub const MARGIN: u64 = 10;

fn record_version() -> u8 {
    1
}

/// What a send leaves behind when it is about to broadcast: enough for a later request to ask the chain
/// what became of it. Public data only. Every field added after the first is `serde(default)`, so a
/// record an older build wrote still reads: an unreadable record is a hold with no way out.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Attempt {
    #[serde(default = "record_version")]
    pub version: u8,
    pub proposal_id: String,
    pub vault_id: String,
    /// The transaction id (hex, as wallets print it), derived before the broadcast.
    pub txid: String,
    /// The id the broadcast tool reported, written only when it differs from `txid`. The chain shows
    /// whichever one is real, so a transaction is found mined under either.
    #[serde(default)]
    pub reported_txid: Option<String>,
    /// The shielded sighash the quorum signed (hex).
    pub sighash: String,
    /// The aggregate signatures (hex, one per real spend), so settling a send as mined can write the
    /// same ceremony record a normal send writes.
    pub signatures: Vec<String>,
    /// The height the signed transaction expires at, from the PCZT. `0` = it never expires.
    pub expiry_height: u32,
    pub recorded_at_unix: u64,
}

/// Why a record could not be written.
#[derive(Debug, PartialEq, Eq)]
pub enum RecordError {
    /// A record for this proposal already exists: another attempt owns it.
    Exists,
    Io(String),
}

/// `<vaults_dir>/<vault>/send-attempts`.
pub fn attempts_dir(vaults_dir: &Path, vault: &str) -> PathBuf {
    vaults_dir.join(vault).join("send-attempts")
}

/// Where a proposal's record lives. Keyed by the id through the SAME sanitizer as the proposal's own
/// file, so an id spelled another way in a URL still reaches the same record.
pub fn attempt_path(vaults_dir: &Path, vault: &str, proposal_id: &str) -> PathBuf {
    attempts_dir(vaults_dir, vault).join(format!("{}.json", proposal_file_stem(proposal_id)))
}

fn short(vault: &str) -> &str {
    vault.get(..8).unwrap_or(vault)
}

/// Write the record durably and atomically, and only if none exists. The content is written to a
/// temporary file and synced BEFORE it takes the final name, by a hard link that fails if the name is
/// taken, so the final path is never seen empty or half written and two attempts cannot both own it.
/// If the directory entry cannot be made durable the record is taken back: a send that is refused for
/// that must not also leave a hold behind.
pub fn record_attempt(vaults_dir: &Path, a: &Attempt) -> Result<(), RecordError> {
    record_attempt_with(vaults_dir, a, sync_dir)
}

/// [`record_attempt`] with the directory sync as a parameter, so its failure can be tested.
fn record_attempt_with(
    vaults_dir: &Path,
    a: &Attempt,
    sync: impl Fn(&Path) -> std::io::Result<()>,
) -> Result<(), RecordError> {
    let stem = proposal_file_stem(&a.proposal_id);
    if stem.is_empty() {
        return Err(RecordError::Io("the proposal id names no file".into()));
    }
    let dir = attempts_dir(vaults_dir, &a.vault_id);
    std::fs::create_dir_all(&dir).map_err(|e| RecordError::Io(e.to_string()))?;
    let json = serde_json::to_vec(a).map_err(|e| RecordError::Io(e.to_string()))?;

    let tmp = unique_tmp(&dir, &stem, "tmp");
    if let Err(e) = write_synced(&tmp, &json) {
        let _ = std::fs::remove_file(&tmp);
        return Err(RecordError::Io(e.to_string()));
    }
    let final_path = attempt_path(vaults_dir, &a.vault_id, &a.proposal_id);
    let linked = std::fs::hard_link(&tmp, &final_path);
    let _ = std::fs::remove_file(&tmp);
    match linked {
        Ok(()) => {}
        Err(e) if e.kind() == std::io::ErrorKind::AlreadyExists => return Err(RecordError::Exists),
        Err(e) => return Err(RecordError::Io(e.to_string())),
    }
    if let Err(e) = sync(&dir) {
        let _ = std::fs::remove_file(&final_path);
        return Err(RecordError::Io(e.to_string()));
    }
    Ok(())
}

/// Replace an existing record atomically (temporary file, sync, rename over it). Used once, to add the
/// id the broadcast tool reported when it differs from the derived one.
fn rewrite_attempt(vaults_dir: &Path, a: &Attempt) -> std::io::Result<()> {
    let dir = attempts_dir(vaults_dir, &a.vault_id);
    let json = serde_json::to_vec(a).map_err(std::io::Error::other)?;
    replace_file(
        &attempt_path(vaults_dir, &a.vault_id, &a.proposal_id),
        &dir,
        &json,
        write_synced,
    )?;
    sync_dir(&dir)
}

/// Whether a directory can hold a record: write a temporary file, give it a second name by hard link,
/// make the directory durable, clean up. Run at boot on the vaults directory, so an operator sees a
/// volume that cannot hold records in the log rather than at the first payment.
pub fn probe_volume(dir: &Path) -> Result<(), String> {
    let tmp = unique_tmp(dir, "probe", "tmp");
    let lnk = unique_tmp(dir, "probe", "lnk");
    let result = (|| -> Result<(), String> {
        write_synced(&tmp, b"probe").map_err(|e| format!("cannot write a file: {e}"))?;
        std::fs::hard_link(&tmp, &lnk).map_err(|e| format!("cannot make a hard link: {e}"))?;
        sync_dir(dir).map_err(|e| format!("cannot sync the directory: {e}"))
    })();
    let _ = std::fs::remove_file(&tmp);
    let _ = std::fs::remove_file(&lnk);
    result
}

/// [`probe_volume`] on a vault's own record directory, created if need be. Run BEFORE the devices are
/// asked to sign, so a volume that cannot hold the record refuses at no cost to anyone.
pub fn probe_record_dir(vaults_dir: &Path, vault: &str) -> Result<(), String> {
    let dir = attempts_dir(vaults_dir, vault);
    std::fs::create_dir_all(&dir).map_err(|e| format!("cannot create the directory: {e}"))?;
    probe_volume(&dir)
}

/// Read a record's text: the shape, and a txid that is a txid.
fn parse_attempt(text: &str) -> Result<Attempt, String> {
    let a: Attempt =
        serde_json::from_str(text).map_err(|e| format!("the record is unreadable: {e}"))?;
    let valid = |t: &str| t.len() == 64 && t.bytes().all(|b| b.is_ascii_hexdigit());
    if !valid(&a.txid) || a.reported_txid.as_deref().is_some_and(|t| !valid(t)) {
        return Err("the record holds no valid txid".into());
    }
    Ok(a)
}

/// The record for a proposal, if any. A record that is there but cannot be read is an error, not "no
/// record": the send is then refused rather than assumed safe.
pub fn load_attempt(
    vaults_dir: &Path,
    vault: &str,
    proposal_id: &str,
) -> Result<Option<Attempt>, String> {
    let path = attempt_path(vaults_dir, vault, proposal_id);
    let text = match std::fs::read_to_string(&path) {
        Ok(t) => t,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(e) => return Err(format!("cannot read the record: {e}")),
    };
    parse_attempt(&text).map(Some)
}

/// Move a dead attempt aside (kept as a trail) so the proposal can be sent again.
pub fn archive_attempt(
    vaults_dir: &Path,
    vault: &str,
    proposal_id: &str,
    now: u64,
) -> std::io::Result<()> {
    let from = attempt_path(vaults_dir, vault, proposal_id);
    let to = attempts_dir(vaults_dir, vault).join(format!(
        "{}.expired-{now}.json",
        proposal_file_stem(proposal_id)
    ));
    std::fs::rename(from, to)
}

/// What the chain says about an earlier attempt.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Settlement {
    /// The transaction is mined.
    Mined,
    /// Not mined, and it still can be: keep refusing.
    StillPossible,
    /// Not mined, and past its expiry plus [`MARGIN`]: it can never be mined.
    Dead,
}

/// The id the wallet lists this attempt's transaction under, if it is mined: the derived one or, when
/// the broadcast tool reported a different one, that. Compared without regard to case.
fn mined_txid<'a>(a: &'a Attempt, mined: &[String]) -> Option<&'a str> {
    let listed = |t: &str| mined.iter().any(|m| m.eq_ignore_ascii_case(t));
    if listed(&a.txid) {
        return Some(&a.txid);
    }
    a.reported_txid.as_deref().filter(|t| listed(t))
}

/// Decide an attempt against what a freshly synced wallet reports. Pure.
///
/// `Dead` needs a real expiry (`0` means the transaction never expires, so it is never dead) and a tip
/// past it plus [`MARGIN`]; a wallet that reports no tip (`0`) cannot be past anything. Anything
/// unclear is `StillPossible`, because the cost of waiting is a held proposal and the cost of guessing
/// wrong is a second payment.
pub fn settle(a: &Attempt, view: &WalletView) -> Settlement {
    if mined_txid(a, &view.mined).is_some() {
        return Settlement::Mined;
    }
    if a.expiry_height != 0 && view.tip > u64::from(a.expiry_height) + MARGIN {
        return Settlement::Dead;
    }
    Settlement::StillPossible
}

/// The steps a send needs from the engine, behind one trait so the rule can be tested without it.
/// Crate-private on purpose: the only way to drive a send from outside is [`send_proposal`] with a
/// [`LiveSend`], so nothing outside can call `broadcast` on its own.
pub(crate) trait SendSteps {
    /// Build, prove and collect the quorum's signature. Nothing is broadcast.
    fn prepare(&self) -> Result<SignedSend, ToolError>;
    /// Broadcast a signed transaction. Called only by [`send_with`], after the record exists.
    fn broadcast(&self, signed: &SignedSend) -> Result<String, ToolError>;
    /// Sync the wallet and read its tip and mined txids.
    fn settle_wallet(&self) -> Result<WalletView, ToolError>;
}

/// What a send ended in. The coordinator maps this to a status and a text in one place.
#[derive(Debug)]
pub enum SendResult<R> {
    /// A dry run: signed, not broadcast.
    DryRun { sighash: String },
    /// Broadcast. `record_error` is set when the proposal's own record could not be written; the send
    /// itself went out and the attempt record guards against a repeat.
    Sent {
        txid: String,
        sighash: String,
        record_error: Option<String>,
    },
    /// An earlier attempt was found mined; the proposal is now `sent`. `record_error` as for `Sent`.
    AlreadySent {
        txid: String,
        record_error: Option<String>,
    },
    /// The proposal is not `ready` (and no earlier attempt explains it).
    NotReady { state: String },
    /// An earlier attempt is not settled: it may be on the network. Nothing was built.
    Unsettled { why: String },
    /// A gate before the room (the caller's own) refused.
    Refused(R),
    /// Building or signing failed. Nothing was broadcast.
    PrepareFailed(ToolError),
    /// The record could not be written, so nothing was broadcast.
    RecordFailed(String),
    /// The broadcast errored. The attempt stays: the transaction may or may not be on the network.
    BroadcastFailed { txid: String, error: ToolError },
}

fn now_unix() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0)
}

/// What a log line says. One function, the only way text reaches the log from here, and tested
/// itself: the vault's whole id and line breaks never get through.
fn log_line(vault: &str, proposal: &str, what: &str) -> String {
    format!(
        "vault {} proposal {}: {}",
        short(vault),
        loggable(vault, proposal),
        loggable(vault, what)
    )
}

fn log(vault: &str, proposal: &str, what: &str) {
    eprintln!("{}", log_line(vault, proposal, what));
}

/// Send an approved proposal: the one place that decides whether a transaction may leave.
///
/// The hosted coordinator's whole entry point; the work is [`send_with`], which tests drive with a
/// stand-in for the engine.
pub fn send_proposal<R>(
    vaults_dir: &Path,
    p: HelperProposal,
    dry_run: bool,
    steps: &LiveSend<'_>,
    preflight: impl FnOnce(&HelperProposal) -> Result<(), R>,
) -> SendResult<R> {
    send_with(vaults_dir, p, dry_run, steps, preflight)
}

/// Order, and why it is this order:
/// 1. A proposal already `sent` is done.
/// 2. A real send first SETTLES any earlier attempt against the chain, BEFORE the state check: a
///    payment that went out can read `expired` or `pending` by now (the state is recomputed on every
///    load), and checking state first would leave it out of the ledger for good.
/// 3. Only a `ready` proposal goes on, through the caller's own gates (`preflight`: plan, capacity,
///    funding), which run before any room opens.
/// 4. The volume is checked able to hold a record, then `prepare`, then the record, then the
///    broadcast. If the record cannot be written, nothing is broadcast.
///
/// A dry run never reads or writes a record and never touches the wallet: it cannot broadcast.
pub(crate) fn send_with<S: SendSteps, R>(
    vaults_dir: &Path,
    p: HelperProposal,
    dry_run: bool,
    steps: &S,
    preflight: impl FnOnce(&HelperProposal) -> Result<(), R>,
) -> SendResult<R> {
    let vault = p.vault_id.clone();
    let id = p.id.clone();

    if p.state == "sent" {
        return SendResult::NotReady { state: p.state };
    }

    if !dry_run {
        match load_attempt(vaults_dir, &vault, &id) {
            Err(why) => {
                log(
                    &vault,
                    &id,
                    &format!("earlier send record: {why}; refusing"),
                );
                return SendResult::Unsettled { why };
            }
            Ok(None) => {}
            Ok(Some(a)) => {
                let view = match steps.settle_wallet() {
                    Ok(v) => v,
                    Err(e) => {
                        let why = format!("the wallet could not be read: {e}");
                        log(&vault, &id, &format!("earlier send unsettled, {why}"));
                        return SendResult::Unsettled { why };
                    }
                };
                match settle(&a, &view) {
                    Settlement::Mined => return settle_as_sent(vaults_dir, p, &a, &view),
                    Settlement::StillPossible => {
                        return SendResult::Unsettled {
                            why: format!(
                                "transaction not mined yet; it can be until height {}",
                                a.expiry_height
                            ),
                        }
                    }
                    Settlement::Dead => {
                        if let Err(e) = archive_attempt(vaults_dir, &vault, &id, now_unix()) {
                            let why = format!("the dead attempt could not be archived: {e}");
                            log(&vault, &id, &why);
                            return SendResult::Unsettled { why };
                        }
                        log(&vault, &id, "earlier attempt expired unmined; archived");
                    }
                }
            }
        }
    }

    if p.state != "ready" {
        return SendResult::NotReady { state: p.state };
    }
    if let Err(r) = preflight(&p) {
        return SendResult::Refused(r);
    }
    // Before any device is asked to sign: a volume that cannot hold the record refuses here.
    if !dry_run {
        if let Err(why) = probe_record_dir(vaults_dir, &vault) {
            log(
                &vault,
                &id,
                &format!("no record possible, nothing built: {why}"),
            );
            return SendResult::RecordFailed(why);
        }
    }

    let signed = match steps.prepare() {
        Ok(s) => s,
        Err(e) => return SendResult::PrepareFailed(e),
    };
    if dry_run {
        let dry = CeremonyRecord {
            vault_id: vault.clone(),
            sighash: signed.sighash().to_string(),
            signatures: signed.signatures().to_vec(),
            txid: None,
            dry_run: true,
            created_at_unix: now_unix(),
        };
        if let Err(e) = append_ceremony(vaults_dir, &dry) {
            log(
                &vault,
                &id,
                &format!("dry-run ceremony record not written: {e}"),
            );
        }
        return SendResult::DryRun {
            sighash: signed.sighash().to_string(),
        };
    }

    // The record comes first. From here on a later request can ask the chain what became of this.
    let mut attempt = Attempt {
        version: record_version(),
        proposal_id: id.clone(),
        vault_id: vault.clone(),
        txid: signed.txid().to_string(),
        reported_txid: None,
        sighash: signed.sighash().to_string(),
        signatures: signed.signatures().to_vec(),
        expiry_height: signed.expiry_height(),
        recorded_at_unix: now_unix(),
    };
    match record_attempt(vaults_dir, &attempt) {
        Ok(()) => {}
        // Another attempt owns the name and may have broadcast: that is a hold, not a failure to retry.
        Err(RecordError::Exists) => {
            let why = "another attempt already holds this proposal".to_string();
            log(&vault, &id, &format!("{why}; nothing broadcast"));
            return SendResult::Unsettled { why };
        }
        Err(RecordError::Io(why)) => {
            log(
                &vault,
                &id,
                &format!("send record not written, nothing broadcast: {why}"),
            );
            return SendResult::RecordFailed(why);
        }
    }

    let reported = match steps.broadcast(&signed) {
        Ok(t) => t,
        Err(error) => {
            log(
                &vault,
                &id,
                &format!("broadcast errored, the attempt stays on record: {error}"),
            );
            return SendResult::BroadcastFailed {
                txid: attempt.txid,
                error,
            };
        }
    };

    let mut problems: Vec<String> = Vec::new();
    // The id the tool reports is the one on the chain. If it is not the one derived from what the
    // devices signed, say so loudly, keep BOTH on record so the transaction is found either way, and
    // show the reported one.
    let txid = if reported.eq_ignore_ascii_case(&attempt.txid) {
        attempt.txid.clone()
    } else {
        log(
            &vault,
            &id,
            &format!(
                "ALERT: the tool reported txid {reported}, the signed transaction derives {}",
                attempt.txid
            ),
        );
        attempt.reported_txid = Some(reported.clone());
        if let Err(e) = rewrite_attempt(vaults_dir, &attempt) {
            problems.push(format!("send record: {e}"));
        }
        reported
    };

    // The same function that settles a payment found mined: trail first, then the proposal.
    problems.extend(mark_mined(vaults_dir, p, &attempt, &txid));
    let record_error = if problems.is_empty() {
        None
    } else {
        let joined = problems.join("; ");
        log(
            &vault,
            &id,
            &format!("SENT, but a record was not written: {joined}"),
        );
        Some(joined)
    };
    SendResult::Sent {
        txid,
        sighash: attempt.sighash,
        record_error,
    }
}

/// Record a payment as made: the ceremony record a normal send writes (once per txid), THEN the
/// proposal as `sent`. The one function for both ways a payment gets here - a send that has just
/// broadcast, and a transaction found mined later - so there is one order and one set of failures.
/// The trail comes first and the proposal only if it was written: a proposal marked `sent` leaves
/// the held list for good, so a trail entry that failed would never be written again; left `ready`,
/// the record stays held and the next settling tries both. Returns what could not be written.
fn mark_mined(vaults_dir: &Path, mut p: HelperProposal, a: &Attempt, txid: &str) -> Vec<String> {
    let mut problems: Vec<String> = Vec::new();
    let trail = load_ceremonies(vaults_dir, &a.vault_id);
    let listed = trail.iter().any(|c| {
        c.txid
            .as_deref()
            .is_some_and(|t| t.eq_ignore_ascii_case(txid))
    });
    if !listed {
        let rec = CeremonyRecord {
            vault_id: a.vault_id.clone(),
            sighash: a.sighash.clone(),
            signatures: a.signatures.clone(),
            txid: Some(txid.to_string()),
            dry_run: false,
            created_at_unix: now_unix(),
        };
        if let Err(e) = append_ceremony(vaults_dir, &rec) {
            problems.push(format!("ceremony record: {e}"));
        }
    }
    if problems.is_empty() {
        p.state = "sent".into();
        p.txid = Some(txid.to_string());
        if let Err(e) = save_proposal(vaults_dir, &p) {
            problems.push(format!("proposal record: {e}"));
        }
    }
    if !problems.is_empty() {
        log(
            &a.vault_id,
            &a.proposal_id,
            &format!(
                "payment is on the chain, but a record was not written: {}",
                problems.join("; ")
            ),
        );
    }
    problems
}

/// An earlier attempt was found mined during a send: settle the proposal as `sent`.
fn settle_as_sent<R>(
    vaults_dir: &Path,
    p: HelperProposal,
    a: &Attempt,
    view: &WalletView,
) -> SendResult<R> {
    let txid = mined_txid(a, &view.mined).unwrap_or(&a.txid).to_string();
    let problems = mark_mined(vaults_dir, p, a, &txid);
    SendResult::AlreadySent {
        txid,
        record_error: if problems.is_empty() {
            None
        } else {
            Some(problems.join("; "))
        },
    }
}

/// A record of a send whose payment is not yet `sent`.
enum Held {
    Record(Attempt),
    /// A record that cannot be read: the file's stem. It refuses every Send for its proposal and
    /// nothing settles it by itself, so it is counted and named, never skipped.
    Unreadable(String),
}

/// Every record of a vault whose proposal is not yet `sent`. A record of a FINISHED send stays on disk
/// for good, so the directory's contents are not the list of held payments: this crosses each record
/// with the proposal's own state. Reads each record and its proposal, every time it is called.
fn held_in(vaults_dir: &Path, vault: &str) -> Vec<Held> {
    let Ok(entries) = std::fs::read_dir(attempts_dir(vaults_dir, vault)) else {
        return Vec::new();
    };
    let now = now_unix();
    let sent =
        |id: &str| load_proposal(vaults_dir, vault, id, now).is_some_and(|p| p.state == "sent");
    entries
        .flatten()
        .filter_map(|e| {
            let name = e.file_name().to_string_lossy().into_owned();
            // `<stem>.json` only: temporaries start with a dot, archives carry `.expired-`.
            if name.starts_with('.') || name.contains(".expired-") {
                return None;
            }
            let stem = name.strip_suffix(".json")?.to_string();
            match std::fs::read_to_string(e.path())
                .map_err(|e| e.to_string())
                .and_then(|t| parse_attempt(&t))
            {
                Ok(a) => (!sent(&a.proposal_id)).then_some(Held::Record(a)),
                Err(_) => (!sent(&stem)).then_some(Held::Unreadable(stem)),
            }
        })
        .collect()
}

/// How often the wallet is read to promote what is mined, per vault: the same window the balance
/// read uses for its sync, so a screen that polls does not turn into a `list-tx` per request.
pub const PROMOTE_THROTTLE_SECS: u64 = 15;

fn last_promote_path(vaults_dir: &Path, vault: &str) -> PathBuf {
    vaults_dir.join(vault).join("last_promote")
}

/// Promote to `sent` every proposal of this vault whose attempt's transaction is mined, WITHOUT a send
/// request. Called when the vault's proposals or ledger are read: a held proposal can pass its own
/// deadline and read `expired`, the screen then offers no Send, and without this a payment that is on
/// the chain would stay out of the ledger for good. It only promotes: whether an attempt is dead is
/// decided by a Send alone.
///
/// It reads the wallet AS IT STANDS, without syncing: a payment is seen once the wallet has synced
/// past it, which a balance read or a Send does. `read_mined` is called only when something is held,
/// and at most once per [`PROMOTE_THROTTLE_SECS`] per vault whether it succeeds or fails, so neither
/// the subprocess nor a log line repeats per request. No record is skipped for its age: a payment the
/// wallet only learns of late (a wallet restored from a backup, rescanned) is still recorded, and the
/// window is what bounds the cost of a record that is never mined. Returns how many proposals it
/// promoted.
pub fn promote_mined_attempts(
    vaults_dir: &Path,
    vault: &str,
    read_mined: impl FnOnce() -> Result<Vec<String>, ToolError>,
) -> usize {
    promote_at(vaults_dir, vault, now_unix(), read_mined)
}

fn promote_at(
    vaults_dir: &Path,
    vault: &str,
    now: u64,
    read_mined: impl FnOnce() -> Result<Vec<String>, ToolError>,
) -> usize {
    let held: Vec<Attempt> = held_in(vaults_dir, vault)
        .into_iter()
        .filter_map(|h| match h {
            Held::Record(a) => Some(a),
            Held::Unreadable(_) => None,
        })
        .collect();
    if held.is_empty() {
        return 0;
    }
    let path = last_promote_path(vaults_dir, vault);
    let last = std::fs::read_to_string(&path)
        .ok()
        .and_then(|t| t.trim().parse::<u64>().ok());
    // A stamp from the future (a clock that went back) is not a recent read: ignored, so it cannot
    // keep a payment from being recorded until the clock catches up.
    if last.is_some_and(|l| l <= now && now - l < PROMOTE_THROTTLE_SECS) {
        return 0;
    }
    let _ = std::fs::write(&path, now.to_string());

    let mined = match read_mined() {
        Ok(m) => m,
        Err(e) => {
            log(
                vault,
                "-",
                &format!("could not read the wallet to settle sends: {e}"),
            );
            return 0;
        }
    };
    let mut promoted = 0;
    for a in held {
        let Some(txid) = mined_txid(&a, &mined).map(str::to_string) else {
            continue;
        };
        let Some(p) = load_proposal(vaults_dir, vault, &a.proposal_id, now) else {
            continue;
        };
        if mark_mined(vaults_dir, p, &a, &txid).is_empty() {
            promoted += 1;
        }
    }
    promoted
}

/// One held payment, for the boot log.
#[derive(Debug, PartialEq, Eq, PartialOrd, Ord)]
pub struct HeldPayment {
    /// The vault's 8-character prefix.
    pub vault: String,
    /// The proposal id (for an unreadable record, the file's name).
    pub proposal: String,
    /// The record cannot be read: it refuses every Send for the proposal and nothing clears it.
    pub unreadable: bool,
}

/// Held payments across every vault, for the boot log. Reads files only.
pub fn unsettled_attempts(vaults_dir: &Path) -> Vec<HeldPayment> {
    let Ok(vaults) = std::fs::read_dir(vaults_dir) else {
        return Vec::new();
    };
    let mut out = Vec::new();
    for v in vaults.flatten() {
        let vault = v.file_name().to_string_lossy().into_owned();
        for h in held_in(vaults_dir, &vault) {
            let (proposal, unreadable) = match h {
                Held::Record(a) => (a.proposal_id, false),
                Held::Unreadable(stem) => (stem, true),
            };
            out.push(HeldPayment {
                vault: short(&vault).to_string(),
                proposal,
                unreadable,
            });
        }
    }
    out.sort();
    out
}

/// The live steps: the real engine, the real relay, the real wallet. `plan` is `None` when the
/// proposal's lines did not validate; the caller's gate refuses first, and `prepare` refuses too.
pub struct LiveSend<'a> {
    pub sc: &'a SendConfig,
    pub plan: Option<&'a SpendPlan>,
    pub relay_base: &'a str,
    pub room: &'a str,
    /// Who the request is sealed to, or why it may not go out at all
    /// ([`crate::helper::request_recipients`]). Held as that answer, so that an unsealed send nobody
    /// signed cannot be turned into "an empty list" on the way here.
    pub recipients: &'a Result<Vec<String>, crate::helper::UnsealedRefused>,
    pub max_polls: u32,
    pub vault_id: &'a str,
    pub vaults_dir: &'a Path,
}

impl SendSteps for LiveSend<'_> {
    fn prepare(&self) -> Result<SignedSend, ToolError> {
        let plan = self
            .plan
            .ok_or_else(|| ToolError::parse("send", "the proposal has no valid plan"))?;
        let device_pubs = self.recipients.as_ref().map_err(|_| {
            ToolError::parse(
                "send",
                "this send would be published unsealed and no seat signed it",
            )
        })?;
        net_prepare_send(
            self.sc,
            plan,
            self.relay_base,
            self.room,
            device_pubs,
            self.max_polls,
            Duration::from_secs(1),
        )
    }
    fn broadcast(&self, signed: &SignedSend) -> Result<String, ToolError> {
        broadcast_signed(self.sc, signed)
    }
    fn settle_wallet(&self) -> Result<WalletView, ToolError> {
        crate::helper::settle_wallet(
            &self.sc.devtool,
            &self.sc.wallet_dir,
            &self.sc.lightwalletd,
            self.vaults_dir,
            self.vault_id,
        )
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::cell::{Cell, RefCell};

    const TXID: &str = "11111111111111111111111111111111111111111111111111111111111111aa";
    const TXID2: &str = "22222222222222222222222222222222222222222222222222222222222222bb";
    const VAULT: &str = "0123456789abcdef";

    fn vaults() -> PathBuf {
        use std::sync::atomic::{AtomicU64, Ordering};
        static N: AtomicU64 = AtomicU64::new(0);
        let d = std::env::temp_dir().join(format!(
            "konclave-send-record-{}-{}",
            std::process::id(),
            N.fetch_add(1, Ordering::Relaxed)
        ));
        let _ = std::fs::remove_dir_all(&d);
        std::fs::create_dir_all(d.join(VAULT)).unwrap();
        d
    }

    fn proposal(state: &str) -> HelperProposal {
        HelperProposal {
            id: "p1".into(),
            vault_id: VAULT.into(),
            kind: "payment".into(),
            to: "utest1x".into(),
            amount_zat: 1000,
            memo: None,
            lines: vec![],
            proposer: "alice".into(),
            state: state.into(),
            approvals: vec!["alice".into(), "bob".into()],
            refusals: vec![],
            threshold: 2,
            total: 3,
            created_at_unix: 1_000,
            expiry_unix: 0,
            txid: None,
        }
    }

    fn attempt(txid: &str, expiry: u32) -> Attempt {
        Attempt {
            version: record_version(),
            proposal_id: "p1".into(),
            vault_id: VAULT.into(),
            txid: txid.into(),
            reported_txid: None,
            sighash: "ab".repeat(32),
            signatures: vec!["cd".repeat(64)],
            expiry_height: expiry,
            recorded_at_unix: 1_000,
        }
    }

    fn view(tip: u64, mined: &[&str]) -> WalletView {
        WalletView {
            tip,
            mined: mined.iter().map(|s| s.to_string()).collect(),
        }
    }

    /// Stand-in engine. Records which steps ran, so a refusal can be shown to have run NONE of them,
    /// and whether the record existed at the moment the transaction was handed to the broadcast.
    struct Fake {
        txid: &'static str,
        /// What the broadcast tool prints. `None`: the derived txid, as it does today.
        reported: Option<&'static str>,
        expiry: u32,
        broadcast_fails: bool,
        prepare_fails: bool,
        /// A record another attempt writes while this one is being prepared.
        rival: Option<Attempt>,
        /// The records' directory is replaced by a file after the volume was probed and before the
        /// record is written: the write fails for a reason the probe could not see.
        sabotage_records: bool,
        view: Result<WalletView, ()>,
        dir: RefCell<Option<PathBuf>>,
        calls: RefCell<Vec<&'static str>>,
    }

    impl Fake {
        fn new() -> Self {
            Fake {
                txid: TXID,
                reported: None,
                expiry: 5_000,
                broadcast_fails: false,
                prepare_fails: false,
                rival: None,
                sabotage_records: false,
                view: Ok(view(4_000, &[])),
                dir: RefCell::new(None),
                calls: RefCell::new(vec![]),
            }
        }
        fn ran(&self, step: &'static str) -> bool {
            self.calls.borrow().contains(&step)
        }
    }

    impl SendSteps for Fake {
        fn prepare(&self) -> Result<SignedSend, ToolError> {
            self.calls.borrow_mut().push("prepare");
            if self.prepare_fails {
                return Err(ToolError::parse("ceremony", "a device refused"));
            }
            if let (Some(r), Some(dir)) = (&self.rival, self.dir.borrow().as_ref()) {
                record_attempt(dir, r).unwrap();
            }
            if let (true, Some(dir)) = (self.sabotage_records, self.dir.borrow().as_ref()) {
                let at = attempts_dir(dir, VAULT);
                std::fs::remove_dir_all(&at).unwrap();
                std::fs::write(&at, b"not a directory").unwrap();
            }
            Ok(SignedSend::for_test(self.txid, self.expiry))
        }
        fn broadcast(&self, signed: &SignedSend) -> Result<String, ToolError> {
            self.calls.borrow_mut().push("broadcast");
            let had_record = self
                .dir
                .borrow()
                .as_ref()
                .is_some_and(|d| matches!(load_attempt(d, VAULT, "p1"), Ok(Some(_))));
            self.calls.borrow_mut().push(if had_record {
                "broadcast_with_record"
            } else {
                "broadcast_without_record"
            });
            if self.broadcast_fails {
                Err(ToolError::parse("broadcast", "connection reset"))
            } else {
                Ok(self.reported.unwrap_or(signed.txid()).to_string())
            }
        }
        fn settle_wallet(&self) -> Result<WalletView, ToolError> {
            self.calls.borrow_mut().push("settle_wallet");
            self.view
                .clone()
                .map_err(|_| ToolError::parse("wallet", "sync failed"))
        }
    }

    fn go(dir: &Path, p: HelperProposal, dry: bool, f: &Fake) -> SendResult<()> {
        f.dir.replace(Some(dir.to_path_buf()));
        send_with(dir, p, dry, f, |_| Ok::<(), ()>(()))
    }

    fn load(dir: &Path) -> HelperProposal {
        crate::helper::load_proposal(dir, VAULT, "p1", 2_000).expect("the proposal is saved")
    }

    /// Make the proposals directory a FILE, so every `save_proposal` fails even for root.
    fn break_proposal_writes(dir: &Path) {
        let _ = std::fs::remove_dir_all(dir.join(VAULT).join("proposals"));
        std::fs::write(dir.join(VAULT).join("proposals"), b"not a directory").unwrap();
    }

    // ---- the order: the record first -------------------------------------------------------

    #[test]
    fn the_record_exists_at_the_moment_of_the_broadcast() {
        // Not only "a record exists afterwards": at the instant the transaction is handed to the
        // broadcast, the record is already on disk. Holds on every platform.
        let dir = vaults();
        let f = Fake::new();
        let _ = go(&dir, proposal("ready"), false, &f);
        assert!(f.ran("broadcast_with_record"), "{:?}", f.calls.borrow());
        assert!(!f.ran("broadcast_without_record"));
    }

    #[test]
    fn a_send_whose_final_save_fails_still_leaves_a_record_with_the_txid() {
        let dir = vaults();
        break_proposal_writes(&dir);
        let f = Fake::new();
        let r = go(&dir, proposal("ready"), false, &f);
        match r {
            SendResult::Sent {
                txid, record_error, ..
            } => {
                assert_eq!(txid, TXID);
                assert!(
                    record_error.is_some(),
                    "a failed save must be reported, not dropped"
                );
            }
            other => panic!("expected Sent, got {other:?}"),
        }
        let a = load_attempt(&dir, VAULT, "p1")
            .unwrap()
            .expect("the attempt must be recorded");
        assert_eq!(a.txid, TXID);
        assert_eq!(
            a.expiry_height, 5_000,
            "the expiry comes from the transaction"
        );
    }

    #[test]
    fn a_second_send_after_a_lost_record_is_refused_before_anything_is_built() {
        let dir = vaults();
        break_proposal_writes(&dir);
        let first = Fake::new();
        let _ = go(&dir, proposal("ready"), false, &first);

        // The save was lost, so the proposal still reads `ready`. The wallet has not mined it yet.
        let second = Fake::new();
        let r = go(&dir, proposal("ready"), false, &second);
        assert!(matches!(r, SendResult::Unsettled { .. }), "{r:?}");
        assert!(!second.ran("prepare"), "no room, no build");
        assert!(!second.ran("broadcast"), "no second transaction");
    }

    #[cfg(unix)]
    #[test]
    fn a_volume_that_cannot_hold_a_record_refuses_before_any_device_is_asked_to_sign() {
        let dir = vaults();
        // A dangling link in place of `send-attempts`: reading a record finds nothing, and creating
        // the directory fails - the one way "no record yet" and "no record possible" come apart.
        std::os::unix::fs::symlink("/nonexistent/elsewhere", attempts_dir(&dir, VAULT)).unwrap();
        let f = Fake::new();
        let r = go(&dir, proposal("ready"), false, &f);
        assert!(matches!(r, SendResult::RecordFailed(_)), "{r:?}");
        assert!(
            !f.ran("prepare"),
            "the devices are not asked to sign for nothing"
        );
        assert!(!f.ran("broadcast"));
    }

    #[test]
    fn a_record_that_fails_to_write_after_the_probe_still_stops_the_broadcast() {
        // The probe passed and the write failed anyway (a disk that fills, a directory that changes):
        // the one arm that says "no record, no broadcast" for an I/O error.
        let dir = vaults();
        let mut f = Fake::new();
        f.sabotage_records = true;
        let r = go(&dir, proposal("ready"), false, &f);
        assert!(matches!(r, SendResult::RecordFailed(_)), "{r:?}");
        assert!(f.ran("prepare"));
        assert!(!f.ran("broadcast"), "no record, no broadcast");
    }

    #[test]
    fn a_rival_that_takes_the_record_during_preparation_is_a_hold_not_a_retry() {
        // Another attempt wrote the record between this one's check and its write. It may have
        // broadcast, so this is "held", never "nothing was sent, try again".
        let dir = vaults();
        let mut f = Fake::new();
        f.rival = Some(attempt(TXID2, 5_000));
        let r = go(&dir, proposal("ready"), false, &f);
        assert!(matches!(r, SendResult::Unsettled { .. }), "{r:?}");
        assert!(!f.ran("broadcast"));
        assert_eq!(
            load_attempt(&dir, VAULT, "p1").unwrap().unwrap().txid,
            TXID2
        );
    }

    #[test]
    fn a_failed_preparation_leaves_no_record_and_no_broadcast() {
        let dir = vaults();
        let mut f = Fake::new();
        f.prepare_fails = true;
        let r = go(&dir, proposal("ready"), false, &f);
        assert!(matches!(r, SendResult::PrepareFailed(_)), "{r:?}");
        assert!(!f.ran("broadcast"));
        assert!(load_attempt(&dir, VAULT, "p1").unwrap().is_none());
    }

    // ---- settling against the chain --------------------------------------------------------

    #[test]
    fn an_attempt_found_mined_settles_the_proposal_as_sent() {
        let dir = vaults();
        record_attempt(&dir, &attempt(TXID, 5_000)).unwrap();
        let mut f = Fake::new();
        f.view = Ok(view(4_100, &[TXID]));
        let r = go(&dir, proposal("ready"), false, &f);
        match r {
            SendResult::AlreadySent { txid, .. } => assert_eq!(txid, TXID),
            other => panic!("expected AlreadySent, got {other:?}"),
        }
        assert!(!f.ran("prepare") && !f.ran("broadcast"));
        let saved = load(&dir);
        assert_eq!(saved.state, "sent");
        assert_eq!(saved.txid.as_deref(), Some(TXID));
        // The trail gets the same record a normal send writes, once.
        let trail = load_ceremonies(&dir, VAULT);
        assert_eq!(trail.len(), 1, "{trail:?}");
        assert_eq!(trail[0].txid.as_deref(), Some(TXID));
        assert!(!trail[0].dry_run);
    }

    #[test]
    fn a_paid_proposal_that_now_reads_expired_is_still_settled_as_sent() {
        // `recompute` turns a `ready` proposal past its deadline into `expired`. The state check must
        // not come before the settling, or a payment that went out never reaches the ledger.
        let dir = vaults();
        record_attempt(&dir, &attempt(TXID, 5_000)).unwrap();
        let mut f = Fake::new();
        f.view = Ok(view(4_100, &[TXID]));
        let r = go(&dir, proposal("expired"), false, &f);
        assert!(matches!(r, SendResult::AlreadySent { .. }), "{r:?}");
        assert_eq!(load(&dir).state, "sent");
    }

    #[test]
    fn settling_comes_before_the_callers_own_gates() {
        // A payment already made must be recorded even when a gate (funding, capacity, a plan that
        // no longer validates) would refuse a new send.
        let dir = vaults();
        record_attempt(&dir, &attempt(TXID, 5_000)).unwrap();
        let mut f = Fake::new();
        f.view = Ok(view(4_100, &[TXID]));
        f.dir.replace(Some(dir.clone()));
        let asked = Cell::new(false);
        let r = send_with(&dir, proposal("ready"), false, &f, |_| {
            asked.set(true);
            Err("refused")
        });
        assert!(matches!(r, SendResult::AlreadySent { .. }), "{r:?}");
        assert!(!asked.get(), "the gate is not even asked");
    }

    #[test]
    fn the_callers_gate_refuses_before_a_room_is_opened() {
        let dir = vaults();
        let f = Fake::new();
        f.dir.replace(Some(dir.clone()));
        let r = send_with(&dir, proposal("ready"), false, &f, |_| Err("unfunded"));
        assert!(matches!(r, SendResult::Refused("unfunded")), "{r:?}");
        assert!(!f.ran("prepare") && !f.ran("broadcast"));
        assert!(load_attempt(&dir, VAULT, "p1").unwrap().is_none());
    }

    #[test]
    fn an_attempt_stays_unsettled_while_its_transaction_can_still_be_mined() {
        let dir = vaults();
        // A canonical payment expires tens of thousands of blocks out: an hour later it is not dead.
        record_attempt(&dir, &attempt(TXID, 4_000 + 50_000)).unwrap();
        let mut f = Fake::new();
        f.view = Ok(view(4_100, &[]));
        let r = go(&dir, proposal("ready"), false, &f);
        assert!(matches!(r, SendResult::Unsettled { .. }), "{r:?}");
        assert!(!f.ran("prepare"));
    }

    #[test]
    fn an_attempt_with_no_expiry_is_never_called_dead() {
        let dir = vaults();
        record_attempt(&dir, &attempt(TXID, 0)).unwrap();
        let mut f = Fake::new();
        f.view = Ok(view(u64::MAX / 2, &[]));
        let r = go(&dir, proposal("ready"), false, &f);
        assert!(matches!(r, SendResult::Unsettled { .. }), "{r:?}");
    }

    #[test]
    fn a_dead_attempt_is_archived_and_the_send_goes_on() {
        let dir = vaults();
        record_attempt(&dir, &attempt(TXID, 1_000)).unwrap();
        let mut f = Fake::new();
        f.txid = TXID2;
        f.view = Ok(view(1_000 + MARGIN + 1, &[]));
        let r = go(&dir, proposal("ready"), false, &f);
        assert!(matches!(r, SendResult::Sent { .. }), "{r:?}");
        // The new attempt owns the name; the old one is kept as a trail.
        assert_eq!(
            load_attempt(&dir, VAULT, "p1").unwrap().unwrap().txid,
            TXID2
        );
        let kept = std::fs::read_dir(attempts_dir(&dir, VAULT))
            .unwrap()
            .flatten()
            .any(|e| e.file_name().to_string_lossy().contains(".expired-"));
        assert!(kept, "the dead attempt is archived, not deleted");
    }

    #[test]
    fn it_is_not_dead_one_block_short_of_the_margin() {
        let dir = vaults();
        record_attempt(&dir, &attempt(TXID, 1_000)).unwrap();
        let mut f = Fake::new();
        f.view = Ok(view(1_000 + MARGIN, &[]));
        assert!(matches!(
            go(&dir, proposal("ready"), false, &f),
            SendResult::Unsettled { .. }
        ));
    }

    #[test]
    fn the_margin_is_ten_blocks() {
        // The docs and the changelog say ten; a reorg shorter than that cannot bring a transaction
        // back after the vault was told it is gone.
        assert_eq!(MARGIN, 10);
    }

    #[test]
    fn a_wallet_that_cannot_be_read_never_frees_an_attempt() {
        let dir = vaults();
        record_attempt(&dir, &attempt(TXID, 1_000)).unwrap();
        let mut f = Fake::new();
        f.view = Err(());
        let r = go(&dir, proposal("ready"), false, &f);
        assert!(matches!(r, SendResult::Unsettled { .. }), "{r:?}");
        assert!(!f.ran("prepare"));
    }

    #[test]
    fn a_record_that_cannot_be_read_refuses_the_send() {
        let dir = vaults();
        std::fs::create_dir_all(attempts_dir(&dir, VAULT)).unwrap();
        std::fs::write(attempt_path(&dir, VAULT, "p1"), b"{ half a record").unwrap();
        let f = Fake::new();
        let r = go(&dir, proposal("ready"), false, &f);
        assert!(matches!(r, SendResult::Unsettled { .. }), "{r:?}");
        assert!(!f.ran("prepare"));
    }

    #[test]
    fn a_place_for_records_that_cannot_be_read_refuses_before_anything_is_built() {
        let dir = vaults();
        // `send-attempts` is a file: whether a record exists is unknowable, which is not "none".
        std::fs::write(attempts_dir(&dir, VAULT), b"not a directory").unwrap();
        let f = Fake::new();
        let r = go(&dir, proposal("ready"), false, &f);
        assert!(matches!(r, SendResult::Unsettled { .. }), "{r:?}");
        assert!(!f.ran("prepare") && !f.ran("broadcast"));
    }

    #[test]
    fn a_dry_run_neither_reads_nor_writes_a_record() {
        let dir = vaults();
        // An unsettled attempt does not block a dry run: it never broadcasts.
        record_attempt(&dir, &attempt(TXID, 4_000 + 50_000)).unwrap();
        let f = Fake::new();
        let r = go(&dir, proposal("ready"), true, &f);
        assert!(matches!(r, SendResult::DryRun { .. }), "{r:?}");
        assert!(
            !f.ran("settle_wallet"),
            "a dry run does not touch the wallet"
        );
        assert!(!f.ran("broadcast"));
        // And on a clean vault a dry run leaves no record behind, only its own ceremony entry.
        let clean = vaults();
        let _ = go(&clean, proposal("ready"), true, &Fake::new());
        assert!(load_attempt(&clean, VAULT, "p1").unwrap().is_none());
        let trail = load_ceremonies(&clean, VAULT);
        assert_eq!(trail.len(), 1);
        assert!(trail[0].dry_run && trail[0].txid.is_none());
    }

    #[test]
    fn a_broadcast_error_keeps_the_attempt_and_holds_the_next_send() {
        let dir = vaults();
        let mut f = Fake::new();
        f.broadcast_fails = true;
        let r = go(&dir, proposal("ready"), false, &f);
        assert!(matches!(r, SendResult::BroadcastFailed { .. }), "{r:?}");
        assert!(load_attempt(&dir, VAULT, "p1").unwrap().is_some());

        let again = Fake::new();
        assert!(matches!(
            go(&dir, proposal("ready"), false, &again),
            SendResult::Unsettled { .. }
        ));
        assert!(!again.ran("broadcast"));
    }

    #[test]
    fn a_normal_send_writes_the_ceremony_trail_and_marks_the_proposal_sent() {
        let dir = vaults();
        let f = Fake::new();
        let r = go(&dir, proposal("ready"), false, &f);
        assert!(
            matches!(
                r,
                SendResult::Sent {
                    record_error: None,
                    ..
                }
            ),
            "{r:?}"
        );
        let saved = load(&dir);
        assert_eq!(
            (saved.state.as_str(), saved.txid.as_deref()),
            ("sent", Some(TXID))
        );
        let trail = load_ceremonies(&dir, VAULT);
        assert_eq!(trail.len(), 1, "{trail:?}");
        assert_eq!(trail[0].txid.as_deref(), Some(TXID));
        assert!(!trail[0].dry_run);
        assert_eq!(trail[0].signatures.len(), 1);
    }

    // ---- the two derivations of a txid ----------------------------------------------------

    #[test]
    fn a_tool_that_reports_another_txid_is_recorded_and_the_transaction_found_under_either() {
        let dir = vaults();
        let mut f = Fake::new();
        f.reported = Some(TXID2);
        let r = go(&dir, proposal("ready"), false, &f);
        // What the tool reports is what the chain shows: that is what the member is told and what
        // the proposal carries.
        match r {
            SendResult::Sent { txid, .. } => assert_eq!(txid, TXID2),
            other => panic!("expected Sent, got {other:?}"),
        }
        assert_eq!(load(&dir).txid.as_deref(), Some(TXID2));
        // Both are on the record, so a wallet that lists either settles it as mined.
        let a = load_attempt(&dir, VAULT, "p1").unwrap().unwrap();
        assert_eq!(
            (a.txid.as_str(), a.reported_txid.as_deref()),
            (TXID, Some(TXID2))
        );
        assert_eq!(settle(&a, &view(4_000, &[TXID2])), Settlement::Mined);
        assert_eq!(settle(&a, &view(4_000, &[TXID])), Settlement::Mined);
        // And it is not left to be called dead while it sits on the chain under the other name.
        assert_eq!(settle(&a, &view(9_999, &[])), Settlement::Dead);
    }

    #[test]
    fn txids_match_without_regard_to_case() {
        let a = attempt(TXID, 5_000);
        let upper = TXID.to_uppercase();
        assert_eq!(
            settle(&a, &view(4_000, &[upper.as_str()])),
            Settlement::Mined
        );
    }

    #[test]
    fn an_older_record_without_the_newer_fields_still_reads() {
        // A hold with no way out is what an unreadable record is: fields added later must default.
        let dir = vaults();
        std::fs::create_dir_all(attempts_dir(&dir, VAULT)).unwrap();
        let old = format!(
            r#"{{"proposal_id":"p1","vault_id":"{VAULT}","txid":"{TXID}","sighash":"{}","signatures":[],"expiry_height":5000,"recorded_at_unix":1}}"#,
            "ab".repeat(32)
        );
        std::fs::write(attempt_path(&dir, VAULT, "p1"), old).unwrap();
        let a = load_attempt(&dir, VAULT, "p1").unwrap().unwrap();
        assert_eq!((a.version, a.reported_txid), (1, None));
    }

    #[test]
    fn a_record_with_a_txid_that_is_not_one_refuses_the_send() {
        // Readable JSON is not a readable record: without this check a corrupted or edited record
        // stops holding, and after its expiry the send starts again.
        let dir = vaults();
        std::fs::create_dir_all(attempts_dir(&dir, VAULT)).unwrap();
        let mut a = attempt("zz", 5_000);
        std::fs::write(
            attempt_path(&dir, VAULT, "p1"),
            serde_json::to_vec(&a).unwrap(),
        )
        .unwrap();
        assert!(load_attempt(&dir, VAULT, "p1").is_err());
        let f = Fake::new();
        assert!(matches!(
            go(&dir, proposal("ready"), false, &f),
            SendResult::Unsettled { .. }
        ));
        assert!(!f.ran("prepare"));

        // The same for the id the tool reported.
        a.txid = TXID.into();
        a.reported_txid = Some("not-a-txid".into());
        std::fs::write(
            attempt_path(&dir, VAULT, "p1"),
            serde_json::to_vec(&a).unwrap(),
        )
        .unwrap();
        assert!(load_attempt(&dir, VAULT, "p1").is_err());
    }

    #[test]
    fn a_payment_found_mined_under_the_reported_id_is_settled_under_that_id() {
        // The wallet lists what the tool reported, not what was derived: the proposal and the trail
        // must carry the id that is on the chain.
        let dir = vaults();
        let mut a = attempt(TXID, 5_000);
        a.reported_txid = Some(TXID2.into());
        record_attempt(&dir, &a).unwrap();
        let mut f = Fake::new();
        f.view = Ok(view(4_100, &[TXID2]));
        match go(&dir, proposal("ready"), false, &f) {
            SendResult::AlreadySent { txid, .. } => assert_eq!(txid, TXID2),
            other => panic!("expected AlreadySent, got {other:?}"),
        }
        assert_eq!(load(&dir).txid.as_deref(), Some(TXID2));
        assert_eq!(load_ceremonies(&dir, VAULT)[0].txid.as_deref(), Some(TXID2));
    }

    #[test]
    fn a_tool_that_prints_the_same_id_in_another_case_is_not_a_divergence() {
        let dir = vaults();
        let mut f = Fake::new();
        f.reported = Some("11111111111111111111111111111111111111111111111111111111111111AA");
        let _ = go(&dir, proposal("ready"), false, &f);
        let a = load_attempt(&dir, VAULT, "p1").unwrap().unwrap();
        assert_eq!(a.reported_txid, None, "{a:?}");
        assert_eq!(load(&dir).txid.as_deref(), Some(TXID));
    }

    #[test]
    fn a_trail_entry_that_is_already_there_is_not_written_twice() {
        // A promotion that failed after its trail entry was written is retried: it must not add a
        // second entry for the same transaction (in either spelling).
        let dir = vaults();
        let mut p = proposal("ready");
        p.expiry_unix = 1_500;
        save_proposal(&dir, &p).unwrap();
        record_attempt(&dir, &attempt(TXID, 0)).unwrap();
        append_ceremony(
            &dir,
            &CeremonyRecord {
                vault_id: VAULT.into(),
                sighash: "ab".repeat(32),
                signatures: vec![],
                txid: Some(TXID.to_uppercase()),
                dry_run: false,
                created_at_unix: 1,
            },
        )
        .unwrap();
        assert_eq!(promote_at(&dir, VAULT, 2_000, || Ok(vec![TXID.into()])), 1);
        assert_eq!(load_ceremonies(&dir, VAULT).len(), 1);
        assert_eq!(load(&dir).state, "sent");
    }

    #[test]
    fn the_archive_of_a_dead_attempt_is_not_a_held_payment() {
        let dir = vaults();
        save_proposal(&dir, &proposal("ready")).unwrap();
        record_attempt(&dir, &attempt(TXID, 1_000)).unwrap();
        archive_attempt(&dir, VAULT, "p1", 5).unwrap();
        // Only the trail is left in `send-attempts/`: nothing is held, at boot or on a read.
        assert!(unsettled_attempts(&dir).is_empty());
        let asked = Cell::new(false);
        promote_at(&dir, VAULT, 2_000, || {
            asked.set(true);
            Ok(vec![])
        });
        assert!(!asked.get());
    }

    // ---- the record itself -----------------------------------------------------------------

    #[test]
    fn the_txid_recorded_is_the_one_derived_before_the_broadcast() {
        let dir = vaults();
        let f = Fake::new();
        let _ = go(&dir, proposal("ready"), false, &f);
        assert_eq!(load_attempt(&dir, VAULT, "p1").unwrap().unwrap().txid, TXID);
    }

    #[test]
    fn two_spellings_of_an_id_reach_one_record() {
        let a = attempt_path(Path::new("/v"), VAULT, "p1");
        for alias in ["p1.", "p1/", "p1\\", " p1"] {
            assert_eq!(attempt_path(Path::new("/v"), VAULT, alias), a, "{alias:?}");
        }
        let dir = vaults();
        record_attempt(&dir, &attempt(TXID, 5_000)).unwrap();
        let mut dup = attempt(TXID2, 5_000);
        dup.proposal_id = "p1.".into();
        assert_eq!(record_attempt(&dir, &dup), Err(RecordError::Exists));
    }

    #[test]
    fn exactly_one_of_two_racing_attempts_owns_the_record() {
        // One round catches a "check, then act" race only some of the time; thirty rounds, each on a
        // fresh vault with eight threads released together, make missing it a matter of luck squared.
        for round in 0..30 {
            let dir = vaults();
            let gate = std::sync::Arc::new(std::sync::Barrier::new(8));
            let results: Vec<_> = (0..8)
                .map(|i| {
                    let (dir, gate) = (dir.clone(), gate.clone());
                    std::thread::spawn(move || {
                        let mut a = attempt(TXID, 5_000);
                        a.signatures = vec![format!("{i:02x}").repeat(64)];
                        gate.wait();
                        record_attempt(&dir, &a)
                    })
                })
                .collect::<Vec<_>>()
                .into_iter()
                .map(|h| h.join().unwrap())
                .collect();
            assert_eq!(
                results.iter().filter(|r| r.is_ok()).count(),
                1,
                "round {round}: {results:?}"
            );
            assert!(results
                .iter()
                .filter(|r| r.is_err())
                .all(|r| *r == Err(RecordError::Exists)));
            // No temporary file is left behind to be read as a record.
            let stray = std::fs::read_dir(attempts_dir(&dir, VAULT))
                .unwrap()
                .flatten()
                .filter(|e| e.file_name().to_string_lossy().ends_with(".tmp"))
                .count();
            assert_eq!(stray, 0);
        }
    }

    #[test]
    fn a_probe_leaves_nothing_behind_and_a_blocked_volume_fails_it() {
        let dir = vaults();
        let before = std::fs::read_dir(&dir).unwrap().count();
        probe_volume(&dir).unwrap();
        assert_eq!(std::fs::read_dir(&dir).unwrap().count(), before);
        probe_record_dir(&dir, VAULT).unwrap();
        let left = std::fs::read_dir(attempts_dir(&dir, VAULT))
            .unwrap()
            .count();
        assert_eq!(left, 0, "the probe cleans up after itself");
        #[cfg(unix)]
        {
            let blocked = vaults();
            std::os::unix::fs::symlink("/nonexistent/elsewhere", attempts_dir(&blocked, VAULT))
                .unwrap();
            assert!(probe_record_dir(&blocked, VAULT).is_err());
        }
    }

    #[test]
    fn the_log_never_carries_a_whole_vault_id_or_a_line_break() {
        // The function `log` prints, not just the filter inside it.
        let engine = format!("wallet at /data/vaults/{VAULT}/wallet: no such table\nforged: ok\r");
        let line = log_line(VAULT, "p1", &engine);
        assert!(!line.contains(VAULT), "{line}");
        assert!(line.contains(short(VAULT)), "{line}");
        assert!(!line.contains('\n') && !line.contains('\r'), "{line:?}");
    }

    // ---- held payments seen without a send request -----------------------------------------

    #[test]
    fn a_held_payment_found_mined_is_promoted_when_the_vault_is_read() {
        // The proposal's own deadline passed while the send was held, so it reads `expired` and the
        // screen offers no Send. Reading the vault is what must settle it.
        let dir = vaults();
        let mut p = proposal("ready");
        p.expiry_unix = 1_500; // long gone when `load` recomputes at t = 2000
        save_proposal(&dir, &p).unwrap();
        record_attempt(&dir, &attempt(TXID, 0)).unwrap();
        assert_eq!(load(&dir).state, "expired");

        let n = promote_at(&dir, VAULT, 2_000, || Ok(vec![TXID.to_uppercase()]));
        assert_eq!(n, 1);
        let saved = load(&dir);
        assert_eq!(saved.state, "sent");
        // Under the record's own spelling, which is the lower-case one wallets print.
        assert_eq!(saved.txid.as_deref(), Some(TXID));
        assert_eq!(load_ceremonies(&dir, VAULT).len(), 1);
        // Done once: a second read finds nothing held and does not read the wallet at all.
        let asked = Cell::new(false);
        let again = promote_at(&dir, VAULT, 2_100, || {
            asked.set(true);
            Ok(vec![])
        });
        assert_eq!(again, 0);
        assert!(!asked.get());
        assert_eq!(
            load_ceremonies(&dir, VAULT).len(),
            1,
            "no duplicate trail entry"
        );
    }

    #[test]
    fn promoting_never_frees_or_promotes_what_is_not_mined() {
        let dir = vaults();
        save_proposal(&dir, &proposal("ready")).unwrap();
        record_attempt(&dir, &attempt(TXID, 1_000)).unwrap();
        // Not mined, and by the expiry it would be dead: only a Send decides that. Reading must not.
        assert_eq!(promote_at(&dir, VAULT, 2_000, || Ok(vec![TXID2.into()])), 0);
        assert!(load_attempt(&dir, VAULT, "p1").unwrap().is_some());
        assert_eq!(load(&dir).state, "ready");
        // A wallet that cannot be read promotes nothing.
        assert_eq!(
            promote_at(&dir, VAULT, 2_100, || Err(ToolError::parse(
                "wallet", "down"
            ))),
            0
        );
    }

    #[test]
    fn a_vault_with_no_record_never_reads_the_wallet() {
        let dir = vaults();
        let asked = Cell::new(false);
        let n = promote_at(&dir, VAULT, 2_000, || {
            asked.set(true);
            Ok(vec![])
        });
        assert_eq!(n, 0);
        assert!(!asked.get(), "nothing held, nothing to ask the wallet");
    }

    #[test]
    fn the_wallet_is_read_once_per_window_however_often_the_vault_is_read() {
        // A screen polls every few seconds. Without a window each poll would start a subprocess
        // under the vault's lock for as long as a payment stays held.
        let dir = vaults();
        save_proposal(&dir, &proposal("ready")).unwrap();
        record_attempt(&dir, &attempt(TXID, 5_000)).unwrap();
        let reads = Cell::new(0);
        let read = || {
            reads.set(reads.get() + 1);
            Ok::<Vec<String>, ToolError>(vec![])
        };
        promote_at(&dir, VAULT, 2_000, read);
        promote_at(&dir, VAULT, 2_000 + PROMOTE_THROTTLE_SECS - 1, read);
        assert_eq!(
            reads.get(),
            1,
            "inside the window the wallet is not read again"
        );
        promote_at(&dir, VAULT, 2_000 + PROMOTE_THROTTLE_SECS, read);
        assert_eq!(reads.get(), 2, "once the window has passed it is");
    }

    #[test]
    fn a_wallet_that_fails_is_not_asked_again_inside_the_window_either() {
        // The same window covers a failure, so a wallet that stays down is not a log line per request.
        let dir = vaults();
        save_proposal(&dir, &proposal("ready")).unwrap();
        record_attempt(&dir, &attempt(TXID, 5_000)).unwrap();
        let reads = Cell::new(0);
        let fail = || {
            reads.set(reads.get() + 1);
            Err::<Vec<String>, ToolError>(ToolError::parse("wallet", "down"))
        };
        promote_at(&dir, VAULT, 3_000, fail);
        promote_at(&dir, VAULT, 3_001, fail);
        assert_eq!(reads.get(), 1);
    }

    #[test]
    fn an_old_record_is_still_promoted_when_the_wallet_learns_of_it_late() {
        // No record is skipped for its age: a wallet restored from a backup, or rescanned, can list a
        // payment months after it was made, and the ledger must still get it.
        let dir = vaults();
        save_proposal(&dir, &proposal("ready")).unwrap();
        record_attempt(&dir, &attempt(TXID, 5_000)).unwrap(); // recorded at t = 1000
        let year = 365 * 24 * 3600;
        assert_eq!(
            promote_at(&dir, VAULT, 1_000 + year, || Ok(vec![TXID.into()])),
            1
        );
        assert_eq!(load(&dir).state, "sent");
    }

    #[test]
    fn a_throttle_stamp_from_the_future_does_not_hold_a_payment_back() {
        let dir = vaults();
        save_proposal(&dir, &proposal("ready")).unwrap();
        record_attempt(&dir, &attempt(TXID, 5_000)).unwrap();
        std::fs::write(
            last_promote_path(&dir, VAULT),
            (2_000 + 100_000).to_string(),
        )
        .unwrap();
        assert_eq!(promote_at(&dir, VAULT, 2_000, || Ok(vec![TXID.into()])), 1);
    }

    #[test]
    fn a_payment_whose_trail_cannot_be_written_is_left_held_and_settled_on_the_next_read() {
        // The trail is written FIRST and the proposal only if it was: a proposal marked sent leaves
        // the held list for good, so a trail entry that failed would never be written again.
        let dir = vaults();
        let mut p = proposal("ready");
        p.expiry_unix = 1_500;
        save_proposal(&dir, &p).unwrap();
        record_attempt(&dir, &attempt(TXID, 0)).unwrap();
        let trail = dir.join(VAULT).join("ceremonies.jsonl");
        std::fs::create_dir_all(&trail).unwrap(); // the trail cannot be appended to

        assert_eq!(promote_at(&dir, VAULT, 2_000, || Ok(vec![TXID.into()])), 0);
        assert_eq!(
            load(&dir).state,
            "expired",
            "not marked sent without its trail"
        );
        assert_eq!(unsettled_attempts(&dir).len(), 1, "still held");

        std::fs::remove_dir_all(&trail).unwrap();
        assert_eq!(
            promote_at(&dir, VAULT, 2_000 + PROMOTE_THROTTLE_SECS, || Ok(vec![
                TXID.into()
            ])),
            1
        );
        assert_eq!(load(&dir).state, "sent");
        assert_eq!(
            load_ceremonies(&dir, VAULT).len(),
            1,
            "the trail got its entry"
        );
    }

    #[test]
    fn a_send_whose_trail_cannot_be_written_stays_held_and_is_settled_by_the_next_read() {
        // The success path of a send goes through the same function as a payment found mined: trail
        // first, the proposal only if the trail was written. A broadcast whose trail fails therefore
        // leaves the proposal `ready` with its record held (never a `sent` without a trail), and a
        // later read, once the wallet lists the transaction, records both.
        let dir = vaults();
        save_proposal(&dir, &proposal("ready")).unwrap();
        let trail = dir.join(VAULT).join("ceremonies.jsonl");
        std::fs::create_dir_all(&trail).unwrap();

        let f = Fake::new();
        match go(&dir, proposal("ready"), false, &f) {
            SendResult::Sent {
                txid, record_error, ..
            } => {
                assert_eq!(txid, TXID);
                assert!(record_error.is_some_and(|e| e.contains("ceremony")));
            }
            other => panic!("expected Sent, got {other:?}"),
        }
        assert_eq!(load(&dir).state, "ready");
        assert_eq!(unsettled_attempts(&dir).len(), 1, "still held");

        std::fs::remove_dir_all(&trail).unwrap();
        assert_eq!(promote_at(&dir, VAULT, 2_000, || Ok(vec![TXID.into()])), 1);
        assert_eq!(load(&dir).state, "sent");
        assert_eq!(load_ceremonies(&dir, VAULT).len(), 1);
    }

    #[test]
    fn the_boot_count_lists_held_payments_and_not_finished_ones() {
        let dir = vaults();
        // One finished send (its record stays on disk for good) and one held.
        let mut done = proposal("sent");
        done.id = "pdone".into();
        done.txid = Some(TXID.into());
        save_proposal(&dir, &done).unwrap();
        let mut rec = attempt(TXID, 5_000);
        rec.proposal_id = "pdone".into();
        record_attempt(&dir, &rec).unwrap();

        save_proposal(&dir, &proposal("ready")).unwrap();
        record_attempt(&dir, &attempt(TXID2, 5_000)).unwrap();

        let held = unsettled_attempts(&dir);
        assert_eq!(
            held,
            vec![HeldPayment {
                vault: short(VAULT).to_string(),
                proposal: "p1".to_string(),
                unreadable: false
            }]
        );
    }

    #[test]
    fn a_record_that_cannot_be_read_is_listed_at_boot_and_never_promoted() {
        // It refuses every Send for its proposal and nothing clears it: exactly what an operator
        // must be told about, so it is counted, named and marked.
        let dir = vaults();
        save_proposal(&dir, &proposal("ready")).unwrap();
        std::fs::create_dir_all(attempts_dir(&dir, VAULT)).unwrap();
        std::fs::write(attempt_path(&dir, VAULT, "p1"), b"{ half a record").unwrap();

        let held = unsettled_attempts(&dir);
        assert_eq!(held.len(), 1);
        assert!(held[0].unreadable && held[0].proposal == "p1", "{held:?}");
        // Reading the vault does not try to promote it, and does not read the wallet for it.
        let asked = Cell::new(false);
        assert_eq!(
            promote_at(&dir, VAULT, 2_000, || {
                asked.set(true);
                Ok(vec![TXID.into()])
            }),
            0
        );
        assert!(!asked.get());
        // An unreadable record of a payment that is already sent holds nothing.
        let mut done = proposal("sent");
        done.id = "pdone".into();
        save_proposal(&dir, &done).unwrap();
        std::fs::write(attempt_path(&dir, VAULT, "pdone"), b"garbage").unwrap();
        assert_eq!(unsettled_attempts(&dir).len(), 1);
    }

    // ---- the proposal file ------------------------------------------------------------------

    #[test]
    fn saving_a_proposal_replaces_it_whole_and_leaves_no_temporary_file() {
        let dir = vaults();
        let mut p = proposal("ready");
        save_proposal(&dir, &p).unwrap();
        p.state = "sent".into();
        p.txid = Some(TXID.into());
        save_proposal(&dir, &p).unwrap();
        assert_eq!(load(&dir).txid.as_deref(), Some(TXID));
        // The temporary lives beside `proposals/`, never in it (it lists every file there), and is gone.
        let stray: Vec<_> = std::fs::read_dir(dir.join(VAULT))
            .unwrap()
            .flatten()
            .filter(|e| e.file_name().to_string_lossy().ends_with(".tmp"))
            .collect();
        assert!(stray.is_empty(), "{stray:?}");
        assert_eq!(crate::helper::list_proposals(&dir, VAULT, 2_000).len(), 1);
    }

    #[test]
    fn a_failed_directory_sync_takes_the_record_back() {
        // The record is refused for it, so it must not also be left behind as a hold.
        let dir = vaults();
        let a = attempt(TXID, 5_000);
        let r = record_attempt_with(&dir, &a, |_| Err(std::io::Error::other("no fsync here")));
        assert!(matches!(r, Err(RecordError::Io(_))), "{r:?}");
        assert!(load_attempt(&dir, VAULT, "p1").unwrap().is_none());
    }

    // ---- the doors --------------------------------------------------------------------------

    /// The broadcast has few doors, and each is named here. A new caller of the tool that
    /// broadcasts, anywhere in this crate, fails this until someone decides it belongs.
    #[test]
    fn the_broadcast_tool_has_only_the_known_callers() {
        fn walk(dir: &Path, needle: &str, out: &mut Vec<(String, usize)>) {
            for entry in std::fs::read_dir(dir).unwrap().flatten() {
                let path = entry.path();
                if path.is_dir() {
                    walk(&path, needle, out);
                } else if path.extension().and_then(|e| e.to_str()) == Some("rs") {
                    let n = std::fs::read_to_string(&path)
                        .unwrap()
                        .matches(needle)
                        .count();
                    if n > 0 {
                        out.push((path.file_name().unwrap().to_string_lossy().into_owned(), n));
                    }
                }
            }
        }
        let scan = |needle: &str| -> Vec<(String, usize)> {
            let mut found = Vec::new();
            walk(
                &Path::new(env!("CARGO_MANIFEST_DIR")).join("src"),
                needle,
                &mut found,
            );
            found.sort();
            found
        };
        // `send.rs`: the signed-transaction broadcast that `send_proposal` and the operator's command
        // line share, and the local bridge's own path (not the hosted coordinator, see CHANGELOG).
        // This file names the call only inside this test, assembled from parts.
        let call = ["pczt", "::send("].concat();
        assert_eq!(scan(&call), vec![("send.rs".to_string(), 2)]);
        // `send.rs`: the definition, the operator wrapper and the test that pins the bytes it hands
        // the tool. `send_record.rs`: the live step `send_with` calls after the record exists.
        let call = ["broadcast", "_signed("].concat();
        assert_eq!(
            scan(&call),
            vec![
                ("send.rs".to_string(), 3),
                ("send_record.rs".to_string(), 1)
            ]
        );
    }

    #[test]
    fn settling_is_decided_by_the_chain_and_the_expiry() {
        let a = attempt(TXID, 1_000);
        assert_eq!(settle(&a, &view(900, &[TXID])), Settlement::Mined);
        // Mined wins even past the expiry.
        assert_eq!(settle(&a, &view(9_000, &[TXID])), Settlement::Mined);
        assert_eq!(settle(&a, &view(900, &[])), Settlement::StillPossible);
        assert_eq!(
            settle(&a, &view(1_000 + MARGIN, &[])),
            Settlement::StillPossible
        );
        assert_eq!(settle(&a, &view(1_000 + MARGIN + 1, &[])), Settlement::Dead);
        // A wallet that reports no tip is not past anything.
        assert_eq!(settle(&a, &view(0, &[])), Settlement::StillPossible);
        // Another transaction being mined is not this one.
        assert_eq!(settle(&a, &view(900, &[TXID2])), Settlement::StillPossible);
        // No expiry: never dead.
        assert_eq!(
            settle(&attempt(TXID, 0), &view(u64::MAX, &[])),
            Settlement::StillPossible
        );
    }

    #[test]
    fn a_live_send_that_no_seat_signed_and_cannot_seal_prepares_nothing() {
        let sc: SendConfig = serde_json::from_value(serde_json::json!({
            "devtool": "/nonexistent/devtool", "wallet_dir": "/w", "lightwalletd": "zec.rocks:443",
            "account": "acc", "konclave_signer": "/nonexistent/signer", "frostd": "/x",
            "frost_client": "/x", "members": [], "threshold": 2, "group": "g",
            "frostd_cert": "c", "frostd_key": "k", "server_url": "s",
            "work_dir": "/nonexistent/work",
        }))
        .unwrap();
        let plan = SpendPlan::Payment {
            to: "utest1x".into(),
            value_zat: 1000,
            memo: None,
        };
        let refused = Err(crate::helper::UnsealedRefused);
        let live = LiveSend {
            sc: &sc,
            plan: Some(&plan),
            relay_base: "https://relay.test",
            room: "room",
            recipients: &refused,
            max_polls: 1,
            vault_id: VAULT,
            vaults_dir: Path::new("/nonexistent/vaults"),
        };
        let err = live.prepare().unwrap_err().to_string();
        assert!(err.contains("unsealed"), "{err}");
    }
}
