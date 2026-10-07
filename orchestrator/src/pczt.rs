//! PCZT orchestration: drives `zcash-devtool pczt` (create → prove → send). PCZT
//! bytes are piped between steps; the final `send` returns the broadcast txid.
//!
//! `parse_txid` validates the tool's output rather than trusting the exit code - a
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

/// `zcash-devtool pczt -w <dir> prove` - reads a PCZT on stdin, returns the proven PCZT.
pub fn prove(devtool: &Path, wallet_dir: &str, pczt: &[u8]) -> Result<Vec<u8>, ToolError> {
    run(devtool, &["pczt", "-w", wallet_dir, "prove"], Some(pczt))
}

/// `zcash-devtool pczt -w <dir> send -s <server> --connection direct` - broadcasts and
/// returns the txid.
///
/// `pub(crate)` on purpose: nothing outside this crate can broadcast except through
/// [`crate::send_record::send_proposal`] (which records the attempt first) or the operator's command
/// line wrapper in [`crate::send`].
pub(crate) fn send(
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

/// The expiry height the signed PCZT itself carries (`0` = none). Read from the transaction, never
/// assumed: a canonical single payment is built with an expiry measured in tens of thousands of
/// blocks, an ordinary one 40 blocks past its target height, and which one this is is only in the PCZT.
pub fn expiry_height_of(pczt_bytes: &[u8]) -> Result<u32, ToolError> {
    let pczt = ::pczt::Pczt::parse(pczt_bytes)
        .map_err(|e| ToolError::parse("pczt", format!("cannot read the signed PCZT: {e:?}")))?;
    Ok(*pczt.global().expiry_height())
}

/// The transaction id as the wallet and explorers print it, from the 32-byte shielded sighash the
/// quorum signed. For a transaction with no transparent input (every vault transaction) ZIP 244's
/// signature digest is the txid digest, and the id is that digest's bytes in reverse order. Known
/// before the broadcast, which is the point.
pub fn txid_from_sighash(sighash: &[u8; 32]) -> String {
    let mut s = String::with_capacity(64);
    for b in sighash.iter().rev() {
        s.push_str(&format!("{b:02x}"));
    }
    s
}

fn is_txid(s: &str) -> bool {
    s.len() == 64 && s.bytes().all(|b| b.is_ascii_hexdigit())
}

#[cfg(test)]
mod tests {
    use super::*;

    // The repo's Ironwood vector. Its expected values do NOT come from the functions under test:
    // the sighash is `konclave-signer extract`'s, the txid is `zcash-devtool pczt inspect`'s (another
    // implementation), the expiry was decoded by hand from the PCZT's postcard header.
    const VECTOR: &[u8] =
        include_bytes!("../../konclave-signer/tests/vectors/ironwood_single_spend.proven.pczt");
    const VECTOR_SIGHASH: &str = "332de126200c22131337474ae50367218ec87815c23d297dcdc8278ecb8903b0";
    const VECTOR_TXID: &str = "b00389cb8e27c8cd7d293dc21578c88e216703e54a47371313220c2026e12d33";

    #[test]
    fn the_txid_is_the_sighash_reversed_as_the_devtool_prints_it() {
        let mut sighash = [0u8; 32];
        for (i, b) in sighash.iter_mut().enumerate() {
            *b = u8::from_str_radix(&VECTOR_SIGHASH[2 * i..2 * i + 2], 16).unwrap();
        }
        assert_eq!(txid_from_sighash(&sighash), VECTOR_TXID);
    }

    #[test]
    fn the_expiry_is_read_from_the_pczt_itself() {
        assert_eq!(expiry_height_of(VECTOR).unwrap(), 4_203_034);
    }

    #[test]
    fn a_pczt_that_cannot_be_read_yields_no_expiry_rather_than_zero() {
        // Zero means "never expires". A parse failure must never be read as that.
        assert!(expiry_height_of(b"not a pczt").is_err());
        assert!(expiry_height_of(&[]).is_err());
    }

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
