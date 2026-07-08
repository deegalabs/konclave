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
#[derive(Debug)]
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

fn extract(path: &str) -> Result<()> {
    let pczt = read_pczt(path)?;
    let sighash = shielded_sighash(&pczt)?;
    println!("SIGHASH {}", hex::encode(sighash));

    let mut out: Vec<(usize, String)> = vec![];
    Signer::new(pczt)
        .sign_orchard_with(|_pczt, bundle, _| {
            for (idx, action) in bundle.actions().iter().enumerate() {
                // Only real spends need a FROST signature; dummy spends (zero value)
                // are signed by the wallet via the IO finalizer.
                let is_real =
                    matches!(action.spend().value(), Some(v) if *v != NoteValue::default());
                if is_real {
                    if let Some(alpha) = action.spend().alpha() {
                        out.push((idx, hex::encode::<&[u8]>(alpha.to_repr().as_ref())));
                    }
                }
            }
            Ok::<(), OErr>(())
        })
        .map_err(|e| anyhow!("orchard parse: {:?}", e))?;

    for (idx, alpha) in out {
        println!("RANDOMIZER {} {}", idx, alpha);
    }
    Ok(())
}

fn inject(path: &str, out_path: &str, sigs: Vec<(usize, [u8; 64])>) -> Result<()> {
    let pczt = read_pczt(path)?;
    let sighash = shielded_sighash(&pczt)?;

    let signer = Signer::new(pczt)
        .sign_orchard_with(|_pczt, bundle, _| {
            let actions = bundle.actions_mut();
            for (idx, sig) in &sigs {
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

    let signed = signer.finish();
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
