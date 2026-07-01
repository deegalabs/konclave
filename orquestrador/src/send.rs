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

use crate::ceremony::{run_coordinator, run_participant, Frostd};
use crate::tools::ToolError;
use crate::{pczt, signer};

/// Everything the automated ceremony needs. Loaded from a JSON file (`--ceremony`) so
/// the paths, group, signers and certs live outside the binary. Contains only paths and
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
    /// The coordinator's frost-client config (holds only that role's material).
    pub coordinator_config: String,
    /// One config per participant that will sign (t of them).
    pub participant_configs: Vec<String>,
    /// Group public key (hex).
    pub group: String,
    /// The signer comm public keys (hex), t of them, passed to the coordinator.
    pub signers: Vec<String>,
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

/// Run the full spend. On `dry_run` it stops after producing a signed PCZT (no broadcast,
/// no funds moved) — the way to validate the ceremony works today without spending.
pub fn orchestrate_send(
    sc: &SendConfig,
    to: &str,
    value_zat: u64,
    memo: Option<&str>,
    dry_run: bool,
) -> Result<SendOutcome, ToolError> {
    std::fs::create_dir_all(&sc.work_dir).map_err(ToolError::Io)?;

    // 1) build the (unproven) PCZT from the vault wallet.
    let tx1 = pczt::create(&sc.devtool, &sc.wallet_dir, to, value_zat, &sc.account, memo)?;

    // 2) prove it (ZK proofs, local).
    let tx2 = pczt::prove(&sc.devtool, &sc.wallet_dir, &tx1)?;
    let tx2_path = format!("{}/tx2-proven.pczt", sc.work_dir);
    std::fs::write(&tx2_path, &tx2).map_err(ToolError::Io)?;

    // 3) extract the sighash + randomizers the FROST ceremony must sign.
    let input = signer::extract(&sc.konclave_signer, &tx2_path)?;
    if input.randomizers.len() != 1 {
        return Err(ToolError::parse(
            "ceremony",
            format!(
                "the automated ceremony currently supports a single real spend; this tx has {}",
                input.randomizers.len()
            ),
        ));
    }
    let action_index = input.randomizers[0].action_index;
    let sighash_hex = hex_encode(&input.sighash);
    let randomizer_hex = hex_encode(&input.randomizers[0].alpha);

    // 4) start frostd fresh (killed on drop → no stale session survives the call).
    let _frostd = Frostd::start(
        &sc.frostd,
        &sc.frostd_cert,
        &sc.frostd_key,
        &sc.frostd_ip,
        sc.frostd_port,
    )?;
    thread::sleep(Duration::from_millis(900));

    // 5) run the ceremony (coordinator + participants concurrently) → 64-byte signature.
    let sig_path = format!("{}/sig.raw", sc.work_dir);
    let signature = run_ceremony(sc, &sighash_hex, &randomizer_hex, &sig_path)?;

    // 6) inject the signature back into the PCZT (inject verifies it).
    let tx3_path = format!("{}/tx3-signed.pczt", sc.work_dir);
    signer::inject(
        &sc.konclave_signer,
        &tx2_path,
        &tx3_path,
        &[(action_index, signature)],
    )?;

    // 7) broadcast — unless this is a dry-run.
    let txid = if dry_run {
        None
    } else {
        let tx3 = std::fs::read(&tx3_path).map_err(ToolError::Io)?;
        Some(pczt::send(&sc.devtool, &sc.wallet_dir, &sc.lightwalletd, &tx3)?)
    };

    Ok(SendOutcome {
        txid,
        signed_pczt: tx3_path,
        sighash: sighash_hex,
    })
}

/// Coordinator + participants run concurrently (they block on each other via frostd), as
/// on separate devices in the product. Here they are threads on one box.
fn run_ceremony(
    sc: &SendConfig,
    sighash_hex: &str,
    randomizer_hex: &str,
    sig_path: &str,
) -> Result<[u8; 64], ToolError> {
    // Owned copies so each closure is 'static.
    let fc = sc.frost_client.clone();
    let coord_cfg = sc.coordinator_config.clone();
    let server_url = sc.server_url.clone();
    let group = sc.group.clone();
    let signers = sc.signers.clone();
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
    for cfg in &sc.participant_configs {
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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn config_parses_from_json() {
        let json = r#"{
            "devtool":"/bin/devtool","wallet_dir":"/w","lightwalletd":"zec.rocks:443",
            "account":"acc-1","konclave_signer":"/bin/ks","frostd":"/bin/frostd",
            "frost_client":"/bin/fc","coordinator_config":"alice.toml",
            "participant_configs":["alice.toml","bob.toml"],
            "group":"deadbeef","signers":["aa","bb"],
            "frostd_cert":"c.pem","frostd_key":"k.pem","server_url":"127.0.0.1:2744",
            "work_dir":"/tmp/x"
        }"#;
        let sc: SendConfig = serde_json::from_str(json).unwrap();
        assert_eq!(sc.frostd_port, 2744); // default
        assert_eq!(sc.frostd_ip, "127.0.0.1"); // default
        assert_eq!(sc.signers.len(), 2);
        assert_eq!(sc.participant_configs.len(), 2);
    }

    #[test]
    fn hex_encode_is_lowercase_padded() {
        assert_eq!(hex_encode(&[0x00, 0x0f, 0xff]), "000fff");
    }
}
