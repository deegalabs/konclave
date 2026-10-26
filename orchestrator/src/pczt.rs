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

/// The consensus branch id the PCZT itself names. Read from the transaction, never assumed: it is
/// what decides which upgrade the transaction is valid under (ZIP 244 binds it into the sighash).
pub fn consensus_branch_of(pczt_bytes: &[u8]) -> Result<u32, ToolError> {
    let pczt = ::pczt::Pczt::parse(pczt_bytes)
        .map_err(|e| ToolError::parse("pczt", format!("cannot read the PCZT: {e:?}")))?;
    Ok(*pczt.global().consensus_branch_id())
}

/// The copy of a proven PCZT that goes into the signing room: the same transaction without the
/// optional per-spend key field (96 bytes per spend, in both pools) that no device reads. The sighash,
/// the outputs and the payment a device shows are built from the effecting data and the output
/// fields. The coordinator keeps its own full copy to apply the signatures to; only what is
/// PUBLISHED passes through here.
///
/// Fails closed: a PCZT that cannot be read is not published as it is.
pub fn published_copy(pczt_bytes: &[u8]) -> Result<Vec<u8>, ToolError> {
    let pczt = ::pczt::Pczt::parse(pczt_bytes)
        .map_err(|e| ToolError::parse("pczt", format!("cannot read the proven PCZT: {e:?}")))?;
    ::pczt::roles::redactor::Redactor::new(pczt)
        .redact_orchard_with(|mut bundle| {
            bundle.redact_actions(|mut action| action.clear_spend_fvk())
        })
        .redact_ironwood_with(|mut bundle| {
            bundle.redact_actions(|mut action| action.clear_spend_fvk())
        })
        .finish()
        .serialize()
        .map_err(|e| ToolError::parse("pczt", format!("cannot write the redacted PCZT: {e:?}")))
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
        let sighash: [u8; 32] = konclave_seal::hex::decode_exact(VECTOR_SIGHASH).unwrap();
        assert_eq!(txid_from_sighash(&sighash), VECTOR_TXID);
    }

    // The same rule on a V5 Orchard transaction, the other version a vault spends from. Both values are
    // `zcash-devtool pczt inspect`'s own output on
    // `konclave-wasm/tests/vectors/orchard_mainnet_two_spend.proven.pczt` (read 2026-10-09), so they do
    // not come from the function under test.
    const ORCHARD_SIGHASH: &str =
        "619ffa04d162b182f274c26d7402014065da13c8a0b62927028a23ddbb598e7f";
    const ORCHARD_TXID: &str = "7f8e59bbdd238a022729b6a0c813da65400102746dc274f282b162d104fa9f61";

    #[test]
    fn the_txid_is_the_sighash_reversed_on_a_v5_orchard_transaction_too() {
        let sighash: [u8; 32] = konclave_seal::hex::decode_exact(ORCHARD_SIGHASH).unwrap();
        assert_eq!(txid_from_sighash(&sighash), ORCHARD_TXID);
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

    // The published copy: the proven PCZT without each spend's optional 96-byte key field, which the
    // devices never read (the sighash, the outputs and the payment they show come from the effecting
    // data and the output fields).
    const ORCHARD_TWO_SPEND: &[u8] =
        include_bytes!("../../konclave-wasm/tests/vectors/orchard_mainnet_two_spend.proven.pczt");

    /// How many key fields `out` lacks compared with `original`, checking that THAT is the only
    /// difference. On the wire the field is `Option<[u8; 96]>`: a `01` tag and the 96 bytes, or a
    /// lone `00`. So `out` must equal `original` with each `01 <96 bytes>` replaced by `00`, and
    /// nothing else. Walks both, so the check does not use the redaction it is checking.
    fn keys_removed(original: &[u8], out: &[u8]) -> usize {
        let (mut i, mut j, mut removed) = (0, 0, 0);
        while i < original.len() && j < out.len() {
            if original[i] == out[j] {
                i += 1;
                j += 1;
            } else {
                assert!(
                    original[i] == 1 && out[j] == 0 && i + 97 <= original.len(),
                    "a difference that is not a removed key, at byte {i}"
                );
                i += 97;
                j += 1;
                removed += 1;
            }
        }
        assert_eq!(
            (i, j),
            (original.len(), out.len()),
            "lengths do not line up"
        );
        removed
    }

    #[test]
    fn the_published_copy_drops_the_key_field_in_either_pool() {
        // The number of spends each vector carries a key for: 4 in the Ironwood vector (a 4-spend
        // `create-max`), 2 in the Orchard one.
        for (name, vector, keys) in [("ironwood", VECTOR, 4), ("orchard", ORCHARD_TWO_SPEND, 2)] {
            let out = published_copy(vector).unwrap();
            assert_eq!(keys_removed(vector, &out), keys, "{name}");
            assert_eq!(vector.len() - out.len(), 96 * keys, "{name}");
        }
    }

    #[test]
    fn the_published_copy_is_the_same_transaction() {
        let out = published_copy(VECTOR).unwrap();
        assert_eq!(expiry_height_of(&out).unwrap(), 4_203_034);
        // Redacting twice changes nothing more, and a PCZT with no keys is left alone.
        assert_eq!(published_copy(&out).unwrap(), out);
    }

    #[test]
    fn a_pczt_that_cannot_be_read_is_not_published() {
        // Fail closed: the caller refuses to publish rather than send what it could not check.
        assert!(published_copy(b"not a pczt").is_err());
        assert!(published_copy(&[]).is_err());
    }

    /// The devices' side of this is tested in `konclave-wasm` against these two files. They are this
    /// function's output, byte for byte, so that test reads what is really published and not a copy
    /// built the way the test would like.
    #[test]
    fn the_published_copy_is_what_the_devices_are_tested_against() {
        let published: [(&[u8], &[u8]); 2] = [
            (
                VECTOR,
                include_bytes!(
                    "../../konclave-wasm/tests/vectors/ironwood_single_spend.published.pczt"
                ),
            ),
            (
                ORCHARD_TWO_SPEND,
                include_bytes!(
                    "../../konclave-wasm/tests/vectors/orchard_mainnet_two_spend.published.pczt"
                ),
            ),
        ];
        for (vector, fixture) in published {
            assert_eq!(published_copy(vector).unwrap(), fixture);
        }
    }
}
