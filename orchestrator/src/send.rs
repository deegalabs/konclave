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
use crate::relay_client::{CurlTransport, RelayClient};
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
    let _ = std::fs::remove_dir_all(&probe_dir);
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

/// Architecture B - a real `/net` broadcast for a browser-DKG vault. Instead of running the
/// native FROST ceremony, the helper builds and proves the PCZT for the vault's own address,
/// publishes the signing request into a relay room, and waits for the browser devices to return
/// the aggregate FROST signature; then it injects and (unless `dry_run`) broadcasts. The devices'
/// shares never reach this process - it sees only public transaction data and the view-only
/// wallet, consistent with "internal transparency, external privacy".
///
/// This is live integration glue (real HTTP via `curl`, real binaries, real broadcast); it is not
/// exercised by CI, and is validated end to end on testnet. The pure protocol + handshake it
/// composes ARE unit-tested (see `net_send`, `relay_client`).
#[allow(clippy::too_many_arguments)]
pub fn net_orchestrate_send(
    sc: &SendConfig,
    plan: &SpendPlan,
    relay_base: &str,
    room: &str,
    // The vault's registered device comms pubkeys (#63): the request is SEALED to these, so the
    // relay carries only ciphertext. Empty = plaintext (compat until every device has registered).
    device_pubs: &[String],
    dry_run: bool,
    max_polls: u32,
    poll_delay: Duration,
) -> Result<SendOutcome, ToolError> {
    std::fs::create_dir_all(&sc.work_dir).map_err(ToolError::Io)?;

    // 1) build + prove the PCZT for the vault's own address.
    let tx1 = build_unproven(sc, plan)?;
    let tx2 = pczt::prove(&sc.devtool, &sc.wallet_dir, &tx1)?;
    let tx2_path = format!("{}/net-tx2-proven.pczt", sc.work_dir);
    std::fs::write(&tx2_path, &tx2).map_err(ToolError::Io)?;

    // 2) extract the sighash + per-spend randomizers the devices must sign.
    let input = signer::extract(&sc.konclave_signer, &tx2_path)?;
    if input.randomizers.is_empty() {
        return Err(ToolError::parse("net-send", "no real spends to sign"));
    }
    let sighash_hex = hex_encode(&input.sighash);

    // 3) publish the signing request into the vault's relay room.
    let client = RelayClient::new(
        CurlTransport,
        relay_base.trim_end_matches('/'),
        room,
        "helper",
    );
    let req = net_send::SignRequest::from_signing_input(&input, &tx2);
    let posted = net_send::publish_sealed_request(&client, &req, device_pubs)
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
        // -valid candidate; bounded by max_polls and the relay's rate limit. Authenticating room
        // writes, #63, would stop the injection at the source.)
        let verify = |sigs: &net_send::SpendSigs| {
            signer::inject(&sc.konclave_signer, &tx2_path, &tx3_path, sigs).is_ok()
        };
        let (found, next) = net_send::collect_response(&client, &req, since, verify)
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
        signatures: sigs.iter().map(|(_, s)| hex_encode(s)).collect(),
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
}
