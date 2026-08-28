//! Wallet orchestration (read side): drives `zcash-devtool wallet` and parses its
//! JSON into typed values. Sync/balance/get-info are the structured, JSON-emitting
//! commands - exactly the "structured output, never read the screen" discipline.

use std::collections::BTreeMap;
use std::path::Path;

use serde::Deserialize;
use serde_json::Value;

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
/// separate - never merged into one unlabeled number (spec §2.3).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Balance {
    pub chain_tip_height: u64,
    pub orchard_spendable: Zatoshis,
    /// Ironwood pool (NU6.3, V6). Post-activation every new shielded deposit lands here, not in
    /// Orchard (Orchard is withdrawal-only), and it carries its OWN value balance (ZIP-318). The
    /// pre-Ironwood reader ignored this field, so an Ironwood-funded vault reported 0 spendable.
    pub ironwood_spendable: Zatoshis,
    pub sapling_spendable: Zatoshis,
    pub transparent_spendable: Zatoshis,
    /// Total including notes not yet spendable (e.g. awaiting confirmations).
    pub total: Zatoshis,
}

impl Balance {
    /// What the FROST/Orchard-family vault can actually spend: the Orchard pool plus the Ironwood
    /// pool (both are RedPallas/Orchard-shaped and this vault holds no Sapling/transparent spend
    /// key). This is the number the send path and the UI mean by "spendable".
    pub fn shielded_spendable(&self) -> Zatoshis {
        Zatoshis::from_u64(self.orchard_spendable.as_u64() + self.ironwood_spendable.as_u64())
            .unwrap_or(self.orchard_spendable)
    }
}

#[derive(Deserialize)]
struct BalanceRaw {
    chain_tip_height: u64,
    orchard_spendable: u64,
    #[serde(default)]
    ironwood_spendable: u64,
    sapling_spendable: u64,
    transparent_spendable: u64,
    total: u64,
    // Any field the pinned devtool emits that we do not name explicitly (e.g. a differently-named
    // Ironwood balance in a future engine bump) lands here, so we can still find the Ironwood
    // spendable by shape instead of guessing the exact key.
    #[serde(flatten)]
    extra: BTreeMap<String, Value>,
}

/// Find an Ironwood spendable amount among fields we did not name explicitly, by shape: any key
/// containing both "ironwood" and "spendable" whose value is a number. Zero if none. This makes the
/// reader robust to the exact JSON key the Ironwood-pinned `zcash-devtool` uses.
fn ironwood_from_extra(extra: &BTreeMap<String, Value>) -> u64 {
    extra
        .iter()
        .filter(|(k, _)| {
            let k = k.to_ascii_lowercase();
            k.contains("ironwood") && k.contains("spendable")
        })
        .filter_map(|(_, v)| v.as_u64())
        .sum()
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
    // Prefer the explicitly-named field; fall back to shape-matching the extras so a renamed
    // Ironwood balance in a later engine still counts.
    let ironwood = if raw.ironwood_spendable != 0 {
        raw.ironwood_spendable
    } else {
        ironwood_from_extra(&raw.extra)
    };
    Ok(Balance {
        chain_tip_height: raw.chain_tip_height,
        orchard_spendable: z(raw.orchard_spendable, "orchard_spendable")?,
        ironwood_spendable: z(ironwood, "ironwood_spendable")?,
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
/// `Confirmed` (§8) - a fresh sync before this call makes the wallet's view current.
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

/// One transaction the wallet has recorded on-chain, for the vault's history. Public, checkable
/// data: the txid links to a block explorer; `mined_height` is `None` while still unconfirmed.
/// (Amount/direction are a follow-up once the tool's richer `list-tx` fields are captured - see
/// #125; this v1 surfaces the full on-chain record of the vault since creation.)
#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize)]
pub struct WalletTx {
    pub txid: String,
    pub mined_height: Option<u64>,
}

/// Parse `list-tx --json` into the vault's full transaction list (newest first: unconfirmed at the
/// top, then mined by descending height). Unlike `parse_confirmed_txids`, this keeps every row.
pub fn parse_transactions(json: &str) -> Result<Vec<WalletTx>, ToolError> {
    #[derive(Deserialize)]
    struct TxRow {
        txid: String,
        mined_height: Option<u64>,
    }
    let line = last_json_array_line(json)?;
    let rows: Vec<TxRow> =
        serde_json::from_str(line).map_err(|e| ToolError::parse("list-tx JSON", e.to_string()))?;
    let mut txs: Vec<WalletTx> = rows
        .into_iter()
        .map(|r| WalletTx {
            txid: r.txid,
            mined_height: r.mined_height,
        })
        .collect();
    // Newest first: unconfirmed (None) sorts above any height; mined rows by descending height.
    txs.sort_by(|a, b| match (a.mined_height, b.mined_height) {
        (None, None) => std::cmp::Ordering::Equal,
        (None, Some(_)) => std::cmp::Ordering::Less,
        (Some(_), None) => std::cmp::Ordering::Greater,
        (Some(x), Some(y)) => y.cmp(&x),
    });
    Ok(txs)
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

/// `zcash-devtool wallet -w <dir> upgrade` - bring an existing wallet database up to the schema
/// the CURRENT engine expects. Idempotent: a wallet already at the current schema is a no-op, so
/// this is safe to call on every sync.
///
/// Why it is called before every sync: a wallet file created by an older engine keeps that engine's
/// schema, and a newer `zcash_client_sqlite` fails the moment it touches a table it added. The
/// observed failure after an engine bump was
/// `DbError(SqliteFailure(..., "no such table: orchard_ironwood_migrations"))` on `sync`, which
/// takes every vault's balance and history offline until the database is migrated. Running the
/// upgrade first makes an engine bump self-healing for wallets that already exist on disk.
///
/// A failure here is deliberately NOT fatal: an older engine has no `upgrade` subcommand at all,
/// and a wallet it can already read needs no migration. Swallowing the error keeps this backward
/// compatible; a real schema problem still surfaces on the `sync` that follows.
pub fn upgrade(devtool: &Path, wallet_dir: &str) {
    let args = ["wallet", "-w", wallet_dir, "upgrade"];
    let _ = crate::tools::run(devtool, &args, None);
}

/// `zcash-devtool wallet -w <dir> sync -s <server> --connection direct` - bring the wallet's
/// view current against lightwalletd so a following `balance` / `list-tx` is up to date. The
/// stdout is progress noise (not JSON); only success/failure matters here.
///
/// Runs `upgrade` first so a wallet written by an older engine is migrated rather than failing.
pub fn sync(devtool: &Path, wallet_dir: &str, server: &str) -> Result<(), ToolError> {
    upgrade(devtool, wallet_dir);
    let s = server_args(server);
    let args = ["wallet", "-w", wallet_dir, "sync", s[0], s[1], s[2], s[3]];
    crate::tools::run(devtool, &args, None)?;
    Ok(())
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

/// `zcash-devtool wallet -w <dir> list-tx --json` → the vault's full transaction history (newest
/// first), for the on-chain record on the Add-funds screen.
pub fn list_transactions(devtool: &Path, wallet_dir: &str) -> Result<Vec<WalletTx>, ToolError> {
    let args = ["wallet", "-w", wallet_dir, "list-tx", "--json"];
    parse_transactions(&run_text(devtool, &args, None)?)
}

#[cfg(test)]
mod tests {
    use super::*;

    /// `sync` must run `wallet upgrade` FIRST, so a wallet database written by an older engine is
    /// migrated instead of failing the moment the newer `zcash_client_sqlite` touches a table it
    /// added (observed in production as `no such table: orchard_ironwood_migrations`, which took
    /// every vault's balance offline until the engine was rolled back).
    ///
    /// Drives a fake devtool that appends its subcommand to a log, then asserts the order.
    #[test]
    fn sync_upgrades_the_wallet_schema_first() {
        use std::io::Write;
        let dir = std::env::temp_dir().join(format!("konclave-upgrade-test-{}", std::process::id()));
        let _ = std::fs::create_dir_all(&dir);
        let log = dir.join("calls.log");
        let _ = std::fs::remove_file(&log);
        let fake = dir.join("fake-devtool");
        {
            let mut f = std::fs::File::create(&fake).expect("create fake devtool");
            // $4 is the subcommand: `wallet -w <dir> <subcommand> ...`
            writeln!(f, "#!/bin/sh\necho \"$4\" >> \"{}\"", log.display()).expect("write");
        }
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let mut p = std::fs::metadata(&fake).expect("stat").permissions();
            p.set_mode(0o755);
            std::fs::set_permissions(&fake, p).expect("chmod");
        }

        sync(&fake, dir.to_str().expect("utf8 dir"), "zec.rocks:443").expect("sync runs");

        let calls = std::fs::read_to_string(&log).expect("the fake devtool was invoked");
        let order: Vec<&str> = calls.lines().collect();
        assert_eq!(
            order,
            vec!["upgrade", "sync"],
            "sync must call `wallet upgrade` before `wallet sync`, got {order:?}"
        );
        let _ = std::fs::remove_dir_all(&dir);
    }

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
    fn transactions_keep_all_rows_newest_first() {
        let txs = parse_transactions(LIST_TX).unwrap();
        // All three rows kept (unlike confirmed_txids, which drops the unmined one).
        assert_eq!(txs.len(), 3);
        // Unconfirmed (mined_height None) sorts first; then mined by descending height.
        assert_eq!(txs[0].txid, "36c60f1e3f602c2a");
        assert_eq!(txs[0].mined_height, None);
        assert_eq!(txs[1].txid, "54266f478505160a"); // height 3428205
        assert_eq!(txs[2].txid, "aab00f903b65e32d"); // height 3413792
        assert_eq!(parse_transactions("[]").unwrap(), Vec::<WalletTx>::new());
    }

    #[test]
    fn parses_balance_into_typed_zatoshis() {
        let b = parse_balance(BALANCE).unwrap();
        assert_eq!(b.chain_tip_height, 3_396_338);
        assert_eq!(b.total, Zatoshis::from_u64(100_000).unwrap());
        assert_eq!(b.orchard_spendable, Zatoshis::ZERO);
        // A pre-Ironwood balance JSON has no ironwood field: it defaults to zero, not an error.
        assert_eq!(b.ironwood_spendable, Zatoshis::ZERO);
        assert_eq!(b.shielded_spendable(), Zatoshis::ZERO);
        // total is 0.001 ZEC (the funding amount), not yet spendable.
        assert_eq!(b.total.to_zec_string(), "0.00100000");
    }

    // Post-NU6.3: the deposit lands in the Ironwood pool. `total` counts it; `orchard_spendable` is
    // zero; the spendable lives under an ironwood field. The pre-Ironwood reader dropped it and
    // reported 0 spendable (the bug this test locks down).
    const BALANCE_IRONWOOD: &str = r#"{"chain_tip_height":3428300,"orchard_spendable":0,"ironwood_spendable":1213291,"sapling_spendable":0,"transparent_spendable":0,"total":1213291}"#;

    #[test]
    fn parses_ironwood_spendable_as_shielded() {
        let b = parse_balance(BALANCE_IRONWOOD).unwrap();
        assert_eq!(b.orchard_spendable, Zatoshis::ZERO);
        assert_eq!(b.ironwood_spendable, Zatoshis::from_u64(1_213_291).unwrap());
        // The number the send path / UI mean by "spendable" now includes the Ironwood pool.
        assert_eq!(
            b.shielded_spendable(),
            Zatoshis::from_u64(1_213_291).unwrap()
        );
        assert_eq!(b.total, Zatoshis::from_u64(1_213_291).unwrap());
    }

    #[test]
    fn ironwood_spendable_found_by_shape_when_key_differs() {
        // A future engine could name the field differently; we still find it by shape (contains
        // "ironwood" + "spendable"), instead of silently reporting 0.
        let j = r#"{"chain_tip_height":3428300,"orchard_spendable":0,"sapling_spendable":0,"transparent_spendable":0,"total":500000,"ironwoodPoolSpendable":500000}"#;
        let b = parse_balance(j).unwrap();
        assert_eq!(b.ironwood_spendable, Zatoshis::from_u64(500_000).unwrap());
        assert_eq!(b.shielded_spendable(), Zatoshis::from_u64(500_000).unwrap());
    }

    #[test]
    fn shielded_spendable_sums_orchard_and_ironwood() {
        // Mid-migration a vault can hold both pools; spendable is the sum.
        let j = r#"{"chain_tip_height":3428300,"orchard_spendable":300000,"ironwood_spendable":700000,"sapling_spendable":0,"transparent_spendable":0,"total":1000000}"#;
        let b = parse_balance(j).unwrap();
        assert_eq!(
            b.shielded_spendable(),
            Zatoshis::from_u64(1_000_000).unwrap()
        );
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
