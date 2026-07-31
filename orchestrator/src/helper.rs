//! Building blocks for the hosted blind helper (ADR-0006, Rung A): the pieces that let a
//! service operate a vault from **public / view-only** material only, never a share. It starts
//! with deriving a vault's Orchard address + UFVK from its FROST group verifying key, so a blind
//! helper can register a vault knowing only its group key (which the browser already shows on
//! `/net`). More of the hosted-helper surface (per-vault view-only wallets, the Architecture-B
//! send path) lands on this module as Rung A is built.

use std::path::Path;

use crate::tools::{run_text_all, ToolError};

/// Derive a vault's Orchard-only receive address and its UFVK from the FROST group verifying key,
/// via `zcash-sign generate --ak <group> --network <network>`. Only **public** material is used
/// (no share), which is exactly what a blind helper is allowed to touch. `network` is `"main"` or
/// `"test"`; anything else is rejected before any process runs.
pub fn derive_identity(
    zcash_sign: &Path,
    group_key: &str,
    network: &str,
) -> Result<(String, String), ToolError> {
    if network != "main" && network != "test" {
        return Err(ToolError::parse(
            "zcash-sign",
            format!("network must be \"main\" or \"test\", got {network:?}"),
        ));
    }
    let out = run_text_all(
        zcash_sign,
        &["generate", "--ak", group_key, "--network", network],
        None,
    )?;
    parse_generate(&out)
}

/// Parse `zcash-sign generate`'s output into (orchard address, ufvk).
fn parse_generate(out: &str) -> Result<(String, String), ToolError> {
    let addr = extract_quoted(out, "unified address:")?;
    let ufvk = extract_quoted(out, "Viewing Key:")?;
    Ok((addr, ufvk))
}

/// Pull the value inside the last pair of quotes on the first line containing `after`.
fn extract_quoted(out: &str, after: &str) -> Result<String, ToolError> {
    for line in out.lines() {
        if let Some(idx) = line.find(after) {
            let rest = &line[idx + after.len()..];
            if let (Some(a), Some(b)) = (rest.find('"'), rest.rfind('"')) {
                if b > a {
                    return Ok(rest[a + 1..b].to_string());
                }
            }
        }
    }
    Err(ToolError::parse(
        "zcash-sign",
        format!("no quoted value found after '{after}'"),
    ))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_mainnet_address_and_ufvk() {
        let out = "Orchard-only unified address: \"u14g48z7mn\"\nUnified Full Viewing Key: \"uview1x2w3\"\n";
        let (a, u) = parse_generate(out).unwrap();
        assert_eq!(a, "u14g48z7mn");
        assert_eq!(u, "uview1x2w3");
    }

    #[test]
    fn parses_testnet_address_and_ufvk() {
        let out = "Orchard-only unified address: \"utest1r6jhrp5\"\nUnified Full Viewing Key: \"uviewtest1y53lp3\"\n";
        let (a, u) = parse_generate(out).unwrap();
        assert_eq!(a, "utest1r6jhrp5");
        assert_eq!(u, "uviewtest1y53lp3");
    }

    #[test]
    fn missing_quoted_value_is_an_error() {
        assert!(parse_generate("nothing quoted here").is_err());
        assert!(parse_generate("Orchard-only unified address: no quotes").is_err());
    }

    #[test]
    fn rejects_unknown_network_before_running_anything() {
        // The network guard fires before exec, so the bogus binary path is never touched.
        let e = derive_identity(Path::new("/nonexistent/zcash-sign"), "deadbeef", "regtest");
        assert!(e.is_err());
    }
}
