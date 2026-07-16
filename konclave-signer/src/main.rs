//! Konclave FROST <-> PCZT bridge.
//!
//! Bridges the two official Zcash tools that currently don't interoperate for a
//! headless Orchard FROST spend:
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
use pczt::{roles::low_level_signer::Signer, Pczt};
use zcash_primitives::transaction::{
    sighash::SignableInput, sighash_v5::v5_signature_hash, txid::TxIdDigester, TxVersion,
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
    },
}

/// Error type for the orchard signing closure (must be `From<ParseError>`).
/// The payloads are carried for `Debug` diagnostics (surfaced on failure), not matched on.
#[derive(Debug)]
#[allow(dead_code)]
enum OErr {
    Parse(orchard::pczt::ParseError),
    Sign(orchard::pczt::SignerError),
    BadIndex(usize),
}
impl From<orchard::pczt::ParseError> for OErr {
    fn from(e: orchard::pczt::ParseError) -> Self {
        OErr::Parse(e)
    }
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

/// Compute the v5 shielded sighash from a proven PCZT.
fn shielded_sighash(pczt: &Pczt) -> Result<[u8; 32]> {
    let tx_data = pczt
        .clone()
        .into_effects()
        .map_err(|e| anyhow!("cannot build tx effects (is the PCZT proven?): {:?}", e))?;
    let txid_parts = tx_data.digest(TxIdDigester);
    if matches!(tx_data.version(), TxVersion::V5)
        && (tx_data.orchard_bundle().is_some() || tx_data.sapling_bundle().is_some())
    {
        let h = v5_signature_hash(&tx_data, &SignableInput::Shielded, &txid_parts);
        let bytes: [u8; 32] = h.as_ref().try_into().unwrap();
        Ok(bytes)
    } else {
        Err(anyhow!(
            "only v5 transactions with shielded components are supported"
        ))
    }
}

/// Return the `(action_index, alpha)` randomizers of the Orchard spends that need a FROST
/// signature. Only real spends are listed; dummy spends (zero value) are signed by the wallet
/// via the IO finalizer, and the real spend can sit at any action index (index 0 is often a
/// dummy pad, so the caller must not assume index 0).
fn extract_randomizers(pczt: &Pczt) -> Result<Vec<(usize, [u8; 32])>> {
    let mut out: Vec<(usize, [u8; 32])> = vec![];
    Signer::new(pczt.clone())
        .sign_orchard_with(|_pczt, bundle, _| {
            for (idx, action) in bundle.actions().iter().enumerate() {
                let is_real =
                    matches!(action.spend().value(), Some(v) if *v != NoteValue::default());
                if is_real {
                    if let Some(alpha) = action.spend().alpha() {
                        let repr = alpha.to_repr();
                        let slice: &[u8] = repr.as_ref();
                        let bytes: [u8; 32] =
                            slice.try_into().expect("redpallas scalar is 32 bytes");
                        out.push((idx, bytes));
                    }
                }
            }
            Ok::<(), OErr>(())
        })
        .map_err(|e| anyhow!("orchard parse: {:?}", e))?;
    Ok(out)
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

/// Apply external redpallas signatures to the given Orchard spend action indices, returning the
/// signed PCZT. Verifies each signature against the shielded sighash as it is applied (a bad
/// signature or an out-of-range index is an error, never a silently-wrong tx).
fn inject_sigs(pczt: Pczt, sigs: &[(usize, [u8; 64])]) -> Result<Pczt> {
    let sighash = shielded_sighash(&pczt)?;
    let signer = Signer::new(pczt)
        .sign_orchard_with(|_pczt, bundle, _| {
            let actions = bundle.actions_mut();
            for (idx, sig) in sigs {
                if *idx >= actions.len() {
                    return Err(OErr::BadIndex(*idx));
                }
                let signature = redpallas::Signature::<SpendAuth>::from(*sig);
                actions[*idx]
                    .apply_signature(sighash, signature)
                    .map_err(OErr::Sign)?;
            }
            Ok::<(), OErr>(())
        })
        .map_err(|e| anyhow!("signing failed: {:?}", e))?;
    Ok(signer.finish())
}

fn inject(path: &str, out_path: &str, sigs: Vec<(usize, [u8; 64])>) -> Result<()> {
    let pczt = read_pczt(path)?;
    let signed = inject_sigs(pczt, &sigs)?;
    std::fs::write(out_path, signed.serialize())?;
    println!("wrote signed PCZT to {}", out_path);
    Ok(())
}

/// Build an unproven Orchard PCZT paying N recipients in one transaction. Mirrors
/// `zcash-devtool pczt create` (which only pays one), extended to a multi-payment ZIP 321
/// request — the multi-output engine the CLI lacks (roadmap 5-B.2, §2).
fn build_payroll(wallet: &str, account_uuid: &str, spec_path: &str, out: &str) -> Result<()> {
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
                create_pczt_from_proposal, input_selection::GreedyInputSelector, propose_transfer,
                ConfirmationsPolicy,
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
        ShieldedProtocol,
    };
    use zip321::{Payment, TransactionRequest};

    #[derive(Deserialize)]
    struct SpecLine {
        address: String,
        value_zat: u64,
        #[serde(default)]
        memo: Option<String>,
    }

    let params = Network::MainNetwork;
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
        ShieldedProtocol::Orchard,
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
        None,
    )
    .map_err(|e: WalletErr<_, std::convert::Infallible, _, _, _, _>| {
        anyhow!("propose_transfer: {e:?}")
    })?;

    let pczt =
        create_pczt_from_proposal(&mut db, &params, account.id(), OvkPolicy::Sender, &proposal)
            .map_err(
                |e: WalletErr<_, _, std::convert::Infallible, _, std::convert::Infallible, _>| {
                    anyhow!("create_pczt_from_proposal: {e:?}")
                },
            )?;

    std::fs::write(out, pczt.serialize())?;
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
        } => build_payroll(&wallet, &account, &spec, &out),
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

    const DKG_PROVEN: &[u8] = include_bytes!("../tests/vectors/dkg_single_spend.proven.pczt");
    const DKG_SIGNED: &[u8] = include_bytes!("../tests/vectors/dkg_single_spend.signed.pczt");
    const DKG_SIG1: &[u8] = include_bytes!("../tests/vectors/dkg_single_spend.sig1.raw");
    const EV_PROVEN: &[u8] = include_bytes!("../tests/vectors/evidence_two_spend.proven.pczt");
    const EV_SIGNED: &[u8] = include_bytes!("../tests/vectors/evidence_two_spend.signed.pczt");
    const EV_SIG0: &[u8] = include_bytes!("../tests/vectors/evidence_two_spend.sig0.raw");
    const EV_SIG1: &[u8] = include_bytes!("../tests/vectors/evidence_two_spend.sig1.raw");

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
    fn extract_dkg_single_spend_matches_mainnet() {
        let pczt = parse(DKG_PROVEN);
        assert_eq!(
            hex::encode(shielded_sighash(&pczt).unwrap()),
            "f30f233e7736ce57368b78cd2d5cd197fc850a8217c3da1a2de3653b900fb0aa",
        );
        let r = extract_randomizers(&pczt).unwrap();
        assert_eq!(r.len(), 1, "one real spend");
        // The real Orchard spend sits at action index 1; index 0 is a dummy pad.
        assert_eq!(r[0].0, 1);
        assert_eq!(
            hex::encode(r[0].1),
            "b2ad61e8bf0de877dd01c52356526adf39b036ffed2e0217ece19407e1717624",
        );
    }

    #[test]
    fn extract_evidence_two_spend_matches_mainnet() {
        let pczt = parse(EV_PROVEN);
        assert_eq!(
            hex::encode(shielded_sighash(&pczt).unwrap()),
            "619ffa04d162b182f274c26d7402014065da13c8a0b62927028a23ddbb598e7f",
        );
        let r = extract_randomizers(&pczt).unwrap();
        assert_eq!(r.len(), 2, "two real spends");
        assert_eq!(r[0].0, 0);
        assert_eq!(
            hex::encode(r[0].1),
            "557c4ff828ed56eb33e8ba7f508a43915338ccf3ad71d1ecedc98e6e861bfc0f",
        );
        assert_eq!(r[1].0, 1);
        assert_eq!(
            hex::encode(r[1].1),
            "4c39a44dd1a50e5d41eb542f74d43847d33776396065c30a062077e209aa872d",
        );
    }

    #[test]
    fn inject_reproduces_broadcast_dkg_pczt() {
        let signed = inject_sigs(parse(DKG_PROVEN), &[(1, sig64(DKG_SIG1))]).unwrap();
        assert_eq!(
            signed.serialize().as_slice(),
            DKG_SIGNED,
            "injecting the broadcast signature must reproduce the exact signed PCZT",
        );
    }

    #[test]
    fn inject_reproduces_broadcast_evidence_pczt() {
        let signed = inject_sigs(
            parse(EV_PROVEN),
            &[(0, sig64(EV_SIG0)), (1, sig64(EV_SIG1))],
        )
        .unwrap();
        assert_eq!(signed.serialize().as_slice(), EV_SIGNED);
    }

    #[test]
    fn inject_rejects_out_of_range_index() {
        let err = inject_sigs(parse(DKG_PROVEN), &[(99, sig64(DKG_SIG1))]);
        assert!(err.is_err(), "an action index past the end must fail");
    }

    #[test]
    fn inject_rejects_wrong_signature() {
        // A validly-shaped but incorrect signature must be rejected as it is applied,
        // not silently written into a broken transaction.
        let err = inject_sigs(parse(DKG_PROVEN), &[(1, [0u8; 64])]);
        assert!(err.is_err(), "a signature that does not verify must fail");
    }
}
