//! End-to-end spend orchestration (step 2c): chain the tested wrappers into a single
//! Ready→Sent flow - build the PCZT, prove it, extract the FROST message, run the
//! ceremony, inject the signature, and (optionally) broadcast.
//!
//! This is where "an error costs real funds" (CLAUDE.md §4), so it follows the proven
//! slice recipe exactly (docs/VERTICAL_SLICE.md) and supports a **dry-run** that stops
//! right before broadcast - everything up to a fully-signed PCZT, no funds moved.
//!
//! `frostd` is started fresh per call and killed on drop, so no ceremony leaks a server
//! or a stale session.

use std::path::PathBuf;
use std::thread;
use std::time::Duration;

use serde::Deserialize;
use zeroize::Zeroizing;

use crate::ceremony::{run_coordinator, run_participant, Frostd};
use crate::epoch::EpochGate;
use crate::relay_client::{CurlTransport, RelayClient, Transport};
use crate::tools::ToolError;
use crate::{net_send, pczt, signer};

/// A vault member as the ceremony knows them: name + comm pubkey + their frost-client
/// config (which holds only that member's role material). Public paths, never a share.
#[derive(Debug, Clone, Deserialize)]
pub struct CeremonyMember {
    pub name: String,
    pub pubkey: String,
    pub config: String,
}

/// Everything the automated ceremony needs. Loaded from a JSON file (`--ceremony`) so
/// the paths, group, members and certs live outside the binary. Contains only paths and
/// public material - never a key share.
#[derive(Debug, Clone, Deserialize)]
pub struct SendConfig {
    pub devtool: PathBuf,
    pub wallet_dir: String,
    /// lightwalletd endpoint for broadcast, e.g. "zec.rocks:443".
    pub lightwalletd: String,
    /// Wallet account id (uuid) the PCZT spends from.
    pub account: String,
    pub konclave_signer: PathBuf,
    pub frostd: PathBuf,
    pub frost_client: PathBuf,
    /// The vault's members - the ceremony picks the signing set from **who approved**
    /// (5-D.3: approval ↔ share that signs).
    pub members: Vec<CeremonyMember>,
    /// How many signatures the quorum needs (t).
    pub threshold: usize,
    /// Group public key (hex).
    pub group: String,
    pub frostd_cert: String,
    pub frostd_key: String,
    #[serde(default = "default_ip")]
    pub frostd_ip: String,
    #[serde(default = "default_port")]
    pub frostd_port: u16,
    /// frost-client's view of the server, e.g. "127.0.0.1:2744".
    pub server_url: String,
    /// Scratch directory for the intermediate PCZT files.
    pub work_dir: String,
    /// 5-E: path to the 32-byte sealing key. When set, member configs ending in
    /// `.sealed` are unsealed to ephemeral 0600 files just for the ceremony - the share
    /// never sits in cleartext on disk. (Key custody is a 0600 file here; the product
    /// uses the OS keychain.)
    #[serde(default)]
    pub sealing_key_file: Option<String>,
    /// C2: OS-keychain vault id for the sealing key (Windows Credential Manager / macOS
    /// Keychain / Linux Secret Service). Preferred over `sealing_key_file` on a real
    /// desktop - no sealing key on disk. When both are set, the keychain wins.
    #[serde(default)]
    pub sealing_keychain_id: Option<String>,
    /// 5-F: `zcash-sign` binary (derives the Orchard address + UFVK from the group key).
    #[serde(default)]
    pub zcash_sign: Option<std::path::PathBuf>,
    /// 5-F: directory under which new DKG vaults (configs + wallet) are created.
    #[serde(default)]
    pub vaults_dir: Option<String>,
}

fn default_ip() -> String {
    "127.0.0.1".into()
}
fn default_port() -> u16 {
    2744
}

/// The result of an orchestration run.
#[derive(Debug, Clone)]
pub struct SendOutcome {
    /// The broadcast txid - `None` on a dry-run (signed but not sent).
    pub txid: Option<String>,
    /// Path to the fully-signed PCZT.
    pub signed_pczt: String,
    /// The shielded sighash the ceremony signed (hex) - useful for the receipt.
    pub sighash: String,
    /// The aggregate FROST signature(s) the quorum produced, one hex string per real spend, in
    /// spend order (64 bytes each). These make the ceremony INDEPENDENTLY verifiable off-chain:
    /// anyone can check each signature under the group's verifying key + the spend's alpha for the
    /// sighash, without trusting the operator (the basis of the ceremony record).
    pub signatures: Vec<String>,
}

/// One payroll beneficiary, fed to the multi-output PCZT builder.
#[derive(Debug, Clone, serde::Serialize)]
pub struct PayrollDest {
    pub address: String,
    pub value_zat: u64,
    pub memo: Option<String>,
}

/// What to spend: a single payment, or a payroll (N outputs in one transaction).
pub enum SpendPlan {
    Payment {
        to: String,
        value_zat: u64,
        memo: Option<String>,
    },
    Payroll {
        lines: Vec<PayrollDest>,
    },
}

/// Build the unproven PCZT for a plan. A single payment uses the official CLI (one
/// output); a payroll uses our multi-output builder (`konclave-signer build-payroll`,
/// which links `zcash_client_backend` - the engine the CLI lacks).
/// What the wallet says when asked whether it can fund a plan.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Funding {
    /// The wallet built the transaction, so the vault can pay this.
    Ok,
    /// It cannot, and these are the two figures that decide it, in zatoshis.
    Short { available: u64, required: u64 },
    /// The wallet CAN build it, and the signing bridge will refuse to sign it: the amount needed
    /// notes from both shielded pools (#427).
    ///
    /// Separate from `Short` because the money is there. The remedy is a different one - two
    /// payments, or consolidating the vault - and reporting it as a shortfall would send a member
    /// looking for funds they already have.
    CrossesPools,
}

/// Does this engine error mean "this transaction spends from both shielded pools"?
///
/// Matched on text because that is what crossing a process boundary leaves us: `konclave-signer`
/// reports it as `anyhow!("mixed Orchard+Ironwood spends are not supported by this bridge")`. The
/// match is deliberately on the two pool names rather than the whole sentence, so a reworded
/// refusal still reads as the same refusal - the failure mode of an exact match here is silently
/// going back to the old behaviour, which is the thing being fixed.
///
/// `konclave-wasm` was made to emit this exact sentence too (#364), so the browser and the native
/// bridge tell a member the same thing about one cause.
fn is_mixed_pool(text: &str) -> bool {
    let t = text.to_ascii_lowercase();
    t.contains("mixed") && t.contains("orchard") && t.contains("ironwood")
}

/// Read `available` / `required` out of a wallet error, in either shape the engine emits.
///
/// There are TWO, and shipping a parser that knew only one is what let an unfundable proposal
/// through on the payment path while the payroll path refused it correctly:
///
///   payroll  (konclave-signer, Debug)  InsufficientFunds { available: Zatoshis(20000), required: Zatoshis(24000) }
///   payment  (zcash-devtool, Display)  Insufficient balance (have 501000, need 900010000 including fee)
///
/// The devtool renders the wallet error through `Display` (`Error::Wallet(e) => e.fmt(f)`), and
/// `zcash_client_backend`'s Display for this case is literally
/// "Insufficient balance (have {}, need {} including fee)". Both shapes are read from the crates,
/// not from a sample, and both are pinned by tests.
pub fn parse_insufficient_funds(stderr: &str) -> Option<(u64, u64)> {
    // Shape 1: the Debug rendering.
    if let Some(at) = stderr.find("InsufficientFunds") {
        let rest = &stderr[at..];
        let grab = |key: &str| -> Option<u64> {
            let i = rest.find(key)? + key.len();
            let tail = &rest[i..];
            let open = tail.find('(')? + 1;
            let close = tail[open..].find(')')?;
            tail[open..open + close].trim().parse::<u64>().ok()
        };
        if let (Some(a), Some(r)) = (grab("available:"), grab("required:")) {
            return Some((a, r));
        }
    }
    // Shape 2: the Display rendering.
    if let Some(at) = stderr.find("Insufficient balance") {
        let rest = &stderr[at..];
        let num_after = |key: &str| -> Option<u64> {
            let i = rest.find(key)? + key.len();
            let digits: String = rest[i..]
                .chars()
                .skip_while(|c| !c.is_ascii_digit())
                .take_while(|c| c.is_ascii_digit())
                .collect();
            digits.parse::<u64>().ok()
        };
        if let (Some(a), Some(r)) = (num_after("have"), num_after("need")) {
            return Some((a, r));
        }
    }
    None
}

/// Ask the WALLET whether this plan can be paid, before anyone is asked to approve or sign.
///
/// This is the only honest answer to "does it fit": the fee depends on which notes the wallet
/// selects, so no client-side estimate can be right. `build_unproven` is what makes it cheap enough
/// to ask - it touches no share, needs no relay, no ceremony and nobody's attention, and it is
/// already step 1 of a real send. Asking it early costs one build; not asking it cost a payroll
/// that was proposed, approved by two people and signed by both before the engine refused it.
///
/// Work happens in a scratch directory that is removed afterwards, so a check never leaves a
/// payroll spec behind (see #297 on the send path's own leftovers).
pub fn funding_check(sc: &SendConfig, plan: &SpendPlan) -> Result<Funding, ToolError> {
    let probe_dir = format!("{}/funding-check", sc.work_dir);
    let _ = std::fs::remove_dir_all(&probe_dir);
    std::fs::create_dir_all(&probe_dir).map_err(ToolError::Io)?;
    let probe = SendConfig {
        work_dir: probe_dir.clone(),
        ..sc.clone()
    };
    let outcome = build_unproven(&probe, plan);
    // #427. Building is necessary and not sufficient: the wallet will happily select notes from
    // BOTH shielded pools when neither covers the amount alone, and the signing bridge refuses a
    // transaction that spends from both. Until now that refusal ran at `signer::extract` inside the
    // SEND (send.rs step 2), which is after the proposal exists, after the quorum approved it and
    // after everyone's attention was spent. Asking the same question here costs one more invocation
    // of a binary this function already located, and turns a post-quorum death into a refusal at
    // compose.
    //
    // `extract` is the question, not a new subcommand: it routes through `active_pool` and already
    // refuses a mix. That also means this works against the binary already deployed - nothing in
    // konclave-signer has to change or be rebuilt for it (#522).
    let crossed = match &outcome {
        Ok(bytes) => {
            let probe_pczt = format!("{probe_dir}/funding-check.pczt");
            match std::fs::write(&probe_pczt, bytes) {
                Ok(()) => matches!(
                    signer::extract(&probe.konclave_signer, &probe_pczt),
                    Err(e) if is_mixed_pool(&e.to_string())
                ),
                // Could not write the probe. Say nothing rather than report a refusal we did not
                // measure: the send path asks the same question again, so a miss here costs the
                // old behaviour, not a wrong answer.
                Err(_) => false,
            }
        }
        Err(_) => false,
    };
    let _ = std::fs::remove_dir_all(&probe_dir);
    if crossed {
        return Ok(Funding::CrossesPools);
    }
    match outcome {
        Ok(_) => Ok(Funding::Ok),
        Err(e) => {
            let text = e.to_string();
            match parse_insufficient_funds(&text) {
                Some((available, required)) => Ok(Funding::Short {
                    available,
                    required,
                }),
                // Not a funding problem: let the caller see the real error rather than reporting a
                // shortfall we did not measure.
                None => Err(e),
            }
        }
    }
}

fn build_unproven(sc: &SendConfig, plan: &SpendPlan) -> Result<Vec<u8>, ToolError> {
    match plan {
        SpendPlan::Payment {
            to,
            value_zat,
            memo,
        } => pczt::create(
            &sc.devtool,
            &sc.wallet_dir,
            to,
            *value_zat,
            &sc.account,
            memo.as_deref(),
        ),
        SpendPlan::Payroll { lines } => {
            // The spec is the most sensitive plaintext this process ever writes: every
            // beneficiary's name, address, amount and payslip memo, for the whole group. It used to
            // be written into `sc.work_dir` and left there - and on the hosted helper that
            // directory is the DURABLE Railway volume, so one payroll's roster outlived the send
            // by however long the vault existed (#297).
            //
            // It now goes through the same guard the unsealed shares use: a 0600 file on tmpfs when
            // /dev/shm exists (so on the helper it never reaches a disk), removed when the guard
            // drops - including on panic and on any error path below.
            let spec = serde_json::to_string(lines)
                .map_err(|e| ToolError::parse("payroll spec", e.to_string()))?;
            let out_path = format!("{}/payroll.pczt", sc.work_dir);
            crate::secrets::with_private_file(spec.as_bytes(), |spec_path| {
                crate::tools::run(
                    &sc.konclave_signer,
                    &[
                        "build-payroll",
                        "--wallet",
                        &sc.wallet_dir,
                        "--account",
                        &sc.account,
                        "--spec",
                        &spec_path.to_string_lossy(),
                        "--out",
                        &out_path,
                    ],
                    None,
                )
            })
            .map_err(|e| ToolError::parse("payroll spec", e.to_string()))??;
            std::fs::read(&out_path).map_err(ToolError::Io)
        }
    }
}

/// Run the full spend. On `dry_run` it stops after producing a signed PCZT (no broadcast,
/// no funds moved) - the way to validate the ceremony works today without spending.
///
/// Handles multi-note spends: a transaction may consume several input notes, each a real
/// Orchard spend needing its own FROST signature (one ceremony round per randomizer).
pub fn orchestrate_send(
    sc: &SendConfig,
    plan: &SpendPlan,
    approvers: &[String],
    dry_run: bool,
) -> Result<SendOutcome, ToolError> {
    std::fs::create_dir_all(&sc.work_dir).map_err(ToolError::Io)?;

    // 5-D.3: the signing set is WHO APPROVED. Resolve the first `threshold` approvers to
    // their configs - the ceremony signs with exactly those members' shares, not a fixed set.
    let mut signers: Vec<&CeremonyMember> = Vec::new();
    for a in approvers {
        if let Some(m) = sc.members.iter().find(|m| m.name.eq_ignore_ascii_case(a)) {
            if !signers.iter().any(|s| s.name == m.name) {
                signers.push(m);
            }
        }
        if signers.len() == sc.threshold {
            break;
        }
    }
    if signers.len() < sc.threshold {
        return Err(ToolError::parse(
            "ceremony",
            format!(
                "need {} approvers with a known key; found {} (approvers: {:?})",
                sc.threshold,
                signers.len(),
                approvers
            ),
        ));
    }
    let signer_pks: Vec<String> = signers.iter().map(|m| m.pubkey.clone()).collect();

    // 5-E: resolve each signer's config path. A `.sealed` config is unsealed to an
    // ephemeral 0600 file (kept alive by `_config_guards` for the whole ceremony, then
    // deleted) - the share is never in cleartext on disk.
    // C2: the sealing key comes from the OS keychain when configured, else the 0600 file.
    let key: Option<Zeroizing<[u8; 32]>> = match (&sc.sealing_keychain_id, &sc.sealing_key_file) {
        (Some(vault_id), _) => {
            use crate::secrets::KeyStore;
            let k = crate::secrets::KeychainStore
                .get_or_create_key(vault_id)
                .map_err(|e| ToolError::parse("keychain", e.to_string()))?;
            Some(Zeroizing::new(k))
        }
        (None, Some(f)) => Some(read_key_file(f)?),
        (None, None) => None,
    };
    let mut _config_guards: Vec<crate::secrets::UnsealedFile> = Vec::new();
    let mut configs: Vec<String> = Vec::with_capacity(signers.len());
    for m in &signers {
        if m.config.ends_with(".sealed") {
            let key: &[u8; 32] = key.as_deref().ok_or_else(|| {
                ToolError::parse(
                    "secrets",
                    "sealed config, but no sealing_key_file in the ceremony",
                )
            })?;
            let sealed = std::fs::read(&m.config).map_err(ToolError::Io)?;
            let uf = crate::secrets::unseal_to_file(&sealed, key)
                .map_err(|e| ToolError::parse("secrets", e.to_string()))?;
            configs.push(uf.path().to_string_lossy().into_owned());
            _config_guards.push(uf);
        } else {
            configs.push(m.config.clone());
        }
    }
    let coordinator_config = configs[0].clone();
    let participant_configs = configs;

    // 1) build the (unproven) PCZT (single payment via CLI, payroll via our builder).
    let tx1 = build_unproven(sc, plan)?;

    // 2) prove it (ZK proofs, local).
    let tx2 = pczt::prove(&sc.devtool, &sc.wallet_dir, &tx1)?;
    let tx2_path = format!("{}/tx2-proven.pczt", sc.work_dir);
    std::fs::write(&tx2_path, &tx2).map_err(ToolError::Io)?;

    // 3) extract the sighash + the per-spend randomizers the ceremony must sign.
    let input = signer::extract(&sc.konclave_signer, &tx2_path)?;
    if input.randomizers.is_empty() {
        return Err(ToolError::parse("ceremony", "no real spends to sign"));
    }
    let sighash_hex = hex_encode(&input.sighash);

    // 4) start frostd fresh (killed on drop → no stale session survives the call).
    let _frostd = Frostd::start(
        &sc.frostd,
        &sc.frostd_cert,
        &sc.frostd_key,
        &sc.frostd_ip,
        sc.frostd_port,
    )?; // start() now blocks until frostd accepts connections (no magic sleep)

    // 5) one ceremony per real spend → collect every (action_index, signature). The
    //    message is the same sighash; each spend re-randomizes it with its own alpha.
    let mut signatures = Vec::with_capacity(input.randomizers.len());
    for (round, r) in input.randomizers.iter().enumerate() {
        let alpha_hex = hex_encode(&r.alpha);
        let sig_path = format!("{}/sig-{round}.raw", sc.work_dir);
        let sig = run_ceremony(
            sc,
            &coordinator_config,
            &participant_configs,
            &signer_pks,
            &sighash_hex,
            &alpha_hex,
            &sig_path,
        )?;
        signatures.push((r.action_index, sig));
        // Let the completed session settle before the next round's fresh session.
        thread::sleep(Duration::from_millis(300));
    }

    // 6) inject every signature back into the PCZT (inject verifies each).
    let tx3_path = format!("{}/tx3-signed.pczt", sc.work_dir);
    signer::inject(&sc.konclave_signer, &tx2_path, &tx3_path, &signatures)?;

    // 7) broadcast - unless this is a dry-run.
    let txid = if dry_run {
        None
    } else {
        let tx3 = std::fs::read(&tx3_path).map_err(ToolError::Io)?;
        Some(pczt::send(
            &sc.devtool,
            &sc.wallet_dir,
            &sc.lightwalletd,
            &tx3,
        )?)
    };

    Ok(SendOutcome {
        txid,
        signed_pczt: tx3_path,
        sighash: sighash_hex,
        signatures: signatures.iter().map(|(_, s)| hex_encode(s)).collect(),
    })
}

/// A transaction that is built, proven and signed by the quorum, and not yet broadcast.
///
/// This is the seam between "signed" and "on the network". Its fields are private and nothing outside
/// this module can build one, so the only way to broadcast a signed transaction is to hold one of
/// these, and the only callers that take one are [`crate::send_record`] (which records the attempt
/// first) and [`net_orchestrate_send_untracked`] (the operator's command line, which has no proposal).
#[derive(Clone)]
pub struct SignedSend {
    txid: String,
    sighash: String,
    signatures: Vec<String>,
    expiry_height: u32,
    /// The consensus branch the signed PCZT is under, read from the same bytes as the expiry.
    branch_id: u32,
    /// The signed PCZT, held as bytes: the expiry that gets recorded and the transaction that gets
    /// broadcast are read from the SAME bytes, not from a file that could change between the two.
    tx3: Vec<u8>,
    tx3_path: String,
}

/// The signed PCZT names the recipients, the amounts and the memos, which must never be logged or
/// persisted (#297): so `Debug` leaves the bytes out, and a stray `{:?}` cannot print them.
impl std::fmt::Debug for SignedSend {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("SignedSend")
            .field("txid", &self.txid)
            .field("expiry_height", &self.expiry_height)
            .field("tx3_bytes", &self.tx3.len())
            .finish_non_exhaustive()
    }
}

impl SignedSend {
    /// Describe a signed PCZT: its id from the sighash the devices signed, its expiry from the PCZT.
    /// Failing to read either is an error: a transaction we cannot describe is not one we can record,
    /// and so not one to send.
    fn describe(
        tx3_path: &str,
        sighash: &[u8; 32],
        signatures: Vec<String>,
    ) -> Result<Self, ToolError> {
        let tx3 = std::fs::read(tx3_path).map_err(ToolError::Io)?;
        Self::from_bytes(tx3, tx3_path, sighash, signatures)
    }

    pub(crate) fn from_bytes(
        tx3: Vec<u8>,
        tx3_path: &str,
        sighash: &[u8; 32],
        signatures: Vec<String>,
    ) -> Result<Self, ToolError> {
        Ok(SignedSend {
            expiry_height: pczt::expiry_height_of(&tx3)?,
            branch_id: pczt::consensus_branch_of(&tx3)?,
            txid: pczt::txid_from_sighash(sighash),
            sighash: hex_encode(sighash),
            signatures,
            tx3,
            tx3_path: tx3_path.to_string(),
        })
    }

    /// The transaction's id, derived from the sighash the devices signed (for a transaction with no
    /// transparent input they are the same digest, byte-reversed), so it is known BEFORE the broadcast.
    pub fn txid(&self) -> &str {
        &self.txid
    }
    /// The shielded sighash the quorum signed (hex).
    pub fn sighash(&self) -> &str {
        &self.sighash
    }
    /// The aggregate signatures, one hex per real spend.
    pub fn signatures(&self) -> &[String] {
        &self.signatures
    }
    /// The height the signed transaction itself expires at, read from the PCZT. `0` means none.
    pub fn expiry_height(&self) -> u32 {
        self.expiry_height
    }
    /// The consensus branch the signed transaction is under, read from the PCZT.
    pub fn branch_id(&self) -> u32 {
        self.branch_id
    }

    /// A signed send for tests that never touch the engine. Not available outside `cfg(test)`.
    #[cfg(test)]
    pub(crate) fn for_test(txid: &str, expiry_height: u32) -> Self {
        SignedSend {
            txid: txid.into(),
            sighash: "ab".repeat(32),
            signatures: vec!["cd".repeat(64)],
            expiry_height,
            branch_id: konclave_seal::epochs::NU6_3,
            tx3: Vec::new(),
            tx3_path: String::new(),
        }
    }
}

/// Broadcast a signed transaction and return the txid the tool reports. `pub(crate)`: callers outside
/// this crate cannot broadcast except through a path that records the attempt first.
pub(crate) fn broadcast_signed(sc: &SendConfig, signed: &SignedSend) -> Result<String, ToolError> {
    pczt::send(&sc.devtool, &sc.wallet_dir, &sc.lightwalletd, &signed.tx3)
}

/// Architecture B - build, prove and collect the quorum's signature for a browser-DKG vault, and stop
/// BEFORE the broadcast. The helper builds and proves the PCZT for the vault's own address,
/// publishes the signing request into a relay room, and waits for the browser devices to return
/// the aggregate FROST signature; then it injects it. The devices' shares never reach this process -
/// it sees only public transaction data and the view-only wallet, consistent with "internal
/// transparency, external privacy".
///
/// Broadcasting is a separate step ([`broadcast_signed`]) on purpose: a send that builds and
/// broadcasts inside one call leaves no moment to record that a transaction is about to leave.
///
/// This is live integration glue (real HTTP via `curl`, real binaries); it is not exercised by CI,
/// and is validated end to end on testnet. The pure protocol + handshake it composes ARE unit-tested
/// (see `net_send`, `relay_client`).
#[allow(clippy::too_many_arguments)]
pub fn net_prepare_send(
    sc: &SendConfig,
    plan: &SpendPlan,
    relay_base: &str,
    room: &str,
    // The vault's registered device comms pubkeys (#63): the request is SEALED to these, so the
    // relay carries only ciphertext. Empty = plaintext (compat until every device has registered).
    device_pubs: &[String],
    max_polls: u32,
    poll_delay: Duration,
    // The chain tip for the build hold and the branch check, asked only when the table has a later
    // upgrade to be near. The hosted coordinator passes `helper::settle_wallet`'s (a forced sync, the
    // one reader of the wallet, #637); the operator's command line, which has no vault directory,
    // reads the wallet as it stands.
    tip: &dyn Fn() -> Result<u64, ToolError>,
) -> Result<SignedSend, ToolError> {
    let client = RelayClient::new(
        CurlTransport::default(),
        relay_base.trim_end_matches('/'),
        room,
        "helper",
    );
    net_prepare_send_with(sc, plan, &client, device_pubs, max_polls, poll_delay, tip)
}

/// [`net_prepare_send`] over any relay transport, so a test can drive the whole path with an
/// in-memory relay and stand-in tools.
pub fn net_prepare_send_with<T: Transport>(
    sc: &SendConfig,
    plan: &SpendPlan,
    client: &RelayClient<T>,
    device_pubs: &[String],
    max_polls: u32,
    poll_delay: Duration,
    tip: &dyn Fn() -> Result<u64, ToolError>,
) -> Result<SignedSend, ToolError> {
    // The live gate: mainnet's table, and the caller's tip (asked only when the table has a later
    // upgrade to be near, which it has since the NU7 row).
    let gate = EpochGate {
        table: &konclave_seal::epochs::MAINNET,
        tip,
    };
    net_prepare_send_gated(sc, plan, client, device_pubs, max_polls, poll_delay, &gate)
}

/// [`net_prepare_send_with`] against a given epoch gate, so the hold and the branch check can be
/// driven with a table that has a later upgrade, which mainnet's does not yet.
pub fn net_prepare_send_gated<T: Transport>(
    sc: &SendConfig,
    plan: &SpendPlan,
    client: &RelayClient<T>,
    device_pubs: &[String],
    max_polls: u32,
    poll_delay: Duration,
    gate: &EpochGate<'_>,
) -> Result<SignedSend, ToolError> {
    std::fs::create_dir_all(&sc.work_dir).map_err(ToolError::Io)?;

    // 0) the build hold: no new transaction is built for a branch that is about to stop being valid.
    // Both a single payment and a payroll go through `build_unproven` below, so one gate covers both.
    let tip = gate.tip()?;
    if let Some(text) = crate::epoch::hold_before_build(gate.table, tip) {
        return Err(crate::epoch::refusal(text));
    }

    // 1) build + prove the PCZT for the vault's own address.
    let tx1 = build_unproven(sc, plan)?;
    let tx2 = pczt::prove(&sc.devtool, &sc.wallet_dir, &tx1)?;
    // The engine chooses the target height and the branch. What it built must be on the branch of
    // the epoch the next block belongs to, and a long-lived crossing must not be built close to an
    // upgrade: else the devices would sign a transaction the network refuses (or one that holds the
    // vault's note for weeks). Read from the PCZT's own bytes, and checked before the room opens.
    crate::epoch::check_built(
        gate.table,
        tip,
        pczt::consensus_branch_of(&tx2)?,
        pczt::expiry_height_of(&tx2)?,
    )?;
    let tx2_path = format!("{}/net-tx2-proven.pczt", sc.work_dir);
    std::fs::write(&tx2_path, &tx2).map_err(ToolError::Io)?;

    // 2) extract the sighash + per-spend randomizers the devices must sign.
    let input = signer::extract(&sc.konclave_signer, &tx2_path)?;
    if input.randomizers.is_empty() {
        return Err(ToolError::parse("net-send", "no real spends to sign"));
    }

    // 3) publish the signing request into the vault's relay room. What goes in is the published copy
    // of the PCZT (see `pczt::published_copy`); `tx2` stays whole, to apply the signatures to.
    let published = pczt::published_copy(&tx2)?;
    let req = net_send::SignRequest::from_signing_input(&input, &published);
    let posted = net_send::publish_sealed_request(client, &req, device_pubs)
        .map_err(|e| ToolError::parse("relay", e))?;

    // 4) poll until the devices return the aggregate signatures (or we time out).
    //
    // Start STRICTLY AFTER our own request, which is what `publish_request` returns the sequence
    // for. Starting at 0 read the room from the beginning and found the PREVIOUS payment's
    // response: the signing room is permanent per vault, so an old `net-sign-response` sits in it
    // for as long as the room lives. Those signatures are structurally valid - same real-spend
    // index, same 64 bytes, so `into_sigs` accepts them - and only the cryptography catches it,
    // as `IronwoodSign(InvalidExternalSignature)` at inject time. Every send after the first one
    // in a room failed that way until the room expired (#358).
    // tx3 is written by the verifier below (a candidate is verified BY injecting it), so it must
    // exist before the poll loop.
    let tx3_path = format!("{}/net-tx3-signed.pczt", sc.work_dir);
    let mut since = posted;
    let mut collected = None;
    for _ in 0..max_polls {
        // Verify each candidate by trial-injecting it: `inject` checks every redpallas signature
        // as it applies it, so a real device's response injects cleanly (and tx3_path is then the
        // signed tx, ready to broadcast) while a bogus response an outsider posted into the public
        // room fails the crypto and is SKIPPED - noise, not a kill (#391). Before this, the send
        // accepted the first structurally-valid message and died at inject, so any outsider could
        // DoS every send by posting one junk response. (Cost: an inject subprocess per structurally
        // -valid candidate. Authenticating room writes, #63, would stop the injection at the
        // source.)
        let verify = |sigs: &net_send::SpendSigs| {
            signer::inject(&sc.konclave_signer, &tx2_path, &tx3_path, sigs).is_ok()
        };
        let (found, next) = net_send::collect_response(client, &req, since, verify)
            .map_err(|e| ToolError::parse("relay", e))?;
        since = next;
        if found.is_some() {
            collected = found;
            break;
        }
        thread::sleep(poll_delay);
    }
    // The accepted response was already injected by `verify`; tx3_path holds the signed tx. `sigs`
    // is still used below to record the ceremony's signatures.
    let sigs = collected.ok_or_else(|| {
        ToolError::parse("net-send", "timed out waiting for the devices' signatures")
    })?;

    // 5) read what a later send needs to judge this one - the transaction's own expiry, from the signed
    // PCZT, and its id, from the sighash - out of the very bytes that will be broadcast.
    SignedSend::describe(
        &tx3_path,
        &input.sighash,
        sigs.iter().map(|(_, s)| hex_encode(s)).collect(),
    )
}

/// The operator's command line (`konclave net-send`): prepare, and broadcast unless `dry_run`, with NO
/// record of the attempt. It has no proposal and no vault directory, and runs at a terminal with the
/// operator watching, which is not the hosted coordinator's situation. The hosted coordinator must
/// not call this: it goes through [`crate::send_record::send_proposal`], and a test fails the build if
/// `helper-server` names this function.
#[allow(clippy::too_many_arguments)]
pub fn net_orchestrate_send_untracked(
    sc: &SendConfig,
    plan: &SpendPlan,
    relay_base: &str,
    room: &str,
    device_pubs: &[String],
    dry_run: bool,
    max_polls: u32,
    poll_delay: Duration,
) -> Result<SendOutcome, ToolError> {
    // The operator's terminal: no vault directory to sync under, the wallet as it stands.
    let tip = || crate::wallet::balance(&sc.devtool, &sc.wallet_dir).map(|b| b.chain_tip_height);
    let signed = net_prepare_send(
        sc,
        plan,
        relay_base,
        room,
        device_pubs,
        max_polls,
        poll_delay,
        &tip,
    )?;
    let txid = if dry_run {
        None
    } else {
        Some(broadcast_signed(sc, &signed)?)
    };
    Ok(SendOutcome {
        txid,
        signed_pczt: signed.tx3_path.clone(),
        sighash: signed.sighash.clone(),
        signatures: signed.signatures.clone(),
    })
}

/// Coordinator + participants run concurrently (they block on each other via frostd), as
/// on separate devices in the product. Here they are threads on one box.
#[allow(clippy::too_many_arguments)]
fn run_ceremony(
    sc: &SendConfig,
    coordinator_config: &str,
    participant_configs: &[String],
    signer_pks: &[String],
    sighash_hex: &str,
    randomizer_hex: &str,
    sig_path: &str,
) -> Result<[u8; 64], ToolError> {
    // Owned copies so each closure is 'static.
    let fc = sc.frost_client.clone();
    let coord_cfg = coordinator_config.to_string();
    let server_url = sc.server_url.clone();
    let group = sc.group.clone();
    let signers = signer_pks.to_vec();
    let sighash = sighash_hex.to_string();
    let randomizer = randomizer_hex.to_string();
    let sig_out = sig_path.to_string();

    // Coordinator: creates the session and collects the aggregate signature.
    let coordinator = thread::spawn(move || {
        let signer_refs: Vec<&str> = signers.iter().map(String::as_str).collect();
        run_coordinator(
            &fc,
            &coord_cfg,
            &server_url,
            &group,
            &signer_refs,
            &sighash,
            Some(&randomizer),
            &sig_out,
        )
    });

    // Let the session register before participants join.
    thread::sleep(Duration::from_millis(700));

    // Participants: each contributes its share (auto-confirming the sign prompt).
    let mut participants = Vec::new();
    for cfg in participant_configs {
        let fc = sc.frost_client.clone();
        let cfg = cfg.clone();
        let server_url = sc.server_url.clone();
        let group = sc.group.clone();
        participants.push(thread::spawn(move || {
            run_participant(&fc, &cfg, &server_url, &group)
        }));
    }
    for p in participants {
        p.join()
            .map_err(|_| ToolError::parse("ceremony", "a participant thread panicked"))??;
    }

    coordinator
        .join()
        .map_err(|_| ToolError::parse("ceremony", "the coordinator thread panicked"))?
}

fn hex_encode(bytes: &[u8]) -> String {
    let mut s = String::with_capacity(bytes.len() * 2);
    for b in bytes {
        s.push_str(&format!("{b:02x}"));
    }
    s
}

/// Read the 32-byte sealing key from a file (raw bytes, 0600). The product keeps this in
/// the OS keychain; the file is the local-first stand-in.
fn read_key_file(path: &str) -> Result<Zeroizing<[u8; 32]>, ToolError> {
    // Hold both the raw file bytes and the extracted key in `Zeroizing` (M4): the sealing
    // key never lingers in freed memory after the ceremony.
    let bytes = Zeroizing::new(std::fs::read(path).map_err(ToolError::Io)?);
    if bytes.len() != 32 {
        return Err(ToolError::parse(
            "secrets",
            format!("key file must be 32 bytes, has {} ({path})", bytes.len()),
        ));
    }
    let mut k = Zeroizing::new([0u8; 32]);
    k.copy_from_slice(&bytes);
    Ok(k)
}

#[cfg(test)]
mod tests {
    use super::*;

    // The Ironwood vector the signer's own tests use. Its sighash is `konclave-signer extract`'s, its
    // txid is `zcash-devtool pczt inspect`'s, its expiry was decoded by hand: none of them comes from
    // the code under test.
    const VECTOR: &[u8] =
        include_bytes!("../../konclave-signer/tests/vectors/ironwood_single_spend.proven.pczt");
    // A second PCZT of the same engine, for the bytes `prove` prints in the preparing test below.
    const PROVEN: &[u8] =
        include_bytes!("../../konclave-signer/tests/vectors/ironwood_zero_value_spend.proven.pczt");
    fn vector_sighash() -> [u8; 32] {
        let hex = "332de126200c22131337474ae50367218ec87815c23d297dcdc8278ecb8903b0";
        konclave_seal::hex::decode_exact(hex).unwrap()
    }

    /// The wiring between what the quorum signed and what gets recorded: the id comes from THE
    /// SIGHASH, the expiry from THE PCZT, the signatures are carried, and the transaction that is
    /// held for broadcast is those same bytes.
    #[test]
    fn a_signed_send_describes_the_transaction_it_will_broadcast() {
        let dir = std::env::temp_dir().join(format!("konclave-signed-send-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("net-tx3-signed.pczt");
        std::fs::write(&path, VECTOR).unwrap();

        let s = SignedSend::describe(
            path.to_str().unwrap(),
            &vector_sighash(),
            vec!["cd".repeat(64)],
        )
        .expect("the vector describes");
        assert_eq!(
            s.txid(),
            "b00389cb8e27c8cd7d293dc21578c88e216703e54a47371313220c2026e12d33"
        );
        assert_eq!(s.expiry_height(), 4_203_034);
        assert_eq!(
            s.sighash(),
            "332de126200c22131337474ae50367218ec87815c23d297dcdc8278ecb8903b0"
        );
        assert_eq!(s.signatures(), ["cd".repeat(64)]);
        assert_eq!(s.tx3, VECTOR);
        std::fs::remove_dir_all(&dir).ok();
    }

    /// A relay that plays the devices: when the helper's signing request lands in the room it posts
    /// the quorum's answer (one signature per requested spend) as another party. A real `RelayState`
    /// underneath, no sockets.
    struct DevicesOnTheRelay {
        state: std::sync::Arc<crate::relay::RelayState>,
        /// The `pczt_hex` of every signing request posted into the room, as the room saw it.
        published: std::sync::Arc<std::sync::Mutex<Vec<String>>>,
        /// How many other responses are posted into the room before the devices' answer.
        extra: usize,
    }
    impl DevicesOnTheRelay {
        fn call(&self, method: &str, url: &str, body: &[u8]) -> Result<Vec<u8>, String> {
            let raw = &url[url.find("/api/relay/").unwrap()..];
            let path = raw.split('?').next().unwrap();
            let r = self.state.handle(method, path, raw, body, 1000);
            (r.status == 200)
                .then_some(r.body)
                .ok_or(format!("relay {}", r.status))
        }
    }
    impl Transport for DevicesOnTheRelay {
        fn post(&self, url: &str, body: &[u8]) -> Result<Vec<u8>, String> {
            let posted = self.call("POST", url, body)?;
            let outer: serde_json::Value = serde_json::from_slice(body).unwrap();
            let data = outer["data"].as_str().unwrap_or_default();
            if let Ok(req) = serde_json::from_str::<net_send::SignRequest>(data) {
                self.published.lock().unwrap().push(req.pczt_hex.clone());
                let answer = net_send::SignResponse {
                    kind: net_send::RESPONSE_KIND.to_string(),
                    sigs: req
                        .spends
                        .iter()
                        .map(|s| net_send::SigResp {
                            index: s.index,
                            sig: "ab".repeat(64),
                        })
                        .collect(),
                };
                let mut bogus = answer.clone();
                for s in &mut bogus.sigs {
                    s.sig = "cd".repeat(64);
                }
                for _ in 0..self.extra {
                    let msg = serde_json::json!({ "from": "other_writer",
                        "data": serde_json::to_string(&bogus).unwrap() });
                    self.call("POST", url, msg.to_string().as_bytes())?;
                }
                let msg = serde_json::json!({ "from": "device",
                    "data": serde_json::to_string(&answer).unwrap() });
                self.call("POST", url, msg.to_string().as_bytes())?;
            }
            Ok(posted)
        }
        fn get(&self, url: &str) -> Result<Vec<u8>, String> {
            self.call("GET", url, &[])
        }
    }

    /// `net_prepare_send_with` against stand-ins for the engine's tools and a relay that answers like
    /// the devices, with `proven_bytes` as what the stand-in `prove` prints. Returns what came out and
    /// the `pczt_hex` of every signing request the room was shown.
    #[cfg(unix)]
    fn prepare_against_stand_ins(
        tag: &str,
        proven_bytes: &[u8],
    ) -> (Result<SignedSend, ToolError>, Vec<String>) {
        prepare_against_stand_ins_with_extra(tag, proven_bytes, 0)
    }

    /// The same, with `extra` other responses posted before the devices' answer. The stand-in `inject`
    /// accepts only the devices' signature, as the real one does, so the answer is told from the
    /// others by what it carries.
    #[cfg(unix)]
    fn prepare_against_stand_ins_with_extra(
        tag: &str,
        proven_bytes: &[u8],
        extra: usize,
    ) -> (Result<SignedSend, ToolError>, Vec<String>) {
        use std::os::unix::fs::PermissionsExt;
        let dir =
            std::env::temp_dir().join(format!("konclave-prepare-{tag}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let vector = dir.join("signed.pczt");
        std::fs::write(&vector, VECTOR).unwrap();
        let script = |name: &str, body: String| {
            let path = dir.join(name);
            std::fs::write(&path, format!("#!/bin/sh\n{body}\n")).unwrap();
            let mut perm = std::fs::metadata(&path).unwrap().permissions();
            perm.set_mode(0o755);
            std::fs::set_permissions(&path, perm).unwrap();
            path
        };
        // `pczt -w <dir> create ...` and `pczt -w <dir> prove`. The proven bytes are a PCZT (what is
        // published is redacted, and a PCZT that cannot be read is not published) but NOT the signed
        // one, so reading the proven bytes where the signed ones belong cannot pass.
        let proven = dir.join("proven.pczt");
        std::fs::write(&proven, proven_bytes).unwrap();
        let devtool = script(
            "devtool",
            format!(
                "case \"$4\" in create) printf unproven;; prove) cat >/dev/null; cat {};; esac",
                proven.display()
            ),
        );
        // `extract <pczt>` prints the vector's sighash; `inject <pczt> <out> --sig ...` writes the
        // signed PCZT, as the real one does only if every signature verifies.
        let signer = script(
            "signer",
            format!(
                "case \"$1\" in extract) echo 'SIGHASH {}'; echo 'RANDOMIZER 0 {}';; inject) case \"$*\" in *{}*) cp {} \"$3\";; *) exit 1;; esac;; esac",
                "332de126200c22131337474ae50367218ec87815c23d297dcdc8278ecb8903b0",
                "11".repeat(32),
                "ab".repeat(64),
                vector.display()
            ),
        );
        let sc: SendConfig = serde_json::from_value(serde_json::json!({
            "devtool": devtool, "wallet_dir": "/w", "lightwalletd": "zec.rocks:443",
            "account": "acc", "konclave_signer": signer, "frostd": "/x", "frost_client": "/x",
            "members": [], "threshold": 2, "group": "g", "frostd_cert": "c", "frostd_key": "k",
            "server_url": "s", "work_dir": dir.join("work"),
        }))
        .unwrap();
        let plan = SpendPlan::Payment {
            to: "utest1x".into(),
            value_zat: 1000,
            memo: None,
        };
        let published = std::sync::Arc::new(std::sync::Mutex::new(Vec::new()));
        let relay = RelayClient::new(
            DevicesOnTheRelay {
                state: std::sync::Arc::new(crate::relay::RelayState::new()),
                published: published.clone(),
                extra,
            },
            "",
            "room",
            "helper",
        );

        // Mainnet has a row after NU6.3 (NU7), so the gate asks for the tip: well before the upgrade,
        // far from any hold.
        let no_tip = || -> Result<u64, ToolError> { Ok(3_500_000) };
        let result = net_prepare_send_with(
            &sc,
            &plan,
            &relay,
            &[],
            5,
            Duration::from_millis(1),
            &no_tip,
        );
        let seen = published.lock().unwrap().clone();
        std::fs::remove_dir_all(&dir).ok();
        (result, seen)
    }

    /// A relay nobody answers on: it takes the signing request and counts the polls it is asked, and it
    /// can fail the n-th one the way curl does when a call outlives its limit.
    struct SilentRelay {
        state: std::sync::Arc<crate::relay::RelayState>,
        gets: std::sync::Arc<std::sync::atomic::AtomicUsize>,
        /// The poll (1-based) that fails; 0 for none.
        fail_on: usize,
    }
    impl SilentRelay {
        fn call(&self, method: &str, url: &str, body: &[u8]) -> Result<Vec<u8>, String> {
            let raw = &url[url.find("/api/relay/").unwrap()..];
            let path = raw.split('?').next().unwrap();
            let r = self.state.handle(method, path, raw, body, 1000);
            (r.status == 200)
                .then_some(r.body)
                .ok_or(format!("relay {}", r.status))
        }
    }
    impl Transport for SilentRelay {
        fn post(&self, url: &str, body: &[u8]) -> Result<Vec<u8>, String> {
            self.call("POST", url, body)
        }
        fn get(&self, url: &str) -> Result<Vec<u8>, String> {
            let n = self.gets.fetch_add(1, std::sync::atomic::Ordering::SeqCst) + 1;
            if n == self.fail_on {
                return Err("curl GET failed: curl: (28) Operation timed out".into());
            }
            self.call("GET", url, &[])
        }
    }

    /// `net_prepare_send_with` against stand-in tools and a relay on which nobody answers, with
    /// `max_polls` polls of a millisecond. Returns what came out and how many polls were made.
    #[cfg(unix)]
    fn prepare_on_a_silent_relay(
        tag: &str,
        max_polls: u32,
        fail_on: usize,
    ) -> (Result<SignedSend, ToolError>, usize) {
        use std::os::unix::fs::PermissionsExt;
        let dir =
            std::env::temp_dir().join(format!("konclave-silent-{tag}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let vector = dir.join("signed.pczt");
        std::fs::write(&vector, VECTOR).unwrap();
        let script = |name: &str, body: String| {
            let path = dir.join(name);
            std::fs::write(&path, format!("#!/bin/sh\n{body}\n")).unwrap();
            let mut perm = std::fs::metadata(&path).unwrap().permissions();
            perm.set_mode(0o755);
            std::fs::set_permissions(&path, perm).unwrap();
            path
        };
        let proven = dir.join("proven.pczt");
        std::fs::write(&proven, PROVEN).unwrap();
        let devtool = script(
            "devtool",
            format!(
                "case \"$4\" in create) printf unproven;; prove) cat >/dev/null; cat {};; esac",
                proven.display()
            ),
        );
        let signer = script(
            "signer",
            format!(
                "case \"$1\" in extract) echo 'SIGHASH {}'; echo 'RANDOMIZER 0 {}';; inject) cp {} \"$3\";; esac",
                "332de126200c22131337474ae50367218ec87815c23d297dcdc8278ecb8903b0",
                "11".repeat(32),
                vector.display()
            ),
        );
        let sc: SendConfig = serde_json::from_value(serde_json::json!({
            "devtool": devtool, "wallet_dir": "/w", "lightwalletd": "zec.rocks:443",
            "account": "acc", "konclave_signer": signer, "frostd": "/x", "frost_client": "/x",
            "members": [], "threshold": 2, "group": "g", "frostd_cert": "c", "frostd_key": "k",
            "server_url": "s", "work_dir": dir.join("work"),
        }))
        .unwrap();
        let plan = SpendPlan::Payment {
            to: "utest1x".into(),
            value_zat: 1000,
            memo: None,
        };
        let gets = std::sync::Arc::new(std::sync::atomic::AtomicUsize::new(0));
        let relay = RelayClient::new(
            SilentRelay {
                state: std::sync::Arc::new(crate::relay::RelayState::new()),
                gets: gets.clone(),
                fail_on,
            },
            "",
            "room",
            "helper",
        );
        // Mainnet has a row after NU6.3 (NU7), so the gate asks for the tip: well before the upgrade,
        // far from any hold.
        let no_tip = || -> Result<u64, ToolError> { Ok(3_500_000) };
        let result = net_prepare_send_with(
            &sc,
            &plan,
            &relay,
            &[],
            max_polls,
            Duration::from_millis(1),
            &no_tip,
        );
        std::fs::remove_dir_all(&dir).ok();
        (result, gets.load(std::sync::atomic::Ordering::SeqCst))
    }

    /// The wait is as many polls as it was given, no more and no fewer: nothing answers, and the
    /// relay is asked exactly `max_polls` times before the send gives up.
    #[cfg(unix)]
    #[test]
    fn the_wait_ends_after_exactly_max_polls_polls() {
        for polls in [1u32, 3, 7] {
            let (r, gets) = prepare_on_a_silent_relay(&format!("exact{polls}"), polls, 0);
            let Err(why) = r else {
                panic!("nobody answered, so the send must have given up");
            };
            let why = why.to_string();
            assert!(why.contains("timed out"), "{why}");
            assert_eq!(gets, polls as usize, "polls made for max_polls={polls}");
        }
    }

    /// A poll that fails ends the wait at once, whatever is left of it: what the call limits of the
    /// relay client turn a stuck call into, and the reason the limits are not set tighter.
    #[cfg(unix)]
    #[test]
    fn a_poll_that_fails_ends_the_wait_at_once() {
        let (r, gets) = prepare_on_a_silent_relay("failed", 50, 2);
        let Err(why) = r else {
            panic!("the second poll failed, so the send must have stopped");
        };
        let why = why.to_string();
        assert!(why.contains("(28)"), "{why}");
        assert_eq!(gets, 2, "no poll after the failed one");
    }

    /// `net_prepare_send_gated` against the same stand-ins, with a table that has a later upgrade and
    /// a tip, for either kind of plan. Returns what came out, the `pczt_hex` of every signing request
    /// the room was shown, and which of the engine's steps ran.
    #[cfg(unix)]
    fn prepare_gated(
        tag: &str,
        proven_bytes: &[u8],
        plan: SpendPlan,
        tip: u64,
    ) -> (Result<SignedSend, ToolError>, Vec<String>, String) {
        use std::os::unix::fs::PermissionsExt;
        let dir = std::env::temp_dir().join(format!("konclave-gated-{tag}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let vector = dir.join("signed.pczt");
        std::fs::write(&vector, VECTOR).unwrap();
        let proven = dir.join("proven.pczt");
        std::fs::write(&proven, proven_bytes).unwrap();
        let ran = dir.join("ran.log");
        let script = |name: &str, body: String| {
            let path = dir.join(name);
            std::fs::write(&path, format!("#!/bin/sh\n{body}\n")).unwrap();
            let mut perm = std::fs::metadata(&path).unwrap().permissions();
            perm.set_mode(0o755);
            std::fs::set_permissions(&path, perm).unwrap();
            path
        };
        // `create` (a single payment) and `prove` are the devtool's; `build-payroll` (a payroll) is the
        // signer's. Every one of them leaves a line in the log, so a refusal can be shown to have run
        // none of the ones that matter.
        let devtool = script(
            "devtool",
            format!(
                "echo \"devtool $4\" >> {}\ncase \"$4\" in create) printf unproven;; prove) cat >/dev/null; cat {};; esac",
                ran.display(),
                proven.display()
            ),
        );
        let signer = script(
            "signer",
            format!(
                "echo \"signer $1\" >> {}\ncase \"$1\" in build-payroll) printf unproven > \"$9\";; extract) echo 'SIGHASH {}'; echo 'RANDOMIZER 0 {}';; inject) cp {} \"$3\";; esac",
                ran.display(),
                "332de126200c22131337474ae50367218ec87815c23d297dcdc8278ecb8903b0",
                "11".repeat(32),
                vector.display()
            ),
        );
        let sc: SendConfig = serde_json::from_value(serde_json::json!({
            "devtool": devtool, "wallet_dir": "/w", "lightwalletd": "zec.rocks:443",
            "account": "acc", "konclave_signer": signer, "frostd": "/x", "frost_client": "/x",
            "members": [], "threshold": 2, "group": "g", "frostd_cert": "c", "frostd_key": "k",
            "server_url": "s", "work_dir": dir.join("work"),
        }))
        .unwrap();
        let published = std::sync::Arc::new(std::sync::Mutex::new(Vec::new()));
        let relay = RelayClient::new(
            DevicesOnTheRelay {
                state: std::sync::Arc::new(crate::relay::RelayState::new()),
                published: published.clone(),
                extra: 0,
            },
            "",
            "room",
            "helper",
        );
        let read_tip = move || -> Result<u64, ToolError> { Ok(tip) };
        let gate = EpochGate {
            table: &crate::epoch::test_table::WITH_NEXT,
            tip: &read_tip,
        };
        let result =
            net_prepare_send_gated(&sc, &plan, &relay, &[], 5, Duration::from_millis(1), &gate);
        let seen = published.lock().unwrap().clone();
        let log = std::fs::read_to_string(&ran).unwrap_or_default();
        std::fs::remove_dir_all(&dir).ok();
        (result, seen, log)
    }

    fn a_payment() -> SpendPlan {
        SpendPlan::Payment {
            to: "utest1x".into(),
            value_zat: 1000,
            memo: None,
        }
    }

    fn a_payroll() -> SpendPlan {
        SpendPlan::Payroll {
            lines: vec![PayrollDest {
                address: "utest1x".into(),
                value_zat: 1000,
                memo: None,
            }],
        }
    }

    /// The build hold, on both paths: inside `A - delta - K` no new transaction is built at all, so
    /// neither the engine's build step nor the room is reached; one block before it, the build runs.
    #[cfg(unix)]
    #[test]
    fn the_build_hold_covers_a_single_payment_and_a_payroll() {
        use crate::epoch::test_table::A;
        use crate::epoch::{k_blocks, Refusal};
        let edge = u64::from(A - 40 - k_blocks(75));
        for (name, plan) in [
            ("payment", a_payment as fn() -> SpendPlan),
            ("payroll", a_payroll),
        ] {
            let (held, seen, log) = prepare_gated(&format!("hold-{name}"), PROVEN, plan(), edge);
            let e = held.expect_err(name);
            assert_eq!(crate::epoch::refusal_of(&e), Some(Refusal::Hold), "{name}");
            assert!(seen.is_empty(), "{name}: nothing reached the room");
            assert!(log.is_empty(), "{name}: the engine built nothing: {log}");
            // One block earlier it is built, proven and signed as ever. (The vector's expiry is far
            // beyond an ordinary one, so the tip is also far from the crossing hold.)
            let (open, _, log) =
                prepare_gated(&format!("open-{name}"), PROVEN, plan(), edge - 1_000);
            open.unwrap_or_else(|e| panic!("{name}: {e}"));
            assert!(log.contains("prove"), "{name}: built and proven: {log}");
        }
    }

    /// The post-build check, on both paths: an engine that is not on the new line builds the old
    /// branch after the upgrade; the PCZT's own branch is read and the send is refused before the room.
    #[cfg(unix)]
    #[test]
    fn a_transaction_built_on_the_wrong_branch_is_refused_before_the_room() {
        use crate::epoch::test_table::A;
        use crate::epoch::Refusal;
        for (name, plan) in [
            ("payment", a_payment as fn() -> SpendPlan),
            ("payroll", a_payroll),
        ] {
            // The stand-in engine always builds the vector's branch, NU6.3: at a tip where the next
            // block is under the later upgrade, that is the engine not having been updated.
            let (r, seen, log) =
                prepare_gated(&format!("branch-{name}"), PROVEN, plan(), u64::from(A));
            let e = r.expect_err(name);
            assert_eq!(
                crate::epoch::refusal_of(&e),
                Some(Refusal::NotUpdated),
                "{name}"
            );
            assert!(seen.is_empty(), "{name}: nothing reached the room");
            assert!(
                !log.contains("extract"),
                "{name}: nobody was asked to sign: {log}"
            );
        }
    }

    /// A crossing (a long expiry) is held further out than an ordinary payment.
    #[cfg(unix)]
    #[test]
    fn a_crossing_is_not_built_close_to_the_upgrade() {
        use crate::epoch::test_table::A;
        use crate::epoch::Refusal;
        // 100 blocks before A: past the ordinary hold's edge? no (edge is A - 64), inside K_c (288).
        let (r, seen, _) = prepare_gated("crossing", PROVEN, a_payment(), u64::from(A) - 100);
        let e = r.expect_err("a crossing this close to the upgrade");
        assert_eq!(crate::epoch::refusal_of(&e), Some(Refusal::CrossingHold));
        assert!(seen.is_empty());
    }

    /// The send loop reads on from where the previous poll stopped, so the answer is reached within
    /// the polls given even when it is not in the first poll's reading. `collect_response`'s own tests
    /// run a copy of the loop; this one runs the real consumer.
    #[cfg(unix)]
    #[test]
    fn the_send_loop_keeps_reading_past_one_poll() {
        let extra = net_send::MAX_CANDIDATES_PER_POLL + 4;
        let (result, _) = prepare_against_stand_ins_with_extra("behind", PROVEN, extra);
        let signed = result.expect("the devices' answer was reached");
        assert_eq!(
            signed.signatures(),
            ["ab".repeat(64)],
            "the signature that was taken is the devices', not a junk one"
        );
    }

    /// The whole of `net_prepare_send_with`, against stand-ins for the engine's tools and a relay
    /// that answers like the devices: what comes out is described from THE SIGHASH THE SIGNER
    /// PRINTED and THE PCZT THAT WAS INJECTED (not the proven one), carries the devices' signatures,
    /// and holds the injected bytes for the broadcast. The tests of `describe` alone cannot see a
    /// call that passes it the wrong arguments.
    #[cfg(unix)]
    #[test]
    fn preparing_a_send_ties_the_record_to_what_the_devices_signed() {
        let (result, seen) = prepare_against_stand_ins("ties", PROVEN);
        let signed = result.expect("prepares");
        // The room saw the published copy, not the PCZT the signatures are applied to and not the
        // one the engine proved.
        assert_eq!(seen.len(), 1, "one signing request was published");
        let in_the_room: Vec<u8> = konclave_seal::hex::decode(&seen[0]).unwrap();
        assert!(
            in_the_room.len() < PROVEN.len(),
            "the room saw the full PCZT"
        );
        assert_eq!((PROVEN.len() - in_the_room.len()) % 96, 0);
        assert_eq!(in_the_room, pczt::published_copy(PROVEN).unwrap());
        assert_eq!(
            signed.txid(),
            "b00389cb8e27c8cd7d293dc21578c88e216703e54a47371313220c2026e12d33",
            "the id comes from the sighash the signer printed"
        );
        assert_eq!(
            signed.sighash(),
            "332de126200c22131337474ae50367218ec87815c23d297dcdc8278ecb8903b0"
        );
        assert_eq!(
            signed.expiry_height(),
            4_203_034,
            "the expiry comes from the injected PCZT"
        );
        assert_eq!(
            signed.signatures(),
            ["ab".repeat(64)],
            "the devices' signatures are carried"
        );
        assert_eq!(
            signed.tx3, VECTOR,
            "what will be broadcast is what was injected"
        );
    }

    /// Fail closed: when the PCZT the engine proved cannot be read, nothing is published and the
    /// send fails. Publishing "what we could not check" is the fail-open this refuses.
    #[cfg(unix)]
    #[test]
    fn a_proven_pczt_that_cannot_be_redacted_is_not_published() {
        let (result, seen) = prepare_against_stand_ins("junk", b"proven-not-a-pczt");
        assert!(result.is_err(), "the send must fail");
        assert!(seen.is_empty(), "nothing reached the room: {seen:?}");
    }

    /// What reaches the broadcast tool is the signed PCZT the record was made from, byte for byte, on
    /// its standard input, and what comes back is the id the tool printed.
    #[cfg(unix)]
    #[test]
    fn the_broadcast_hands_the_tool_the_signed_bytes_and_returns_its_txid() {
        use std::os::unix::fs::PermissionsExt;
        let dir = std::env::temp_dir().join(format!("konclave-broadcast-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let captured = dir.join("stdin.bin");
        let devtool = dir.join("devtool");
        std::fs::write(
            &devtool,
            format!(
                "#!/bin/sh\ncat > {}\necho 'Sending transaction...'\necho {}\n",
                captured.display(),
                "cd".repeat(32)
            ),
        )
        .unwrap();
        let mut perm = std::fs::metadata(&devtool).unwrap().permissions();
        perm.set_mode(0o755);
        std::fs::set_permissions(&devtool, perm).unwrap();
        let sc: SendConfig = serde_json::from_value(serde_json::json!({
            "devtool": devtool, "wallet_dir": "/w", "lightwalletd": "zec.rocks:443",
            "account": "acc", "konclave_signer": "/x", "frostd": "/x", "frost_client": "/x",
            "members": [], "threshold": 2, "group": "g", "frostd_cert": "c", "frostd_key": "k",
            "server_url": "s", "work_dir": dir.join("work"),
        }))
        .unwrap();
        let signed =
            SignedSend::from_bytes(VECTOR.to_vec(), "x", &vector_sighash(), vec![]).unwrap();

        let txid = broadcast_signed(&sc, &signed).expect("broadcasts");
        assert_eq!(txid, "cd".repeat(32));
        assert_eq!(std::fs::read(&captured).unwrap(), VECTOR);
        std::fs::remove_dir_all(&dir).ok();
    }

    /// The signed PCZT names recipients, amounts and memos and must never be logged (#297): a derived
    /// `Debug` would print every byte of it.
    #[test]
    fn debug_printing_a_signed_send_never_shows_the_pczt() {
        let signed =
            SignedSend::from_bytes(VECTOR.to_vec(), "x", &vector_sighash(), vec![]).unwrap();
        let shown = format!("{signed:?}");
        assert!(shown.contains(signed.txid()), "{shown}");
        // The PCZT's first bytes are "PCZT" = 80, 67, 90, 84.
        assert!(!shown.contains("80, 67, 90, 84"), "{shown}");
        assert!(shown.len() < 400, "{} bytes of debug output", shown.len());
    }

    #[test]
    fn a_transaction_that_cannot_be_described_cannot_be_sent() {
        // No PCZT, no expiry, no record, no broadcast: never a silent zero.
        let r = SignedSend::from_bytes(b"not a pczt".to_vec(), "x", &[0u8; 32], vec![]);
        assert!(r.is_err());
        let missing = SignedSend::describe("/nonexistent/net-tx3-signed.pczt", &[0u8; 32], vec![]);
        assert!(missing.is_err());
    }

    #[test]
    fn config_parses_from_json() {
        let json = r#"{
            "devtool":"/bin/devtool","wallet_dir":"/w","lightwalletd":"zec.rocks:443",
            "account":"acc-1","konclave_signer":"/bin/ks","frostd":"/bin/frostd",
            "frost_client":"/bin/fc",
            "members":[
              {"name":"Alice","pubkey":"aa","config":"alice.toml"},
              {"name":"Bob","pubkey":"bb","config":"bob.toml"},
              {"name":"Carol","pubkey":"cc","config":"carol.toml"}
            ],
            "threshold":2,
            "group":"deadbeef",
            "frostd_cert":"c.pem","frostd_key":"k.pem","server_url":"127.0.0.1:2744",
            "work_dir":"/tmp/x"
        }"#;
        let sc: SendConfig = serde_json::from_str(json).unwrap();
        assert_eq!(sc.frostd_port, 2744); // default
        assert_eq!(sc.frostd_ip, "127.0.0.1"); // default
        assert_eq!(sc.threshold, 2);
        assert_eq!(sc.members.len(), 3);
        assert_eq!(sc.members[1].name, "Bob");
    }

    #[test]
    fn hex_encode_is_lowercase_padded() {
        assert_eq!(hex_encode(&[0x00, 0x0f, 0xff]), "000fff");
    }
}

#[cfg(test)]
mod funding_tests {
    use super::*;

    // The exact string a real refusal produced on mainnet, wrapped the way the tool reports it.
    const REAL: &str = "/usr/local/bin/konclave-signer exited with 1: Error: propose_transfer: \
                        InsufficientFunds { available: Zatoshis(20000), required: Zatoshis(24000) }";

    /// The OTHER shape, and the one that got through: `zcash-devtool` renders the wallet error via
    /// Display, and the backend's Display for this case is
    /// "Insufficient balance (have {}, need {} including fee)".
    const REAL_DISPLAY: &str =
        "Error: Insufficient balance (have 501000, need 900010000 including fee)";

    #[test]
    fn reads_both_figures_from_a_real_refusal() {
        assert_eq!(parse_insufficient_funds(REAL), Some((20_000, 24_000)));
    }

    #[test]
    fn reads_the_display_shape_too() {
        // A parser that knew only the Debug shape let an unfundable payment through in production
        // while refusing the equivalent payroll. Same question, two binaries, two wordings.
        assert_eq!(
            parse_insufficient_funds(REAL_DISPLAY),
            Some((501_000, 900_010_000))
        );
    }

    #[test]
    fn the_two_shapes_answer_the_same_question() {
        let (a1, r1) = parse_insufficient_funds(REAL).expect("debug shape");
        let (a2, r2) = parse_insufficient_funds(REAL_DISPLAY).expect("display shape");
        assert!(
            r1 > a1 && r2 > a2,
            "a refusal always needs more than it has"
        );
    }

    #[test]
    fn the_gap_is_the_fee_plus_what_is_missing() {
        let (available, required) = parse_insufficient_funds(REAL).expect("parsed");
        assert!(
            required > available,
            "a refusal always needs more than it has"
        );
        assert_eq!(required - available, 4_000);
    }

    #[test]
    fn ignores_an_error_that_is_not_about_funds() {
        assert_eq!(parse_insufficient_funds("Error: no such wallet"), None);
        assert_eq!(parse_insufficient_funds(""), None);
    }

    #[test]
    fn survives_a_truncated_or_reordered_report() {
        // Half a message must not yield half an answer.
        assert_eq!(
            parse_insufficient_funds("InsufficientFunds { available: Zatoshis(1) }"),
            None
        );
        assert_eq!(
            parse_insufficient_funds(
                "InsufficientFunds { available: Zatoshis(7), required: Zatoshis(9) } trailing"
            ),
            Some((7, 9))
        );
    }

    #[test]
    fn a_zero_balance_is_a_number_like_any_other() {
        assert_eq!(
            parse_insufficient_funds(
                "InsufficientFunds { available: Zatoshis(0), required: Zatoshis(10000) }"
            ),
            Some((0, 10_000))
        );
    }

    // #427. The refusal that used to arrive AFTER the quorum approved.
    //
    // `funding_check` needs the real binaries, so what is pinned here is the decision it rests on:
    // recognising the bridge's refusal in the text that crosses the process boundary. Getting this
    // wrong in the FALSE direction is silent - the check simply goes back to the old behaviour and
    // the payment dies at signing again - which is why the match is on the two pool names rather
    // than on the exact sentence.
    #[test]
    fn the_bridges_mixed_pool_refusal_is_recognised() {
        assert!(is_mixed_pool(
            "mixed Orchard+Ironwood spends are not supported by this bridge"
        ));
        // As it arrives through ToolError, wrapped in the runner's own formatting.
        assert!(is_mixed_pool(
            "/usr/local/bin/konclave-signer exited with 1: Error: mixed Orchard+Ironwood spends are not supported by this bridge"
        ));
        // Reworded upstream, same cause. An exact match would fail open here.
        assert!(is_mixed_pool(
            "refusing a mixed transaction: it spends Orchard and Ironwood notes together"
        ));
    }

    #[test]
    fn and_other_engine_failures_are_not_mistaken_for_it() {
        // These must reach the caller as themselves. Reporting a pool problem for any of them would
        // tell a member to split a payment that has a different thing wrong with it.
        assert!(!is_mixed_pool(
            "no real shielded spends to sign in this PCZT"
        ));
        assert!(!is_mixed_pool(
            "Insufficient balance (have 501000, need 900010000 including fee)"
        ));
        assert!(!is_mixed_pool("failed to parse PCZT: Io(Custom)"));
        // Names one pool only: an Orchard-only or Ironwood-only failure is not a crossing.
        assert!(!is_mixed_pool("orchard parse: MissingSpendAuthSig"));
        assert!(!is_mixed_pool(""));
    }
}
