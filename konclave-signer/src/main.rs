//! Konclave FROST <-> PCZT bridge.
//!
//! Bridges the two official Zcash tools that currently don't interoperate for a
//! headless Orchard (pre-NU6.3) or Ironwood (post-NU6.3) FROST spend; the pool is
//! detected from the transaction, so the same commands work across the upgrade:
//!   - `extract`: reads a proven PCZT (from zcash-devtool) and prints the shielded
//!     sighash plus the per-spend randomizer (alpha) that the FROST ceremony needs.
//!   - `inject`: applies the external redpallas signatures produced by the FROST
//!     ceremony back into the PCZT, then writes the signed PCZT (for broadcast).
//!
//! This is glue only: all crypto lives in the official libraries (orchard/pczt) and
//! the FROST math stays in frost-core. It mirrors zcash-sign's logic at the library
//! versions used by zcash-devtool, so the PCZT wire format matches.

use std::io::Read;

use anyhow::{anyhow, Result};
use clap::{Parser, Subcommand};
use ff::PrimeField;
use orchard::primitives::redpallas::{self, SpendAuth};
use orchard::value::NoteValue;
use pczt::{
    roles::low_level_signer::{OrchardParseError, Signer as LowSigner},
    roles::signer::Signer as HlSigner,
    Pczt,
};

#[derive(Parser)]
#[command(
    name = "konclave-signer",
    about = "Konclave FROST<->PCZT bridge (extract sighash+randomizer, inject FROST signatures)"
)]
struct Cli {
    #[command(subcommand)]
    cmd: Cmd,
}

#[derive(Subcommand)]
enum Cmd {
    /// Print the shielded sighash and the per-spend randomizers (alpha) for FROST.
    Extract {
        /// Path to the proven PCZT.
        pczt: String,
    },
    /// Apply external redpallas signatures to Orchard spends; write the signed PCZT.
    Inject {
        /// Path to the proven PCZT.
        pczt: String,
        /// Output path for the signed PCZT.
        out: String,
        /// One or more signatures, each as "<action_index>:<128-hex-chars>".
        #[arg(long = "sig", required = true, value_parser = parse_sig)]
        sig: Vec<(usize, [u8; 64])>,
    },
    /// Build an unproven multi-output Orchard PCZT for a payroll (N recipients, one tx).
    BuildPayroll {
        /// Wallet directory (contains data.sqlite).
        #[arg(long)]
        wallet: String,
        /// Account UUID to spend from.
        #[arg(long)]
        account: String,
        /// Payroll spec JSON path: [{"address":..,"value_zat":..,"memo":..}, ...].
        #[arg(long)]
        spec: String,
        /// Output path for the unproven PCZT.
        #[arg(long)]
        out: String,
        /// Consensus network: "main" (default) or "test". Testnet targets Ironwood/NU6.3
        /// validation once the engine is rebuilt against it; production stays mainnet.
        #[arg(long, default_value = "main")]
        network: String,
    },
}

/// Error type for the low-level signing closure used to read per-spend randomizers.
/// Must be `From<OrchardParseError>`; the payload is carried for `Debug` diagnostics.
#[derive(Debug)]
#[allow(dead_code)]
enum OErr {
    Parse(OrchardParseError),
}
impl From<OrchardParseError> for OErr {
    fn from(e: OrchardParseError) -> Self {
        OErr::Parse(e)
    }
}

/// Which shielded pool a transaction's FROST spends live in. Post-NU6.3, new funds land in the
/// Ironwood pool; pre-NU6.3 notes are Orchard. A single Konclave send spends from one pool.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Pool {
    Orchard,
    Ironwood,
}

fn parse_sig(s: &str) -> std::result::Result<(usize, [u8; 64]), String> {
    let (idx, hexsig) = s.split_once(':').ok_or("expected <index>:<hex>")?;
    let idx: usize = idx
        .parse()
        .map_err(|_| "invalid action index".to_string())?;
    let bytes = hex::decode(hexsig.trim()).map_err(|_| "invalid hex signature".to_string())?;
    let arr: [u8; 64] = bytes
        .try_into()
        .map_err(|_| "signature must be exactly 64 bytes".to_string())?;
    Ok((idx, arr))
}

fn read_pczt(path: &str) -> Result<Pczt> {
    let mut buf = vec![];
    std::fs::File::open(path)?.read_to_end(&mut buf)?;
    Pczt::parse(&buf).map_err(|e| anyhow!("failed to parse PCZT: {:?}", e))
}

/// The shielded sighash of a proven PCZT (V5 Orchard or V6 Ironwood), via the canonical signer
/// role, which handles both tx versions and verifies each signature it later applies.
fn shielded_sighash(pczt: &Pczt) -> Result<[u8; 32]> {
    let signer = HlSigner::new(pczt.clone())
        .map_err(|e| anyhow!("signer init (is the PCZT proven?): {:?}", e))?;
    Ok(signer.shielded_sighash())
}

/// Collect `(action_index, alpha)` for the REAL spends of one Orchard-shaped bundle. Dummy
/// spends (zero value) are signed by the wallet's IO finalizer and are skipped; a real spend
/// can sit at any action index (index 0 is often a dummy pad).
fn collect_real(bundle: &orchard::pczt::Bundle) -> Vec<(usize, [u8; 32])> {
    let mut out = vec![];
    for (idx, action) in bundle.actions().iter().enumerate() {
        let is_real = matches!(action.spend().value(), Some(v) if *v != NoteValue::default());
        if is_real {
            if let Some(alpha) = action.spend().alpha() {
                let repr = alpha.to_repr();
                let slice: &[u8] = repr.as_ref();
                let bytes: [u8; 32] = slice.try_into().expect("redpallas scalar is 32 bytes");
                out.push((idx, bytes));
            }
        }
    }
    out
}

/// Real Orchard-pool spends `(idx, alpha)` (empty for a pure-Ironwood tx).
fn orchard_spends(pczt: &Pczt) -> Result<Vec<(usize, [u8; 32])>> {
    let mut r = vec![];
    LowSigner::new(pczt.clone())
        .sign_orchard_with(|_pczt, bundle, _| {
            r = collect_real(bundle);
            Ok::<(), OErr>(())
        })
        .map_err(|e| anyhow!("orchard parse: {:?}", e))?;
    Ok(r)
}

/// Real Ironwood-pool spends `(idx, alpha)` (empty for a pre-NU6.3 Orchard tx).
fn ironwood_spends(pczt: &Pczt) -> Result<Vec<(usize, [u8; 32])>> {
    let mut r = vec![];
    LowSigner::new(pczt.clone())
        .sign_ironwood_with(|_pczt, bundle, _| {
            r = collect_real(bundle);
            Ok::<(), OErr>(())
        })
        .map_err(|e| anyhow!("ironwood parse: {:?}", e))?;
    Ok(r)
}

/// Which pool this transaction's FROST spends are in. A single Konclave send spends from one
/// pool; a mix (both pools with real spends) is rejected rather than risk mis-signing.
fn active_pool(pczt: &Pczt) -> Result<Pool> {
    let has_orchard = !orchard_spends(pczt)?.is_empty();
    let has_ironwood = !ironwood_spends(pczt)?.is_empty();
    match (has_orchard, has_ironwood) {
        (true, false) => Ok(Pool::Orchard),
        (false, true) => Ok(Pool::Ironwood),
        (false, false) => Err(anyhow!("no real shielded spends to sign in this PCZT")),
        (true, true) => Err(anyhow!(
            "mixed Orchard+Ironwood spends are not supported by this bridge"
        )),
    }
}

/// The `(action_index, alpha)` randomizers of the real spends the FROST ceremony must sign,
/// from whichever pool (Orchard pre-NU6.3, or Ironwood post-NU6.3) the tx spends from.
fn extract_randomizers(pczt: &Pczt) -> Result<Vec<(usize, [u8; 32])>> {
    match active_pool(pczt)? {
        Pool::Orchard => orchard_spends(pczt),
        Pool::Ironwood => ironwood_spends(pczt),
    }
}

fn extract(path: &str) -> Result<()> {
    let pczt = read_pczt(path)?;
    let sighash = shielded_sighash(&pczt)?;
    println!("SIGHASH {}", hex::encode(sighash));
    for (idx, alpha) in extract_randomizers(&pczt)? {
        println!("RANDOMIZER {} {}", idx, hex::encode(alpha));
    }
    Ok(())
}

/// Apply external redpallas signatures to the given spend action indices, returning the signed
/// PCZT. The signer role verifies each signature against the shielded sighash as it is applied
/// (a bad signature or an out-of-range index is an error, never a silently-wrong tx), and the
/// pool is resolved from the tx so an Orchard or an Ironwood send both work.
fn inject_sigs(pczt: Pczt, sigs: &[(usize, [u8; 64])]) -> Result<Pczt> {
    let pool = active_pool(&pczt)?;
    let mut signer = HlSigner::new(pczt).map_err(|e| anyhow!("signer init: {:?}", e))?;
    for (idx, sig) in sigs {
        let signature = redpallas::Signature::<SpendAuth>::from(*sig);
        let res = match pool {
            Pool::Orchard => signer.apply_orchard_signature(*idx, signature),
            Pool::Ironwood => signer.apply_ironwood_signature(*idx, signature),
        };
        res.map_err(|e| anyhow!("apply {:?} signature at index {}: {:?}", pool, idx, e))?;
    }
    Ok(signer.finish())
}

fn inject(path: &str, out_path: &str, sigs: Vec<(usize, [u8; 64])>) -> Result<()> {
    let pczt = read_pczt(path)?;
    let signed = inject_sigs(pczt, &sigs)?;
    let bytes = signed
        .serialize()
        .map_err(|e| anyhow!("serialize signed PCZT: {:?}", e))?;
    std::fs::write(out_path, bytes)?;
    println!("wrote signed PCZT to {}", out_path);
    Ok(())
}

/// Build an unproven Orchard PCZT paying N recipients in one transaction. Mirrors
/// `zcash-devtool pczt create` (which only pays one), extended to a multi-payment ZIP 321
/// request — the multi-output engine the CLI lacks (roadmap 5-B.2, §2).
fn build_payroll(
    wallet: &str,
    account_uuid: &str,
    spec_path: &str,
    out: &str,
    network: &str,
) -> Result<()> {
    use std::num::NonZeroUsize;
    use std::str::FromStr;

    use rand::rngs::OsRng;
    use serde::Deserialize;
    use uuid::Uuid;
    use zcash_address::ZcashAddress;
    use zcash_client_backend::{
        data_api::{
            error::Error as WalletErr,
            wallet::{
                create_pczt_from_proposal,
                input_selection::{GreedyInputSelector, SpendPolicy},
                propose_transfer, ConfirmationsPolicy,
            },
            Account as _, WalletRead,
        },
        fees::{
            standard::MultiOutputChangeStrategy, DustOutputPolicy, SplitPolicy, StandardFeeRule,
        },
        wallet::OvkPolicy,
    };
    use zcash_client_sqlite::{util::SystemClock, AccountUuid, WalletDb};
    use zcash_protocol::{
        consensus::Network,
        memo::{Memo, MemoBytes},
        value::Zatoshis,
        ShieldedPool,
    };
    use zip321::{Payment, TransactionRequest};

    #[derive(Deserialize)]
    struct SpecLine {
        address: String,
        value_zat: u64,
        #[serde(default)]
        memo: Option<String>,
    }

    let params = match network {
        "main" | "mainnet" => Network::MainNetwork,
        "test" | "testnet" => Network::TestNetwork,
        other => {
            return Err(anyhow!(
                "unknown network {other:?} (expected \"main\" or \"test\")"
            ))
        }
    };
    let db_path = format!("{}/data.sqlite", wallet.trim_end_matches('/'));
    let mut db = WalletDb::for_path(&db_path, params, SystemClock, OsRng)
        .map_err(|e| anyhow!("open wallet {db_path}: {e:?}"))?;

    let uuid = Uuid::from_str(account_uuid).map_err(|_| anyhow!("invalid account uuid"))?;
    let account = db
        .get_account(AccountUuid::from_uuid(uuid))
        .map_err(|e| anyhow!("get_account: {e:?}"))?
        .ok_or_else(|| anyhow!("account not found: {account_uuid}"))?;

    let lines: Vec<SpecLine> = serde_json::from_str(&std::fs::read_to_string(spec_path)?)?;
    if lines.is_empty() {
        return Err(anyhow!("payroll spec has no lines"));
    }

    let mut payments = Vec::with_capacity(lines.len());
    for (i, l) in lines.iter().enumerate() {
        let addr =
            ZcashAddress::from_str(&l.address).map_err(|_| anyhow!("line {i}: bad address"))?;
        let value = Zatoshis::from_u64(l.value_zat).map_err(|_| anyhow!("line {i}: bad value"))?;
        let memo = l
            .memo
            .as_ref()
            .map(|m| Memo::from_str(m))
            .transpose()?
            .map(MemoBytes::from);
        payments.push(
            Payment::new(addr, Some(value), memo, None, None, vec![])
                .map_err(|e| anyhow!("line {i}: {e:?}"))?,
        );
    }
    let request = TransactionRequest::new(payments).map_err(|e| anyhow!("request: {e:?}"))?;

    let change_strategy = MultiOutputChangeStrategy::new(
        StandardFeeRule::Zip317,
        None,
        ShieldedPool::Orchard,
        DustOutputPolicy::default(),
        SplitPolicy::with_min_output_value(
            NonZeroUsize::new(4).unwrap(),
            Zatoshis::from_u64(10_000_000).unwrap(),
        ),
    );
    let input_selector = GreedyInputSelector::new();

    let proposal = propose_transfer(
        &mut db,
        &params,
        account.id(),
        &input_selector,
        &change_strategy,
        request,
        ConfirmationsPolicy::default(),
        &SpendPolicy::default(),
        None,
    )
    .map_err(|e: WalletErr<_, std::convert::Infallible, _, _, _, _>| {
        anyhow!("propose_transfer: {e:?}")
    })?;

    // `None` expiry (the caller syncs before building) and the DEFAULT Orchard bundle type; the
    // pool (Orchard pre-NU6.3, Ironwood post-NU6.3) is resolved from consensus at the target height.
    let pczt = create_pczt_from_proposal(
        &mut db,
        &params,
        account.id(),
        OvkPolicy::Sender,
        &proposal,
        None,
        orchard::builder::BundleType::DEFAULT,
    )
    .map_err(
        |e: WalletErr<_, _, std::convert::Infallible, _, std::convert::Infallible, _>| {
            anyhow!("create_pczt_from_proposal: {e:?}")
        },
    )?;

    let bytes = pczt
        .serialize()
        .map_err(|e| anyhow!("serialize payroll PCZT: {:?}", e))?;
    std::fs::write(out, bytes)?;
    println!("wrote payroll PCZT ({} outputs) to {}", lines.len(), out);
    Ok(())
}

fn main() -> Result<()> {
    match Cli::parse().cmd {
        Cmd::Extract { pczt } => extract(&pczt),
        Cmd::Inject { pczt, out, sig } => inject(&pczt, &out, sig),
        Cmd::BuildPayroll {
            wallet,
            account,
            spec,
            out,
            network,
        } => build_payroll(&wallet, &account, &spec, &out, &network),
    }
}

// Destructive tests for the fund-critical FROST<->PCZT bridge, closing security-audit item C6.
// The fixtures under tests/vectors/ are REAL proven Orchard PCZTs from mainnet ceremonies (the
// DKG-vault send `aab00f90...` and the funding send `7f8e59bb...`), with the FROST signatures that
// were actually broadcast. They pin the sighash, the per-spend randomizers, and byte-for-byte
// reproduction of the signed PCZT — so a regression in extraction or injection cannot pass silently.
#[cfg(test)]
mod tests {
    use super::*;

    // A REAL Ironwood (NU6.3 / V6) FROST vector, produced by a 2-of-3 ceremony on testnet: a
    // proven PCZT with four real Ironwood spends, and a genuine aggregate signature for the spend
    // at action index 0 (the signed vector applies that one signature). This is the post-NU6.3
    // replacement for the pre-Ironwood Orchard (v1 PCZT) vectors; see
    // temp/IRONWOOD-PRODUCTIZATION-PLAN.md for how the clean cut at activation is sequenced.
    const IW_PROVEN: &[u8] = include_bytes!("../tests/vectors/ironwood_single_spend.proven.pczt");
    const IW_SIGNED: &[u8] = include_bytes!("../tests/vectors/ironwood_single_spend.signed.pczt");
    const IW_SIG0: &[u8] = include_bytes!("../tests/vectors/ironwood_single_spend.sig0.raw");

    fn parse(bytes: &[u8]) -> Pczt {
        Pczt::parse(bytes).expect("fixture is a valid PCZT")
    }
    fn sig64(bytes: &[u8]) -> [u8; 64] {
        bytes.try_into().expect("fixture signature is 64 bytes")
    }

    #[test]
    fn parse_sig_accepts_index_and_hex() {
        let (idx, sig) = parse_sig(&format!("1:{}", "ab".repeat(64))).unwrap();
        assert_eq!(idx, 1);
        assert_eq!(sig, [0xabu8; 64]);
    }

    #[test]
    fn parse_sig_rejects_malformed() {
        assert!(parse_sig("nocolon").is_err()); // missing ':'
        assert!(parse_sig("x:abcd").is_err()); // non-numeric index
        assert!(parse_sig("0:zz").is_err()); // non-hex signature
        assert!(parse_sig(&format!("0:{}", "ab".repeat(10))).is_err()); // wrong length (20 != 64 bytes)
    }

    #[test]
    fn ironwood_tx_is_detected_as_ironwood_pool() {
        assert_eq!(active_pool(&parse(IW_PROVEN)).unwrap(), Pool::Ironwood);
    }

    #[test]
    fn extract_ironwood_sighash_and_randomizers() {
        let pczt = parse(IW_PROVEN);
        assert_eq!(
            hex::encode(shielded_sighash(&pczt).unwrap()),
            "332de126200c22131337474ae50367218ec87815c23d297dcdc8278ecb8903b0",
        );
        let r = extract_randomizers(&pczt).unwrap();
        assert_eq!(r.len(), 4, "four real Ironwood spends");
        assert_eq!(r[0].0, 0);
        assert_eq!(
            hex::encode(r[0].1),
            "63267dad44b3621cd5246056295def55bd012cb053de4ba7af406e35d4ba4734",
        );
        assert_eq!(r[3].0, 3);
        assert_eq!(
            hex::encode(r[3].1),
            "cf92a74546950873969d7540a65ccaaaf849f73f62ca7ae50ccab671cb023512",
        );
    }

    #[test]
    fn inject_reproduces_signed_ironwood_pczt() {
        let signed = inject_sigs(parse(IW_PROVEN), &[(0, sig64(IW_SIG0))]).unwrap();
        assert_eq!(
            signed.serialize().unwrap().as_slice(),
            IW_SIGNED,
            "injecting the aggregate signature must reproduce the exact signed PCZT",
        );
    }

    #[test]
    fn inject_rejects_out_of_range_index() {
        let err = inject_sigs(parse(IW_PROVEN), &[(99, sig64(IW_SIG0))]);
        assert!(err.is_err(), "an action index past the end must fail");
    }

    #[test]
    fn inject_rejects_wrong_signature() {
        // A validly-shaped but incorrect signature must be rejected as it is applied,
        // not silently written into a broken transaction.
        let err = inject_sigs(parse(IW_PROVEN), &[(0, [0u8; 64])]);
        assert!(err.is_err(), "a signature that does not verify must fail");
    }
}
