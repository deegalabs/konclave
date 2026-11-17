//! Which notes a vault's build spends.
//!
//! [`Selection::Largest`] takes the fewest notes, the largest first, so a payment one note covers
//! is paid from that note; the library's own order is oldest first.
//!
//! Only the ORDER of the notes changes. Which notes are eligible (confirmations, the dust floor, the
//! scan state, locks, the excluded ones) stays the store's own query, and everything else about the
//! proposal stays the library's `propose_transfer`: the selector below hands the library's greedy
//! selector a view of the wallet that answers "which notes cover this" largest first.

use std::marker::PhantomData;

use zcash_client_backend::{
    data_api::{
        anchor_retention::PoolMigrationParams,
        wallet::{
            input_selection::{
                GreedyInputSelector, GreedyInputSelectorError, InputSelector, InputSelectorError,
                LockFilter, SpendPolicy,
            },
            ConfirmationsPolicy, TargetHeight,
        },
        AccountMeta, InputSource, NoteFilter, ReceivedNotes, TargetValue,
    },
    fees::{ChangeError, ChangeStrategy, EphemeralBalance, TransactionBalance},
    proposal::Proposal,
    wallet::{Note, ReceivedNote},
};
use zcash_primitives::transaction::TxVersion;
use zcash_protocol::{
    consensus::{self, BlockHeight},
    value::{BalanceError, Zatoshis, MAX_MONEY},
    ShieldedPool, TxId,
};
use zip321::TransactionRequest;

/// The order a build takes notes in.
#[derive(Clone, Copy, Debug, PartialEq, Eq, clap::ValueEnum)]
pub enum Selection {
    /// The fewest notes, the largest first (the default).
    Largest,
    /// The library's own: the oldest notes first.
    Oldest,
}

/// The shortest run of `notes` (each with its value), largest first (older first among equal
/// values), whose sum reaches `target`; all of them when none does, so a shortfall is still
/// reported by the library.
fn largest_covering<R, N>(
    mut keyed: Vec<(Zatoshis, ReceivedNote<R, N>)>,
    target: Zatoshis,
) -> Vec<ReceivedNote<R, N>> {
    keyed.sort_by(|(va, a), (vb, b)| {
        vb.cmp(va).then_with(|| {
            a.note_commitment_tree_position()
                .cmp(&b.note_commitment_tree_position())
        })
    });
    let mut sum = Some(Zatoshis::ZERO);
    let mut out = Vec::new();
    for (v, n) in keyed {
        if sum.is_some_and(|s| s >= target) {
            break;
        }
        // Note values and their sum are bounded by MAX_MONEY, so this cannot overflow; if it ever did,
        // the sum stays unknown and every note is taken, leaving the library to judge the total.
        sum = sum.and_then(|s| s + v);
        out.push(n);
    }
    out
}

/// A view of a wallet whose answer to "which notes cover this" is largest first. Every other
/// question goes to the wallet unchanged.
pub struct LargestFirst<'a, D>(pub &'a D);

impl<D: InputSource> InputSource for LargestFirst<'_, D> {
    type Error = D::Error;
    type AccountId = D::AccountId;
    type NoteRef = D::NoteRef;

    fn get_spendable_note(
        &self,
        txid: &TxId,
        protocol: ShieldedPool,
        index: u32,
        target_height: TargetHeight,
        lock_filter: LockFilter<'_>,
    ) -> Result<Option<ReceivedNote<Self::NoteRef, Note>>, Self::Error> {
        self.0
            .get_spendable_note(txid, protocol, index, target_height, lock_filter)
    }

    fn anchor_computable(
        &self,
        protocol: ShieldedPool,
        height: BlockHeight,
    ) -> Result<bool, Self::Error> {
        self.0.anchor_computable(protocol, height)
    }

    fn select_spendable_notes(
        &self,
        account: Self::AccountId,
        target_value: TargetValue,
        sources: &[ShieldedPool],
        target_height: TargetHeight,
        confirmations_policy: ConfirmationsPolicy,
        exclude: &[Self::NoteRef],
        lock_filter: LockFilter<'_>,
    ) -> Result<ReceivedNotes<Self::NoteRef>, Self::Error> {
        let target = match target_value {
            TargetValue::AtLeast(v) => v,
            // Spending everything has no order to choose.
            other => {
                return self.0.select_spendable_notes(
                    account,
                    other,
                    sources,
                    target_height,
                    confirmations_policy,
                    exclude,
                    lock_filter,
                )
            }
        };
        // Every eligible note, through the store's exact query for a payment (an `AtLeast` the
        // wallet can never reach returns all of them), then each pool on its own, largest first.
        // Pools are never merged: the selector keeps the first pool that covers alone.
        let all = self.0.select_spendable_notes(
            account,
            TargetValue::AtLeast(Zatoshis::const_from_u64(MAX_MONEY)),
            sources,
            target_height,
            confirmations_policy,
            exclude,
            lock_filter,
        )?;
        let sapling = all
            .sapling()
            .iter()
            .map(|n| n.note_value().map(|v| (v, n.clone())))
            .collect::<Result<Vec<_>, BalanceError>>();
        let orchard = all
            .orchard()
            .iter()
            .map(|n| n.note_value().map(|v| (v, n.clone())))
            .collect::<Result<Vec<_>, BalanceError>>();
        let ironwood = all
            .ironwood()
            .iter()
            .map(|n| n.note_value().map(|v| (v, n.clone())))
            .collect::<Result<Vec<_>, BalanceError>>();
        // A stored note whose value is out of range is not a note this build can reason about:
        // hand the question back to the store's own order rather than guess.
        let (Ok(sapling), Ok(orchard), Ok(ironwood)) = (sapling, orchard, ironwood) else {
            return self.0.select_spendable_notes(
                account,
                target_value,
                sources,
                target_height,
                confirmations_policy,
                exclude,
                lock_filter,
            );
        };
        let sapling = largest_covering(sapling, target);
        let orchard = largest_covering(orchard, target);
        let ironwood = largest_covering(ironwood, target);
        Ok(ReceivedNotes::new(sapling, orchard, ironwood))
    }

    fn select_unspent_notes(
        &self,
        account: Self::AccountId,
        sources: &[ShieldedPool],
        target_height: TargetHeight,
        exclude: &[Self::NoteRef],
        lock_filter: LockFilter<'_>,
    ) -> Result<ReceivedNotes<Self::NoteRef>, Self::Error> {
        self.0
            .select_unspent_notes(account, sources, target_height, exclude, lock_filter)
    }

    fn get_change_receivers(
        &self,
        account: Self::AccountId,
    ) -> Result<zcash_client_backend::data_api::ChangeReceivers, Self::Error> {
        self.0.get_change_receivers(account)
    }

    fn get_account_metadata(
        &self,
        account: Self::AccountId,
        selector: &NoteFilter,
        target_height: TargetHeight,
        exclude: &[Self::NoteRef],
        lock_filter: LockFilter<'_>,
    ) -> Result<AccountMeta, Self::Error> {
        self.0
            .get_account_metadata(account, selector, target_height, exclude, lock_filter)
    }

    fn get_unspent_transparent_output(
        &self,
        outpoint: &zcash_transparent::bundle::OutPoint,
        target_height: TargetHeight,
    ) -> Result<
        Option<zcash_client_backend::wallet::WalletTransparentOutput<Self::AccountId>>,
        Self::Error,
    > {
        self.0
            .get_unspent_transparent_output(outpoint, target_height)
    }

    fn get_spendable_transparent_outputs(
        &self,
        address: &zcash_transparent::address::TransparentAddress,
        target_height: TargetHeight,
        confirmations_policy: ConfirmationsPolicy,
        output_filter: zcash_client_backend::data_api::CoinbaseFilter,
        lock_filter: LockFilter<'_>,
    ) -> Result<
        Vec<zcash_client_backend::wallet::WalletTransparentOutput<Self::AccountId>>,
        Self::Error,
    > {
        self.0.get_spendable_transparent_outputs(
            address,
            target_height,
            confirmations_policy,
            output_filter,
            lock_filter,
        )
    }

    fn get_spendable_transparent_outputs_for_addresses(
        &self,
        addresses: &[zcash_transparent::address::TransparentAddress],
        target_height: TargetHeight,
        confirmations_policy: ConfirmationsPolicy,
        output_filter: zcash_client_backend::data_api::CoinbaseFilter,
        lock_filter: LockFilter<'_>,
    ) -> Result<
        Vec<zcash_client_backend::wallet::WalletTransparentOutput<Self::AccountId>>,
        Self::Error,
    > {
        self.0.get_spendable_transparent_outputs_for_addresses(
            addresses,
            target_height,
            confirmations_policy,
            output_filter,
            lock_filter,
        )
    }

    #[allow(clippy::too_many_arguments)]
    fn select_spendable_transparent_outputs(
        &self,
        account: Self::AccountId,
        target_height: TargetHeight,
        confirmations_policy: ConfirmationsPolicy,
        output_filter: zcash_client_backend::data_api::CoinbaseFilter,
        address_allow_list: Option<&[zcash_transparent::address::TransparentAddress]>,
        target_value: TargetValue,
        max_inputs: usize,
        fee_rule: &zcash_client_backend::fees::StandardFeeRule,
        lock_filter: LockFilter<'_>,
    ) -> Result<
        Vec<zcash_client_backend::wallet::WalletTransparentOutput<Self::AccountId>>,
        Self::Error,
    > {
        self.0.select_spendable_transparent_outputs(
            account,
            target_height,
            confirmations_policy,
            output_filter,
            address_allow_list,
            target_value,
            max_inputs,
            fee_rule,
            lock_filter,
        )
    }
}

/// The vault's change strategy, read through the [`LargestFirst`] view: every call goes to the
/// strategy unchanged, with the wallet behind the view as its source.
struct ThroughView<'c, 'a, C, D>(&'c C, PhantomData<&'a D>);

impl<'a, C, D> ChangeStrategy for ThroughView<'_, 'a, C, D>
where
    D: InputSource,
    C: ChangeStrategy<MetaSource = D>,
{
    type FeeRule = C::FeeRule;
    type Error = C::Error;
    type MetaSource = LargestFirst<'a, D>;
    type AccountMetaT = C::AccountMetaT;

    fn fee_rule(&self) -> &Self::FeeRule {
        self.0.fee_rule()
    }

    fn fetch_wallet_meta(
        &self,
        meta_source: &Self::MetaSource,
        account: D::AccountId,
        target_height: TargetHeight,
        exclude: &[D::NoteRef],
    ) -> Result<Self::AccountMetaT, D::Error> {
        self.0
            .fetch_wallet_meta(meta_source.0, account, target_height, exclude)
    }

    fn compute_balance<P: consensus::Parameters, NoteRefT: Clone>(
        &self,
        params: &P,
        target_height: TargetHeight,
        anchor_height: BlockHeight,
        zip318: &PoolMigrationParams,
        transparent_inputs: &[impl zcash_primitives::transaction::fees::transparent::InputView],
        transparent_outputs: &[impl zcash_primitives::transaction::fees::transparent::OutputView],
        sapling: &impl zcash_client_backend::fees::sapling::BundleView<NoteRefT>,
        orchard: &impl zcash_client_backend::fees::orchard::BundleView<NoteRefT>,
        ironwood: &impl zcash_client_backend::fees::orchard::BundleView<NoteRefT>,
        ephemeral_balance: Option<EphemeralBalance>,
        wallet_meta: &Self::AccountMetaT,
    ) -> Result<TransactionBalance, ChangeError<Self::Error, NoteRefT>> {
        self.0.compute_balance(
            params,
            target_height,
            anchor_height,
            zip318,
            transparent_inputs,
            transparent_outputs,
            sapling,
            orchard,
            ironwood,
            ephemeral_balance,
            wallet_meta,
        )
    }
}

/// The library's greedy selector over the [`LargestFirst`] view of the wallet. `propose_transfer`
/// takes it like any selector, so the proposal keeps everything else the library does.
pub struct LargestFirstSelector<D>(PhantomData<D>);

impl<D> LargestFirstSelector<D> {
    pub fn new() -> Self {
        Self(PhantomData)
    }
}

impl<D: InputSource> InputSelector for LargestFirstSelector<D> {
    type Error = GreedyInputSelectorError;
    type InputSource = D;

    #[allow(clippy::type_complexity)]
    fn propose_transaction<ParamsT, ChangeT>(
        &self,
        params: &ParamsT,
        wallet_db: &D,
        target_height: TargetHeight,
        anchor_height: BlockHeight,
        zip318: &PoolMigrationParams,
        confirmations_policy: ConfirmationsPolicy,
        account: D::AccountId,
        transaction_request: TransactionRequest,
        change_strategy: &ChangeT,
        spend_policy: &SpendPolicy,
        proposed_version: Option<TxVersion>,
    ) -> Result<
        Proposal<ChangeT::FeeRule, D::NoteRef>,
        InputSelectorError<D::Error, Self::Error, ChangeT::Error, D::NoteRef>,
    >
    where
        ParamsT: consensus::Parameters,
        ChangeT: ChangeStrategy<MetaSource = D>,
    {
        let view = LargestFirst(wallet_db);
        GreedyInputSelector::<LargestFirst<'_, D>>::new().propose_transaction(
            params,
            &view,
            target_height,
            anchor_height,
            zip318,
            confirmations_policy,
            account,
            transaction_request,
            &ThroughView(change_strategy, PhantomData),
            spend_policy,
            proposed_version,
        )
    }
}
