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

mod selection;
use selection::Selection;

use anyhow::{anyhow, Result};
use clap::{Parser, Subcommand};
use konclave_seal::spends::spends_to_sign;
use orchard::primitives::redpallas::{self, SpendAuth};
use pczt::{
    roles::low_level_signer::{OrchardParseError, Signer as LowSigner},
    roles::signer::Signer as HlSigner,
    Pczt,
};
use zcash_primitives::transaction::fees::zip317 as prim_zip317;

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
        /// The vault has permitted the ZIP 2009 fee (every seat reports it reads that rate and the
        /// operator's switch is open). Without it the build pays the legacy 5,000 per action.
        #[arg(long)]
        zip2009_permitted: bool,
        /// The height from which that permission holds (the highest `fee_from` the seats reported).
        /// Without it the permission is not used, so a rolled-back caller is read as legacy.
        #[arg(long)]
        zip2009_from: Option<u32>,
        /// Which notes the build takes first: the fewest, largest first (default), or the oldest
        /// (the library's own order, kept for comparison in tests; the coordinator never asks for it).
        #[arg(long, value_enum, default_value_t = Selection::Largest)]
        selection: Selection,
        /// Pay any change to ONE output instead of splitting it into up to four (the coordinator
        /// asks for it only when the split would take the transaction past what the vault can sign).
        #[arg(long)]
        single_change: bool,
    },
    /// Print the exit status `inject` uses for a refused signature, as
    /// `{"signature_rejected": <n>}`. A build that predates the status has no such command, which is
    /// how the coordinator knows not to read its exits that way.
    InjectStatuses,
}

/// The confirmations a vault's build asks of its notes (#870), set here by name so a library update
/// cannot change them unnoticed: 3 for the wallet's own change and the anchor depth, 10 for notes
/// received from others. These are ZIP 315's counts. Since NU7, blocks come every 25 seconds, so the
/// same counts are about a third of the time they were; they stay ZIP 315's because the library
/// warns that a policy of one's own can make a wallet's transactions distinguishable, and ZIP 218
/// does not argue for reducing them. Revisit when ZIP 315 is updated for NU7.
const TRUSTED_CONFIRMATIONS: u32 = 3;
const UNTRUSTED_CONFIRMATIONS: u32 = 10;

fn vault_confirmations() -> zcash_client_backend::data_api::wallet::ConfirmationsPolicy {
    use std::num::NonZeroU32;
    zcash_client_backend::data_api::wallet::ConfirmationsPolicy::new(
        NonZeroU32::new(TRUSTED_CONFIRMATIONS).expect("a count above zero"),
        NonZeroU32::new(UNTRUSTED_CONFIRMATIONS).expect("a count above zero"),
        // As ZIP 315's default; a vault has no transparent funds to shield.
        true,
    )
    .expect("the trusted count is not above the untrusted one")
}

/// The ZIP 317 fee rule at a marginal fee: the one place a rule is constructed. Grace actions and the
/// P2PKH sizes are ZIP 317's own (the vault has no transparent part), only the marginal moves.
fn build_fee_rule(marginal: u64) -> Result<prim_zip317::FeeRule> {
    prim_zip317::FeeRule::non_standard(
        zcash_protocol::value::Zatoshis::from_u64(marginal)
            .map_err(|_| anyhow!("marginal fee out of range"))?,
        konclave_seal::epochs::GRACE_ACTIONS as usize,
        prim_zip317::P2PKH_STANDARD_INPUT_SIZE,
        prim_zip317::P2PKH_STANDARD_OUTPUT_SIZE,
    )
    .ok_or_else(|| anyhow!("fee rule"))
}

/// The marginal fee a build pays, decided ONCE from the facts, before the fee rule exists. The
/// permission is used only on mainnet (the table is mainnet's; a testnet build stays legacy), only
/// with a height to hold it from, and only when the wallet's target has reached that height; then
/// `konclave_seal::epochs::fee_rule_for` says what the era at the target pays. Over facts alone, so
/// every branch is testable without a wallet.
fn marginal_for_build(mainnet: bool, target: u32, permitted: bool, from: Option<u32>) -> u64 {
    // The predicate is konclave-seal's, the one the coordinator's guard asks too.
    konclave_seal::epochs::fee_rule_for(
        target,
        konclave_seal::epochs::zip2009_in_force(mainnet, target, permitted, from),
    )
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

// Which spends of a bundle this vault signs is `konclave_seal::spends::spends_to_sign`, the one
// rule konclave-wasm reads too: the spends still awaiting a signature, and a refusal for any spend
// that still carries `dummy_sk`.

/// Real Orchard-pool spends `(idx, alpha)` (empty for a pure-Ironwood tx).
fn orchard_spends(pczt: &Pczt) -> Result<Vec<(usize, [u8; 32])>> {
    let mut r = Ok(vec![]);
    LowSigner::new(pczt.clone())
        .sign_orchard_with(|_pczt, bundle, _| {
            r = spends_to_sign(bundle);
            Ok::<(), OErr>(())
        })
        .map_err(|e| anyhow!("orchard parse: {:?}", e))?;
    r.map_err(|e| anyhow!(e))
}

/// Real Ironwood-pool spends `(idx, alpha)` (empty for a pre-NU6.3 Orchard tx).
fn ironwood_spends(pczt: &Pczt) -> Result<Vec<(usize, [u8; 32])>> {
    let mut r = Ok(vec![]);
    LowSigner::new(pczt.clone())
        .sign_ironwood_with(|_pczt, bundle, _| {
            r = spends_to_sign(bundle);
            Ok::<(), OErr>(())
        })
        .map_err(|e| anyhow!("ironwood parse: {:?}", e))?;
    r.map_err(|e| anyhow!(e))
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
        res.map_err(|e| {
            anyhow::Error::new(SignatureRejected(format!(
                "apply {:?} signature at index {}: {:?}",
                pool, idx, e
            )))
        })?;
    }
    Ok(signer.finish())
}

// The exit status of `inject` when a signature was checked and refused; every other failure (the
// PCZT could not be read, the output could not be written) exits 1, so the caller can tell "this
// answer is wrong" from "the check did not run" without reading the error text.
use konclave_seal::spends::INJECT_EXIT_SIGNATURE_REJECTED as EXIT_SIGNATURE_REJECTED;

/// A signature that was checked against the transaction and refused.
#[derive(Debug)]
struct SignatureRejected(String);

impl std::fmt::Display for SignatureRejected {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(&self.0)
    }
}

impl std::error::Error for SignatureRejected {}

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

/// Build an unproven Orchard PCZT paying N recipients in one transaction: the one builder, for a
/// payroll and for a single payment (a payroll of one line). It mirrors what `zcash-devtool pczt
/// create` did (which only pays one) and extends it to a multi-payment ZIP 321 request.
#[allow(clippy::too_many_arguments)]
fn build_payroll(
    wallet: &str,
    account_uuid: &str,
    spec_path: &str,
    out: &str,
    network: &str,
    zip2009_permitted: bool,
    zip2009_from: Option<u32>,
    selection: Selection,
    single_change: bool,
) -> Result<()> {
    use std::str::FromStr;

    use rand10::{rand_core::UnwrapErr, rngs::SysRng};
    use serde::Deserialize;
    use uuid::Uuid;
    use zcash_address::ZcashAddress;
    use zcash_client_backend::data_api::{Account as _, WalletRead};
    use zcash_client_sqlite::{util::SystemClock, AccountUuid, WalletDb};
    use zcash_protocol::{
        consensus::Network,
        memo::{Memo, MemoBytes},
        value::Zatoshis,
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
    let mut db = WalletDb::for_path(&db_path, params, SystemClock, UnwrapErr(SysRng))
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

    // The wallet's own target height is read BEFORE the rule is built (F5): the marginal fee is also
    // the dust and split threshold of the change strategy, so a rule that looked at the height
    // inside `fee_required` would disagree with its own threshold. The wallet's tip only rises, so
    // the height the proposal uses is never below this one; at the switch the build pays the
    // lower-height (legacy) fee, which a device accepts and the network relays.
    let confirmations = vault_confirmations();
    let (target, _anchor) = db
        .get_target_and_anchor_heights(confirmations.trusted())
        .map_err(|e| anyhow!("target height: {e:?}"))?
        .ok_or_else(|| anyhow!("the wallet has no block data: sync it first"))?;
    let marginal = marginal_for_build(
        matches!(params, Network::MainNetwork),
        u32::from(target),
        zip2009_permitted,
        zip2009_from,
    );
    let pczt = propose_and_build(
        &mut db,
        &params,
        account.id(),
        request,
        marginal,
        selection,
        single_change,
    )?;

    let bytes = pczt
        .serialize()
        .map_err(|e| anyhow!("serialize payroll PCZT: {:?}", e))?;
    std::fs::write(out, bytes)?;
    println!("wrote payroll PCZT ({} outputs) to {}", lines.len(), out);
    Ok(())
}

/// The proposal and the unproven PCZT a vault's build makes from a wallet, a request and a marginal
/// fee: the input selector, the spend policy, the confirmations and the change strategy live HERE
/// and nowhere else, so a test that drives this function drives what the coordinator builds.
fn propose_and_build<C, P, CL, R>(
    db: &mut zcash_client_sqlite::WalletDb<C, P, CL, R>,
    params: &P,
    account_id: zcash_client_sqlite::AccountUuid,
    request: zip321::TransactionRequest,
    marginal: u64,
    selection: Selection,
    single_change: bool,
) -> Result<Pczt>
where
    P: zcash_protocol::consensus::Parameters + Clone,
    zcash_client_sqlite::WalletDb<C, P, CL, R>:
        zcash_client_backend::data_api::WalletRead<
                Error = zcash_client_sqlite::error::SqliteClientError,
                AccountId = zcash_client_sqlite::AccountUuid,
            > + zcash_client_backend::data_api::WalletWrite
            + zcash_client_backend::data_api::InputSource<
                Error = zcash_client_sqlite::error::SqliteClientError,
                AccountId = zcash_client_sqlite::AccountUuid,
                NoteRef = zcash_client_sqlite::ReceivedNoteId,
            > + zcash_client_backend::data_api::WalletCommitmentTrees,
{
    use std::num::NonZeroUsize;

    use rand10::{rand_core::UnwrapErr, rngs::SysRng};
    use zcash_client_backend::{
        data_api::{
            error::Error as WalletErr,
            wallet::{
                create_pczt_from_proposal,
                input_selection::{GreedyInputSelector, SpendPolicy},
                propose_transfer,
            },
        },
        fees::{zip317::MultiOutputChangeStrategy, DustOutputPolicy, SplitPolicy},
        wallet::OvkPolicy,
    };
    use zcash_client_sqlite::util::SystemClock;
    use zcash_protocol::{value::Zatoshis, ShieldedPool};

    let confirmations = vault_confirmations();
    let fee_rule = build_fee_rule(marginal)?;
    let change_strategy = MultiOutputChangeStrategy::new(
        fee_rule,
        None,
        ShieldedPool::Orchard,
        DustOutputPolicy::default(),
        // The vault keeps up to four notes of at least 0.1 ZEC (parallel spends) unless the
        // coordinator asks for one change output, which it does only when that split would take the
        // transaction past what the vault can sign.
        if single_change {
            SplitPolicy::single_output()
        } else {
            SplitPolicy::with_min_output_value(
                NonZeroUsize::new(4).unwrap(),
                Zatoshis::from_u64(10_000_000).unwrap(),
            )
        },
    );
    // The same call for both orders: only the selector differs (selection.rs).
    macro_rules! propose {
        ($selector:expr) => {
            propose_transfer(
                db,
                params,
                account_id,
                &$selector,
                &change_strategy,
                request,
                confirmations,
                &SpendPolicy::default(),
                None,
                // proposed_version: None -> build at the version implied by the target height (V6
                // from NU6.3/Ironwood onward), so the pool is resolved from consensus, not here.
                None,
            )
            .map_err(|e: WalletErr<_, std::convert::Infallible, _, _, _, _>| {
                anyhow!("propose_transfer: {e:?}")
            })?
        };
    }
    let proposal = match selection {
        Selection::Largest => propose!(selection::LargestFirstSelector::new()),
        Selection::Oldest => propose!(GreedyInputSelector::new()),
    };

    // `None` expiry (the caller syncs before building) and the DEFAULT Orchard-pool padding; the
    // pool (Orchard pre-NU6.3, Ironwood post-NU6.3) is resolved from consensus at the target height.
    // The final arg changed from an orchard `BundleType` to `BundlePadding` in the Ironwood line
    // (backend 0.24); DEFAULT preserves the previous behavior.
    create_pczt_from_proposal(
        db,
        params,
        &SystemClock,
        &mut UnwrapErr(SysRng),
        account_id,
        OvkPolicy::Sender,
        &proposal,
        None,
        zcash_primitives::transaction::builder::BundlePadding::DEFAULT,
    )
    .map_err(
        |e: WalletErr<_, _, std::convert::Infallible, _, std::convert::Infallible, _>| {
            anyhow!("create_pczt_from_proposal: {e:?}")
        },
    )
}

fn main() -> Result<()> {
    match Cli::parse().cmd {
        Cmd::Extract { pczt } => extract(&pczt),
        Cmd::InjectStatuses => {
            println!("{{\"signature_rejected\":{EXIT_SIGNATURE_REJECTED}}}");
            Ok(())
        }
        Cmd::Inject { pczt, out, sig } => match inject(&pczt, &out, sig) {
            Err(e) if e.downcast_ref::<SignatureRejected>().is_some() => {
                eprintln!("Error: {e:#}");
                std::process::exit(EXIT_SIGNATURE_REJECTED);
            }
            other => other,
        },
        Cmd::BuildPayroll {
            wallet,
            account,
            spec,
            out,
            network,
            zip2009_permitted,
            zip2009_from,
            selection,
            single_change,
        } => build_payroll(
            &wallet,
            &account,
            &spec,
            &out,
            &network,
            zip2009_permitted,
            zip2009_from,
            selection,
            single_change,
        ),
    }
}

// Destructive tests for the fund-critical FROST<->PCZT bridge, closing security-audit item C6.
// The fixtures under tests/vectors/ are REAL proven Orchard PCZTs from mainnet ceremonies (the
// DKG-vault send `aab00f90...` and the funding send `7f8e59bb...`), with the FROST signatures that
// were actually broadcast. They pin the sighash, the per-spend randomizers, and byte-for-byte
// reproduction of the signed PCZT - so a regression in extraction or injection cannot pass silently.
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

    /// #870: the vault's build asks ZIP 315's confirmation counts by name, and the library's default
    /// is still those same counts: a library update that moves either fails here instead of moving
    /// the vault's anchor depth unnoticed.
    #[test]
    fn the_vault_asks_zip_315s_confirmations_and_the_library_default_has_not_moved() {
        use zcash_client_backend::data_api::wallet::ConfirmationsPolicy;
        let ours = vault_confirmations();
        assert_eq!(ours.trusted().get(), 3, "the wallet's own change");
        assert_eq!(ours.untrusted().get(), 10, "notes received from others");
        assert_eq!(
            ours,
            ConfirmationsPolicy::default(),
            "zcash_client_backend's default moved: decide whether the vault follows (#870)"
        );
        // The build reads the named policy, not the library's default.
        let src = include_str!("main.rs");
        let body = &src[src.find("fn build_payroll(").unwrap()..src.find("#[cfg(test)]").unwrap()];
        assert!(body.contains("vault_confirmations()"));
        assert!(!body.contains(concat!("ConfirmationsPolicy::", "default()")));
        // The app says the same counts (ui/src/api.ts, the "waiting for confirmations" line): one
        // rule, so the screen cannot keep a number the build no longer asks.
        let ui = include_str!("../../ui/src/api.ts");
        assert!(ui.contains(&format!(
            "CONFIRMATIONS_TRUSTED = {TRUSTED_CONFIRMATIONS}\n"
        )));
        assert!(ui.contains(&format!(
            "CONFIRMATIONS_UNTRUSTED = {UNTRUSTED_CONFIRMATIONS}\n"
        )));
    }

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

    /// The proven Ironwood fixture with its consensus branch rewritten to NU7's (0x77190AD9). The branch id
    /// sits once in the PCZT's global section, as a postcard varint (5 bytes for either id), so the
    /// patch changes no length. The proofs and the signatures do not depend on it; the sighash does.
    fn as_nu7(bytes: &[u8]) -> Vec<u8> {
        let (nu6_3, nu7) = (
            [0xdb, 0xac, 0x94, 0xbd, 0x03],
            [0xd9, 0x95, 0xe4, 0xb8, 0x07],
        );
        let at: Vec<usize> = bytes
            .windows(5)
            .enumerate()
            .filter(|(_, w)| *w == nu6_3)
            .map(|(i, _)| i)
            .collect();
        assert_eq!(
            at.len(),
            1,
            "the NU6.3 branch id occurs once in the fixture"
        );
        [&bytes[..at[0]], &nu7[..], &bytes[at[0] + 5..]].concat()
    }

    #[test]
    fn an_nu7_pczt_has_the_sighash_the_stable_crate_computes_and_it_commits_to_the_branch() {
        let nu6_3 = shielded_sighash(&parse(IW_PROVEN)).unwrap();
        let nu7 = shielded_sighash(&parse(&as_nu7(IW_PROVEN))).unwrap();
        assert_ne!(nu6_3, nu7, "the branch id is hashed into the sighash");
        // The ORACLE for the device's own recompute: konclave-wasm's test of the same name holds this
        // literal too, so the two implementations meet on one value.
        assert_eq!(
            hex::encode(nu7),
            "9b869f2332ef5a0d8e987612e9bdbe67275a6fdc1d742b77b929d4bbb0a0601d"
        );
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

    /// The caller tells "this answer is wrong" from "the check did not run" by the exit status, so a
    /// refused signature or index must carry the marker that selects it, and a PCZT that cannot be
    /// read must not.
    #[test]
    fn a_refused_signature_is_told_apart_from_a_check_that_did_not_run() {
        for sigs in [vec![(0, [0u8; 64])], vec![(99, sig64(IW_SIG0))]] {
            let err = inject_sigs(parse(IW_PROVEN), &sigs).unwrap_err();
            assert!(err.downcast_ref::<SignatureRejected>().is_some(), "{err:#}");
        }
        let unread = inject("/nonexistent/konclave.pczt", "/nonexistent/out", vec![]).unwrap_err();
        assert!(unread.downcast_ref::<SignatureRejected>().is_none());
    }

    // A wallet-controlled ZERO-VALUE spend that still awaits a signature. Derived from
    // `ironwood_single_spend.proven.pczt` by setting action 1's spend value to 0, so it differs
    // from the real vector in exactly the one field under test and nothing else.
    //
    // This shape is not synthetic in the wild: post-NU6.3 the builder pairs a requested spend or
    // output with a fabricated zero-valued counterpart under the cross-address restriction, and
    // that counterpart is WALLET-CONTROLLED - ours to sign, not a protocol padding dummy. The
    // padding dummy is the one carrying `dummy_sk`, and the IO Finalizer signs and clears it, so
    // it arrives here with `spend_auth_sig == Some`. This one arrives with `None`.
    //
    // librustzcash states the rule (`zcash_client_backend/src/data_api/wallet.rs`): an action
    // needs a signature "if and only if its spend requires one: this covers both the requested
    // real spends and the wallet-controlled zero-value spends [...] Protocol padding dummies are
    // pre-signed and cleared by the IO Finalizer, so they are excluded by this check."
    const IW_ZERO_VALUE: &[u8] =
        include_bytes!("../tests/vectors/ironwood_zero_value_spend.proven.pczt");

    #[test]
    fn a_zero_value_spend_awaiting_a_signature_is_collected() {
        // The regression this guards: selecting by `value != 0` skips this spend, nobody signs it,
        // and the failure surfaces far away as `MissingSpendAuthSig` at extract (#86). Selecting by
        // "does it still need a signature" is what upstream `zcash-sign` switched to for Ironwood
        // (frost-tools #592).
        let r = extract_randomizers(&parse(IW_ZERO_VALUE)).unwrap();
        let indices: Vec<usize> = r.iter().map(|(i, _)| *i).collect();
        assert_eq!(
            indices,
            vec![0, 1, 2, 3],
            "every unsigned spend must be collected, including the zero-value one at index 1",
        );
    }

    #[test]
    fn an_already_signed_spend_is_not_collected() {
        // The other half: the discriminator must not become "collect everything". A spend the IO
        // Finalizer (or an earlier signer) already authorized carries a signature and is skipped -
        // which is what keeps a protocol padding dummy out of the ceremony.
        let signed = inject_sigs(parse(IW_PROVEN), &[(0, sig64(IW_SIG0))]).unwrap();
        let r = extract_randomizers(&signed).unwrap();
        let indices: Vec<usize> = r.iter().map(|(i, _)| *i).collect();
        assert_eq!(
            indices,
            vec![1, 2, 3],
            "action 0 now carries a signature and must not be collected again",
        );
    }

    // `ironwood_single_spend.proven.pczt` with `dummy_sk` set on action 1 and nothing else
    // changed (the bytes after action 1's `alpha` read `zip32_derivation: None, dummy_sk: None`;
    // the second became `Some(sk)`). Action 1 is a spend the vault signs; the key left on it is
    // what a padding dummy carries before the IO Finalizer signs and clears it.
    // konclave-wasm carries the identical file.
    const IW_DUMMY_SK: &[u8] =
        include_bytes!("../tests/vectors/ironwood_dummy_sk_spend.proven.pczt");

    #[test]
    fn a_spend_still_carrying_dummy_sk_is_refused() {
        // "Signers MUST reject PCZTs that contain `dummy_sk` values" (pczt, orchard). It awaits a
        // signature like a real spend, so the predicate alone collected it.
        let err = extract_randomizers(&parse(IW_DUMMY_SK))
            .unwrap_err()
            .to_string();
        assert!(err.contains("dummy_sk"), "{err}");
    }

    // `ironwood_single_spend.signed.pczt` with `dummy_sk` set on action 0, the action that
    // already carries its signature, and nothing else changed. konclave-wasm carries the
    // identical file.
    const IW_DUMMY_SK_SIGNED: &[u8] =
        include_bytes!("../tests/vectors/ironwood_dummy_sk_signed.pczt");

    #[test]
    fn a_signed_spend_still_carrying_dummy_sk_is_refused_too() {
        // The specification refuses the PCZT, not the spend: a key left on an action that is
        // already signed is refused as well, though that action would not join the ceremony.
        let err = extract_randomizers(&parse(IW_DUMMY_SK_SIGNED))
            .unwrap_err()
            .to_string();
        assert!(err.contains("dummy_sk"), "{err}");
    }

    /// The REAL NU7 vector (testnet, 2026-10-26, a throwaway wallet's own 0.1 TAZ self-payment: public
    /// data only), built and proven by the patched `zcash-devtool` while the testnet was past NU7. The
    /// signer reads it with the branch id of NU7, and the device's hand-written ZIP 244 recompute and the
    /// `pczt` crate's agree on its sighash. What this does NOT prove: that a node accepts a transaction
    /// signed over this digest (needs a signed broadcast on testnet; the devtool's own `pczt sign` does
    /// not sign Ironwood spends, so there was no independent signature to verify here). The pinned hex
    /// is what both produced on the day, to catch a drift in either.
    #[test]
    fn a_real_nu7_pczt_reads_the_same_in_the_signer_and_on_the_device() {
        const PROVEN: &[u8] = include_bytes!("../tests/vectors/nu7_testnet.proven.pczt");
        let proven = parse(PROVEN);
        assert_eq!(*proven.global().consensus_branch_id(), 0x7719_0ad9);
        assert_eq!(
            extract_randomizers(&proven).unwrap().len(),
            1,
            "one real spend"
        );
        let sighash = shielded_sighash(&proven).unwrap();
        assert_eq!(
            sighash,
            konclave_wasm::pczt_bridge::shielded_sighash(&proven).unwrap(),
            "the signer and the device disagree on a real NU7 transaction"
        );
        assert_eq!(
            hex::encode(sighash),
            "e7002fa86ed26a033d10bbcb25dc19fd3daf0dd64c5b4028ac9af83092bd8392"
        );
    }

    // F2 part 1 for the builder. The oracle is written here: literal heights and `5_000 * max(2, n)` /
    // `1_000 * max(2, n)`; nothing is read from the table or from the function under test.
    #[test]
    fn the_rule_a_build_gets_charges_the_literal_fee_at_each_side_of_the_switch() {
        use zcash_primitives::transaction::fees::FeeRule as _;
        use zcash_protocol::consensus::Network::MainNetwork as Main;
        for n in 1..=8usize {
            for (target, permitted, from, per_action) in [
                (3_589_999u32, true, Some(3_590_000u32), 5_000u64),
                (3_590_000, true, Some(3_590_000), 1_000),
                (3_590_000, false, Some(3_590_000), 5_000),
                (3_590_000, true, None, 5_000),
                (3_599_999, true, Some(3_600_000), 5_000),
                (3_600_000, true, Some(3_600_000), 1_000),
            ] {
                let rule =
                    build_fee_rule(marginal_for_build(true, target, permitted, from)).unwrap();
                let fee = rule
                    .fee_required(&Main, target.into(), [], [], 0, 0, n, 0)
                    .unwrap();
                assert_eq!(
                    u64::from(fee),
                    per_action * (n.max(2) as u64),
                    "n={n} target={target} permitted={permitted} from={from:?}"
                );
            }
        }
    }

    // M1: the dispatch in `main` hands the flags to `build_payroll` as they were parsed, and not a
    // constant: the flag a member's vault was permitted by must reach the decision, and the note
    // order the coordinator asked for must reach the build.
    #[test]
    fn main_hands_the_parsed_flags_to_the_build() {
        let src = include_str!("main.rs");
        let body = &src[src.find("fn main() -> Result<()>").unwrap()
            ..src.find("// Destructive tests").unwrap()];
        let flat: String = body.split_whitespace().collect();
        assert!(
            flat.contains("zip2009_permitted,zip2009_from,selection,single_change,}=>build_payroll(&wallet,&account,&spec,&out,&network,zip2009_permitted,zip2009_from,selection,single_change,)"),
            "{flat}"
        );
    }

    #[test]
    fn a_testnet_build_never_uses_the_permission() {
        assert_eq!(marginal_for_build(false, 3_600_000, true, Some(0)), 5_000);
    }

    #[test]
    fn the_permission_arrives_on_the_command_line_and_defaults_to_legacy() {
        let base = [
            "konclave-signer",
            "build-payroll",
            "--wallet",
            "w",
            "--account",
            "a",
            "--spec",
            "s",
            "--out",
            "o",
        ];
        let get = |extra: &[&str]| match Cli::try_parse_from(base.iter().chain(extra)).unwrap().cmd
        {
            Cmd::BuildPayroll {
                zip2009_permitted,
                zip2009_from,
                network,
                ..
            } => (zip2009_permitted, zip2009_from, network),
            _ => unreachable!(),
        };
        assert_eq!(get(&[]), (false, None, "main".into()));
        assert_eq!(
            get(&["--zip2009-permitted", "--zip2009-from", "3590000"]),
            (true, Some(3_590_000), "main".into())
        );
        assert!(Cli::try_parse_from(base.iter().chain(&["--zip2009-from", "x"])).is_err());
    }

    #[test]
    fn build_payroll_hands_the_permission_to_the_decision_and_nothing_else_decides() {
        // Source scan: the wallet's marginal comes from `marginal_for_build` over the two flags, and
        // the rule from `build_fee_rule`; no other path to a marginal exists in this file.
        let src = include_str!("main.rs");
        let body = &src[src.find("fn build_payroll(").unwrap()..src.find("fn main()").unwrap()];
        let flat: String = body.split_whitespace().collect();
        assert!(flat.contains("marginal_for_build(matches!(params,Network::MainNetwork),u32::from(target),zip2009_permitted,zip2009_from,)"));
        assert!(flat.contains("build_fee_rule(marginal)"));
    }
}

// Which notes a build spends: the fewest, the largest first, whatever smaller notes the vault
// received earlier. Driven through `propose_and_build`, the builder the coordinator runs, against the
// library's own wallet test harness (a real sqlite wallet, fake compact blocks, Ironwood active). The
// cap itself is the coordinator's (`build_within_cap` and its tests in orchestrator/src/send.rs).
#[cfg(test)]
mod note_order {
    use super::*;
    use zcash_client_backend::data_api::testing::{
        orchard::OrchardPoolTester, pool::ShieldedPoolTester, AddressType, FakeCompactOutput,
        IronwoodFvk, TestBuilder,
    };
    use zcash_client_backend::data_api::Account as _;
    use zcash_client_sqlite::testing::{db::TestDbFactory, BlockCache};
    use zcash_primitives::block::BlockHash;
    use zcash_protocol::{consensus::BlockHeight, local_consensus::LocalNetwork, value::Zatoshis};

    /// The sealed cap for 1 to 31 devices as `orchestrator/src/net_send.rs` pins it today; a
    /// secondary check only (the rule under test is the spend count).
    const SEALED_CAP: usize = 6;
    /// What `funding_check` builds at: always the legacy marginal fee (F3, `orchestrator/src/send.rs`).
    const PROBE_MARGINAL: u64 = 5_000;
    /// A small payment a vault receives (0.0001 ZEC).
    const SMALL_NOTE: u64 = 10_000;
    const ZEC: u64 = 100_000_000;

    fn network(nu7: bool) -> LocalNetwork {
        let at = BlockHeight::from_u32(100_000);
        LocalNetwork {
            nu6: Some(at),
            nu6_1: Some(at),
            nu6_2: Some(at),
            nu6_3: Some(at),
            nu7: nu7.then_some(at),
            ..TestBuilder::<(), ()>::DEFAULT_NETWORK
        }
    }

    /// One block of the vault's history: notes of these values, Ironwood unless `orchard`, to the
    /// external address unless `change`.
    #[derive(Clone)]
    struct Block {
        values: Vec<u64>,
        orchard: bool,
        change: bool,
    }

    fn small_notes(n: usize) -> Block {
        Block {
            values: vec![SMALL_NOTE; n],
            orchard: false,
            change: false,
        }
    }

    fn notes(values: &[u64]) -> Block {
        Block {
            values: values.to_vec(),
            orchard: false,
            change: false,
        }
    }

    struct Wallet {
        blocks: Vec<Block>,
        /// Empty blocks after the last one (10 makes every note spendable).
        confirmations: u32,
        /// Blocks appended after the confirmations (not yet spendable).
        recent: Vec<Block>,
        nu7: bool,
    }

    impl Wallet {
        fn of(blocks: Vec<Block>) -> Self {
            Wallet {
                blocks,
                confirmations: UNTRUSTED_CONFIRMATIONS,
                recent: vec![],
                nu7: false,
            }
        }
    }

    /// Builds a payment of `lines` x `pay` from the wallet in the given order.
    fn build(w: &Wallet, lines: usize, pay: u64, selection: Selection) -> Result<Pczt, String> {
        build_with(w, lines, pay, selection, false)
    }

    fn build_with(
        w: &Wallet,
        lines: usize,
        pay: u64,
        selection: Selection,
        single_change: bool,
    ) -> Result<Pczt, String> {
        let mut st = TestBuilder::new()
            .with_network(network(w.nu7))
            .with_data_store_factory(TestDbFactory::default())
            .with_block_cache(BlockCache::new())
            .with_account_from_sapling_activation(BlockHash([0; 32]))
            .build();
        let ofvk = st.test_account_orchard().unwrap().clone();
        let ifvk = IronwoodFvk(ofvk.clone());
        let account_id = st.test_account().unwrap().id();
        let mut heights: Vec<BlockHeight> = vec![];
        macro_rules! add {
            ($b:expr) => {{
                let b: &Block = $b;
                let scope = if b.change {
                    AddressType::Internal
                } else {
                    AddressType::DefaultExternal
                };
                let h = if b.orchard {
                    let outs: Vec<_> = b
                        .values
                        .iter()
                        .map(|v| {
                            FakeCompactOutput::new(
                                ofvk.clone(),
                                scope,
                                Zatoshis::const_from_u64(*v),
                            )
                        })
                        .collect();
                    st.generate_next_block_multi(&outs).0
                } else {
                    let outs: Vec<_> = b
                        .values
                        .iter()
                        .map(|v| {
                            FakeCompactOutput::new(
                                ifvk.clone(),
                                scope,
                                Zatoshis::const_from_u64(*v),
                            )
                        })
                        .collect();
                    st.generate_next_block_multi(&outs).0
                };
                heights.push(h);
            }};
        }
        for b in &w.blocks {
            add!(b);
        }
        for _ in 0..w.confirmations {
            heights.push(st.generate_empty_block().0);
        }
        for b in &w.recent {
            add!(b);
        }
        let (first, count) = (heights[0], heights.len());
        st.scan_cached_blocks(first, count);

        let to = OrchardPoolTester::sk_default_address(&OrchardPoolTester::sk(&[0xf5; 32]));
        let payments = (0..lines)
            .map(|_| {
                zip321::Payment::new(
                    to.to_zcash_address(st.network()),
                    Some(Zatoshis::from_u64(pay).unwrap()),
                    None,
                    None,
                    None,
                    vec![],
                )
                .unwrap()
            })
            .collect();
        let request = zip321::TransactionRequest::new(payments).unwrap();
        let params = network(w.nu7);
        propose_and_build(
            st.wallet_mut().db_mut(),
            &params,
            account_id,
            request,
            PROBE_MARGINAL,
            selection,
            single_change,
        )
        .map_err(|e| e.to_string())
    }

    /// The values of the notes a PCZT really spends (padding spends carry zero), both pools, read
    /// through the same low-level signer role the bridge uses.
    fn spent(p: &Pczt) -> Vec<u64> {
        let mut v = vec![];
        let mut take = |bundle: &orchard::pczt::Bundle| {
            for a in bundle.actions() {
                if let Some(x) = a.spend().value() {
                    if x.inner() > 0 {
                        v.push(x.inner());
                    }
                }
            }
        };
        LowSigner::new(p.clone())
            .sign_orchard_with(|_, b, _| {
                take(b);
                Ok::<(), OErr>(())
            })
            .unwrap()
            .sign_ironwood_with(|_, b, _| {
                take(b);
                Ok::<(), OErr>(())
            })
            .unwrap();
        v.sort_unstable();
        v
    }

    fn actions(p: &Pczt) -> usize {
        konclave_seal::spends::action_count(p)
    }

    /// The control: with no small notes, a 0.01 ZEC payment from a 1 ZEC note fits the cap.
    #[test]
    fn control_a_lone_large_note_pays_within_the_cap() {
        let p = build(
            &Wallet::of(vec![notes(&[ZEC])]),
            1,
            ZEC / 100,
            Selection::Largest,
        )
        .unwrap();
        assert_eq!(spent(&p), vec![ZEC]);
        assert!(actions(&p) <= SEALED_CAP);
    }

    /// The control: small notes NEWER than the large note are not reached.
    #[test]
    fn control_small_notes_after_the_large_note_are_not_selected() {
        let w = Wallet::of(vec![notes(&[ZEC]), small_notes(10)]);
        let p = build(&w, 1, ZEC / 100, Selection::Largest).unwrap();
        assert_eq!(spent(&p), vec![ZEC]);
    }

    /// With seven notes of 0.0001 ZEC older than the vault's 1 ZEC note,
    /// a 0.01 ZEC payment that note covers alone is paid from that note.
    #[test]
    fn a_payment_one_note_covers_is_paid_from_that_note() {
        let w = Wallet::of(vec![small_notes(7), notes(&[ZEC])]);
        let p = build(&w, 1, ZEC / 100, Selection::Largest).unwrap();
        assert_eq!(spent(&p), vec![ZEC], "no small note is spent");
        assert!(actions(&p) <= SEALED_CAP, "{} actions", actions(&p));
    }

    /// The timing-free form: after any payment the vault's funds are a change
    /// note newer than every small note already received.
    #[test]
    fn a_payment_change_covers_is_paid_from_the_change() {
        let change = Block {
            values: vec![ZEC],
            orchard: false,
            change: true,
        };
        let p = build(
            &Wallet::of(vec![small_notes(7), change]),
            1,
            ZEC / 100,
            Selection::Largest,
        )
        .unwrap();
        assert_eq!(spent(&p), vec![ZEC]);
    }

    /// The same once NU7 is active (its fee and block rules are not the selection's).
    #[test]
    fn a_payment_one_note_covers_is_paid_from_that_note_under_nu7() {
        let mut w = Wallet::of(vec![small_notes(7), notes(&[ZEC])]);
        w.nu7 = true;
        let p = build(&w, 1, ZEC / 100, Selection::Largest).unwrap();
        assert_eq!(spent(&p), vec![ZEC]);
    }

    /// No single note covers: the fewest notes, the largest first, and still no small note.
    #[test]
    fn with_no_single_covering_note_the_largest_notes_pay_and_no_small_note() {
        let w = Wallet::of(vec![
            small_notes(7),
            notes(&[40_000_000, 40_000_000, 40_000_000]),
        ]);
        let p = build(&w, 1, ZEC, Selection::Largest).unwrap();
        assert_eq!(spent(&p), vec![40_000_000; 3]);
    }

    /// The order changes nothing about eligibility: a large note still under the confirmations a
    /// note from outside needs is not taken.
    #[test]
    fn an_unconfirmed_large_note_is_not_taken() {
        let mut w = Wallet::of(vec![small_notes(7), notes(&[5_000_000])]);
        w.recent = vec![notes(&[ZEC])];
        let p = build(&w, 1, ZEC / 100, Selection::Largest).unwrap();
        assert_eq!(spent(&p), vec![5_000_000]);
    }

    /// A shortfall is still the library's, with its numbers, in both orders (the coordinator parses
    /// it into `Funding::Short`).
    #[test]
    fn a_shortfall_is_still_reported_by_the_library_in_both_orders() {
        let w = Wallet::of(vec![small_notes(3), notes(&[ZEC])]);
        for sel in [Selection::Largest, Selection::Oldest] {
            let e = build(&w, 1, 2 * ZEC, sel).unwrap_err();
            assert!(e.contains("InsufficientFunds"), "{sel:?}: {e}");
        }
    }

    /// A vault whose funds are an Orchard note: small notes received now land in Ironwood (no receive into Orchard
    /// after NU6.3) and are not taken.
    #[test]
    fn a_vault_on_an_orchard_note_is_not_reached() {
        let large = Block {
            values: vec![ZEC],
            orchard: true,
            change: false,
        };
        let p = build(
            &Wallet::of(vec![small_notes(7), large]),
            1,
            ZEC / 100,
            Selection::Largest,
        )
        .unwrap();
        assert_eq!(spent(&p), vec![ZEC]);
    }

    /// A payroll whose split change would take it over: two older 0.3 ZEC notes and a newer 2 ZEC
    /// note, five lines of 0.1 ZEC. The fewest notes is the 2 ZEC note, and its change split in
    /// several outputs makes 7 actions; the coordinator's second build pays the change to one output
    /// (`build_within_cap`), which lands at 6, as the old order did.
    #[test]
    fn the_five_line_payroll_lands_at_six_actions_with_one_change_output() {
        let w = Wallet::of(vec![notes(&[30_000_000, 30_000_000]), notes(&[2 * ZEC])]);
        let split = build(&w, 5, ZEC / 10, Selection::Largest).unwrap();
        let single = build_with(&w, 5, ZEC / 10, Selection::Largest, true).unwrap();
        assert!(
            actions(&split) > 6,
            "the split build is the case: {}",
            actions(&split)
        );
        assert_eq!(actions(&single), 6);
        assert_eq!(
            spent(&single),
            spent(&split),
            "the same notes, only the change differs"
        );
    }

    /// The same payroll in a vault that also holds older small notes: the second build spends the
    /// 2 ZEC note alone and lands at 6.
    #[test]
    fn the_five_line_payroll_with_older_small_notes_lands_at_six_actions() {
        let w = Wallet::of(vec![
            small_notes(6),
            notes(&[30_000_000, 30_000_000]),
            notes(&[2 * ZEC]),
        ]);
        let single = build_with(&w, 5, ZEC / 10, Selection::Largest, true).unwrap();
        assert_eq!(actions(&single), 6);
        assert_eq!(spent(&single), vec![2 * ZEC]);
    }

    /// The order arrives on the command line: largest first unless the coordinator names the
    /// oldest, and nothing else is accepted.
    #[test]
    fn the_note_order_defaults_to_largest_first_and_parses_oldest() {
        let base = [
            "konclave-signer",
            "build-payroll",
            "--wallet",
            "w",
            "--account",
            "a",
            "--spec",
            "s",
            "--out",
            "o",
        ];
        let get = |extra: &[&str]| match Cli::try_parse_from(base.iter().chain(extra)).unwrap().cmd
        {
            Cmd::BuildPayroll { selection, .. } => selection,
            _ => unreachable!(),
        };
        assert_eq!(get(&[]), Selection::Largest);
        assert_eq!(get(&["--selection", "oldest"]), Selection::Oldest);
        assert_eq!(get(&["--selection", "largest"]), Selection::Largest);
        assert!(Cli::try_parse_from(base.iter().chain(&["--selection", "newest"])).is_err());
        let single =
            |extra: &[&str]| match Cli::try_parse_from(base.iter().chain(extra)).unwrap().cmd {
                Cmd::BuildPayroll { single_change, .. } => single_change,
                _ => unreachable!(),
            };
        assert!(
            !single(&[]),
            "the change is split unless the coordinator asks"
        );
        assert!(single(&["--single-change"]));
    }
}
