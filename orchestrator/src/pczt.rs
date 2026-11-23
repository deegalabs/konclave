//! PCZT orchestration: drives `zcash-devtool pczt` (prove → send; building is `konclave-signer build-payroll`). PCZT
//! bytes are piped between steps; the final `send` returns the broadcast txid.
//!
//! `parse_txid` validates the tool's output rather than trusting the exit code - a
//! rejected broadcast (e.g. an expired tx) is turned into an explicit error even if
//! the process exits zero.

use std::path::Path;

use crate::tools::{run, ToolError};

/// `zcash-devtool pczt -w <dir> prove` - reads a PCZT on stdin, returns the proven PCZT.
pub fn prove(devtool: &Path, wallet_dir: &str, pczt: &[u8]) -> Result<Vec<u8>, ToolError> {
    run(devtool, &["pczt", "-w", wallet_dir, "prove"], Some(pczt))
}

/// One broadcast attempt on one server: `zcash-devtool pczt -w <dir> send` with the server's
/// arguments, stopped at `call`'s deadline. Returns the txid the tool reports.
///
/// Private to this crate on purpose, and called from one place, [`crate::lightclient::broadcast`]
/// (which decides what is tried where, and for how long). Nothing outside this crate can broadcast
/// except through [`crate::send_record::send_proposal`] (which records the attempt first) or the
/// operator's command line wrapper in [`crate::send`].
pub(crate) fn send_on(
    devtool: &Path,
    wallet_dir: &str,
    server: &str,
    signed_pczt: &[u8],
    call: crate::lightclient::Call,
) -> Result<String, ToolError> {
    let out = crate::lightclient::run_text(
        devtool,
        &["pczt", "-w", wallet_dir, "send"],
        server,
        Some(signed_pczt),
        call,
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

/// How many actions the transaction carries, in both shielded pools together.
///
/// What the signing request's size grows with (#821): every action adds its own fields and its share
/// of the proof, whether it spends, pays or is padding. A transaction can carry an Orchard and an
/// Ironwood bundle at once (Orchard notes spent, the payment placed in Ironwood), each padded to at
/// least two actions, so counting one pool would undercount exactly the sends that are largest.
/// The count is the same before and after proving, which is what lets it be asked at proposal time.
pub fn action_count_of(pczt_bytes: &[u8]) -> Result<usize, ToolError> {
    let pczt = ::pczt::Pczt::parse(pczt_bytes)
        .map_err(|e| ToolError::parse("pczt", format!("cannot read the PCZT: {e:?}")))?;
    // The count is `konclave_seal::spends`' (the device's fee check reads the same one), not a second one.
    Ok(konclave_seal::spends::action_count(&pczt))
}

/// The fee the PCZT pays and its logical actions, by the reader the device judges the fee with.
pub fn fee_and_actions_of(pczt_bytes: &[u8]) -> Result<(u64, u64), ToolError> {
    let pczt = ::pczt::Pczt::parse(pczt_bytes)
        .map_err(|e| ToolError::parse("pczt", format!("cannot read the PCZT: {e:?}")))?;
    konclave_seal::spends::fee_and_actions(&pczt).map_err(|e| ToolError::parse("pczt", e))
}

/// The copy of a proven PCZT that goes into the signing room. It leaves out, in both pools, five
/// fields no device reads (the calls below name them); the tests pin that exactly those five go.
/// The sighash, the outputs and the payment a device shows are built from the
/// effecting data and the output fields. The coordinator keeps its own full copy to apply the
/// signatures to; only what is PUBLISHED passes through here.
///
/// Fails closed: a PCZT that cannot be read is not published as it is.
pub fn published_copy(pczt_bytes: &[u8]) -> Result<Vec<u8>, ToolError> {
    let pczt = ::pczt::Pczt::parse(pczt_bytes)
        .map_err(|e| ToolError::parse("pczt", format!("cannot read the proven PCZT: {e:?}")))?;
    ::pczt::roles::redactor::Redactor::new(pczt)
        .redact_orchard_with(|mut bundle| {
            bundle.clear_bsk();
            bundle.clear_zkproof();
            bundle.redact_actions(|mut action| {
                action.clear_spend_fvk();
                action.clear_rcv();
                action.clear_spend_witness();
            })
        })
        .redact_ironwood_with(|mut bundle| {
            bundle.clear_bsk();
            bundle.clear_zkproof();
            bundle.redact_actions(|mut action| {
                action.clear_spend_fvk();
                action.clear_rcv();
                action.clear_spend_witness();
            })
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

    /// A broadcast to a server that never answers is stopped at its deadline, not held for as long as
    /// the server hangs (it holds a worker and the vault's lock while it waits).
    #[cfg(unix)]
    #[test]
    fn a_broadcast_to_a_server_that_never_answers_is_stopped() {
        let dir = std::env::temp_dir().join(format!("konclave-pczt-hang-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let hang = dir.join("devtool");
        crate::test_exec::write_script(&hang, "#!/bin/sh\nexec sleep 30\n");
        crate::lightclient::set_within_for_test(Some(std::time::Duration::from_millis(300)));
        let started = std::time::Instant::now();
        let r = send_on(
            &hang,
            "/w",
            "zec.rocks:443",
            b"signed",
            crate::lightclient::Call::Broadcast,
        );
        crate::lightclient::set_within_for_test(None);
        std::fs::remove_dir_all(&dir).ok();
        assert!(r.is_err());
        assert!(
            started.elapsed() < std::time::Duration::from_secs(5),
            "the broadcast was not stopped"
        );
    }

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

    // The published copy: the proven PCZT without the five fields no device reads (the sighash, the
    // outputs and the payment they show come from the effecting data and the output fields).
    const ORCHARD_TWO_SPEND: &[u8] =
        include_bytes!("../../konclave-wasm/tests/vectors/orchard_mainnet_two_spend.proven.pczt");

    /// `d` (a derived Debug) with every `field: Some(..)` written as `field: None`, matching the
    /// brackets so a nested value goes whole. An empty proof (`Some([])`, which a pool with no
    /// actions carries by construction) is left as it is.
    fn none_out(d: &str, field: &str) -> String {
        let key = format!("{field}: Some(");
        let (mut out, mut rest) = (String::new(), d);
        while let Some(i) = rest.find(&key) {
            let start = i + key.len();
            let mut depth = 1;
            let end = rest[start..]
                .char_indices()
                .find_map(|(j, c)| {
                    match c {
                        '(' => depth += 1,
                        ')' => depth -= 1,
                        _ => {}
                    }
                    (depth == 0).then_some(start + j + 1)
                })
                .unwrap();
            out.push_str(&rest[..i]);
            if field == "zkproof" && &rest[start..end] == "[])" {
                out.push_str(&rest[i..end]);
            } else {
                out.push_str(&format!("{field}: None"));
            }
            rest = &rest[end..];
        }
        out.push_str(rest);
        out
    }

    /// How many spend key fields `original` has and `out` lacks. Read from the derived Debug, which
    /// names every field, so it does not use the redaction it checks.
    fn keys_removed(original: &[u8], out: &[u8]) -> usize {
        let count = |b: &[u8]| {
            format!("{:?}", ::pczt::Pczt::parse(b).unwrap())
                .matches("fvk: Some")
                .count()
        };
        count(original) - count(out)
    }

    #[test]
    fn the_published_copy_drops_the_key_field_in_either_pool() {
        // The number of spends each vector carries a key for: 4 in the Ironwood vector (a 4-spend
        // `create-max`), 2 in the Orchard one.
        for (name, vector, keys) in [("ironwood", VECTOR, 4), ("orchard", ORCHARD_TWO_SPEND, 2)] {
            let out = published_copy(vector).unwrap();
            assert_eq!(keys_removed(vector, &out), keys, "{name}");
            assert!(vector.len() - out.len() >= 96 * keys, "{name}");
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

    // #821. One vector per pool, so a count that read only one bundle fails on the other.
    #[test]
    fn the_action_count_reads_both_pools() {
        assert_eq!(action_count_of(VECTOR).unwrap(), 4, "ironwood");
        assert_eq!(action_count_of(ORCHARD_TWO_SPEND).unwrap(), 2, "orchard");
        // Proving and redacting change neither the actions nor their count.
        assert_eq!(
            action_count_of(&published_copy(VECTOR).unwrap()).unwrap(),
            4
        );
        assert!(action_count_of(b"not a pczt").is_err());
    }

    /// A fixed-sequence generator for the one nonce the extractor draws: it signs a test vector, and a
    /// test must not depend on the machine's entropy.
    struct TestRng(u64);
    impl rand_core_10::TryRng for TestRng {
        type Error = core::convert::Infallible;
        fn try_next_u32(&mut self) -> Result<u32, Self::Error> {
            Ok((self.try_next_u64()? >> 32) as u32)
        }
        fn try_next_u64(&mut self) -> Result<u64, Self::Error> {
            self.0 ^= self.0 << 13;
            self.0 ^= self.0 >> 7;
            self.0 ^= self.0 << 17;
            Ok(self.0)
        }
        fn try_fill_bytes(&mut self, dst: &mut [u8]) -> Result<(), Self::Error> {
            for chunk in dst.chunks_mut(8) {
                let n = self.try_next_u64()?.to_le_bytes();
                chunk.copy_from_slice(&n[..chunk.len()]);
            }
            Ok(())
        }
    }
    impl rand_core_10::TryCryptoRng for TestRng {}

    /// What a copy answers to the PCZT's IO finalization step (`finalize_io`), asked through the
    /// signer's parse, on the pool `ironwood` selects.
    fn finalize_step(bytes: &[u8], ironwood: bool) -> String {
        use ::pczt::roles::low_level_signer::{OrchardParseError, Signer};
        let mut out = String::new();
        let f = |_: &::pczt::Pczt,
                 b: &mut ::orchard::pczt::Bundle,
                 _: &mut u8|
         -> Result<(), OrchardParseError> {
            out = match b.finalize_io([7u8; 32], TestRng(1)) {
                Ok(()) => "ok".into(),
                Err(e) => format!("{e:?}"),
            };
            Ok(())
        };
        let s = Signer::new(::pczt::Pczt::parse(bytes).unwrap());
        if ironwood {
            s.sign_ironwood_with(f).unwrap();
        } else {
            s.sign_orchard_with(f).unwrap();
        }
        out
    }

    #[test]
    fn the_published_copy_cannot_be_finalized_in_either_pool() {
        for (name, vector, ironwood) in [
            ("orchard", ORCHARD_TWO_SPEND, false),
            ("ironwood", VECTOR, true),
        ] {
            // Control: the full copy answers the step, so a refusal below is the copy's, not the step's.
            assert_eq!(finalize_step(vector, ironwood), "ok", "{name}");
            let out = finalize_step(&published_copy(vector).unwrap(), ironwood);
            assert!(out.contains("MissingValueCommitTrapdoor"), "{name}: {out}");
        }
    }

    #[test]
    fn the_published_copy_lacks_exactly_the_five_fields_in_either_pool() {
        for (name, vector) in [("orchard", ORCHARD_TWO_SPEND), ("ironwood", VECTOR)] {
            // Control: the proven vector has them, so an empty answer cannot be a reader's blind spot.
            let full = ::pczt::Pczt::parse(vector).unwrap();
            let out = ::pczt::Pczt::parse(&published_copy(vector).unwrap()).unwrap();
            // The derived Debug names every field, including the ones with no getter.
            let seen = |p: &::pczt::Pczt| {
                let d = format!("{p:?}");
                let d = d[d.find("orchard: Bundle").unwrap()..].to_string();
                [
                    d.matches("rcv: Some").count(),
                    d.matches("bsk: Some").count(),
                    // A pool with no actions carries an empty proof by construction: not a proof.
                    d.matches("zkproof: Some").count() - d.matches("zkproof: Some([])").count(),
                    d.matches("witness: Some").count(),
                ]
            };
            let (before, after) = (seen(&full), seen(&out));
            assert!(
                before.iter().all(|n| *n > 0),
                "{name}: the vector has none of one to remove: {before:?}"
            );
            assert_eq!(after, [0, 0, 0, 0], "{name}");
            // And nothing else is missing: the published copy reads as the full one with exactly
            // those five set to None. (Everything before the Orchard bundle, the empty Sapling one,
            // is compared as it is.)
            let (full_d, out_d) = (format!("{full:?}"), format!("{out:?}"));
            let split = |d: &str| {
                d.find("orchard: Bundle")
                    .map(|i| (d[..i].to_string(), d[i..].to_string()))
                    .unwrap()
            };
            let ((full_head, full_tail), (out_head, out_tail)) = (split(&full_d), split(&out_d));
            assert_eq!(full_head, out_head, "{name}: the head differs");
            let mut expected = full_tail;
            for field in ["fvk", "rcv", "bsk", "witness", "zkproof"] {
                expected = none_out(&expected, field);
            }
            assert_eq!(
                expected, out_tail,
                "{name}: something else was cleared or changed"
            );
        }
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
