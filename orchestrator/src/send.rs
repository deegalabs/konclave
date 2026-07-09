//! End-to-end spend orchestration (step 2c): chain the tested wrappers into a single
//! Ready→Sent flow — build the PCZT, prove it, extract the FROST message, run the
//! ceremony, inject the signature, and (optionally) broadcast.
//!
//! This is where "an error costs real funds" (CLAUDE.md §4), so it follows the proven
//! slice recipe exactly (docs/VERTICAL_SLICE.md) and supports a **dry-run** that stops
//! right before broadcast — everything up to a fully-signed PCZT, no funds moved.
//!
//! `frostd` is started fresh per call and killed on drop, so no ceremony leaks a server
//! or a stale session.

use std::path::PathBuf;
use std::thread;
use std::time::Duration;

use serde::Deserialize;
use zeroize::Zeroizing;

use crate::ceremony::{run_coordinator, run_participant, Frostd};
use crate::tools::ToolError;
use crate::{pczt, signer};

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
/// public material — never a key share.
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
    /// The vault's members — the ceremony picks the signing set from **who approved**
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
    /// `.sealed` are unsealed to ephemeral 0600 files just for the ceremony — the share
    /// never sits in cleartext on disk. (Key custody is a 0600 file here; the product
    /// uses the OS keychain.)
    #[serde(default)]
    pub sealing_key_file: Option<String>,
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
    /// The broadcast txid — `None` on a dry-run (signed but not sent).
    pub txid: Option<String>,
    /// Path to the fully-signed PCZT.
    pub signed_pczt: String,
    /// The shielded sighash the ceremony signed (hex) — useful for the receipt.
    pub sighash: String,
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
/// which links `zcash_client_backend` — the engine the CLI lacks).
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
            let spec = serde_json::to_string(lines)
                .map_err(|e| ToolError::parse("payroll spec", e.to_string()))?;
            let spec_path = format!("{}/payroll-spec.json", sc.work_dir);
            std::fs::write(&spec_path, spec).map_err(ToolError::Io)?;
            let out_path = format!("{}/payroll.pczt", sc.work_dir);
            crate::tools::run(
                &sc.konclave_signer,
                &[
                    "build-payroll",
                    "--wallet",
                    &sc.wallet_dir,
                    "--account",
                    &sc.account,
                    "--spec",
                    &spec_path,
                    "--out",
                    &out_path,
                ],
                None,
            )?;
            std::fs::read(&out_path).map_err(ToolError::Io)
        }
    }
}

/// Run the full spend. On `dry_run` it stops after producing a signed PCZT (no broadcast,
/// no funds moved) — the way to validate the ceremony works today without spending.
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
    // their configs — the ceremony signs with exactly those members' shares, not a fixed set.
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
    // deleted) — the share is never in cleartext on disk.
    let key: Option<Zeroizing<[u8; 32]>> = match &sc.sealing_key_file {
        Some(f) => Some(read_key_file(f)?),
        None => None,
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

    // 7) broadcast — unless this is a dry-run.
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
