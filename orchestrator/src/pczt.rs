//! PCZT orchestration: drives `zcash-devtool pczt` (create → prove → send). PCZT
//! bytes are piped between steps; the final `send` returns the broadcast txid.
//!
//! `parse_txid` validates the tool's output rather than trusting the exit code — a
//! rejected broadcast (e.g. an expired tx) is turned into an explicit error even if
//! the process exits zero.

use std::path::Path;

use crate::tools::{run, run_text, ToolError};

/// `zcash-devtool pczt -w <dir> create --address <a> --value <zat> [--memo <m>] <account>`
/// Returns the (unproven) PCZT bytes.
pub fn create(
    devtool: &Path,
    wallet_dir: &str,
    address: &str,
    value_zat: u64,
    account: &str,
    memo: Option<&str>,
) -> Result<Vec<u8>, ToolError> {
    let value_s = value_zat.to_string();
    let mut args: Vec<&str> = vec![
        "pczt",
        "-w",
        wallet_dir,
        "create",
        "--address",
        address,
        "--value",
        value_s.as_str(),
    ];
    if let Some(m) = memo {
        args.push("--memo");
        args.push(m);
    }
    args.push(account);
    run(devtool, &args, None)
}

/// `zcash-devtool pczt -w <dir> create-max --address <addr> <account>` — build a PCZT that spends
/// EVERY note in the account to `address`, with NO change and NO wallet-controlled dummy spend.
///
/// This is the Orchard→Ironwood migration path (#86): the pinned engine (`42ffd0d`) leaves the
/// zero-value migration dummy of a normal `create` unsigned → `MissingSpendAuthSig` at extract.
/// `create-max` has no dummy, so a one-time self-send migrates the vault's Orchard funds into the
/// Ironwood pool; afterwards normal `create` payments work (the Ironwood pool signs its own dummy).
/// INTERIM — remove once the engine bumps to librustzcash ≥ `51385a15` (the proper fix, see #86).
#[allow(dead_code)] // the migration wiring in send.rs is the remaining step (#86); primitive ready
pub fn create_max(
    devtool: &Path,
    wallet_dir: &str,
    address: &str,
    account: &str,
) -> Result<Vec<u8>, ToolError> {
    let args: Vec<&str> = vec![
        "pczt",
        "-w",
        wallet_dir,
        "create-max",
        "--address",
        address,
        account,
    ];
    run(devtool, &args, None)
}

/// `zcash-devtool pczt -w <dir> prove` — reads a PCZT on stdin, returns the proven PCZT.
pub fn prove(devtool: &Path, wallet_dir: &str, pczt: &[u8]) -> Result<Vec<u8>, ToolError> {
    run(devtool, &["pczt", "-w", wallet_dir, "prove"], Some(pczt))
}

/// `zcash-devtool pczt -w <dir> send -s <server> --connection direct` — broadcasts and
/// returns the txid.
pub fn send(
    devtool: &Path,
    wallet_dir: &str,
    server: &str,
    signed_pczt: &[u8],
) -> Result<String, ToolError> {
    let out = run_text(
        devtool,
        &[
            "pczt",
            "-w",
            wallet_dir,
            "send",
            "-s",
            server,
            "--connection",
            "direct",
        ],
        Some(signed_pczt),
    )?;
    parse_txid(&out)
}

/// Extract the broadcast txid from `pczt send` output. A line containing `Error`/
/// `failed` is a broadcast failure (surfaced with the tool's message); otherwise the
/// last bare 64-hex line is the txid.
pub fn parse_txid(output: &str) -> Result<String, ToolError> {
    for line in output.lines().rev() {
        let l = line.trim();
        if l.is_empty() {
            continue;
        }
        if l.contains("Error") || l.contains("failed") {
            return Err(ToolError::parse("broadcast", l.to_string()));
        }
        if is_txid(l) {
            return Ok(l.to_string());
        }
    }
    Err(ToolError::parse("broadcast", "no txid in output"))
}

fn is_txid(s: &str) -> bool {
    s.len() == 64 && s.bytes().all(|b| b.is_ascii_hexdigit())
}

#[cfg(test)]
mod tests {
    use super::*;

    // Real successful broadcast output from the vertical slice (Gate 1).
    const SEND_OK: &str = r#"2026-07-01T02:23:00Z  INFO zcash_devtool::remote: Connecting to zec.rocks:443
Sending transaction...
f63ee64d7bc086a8286631d03936ec2ca2ca57f4e4c63712fc95c1f02c522360"#;

    // Real failed broadcast (the first, expired attempt).
    const SEND_EXPIRED: &str = r#"Sending transaction...
Error: Send failed: (-25) failed to validate tx: transaction did not pass consensus validation: transaction must not be mined at a block Height(3396614) greater than its expiry Height(3396401), failing transaction transaction::Hash("4998b101b0a2abcfc2775c6f1c17a7d828521a3823680077e7231b4c4baa659d")"#;

    #[test]
    fn parses_txid_on_success() {
        assert_eq!(
            parse_txid(SEND_OK).unwrap(),
            "f63ee64d7bc086a8286631d03936ec2ca2ca57f4e4c63712fc95c1f02c522360"
        );
    }

    #[test]
    fn broadcast_failure_is_error_not_a_txid() {
        // Even though the error text embeds a hash, we must NOT read it as a txid.
        let err = parse_txid(SEND_EXPIRED).unwrap_err();
        assert!(matches!(err, ToolError::Parse { .. }));
        assert!(err.to_string().contains("expiry"));
    }

    #[test]
    fn no_txid_is_error() {
        assert!(matches!(
            parse_txid("Sending transaction...\n"),
            Err(ToolError::Parse { .. })
        ));
    }
}
