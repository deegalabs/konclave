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

// ---- hex helpers (dependency-free) ----

fn hex_encode(bytes: &[u8]) -> String {
    let mut s = String::with_capacity(bytes.len() * 2);
    for b in bytes {
        s.push_str(&format!("{b:02x}"));
    }
    s
}

fn hex_decode(s: &str) -> Result<Vec<u8>, ToolError> {
    if s.len() % 2 != 0 {
        return Err(ToolError::parse("hex", "odd length"));
    }
    (0..s.len())
        .step_by(2)
        .map(|i| {
            u8::from_str_radix(&s[i..i + 2], 16)
                .map_err(|e| ToolError::parse("hex", e.to_string()))
        })
        .collect()
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

    // Real `konclave-signer extract` output from the vertical slice.
    const EXTRACT: &str = "SIGHASH 9d65aa4b4c1b23e777006823381a5228d8a7171c6f5c77c2cfaba2b001b19849\nRANDOMIZER 1 320f2f9d61fd336a03db6609953704d49ce13ab059711c87e332ed240a569911\n";

    #[test]
    fn parses_sighash_and_randomizer() {
        let input = parse_extract(EXTRACT).unwrap();
        assert_eq!(hex_encode(&input.sighash), "9d65aa4b4c1b23e777006823381a5228d8a7171c6f5c77c2cfaba2b001b19849");
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
            parse_extract("RANDOMIZER 0 320f2f9d61fd336a03db6609953704d49ce13ab059711c87e332ed240a569911"),
            Err(ToolError::Parse { .. })
        ));
    }

    #[test]
    fn no_randomizers_is_error() {
        // A sighash with no real spends to sign is a malformed request.
        let only_sighash = "SIGHASH 9d65aa4b4c1b23e777006823381a5228d8a7171c6f5c77c2cfaba2b001b19849";
        assert!(matches!(parse_extract(only_sighash), Err(ToolError::Parse { .. })));
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
