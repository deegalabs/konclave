//! Bridge orchestration: drives `konclave-signer` (our FROST↔PCZT bridge).
//!
//! `extract` yields the shielded sighash and the per-spend randomizers the FROST
//! ceremony must sign; `inject` applies the resulting redpallas signatures back into
//! the PCZT. Parsing is separated from process invocation so it is unit-tested.

use std::path::Path;

use crate::tools::{run, run_text, ToolError};

/// The randomizer (alpha) for one real Orchard spend, by action index.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Randomizer {
    pub action_index: usize,
    pub alpha: [u8; 32],
}

/// Everything the FROST ceremony needs to sign a PCZT: the shielded sighash and one
/// randomizer per real spend (dummies are already filtered out by the bridge).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SigningInput {
    pub sighash: [u8; 32],
    pub randomizers: Vec<Randomizer>,
}

/// Parse the output of `konclave-signer extract`:
/// ```text
/// SIGHASH <64-hex>
/// RANDOMIZER <action_index> <64-hex>
/// ```
pub fn parse_extract(output: &str) -> Result<SigningInput, ToolError> {
    let mut sighash: Option<[u8; 32]> = None;
    let mut randomizers = Vec::new();

    for line in output.lines() {
        let mut fields = line.split_whitespace();
        match fields.next() {
            Some("SIGHASH") => {
                let hex = fields
                    .next()
                    .ok_or_else(|| ToolError::parse("extract", "SIGHASH line has no value"))?;
                sighash = Some(hex32(hex, "sighash")?);
            }
            Some("RANDOMIZER") => {
                let idx = fields
                    .next()
                    .ok_or_else(|| ToolError::parse("extract", "RANDOMIZER line has no index"))?
                    .parse::<usize>()
                    .map_err(|e| ToolError::parse("randomizer index", e.to_string()))?;
                let hex = fields
                    .next()
                    .ok_or_else(|| ToolError::parse("extract", "RANDOMIZER line has no value"))?;
                randomizers.push(Randomizer {
                    action_index: idx,
                    alpha: hex32(hex, "randomizer")?,
                });
            }
            _ => {} // ignore blank/other lines
        }
    }

    let sighash =
        sighash.ok_or_else(|| ToolError::parse("extract", "no SIGHASH line in output"))?;
    if randomizers.is_empty() {
        return Err(ToolError::parse("extract", "no RANDOMIZER lines in output"));
    }
    Ok(SigningInput {
        sighash,
        randomizers,
    })
}

// ---- wrappers ----

/// `konclave-signer extract <pczt>`
pub fn extract(konclave_signer: &Path, pczt_path: &str) -> Result<SigningInput, ToolError> {
    let out = run_text(konclave_signer, &["extract", pczt_path], None)?;
    parse_extract(&out)
}

/// `konclave-signer inject <pczt> <out> --sig <idx>:<128-hex> …`
pub fn inject(
    konclave_signer: &Path,
    pczt_path: &str,
    out_path: &str,
    signatures: &[(usize, [u8; 64])],
) -> Result<(), ToolError> {
    let mut owned: Vec<String> = vec!["inject".into(), pczt_path.into(), out_path.into()];
    for (idx, sig) in signatures {
        owned.push("--sig".into());
        owned.push(format!("{idx}:{}", hex_encode(sig)));
    }
    let args: Vec<&str> = owned.iter().map(String::as_str).collect();
    run(konclave_signer, &args, None)?;
    Ok(())
}

pub use konclave_seal::spends::INJECT_EXIT_SIGNATURE_REJECTED;

/// Whether this `konclave-signer` exits with [`INJECT_EXIT_SIGNATURE_REJECTED`] for a refused
/// signature. A build that predates it exits 1 for every failure, and reading that as "the check did
/// not run" would hold the cursor on every refused answer; so it is asked, not assumed, and any
/// failure to answer (no such command, a different number, no answer within the deadline) is "no".
pub fn speaks_refusal_status(konclave_signer: &Path) -> bool {
    let answer = crate::tools::run_within(
        konclave_signer,
        &["inject-statuses"],
        None,
        std::time::Duration::from_secs(5),
    );
    let speaks = answer
        .ok()
        .and_then(|out| serde_json::from_slice::<serde_json::Value>(&out).ok())
        .and_then(|v| v.get("signature_rejected").and_then(|n| n.as_i64()))
        == Some(i64::from(INJECT_EXIT_SIGNATURE_REJECTED));
    if !speaks {
        eprintln!(
            "signer: no refusal status reported; this send reads every failed check as a refusal"
        );
    }
    speaks
}

/// What an attempted inject says about the signatures it was given: valid (and the signed PCZT is
/// written), refused by the check, or nothing at all because the check did not run.
///
/// With a signer that does not speak the refusal status (`speaks` false), every failure is read as a
/// refusal, as before that status existed: an answer is then never read again, which loses one whose
/// check did not run but cannot hold the cursor.
pub fn inject_verdict(result: &Result<(), ToolError>, speaks: bool) -> crate::net_send::Verdict {
    use crate::net_send::Verdict;
    match result {
        Ok(()) => Verdict::Valid,
        Err(_) if !speaks => Verdict::Invalid,
        Err(ToolError::NonZero {
            code: Some(INJECT_EXIT_SIGNATURE_REJECTED),
            ..
        }) => Verdict::Invalid,
        Err(_) => Verdict::CouldNotRun,
    }
}

// ---- hex helpers (dependency-free) ----

fn hex_encode(bytes: &[u8]) -> String {
    let mut s = String::with_capacity(bytes.len() * 2);
    for b in bytes {
        s.push_str(&format!("{b:02x}"));
    }
    s
}

fn hex_decode(s: &str) -> Result<Vec<u8>, ToolError> {
    konclave_seal::hex::decode(s).ok_or_else(|| ToolError::parse("hex", "not hex"))
}

fn hex32(s: &str, what: &str) -> Result<[u8; 32], ToolError> {
    let bytes = hex_decode(s)?;
    bytes
        .try_into()
        .map_err(|_| ToolError::parse(what, "expected 32 bytes"))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn only_the_signers_refusal_judges_an_answer() {
        use crate::net_send::Verdict;
        let nz = |code| {
            Err(ToolError::NonZero {
                program: "konclave-signer".into(),
                code,
                stderr: String::new(),
                stdout: String::new(),
            })
        };
        assert_eq!(inject_verdict(&Ok(()), true), Verdict::Valid);
        assert_eq!(inject_verdict(&nz(Some(3)), true), Verdict::Invalid);
        assert_eq!(inject_verdict(&nz(Some(1)), true), Verdict::CouldNotRun);
        assert_eq!(inject_verdict(&nz(None), true), Verdict::CouldNotRun);
        // A signer that predates the status: every failure is a refusal, never a hold.
        assert_eq!(inject_verdict(&Ok(()), false), Verdict::Valid);
        assert_eq!(inject_verdict(&nz(Some(1)), false), Verdict::Invalid);
        assert_eq!(inject_verdict(&nz(Some(3)), false), Verdict::Invalid);
        let spawn = Err(ToolError::Spawn {
            program: "konclave-signer".into(),
            source: std::io::Error::from(std::io::ErrorKind::NotFound),
        });
        assert_eq!(inject_verdict(&spawn, true), Verdict::CouldNotRun);
    }

    #[cfg(unix)]
    fn stand_in(name: &str, body: &str) -> std::path::PathBuf {
        let dir =
            std::env::temp_dir().join(format!("konclave-statuses-{name}-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("signer");
        crate::test_exec::write_script(&path, &format!("#!/bin/sh\n{body}\n"));
        path
    }

    /// The coordinator asks the signer, and only an exact answer turns the refusal status on: an
    /// older signer (no such command), a different number or a missing binary all read as "no".
    #[cfg(unix)]
    #[test]
    fn the_refusal_status_is_asked_of_the_signer_not_assumed() {
        let speaks = stand_in(
            "speaks",
            r#"[ "$1" = inject-statuses ] && echo '{"signature_rejected":3}'"#,
        );
        assert!(speaks_refusal_status(&speaks));
        let older = stand_in("older", "echo 'error: unrecognized subcommand' >&2; exit 2");
        assert!(!speaks_refusal_status(&older));
        let other = stand_in("other", r#"echo '{"signature_rejected":4}'"#);
        assert!(!speaks_refusal_status(&other));
        assert!(!speaks_refusal_status(Path::new(
            "/nonexistent/konclave-signer"
        )));
    }

    // Real `konclave-signer extract` output from the vertical slice.
    const EXTRACT: &str = "SIGHASH 9d65aa4b4c1b23e777006823381a5228d8a7171c6f5c77c2cfaba2b001b19849\nRANDOMIZER 1 320f2f9d61fd336a03db6609953704d49ce13ab059711c87e332ed240a569911\n";

    #[test]
    fn parses_sighash_and_randomizer() {
        let input = parse_extract(EXTRACT).unwrap();
        assert_eq!(
            hex_encode(&input.sighash),
            "9d65aa4b4c1b23e777006823381a5228d8a7171c6f5c77c2cfaba2b001b19849"
        );
        assert_eq!(input.randomizers.len(), 1);
        assert_eq!(input.randomizers[0].action_index, 1);
        assert_eq!(
            hex_encode(&input.randomizers[0].alpha),
            "320f2f9d61fd336a03db6609953704d49ce13ab059711c87e332ed240a569911"
        );
    }

    #[test]
    fn hex_roundtrip() {
        let sig = [0xabu8; 64];
        let encoded = hex_encode(&sig);
        assert_eq!(encoded.len(), 128);
        assert_eq!(hex_decode(&encoded).unwrap(), sig.to_vec());
    }

    #[test]
    fn missing_sighash_is_error() {
        assert!(matches!(
            parse_extract(
                "RANDOMIZER 0 320f2f9d61fd336a03db6609953704d49ce13ab059711c87e332ed240a569911"
            ),
            Err(ToolError::Parse { .. })
        ));
    }

    #[test]
    fn no_randomizers_is_error() {
        // A sighash with no real spends to sign is a malformed request.
        let only_sighash =
            "SIGHASH 9d65aa4b4c1b23e777006823381a5228d8a7171c6f5c77c2cfaba2b001b19849";
        assert!(matches!(
            parse_extract(only_sighash),
            Err(ToolError::Parse { .. })
        ));
    }

    #[test]
    fn bad_hex_is_error() {
        assert!(matches!(
            parse_extract("SIGHASH zzzz"),
            Err(ToolError::Parse { .. })
        ));
        // wrong length (not 32 bytes)
        assert!(matches!(
            parse_extract("SIGHASH abcd"),
            Err(ToolError::Parse { .. })
        ));
    }
}
