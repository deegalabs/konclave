//! Wallet orchestration (read side): drives `zcash-devtool wallet` and parses its
//! JSON into typed values. Sync/balance/get-info are the structured, JSON-emitting
//! commands — exactly the "structured output, never read the screen" discipline.

use std::path::Path;

use serde::Deserialize;

use crate::money::Zatoshis;
use crate::tools::{run_text, ToolError};

/// Server + chain info (from `wallet get-info`).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ChainInfo {
    pub chain_name: String,
    pub chain_tip_height: u64,
    pub server_uri: String,
}

#[derive(Deserialize)]
struct ChainInfoRaw {
    chain_name: String,
    chain_tip_height: u64,
    server_uri: String,
}

/// Vault balance (from `wallet balance --json`). Confirmed vs. spendable are kept
/// separate — never merged into one unlabeled number (spec §2.3).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Balance {
    pub chain_tip_height: u64,
    pub orchard_spendable: Zatoshis,
    pub sapling_spendable: Zatoshis,
    pub transparent_spendable: Zatoshis,
    /// Total including notes not yet spendable (e.g. awaiting confirmations).
    pub total: Zatoshis,
}

#[derive(Deserialize)]
struct BalanceRaw {
    chain_tip_height: u64,
    orchard_spendable: u64,
    sapling_spendable: u64,
    transparent_spendable: u64,
    total: u64,
}

/// Parse the JSON from `wallet get-info`.
pub fn parse_chain_info(json: &str) -> Result<ChainInfo, ToolError> {
    // get-info logs an INFO line to stderr; stdout is the single JSON object. Be
    // defensive: take the last non-empty line in case anything leaked to stdout.
    let line = last_json_line(json)?;
    let raw: ChainInfoRaw =
        serde_json::from_str(line).map_err(|e| ToolError::parse("get-info JSON", e.to_string()))?;
    Ok(ChainInfo {
        chain_name: raw.chain_name,
        chain_tip_height: raw.chain_tip_height,
        server_uri: raw.server_uri,
    })
}

/// Parse the JSON from `wallet balance --json`, validating every amount.
pub fn parse_balance(json: &str) -> Result<Balance, ToolError> {
    let line = last_json_line(json)?;
    let raw: BalanceRaw =
        serde_json::from_str(line).map_err(|e| ToolError::parse("balance JSON", e.to_string()))?;
    let z = |v: u64, field: &str| {
        Zatoshis::from_u64(v)
            .map_err(|e| ToolError::parse(format!("balance.{field}"), e.to_string()))
    };
    Ok(Balance {
        chain_tip_height: raw.chain_tip_height,
        orchard_spendable: z(raw.orchard_spendable, "orchard_spendable")?,
        sapling_spendable: z(raw.sapling_spendable, "sapling_spendable")?,
        transparent_spendable: z(raw.transparent_spendable, "transparent_spendable")?,
        total: z(raw.total, "total")?,
    })
}

/// The last line that looks like a JSON object (`{…}`).
fn last_json_line(text: &str) -> Result<&str, ToolError> {
    text.lines()
        .map(str::trim)
        .rfind(|l| l.starts_with('{') && l.ends_with('}'))
        .ok_or_else(|| ToolError::parse("tool output", "no JSON object found"))
}

/// The last line that looks like a JSON array (`[…]`).
fn last_json_array_line(text: &str) -> Result<&str, ToolError> {
    text.lines()
        .map(str::trim)
        .rfind(|l| l.starts_with('[') && l.ends_with(']'))
        .ok_or_else(|| ToolError::parse("tool output", "no JSON array found"))
}

/// Parse `list-tx --json` (a `[{"txid","mined_height"}]` array) into the txids the wallet has
/// recorded as **mined** (`mined_height` non-null). Unmined transactions are excluded. This is the
/// `confirmed_txids` source that lets reconciliation promote a locally-`Sent` proposal to
/// `Confirmed` (§8) — a fresh sync before this call makes the wallet's view current.
pub fn parse_confirmed_txids(json: &str) -> Result<Vec<String>, ToolError> {
    #[derive(serde::Deserialize)]
    struct TxRow {
        txid: String,
        mined_height: Option<u64>,
    }
    let line = last_json_array_line(json)?;
    let rows: Vec<TxRow> =
        serde_json::from_str(line).map_err(|e| ToolError::parse("list-tx JSON", e.to_string()))?;
    Ok(rows
        .into_iter()
        .filter(|r| r.mined_height.is_some())
        .map(|r| r.txid)
        .collect())
}

// ---- wrappers that actually run the tool ----

/// Common server args for read commands.
fn server_args(server: &str) -> [&str; 4] {
    ["-s", server, "--connection", "direct"]
}

/// `zcash-devtool wallet -w <dir> get-info -s <server> --connection direct`
pub fn get_info(devtool: &Path, wallet_dir: &str, server: &str) -> Result<ChainInfo, ToolError> {
    let s = server_args(server);
    let args = [
        "wallet", "-w", wallet_dir, "get-info", s[0], s[1], s[2], s[3],
    ];
    parse_chain_info(&run_text(devtool, &args, None)?)
}

/// `zcash-devtool wallet -w <dir> balance --json`
pub fn balance(devtool: &Path, wallet_dir: &str) -> Result<Balance, ToolError> {
    let args = ["wallet", "-w", wallet_dir, "balance", "--json"];
    parse_balance(&run_text(devtool, &args, None)?)
}

/// `zcash-devtool wallet -w <dir> list-tx --json` → the txids the wallet has recorded as mined.
pub fn list_confirmed_txids(devtool: &Path, wallet_dir: &str) -> Result<Vec<String>, ToolError> {
    let args = ["wallet", "-w", wallet_dir, "list-tx", "--json"];
    parse_confirmed_txids(&run_text(devtool, &args, None)?)
}

#[cfg(test)]
mod tests {
    use super::*;

    // Real output captured during the vertical slice.
    const GET_INFO: &str = r#"2026-06-30T20:12:45Z  INFO zcash_devtool::remote: Connecting to zec.rocks:443
{"chain_name":"main","chain_tip_height":3396328,"server_uri":"https://zec.rocks:443"}"#;

    const BALANCE: &str = r#"{"chain_tip_height":3396338,"orchard_spendable":0,"sapling_spendable":0,"total":100000,"transparent_spendable":0}"#;

    #[test]
    fn parses_chain_info_ignoring_log_line() {
        let info = parse_chain_info(GET_INFO).unwrap();
        assert_eq!(info.chain_name, "main");
        assert_eq!(info.chain_tip_height, 3_396_328);
        assert_eq!(info.server_uri, "https://zec.rocks:443");
    }

    // `list-tx --json` shape (a log line may precede the array), with one unmined tx.
    const LIST_TX: &str = r#"2026-07-28T16:00:00Z  INFO zcash_devtool::remote: Connecting
[{"txid":"54266f478505160a","mined_height":3428205},{"txid":"36c60f1e3f602c2a","mined_height":null},{"txid":"aab00f903b65e32d","mined_height":3413792}]"#;

    #[test]
    fn confirmed_txids_keeps_only_mined() {
        let ids = parse_confirmed_txids(LIST_TX).unwrap();
        assert_eq!(
            ids,
            vec![
                "54266f478505160a".to_string(),
                "aab00f903b65e32d".to_string()
            ]
        );
        assert!(!ids.iter().any(|t| t == "36c60f1e3f602c2a")); // the unmined one is excluded
    }

    #[test]
    fn confirmed_txids_empty_array_is_ok() {
        assert_eq!(parse_confirmed_txids("[]").unwrap(), Vec::<String>::new());
    }

    #[test]
    fn parses_balance_into_typed_zatoshis() {
        let b = parse_balance(BALANCE).unwrap();
        assert_eq!(b.chain_tip_height, 3_396_338);
        assert_eq!(b.total, Zatoshis::from_u64(100_000).unwrap());
        assert_eq!(b.orchard_spendable, Zatoshis::ZERO);
        // total is 0.001 ZEC (the funding amount), not yet spendable.
        assert_eq!(b.total.to_zec_string(), "0.00100000");
    }

    #[test]
    fn malformed_json_is_explicit_error() {
        assert!(matches!(
            parse_balance("not json at all"),
            Err(ToolError::Parse { .. })
        ));
        assert!(matches!(
            parse_balance(r#"{"chain_tip_height":"oops"}"#),
            Err(ToolError::Parse { .. })
        ));
    }
}
