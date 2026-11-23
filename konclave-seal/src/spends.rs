//! Which spends of a PCZT bundle a vault signs. One rule, read by both signers: the browser
//! (`konclave-wasm`) and the native bridge (`konclave-signer`). It used to be two copies of the
//! same function, and a rule that lives twice is the repo's most repeated defect (CLAUDE.md §11).

use ff::PrimeField;

/// The exit status of `konclave-signer inject` when it checked a signature and refused it. Every
/// other failure exits 1. The signer exits with it and the coordinator reads it, so it lives here,
/// once, where both are compiled from.
pub const INJECT_EXIT_SIGNATURE_REJECTED: i32 = 3;

/// Every spend `(action_index, alpha)` in one Orchard-shaped bundle (Orchard or Ironwood) that
/// still AWAITS a signature, or a refusal if any spend still carries a dummy spending key.
///
/// The test is `spend_auth_sig().is_none()`, NOT "is this a non-zero (real) spend", and the
/// difference is load-bearing post-NU6.3. Selecting by value was inherited from `zcash-sign` at
/// `36df5d2` (frost-tools #574); the Foundation replaced it with this predicate in `0cfaa75`
/// (#592), because post-NU6.3 the builder pairs a spend or output with a fabricated zero-valued
/// counterpart that is WALLET-CONTROLLED and ours to sign. Filtering by value skipped it, nobody
/// signed it, and the failure surfaced far away as `MissingSpendAuthSig` (#86). Anything an
/// earlier signer authorized carries a signature and is skipped, which keeps a signed action out
/// of a second ceremony. A real spend can sit at any action index.
///
/// A protocol padding dummy is excluded because the IO Finalizer signs it with its `dummy_sk` and
/// clears the key. One that still carries `dummy_sk` was never finalized: it awaits a signature
/// like a real spend, so the predicate alone would take it as ours, add it to the ceremony and to
/// the action count the fee is read from, and the send would fail at injection. The pczt and
/// orchard crates both say "Signers MUST reject PCZTs that contain `dummy_sk` values", so the
/// whole bundle is refused, before anything is collected.
pub fn spends_to_sign(bundle: &orchard::pczt::Bundle) -> Result<Vec<(usize, [u8; 32])>, String> {
    if let Some(idx) = bundle
        .actions()
        .iter()
        .position(|a| a.spend().dummy_sk().is_some())
    {
        return Err(format!(
            "[dummy] action {idx} still carries a dummy spending key (`dummy_sk`): the transaction was not finalized, and a signer must refuse it"
        ));
    }
    let mut out = vec![];
    for (idx, action) in bundle.actions().iter().enumerate() {
        if action.spend().spend_auth_sig().is_none() {
            if let Some(alpha) = action.spend().alpha() {
                let repr = alpha.to_repr();
                let slice: &[u8] = repr.as_ref();
                let bytes: [u8; 32] = slice.try_into().expect("redpallas scalar is 32 bytes");
                out.push((idx, bytes));
            }
        }
    }
    Ok(out)
}

/// The spends this vault signs (`spends_to_sign`), each checked against the vault's own key
/// before a device takes part. Refuses the WHOLE bundle (a transaction with one bad spend cannot
/// be sent, so a partial answer would only hand out signatures for nothing) if any of them has a
/// zero randomizer or shares one with another spend (`[alpha]`), or if its `rk` is not the vault's
/// key under its own randomizer (`[rk]`). `vault_ak` is the vault's group verifying key; one that
/// is not a usable key refuses too (`[vaultkey]`, which is about the device's own record, not the
/// transaction).
///
/// This is a consistency check, not a proof of how a randomizer was chosen. It deliberately does
/// not use orchard's `Spend::verify_rk`: for a zero-value spend that takes the key from the PCZT's
/// own `fvk` field, which is the value being checked.
pub fn spends_to_sign_for(
    bundle: &orchard::pczt::Bundle,
    vault_ak: &[u8; 32],
) -> Result<Vec<(usize, [u8; 32])>, String> {
    let spends = spends_to_sign(bundle)?;
    let ak = orchard::keys::SpendValidatingKey::from_bytes(vault_ak)
        .ok_or("[vaultkey] the vault's key is not a usable verifying key")?;
    let mut seen: Vec<(usize, [u8; 32])> = vec![];
    for (idx, bytes) in &spends {
        let spend = bundle.actions()[*idx].spend();
        let alpha = spend.alpha().as_ref().expect("a selected spend has one");
        if *bytes == [0u8; 32] {
            return Err(format!("[alpha] action {idx} has no usable randomizer"));
        }
        if let Some((first, _)) = seen.iter().find(|(_, b)| b == bytes) {
            return Err(format!(
                "[alpha] actions {first} and {idx} share a randomizer"
            ));
        }
        seen.push((*idx, *bytes));
        if <[u8; 32]>::from(spend.rk()) != <[u8; 32]>::from(&ak.randomize(alpha)) {
            return Err(format!(
                "[rk] action {idx}: its key is not this vault's key under its randomizer"
            ));
        }
    }
    Ok(spends)
}

/// What the fee of one Orchard-shaped bundle is read from: how many actions it carries (padding
/// included) and what it takes out of its pool, which the sighash covers.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct BundleFee {
    pub actions: usize,
    /// Positive when the bundle takes value out of its pool (the fee, when nothing else moves value).
    pub value_balance: i64,
}

/// The ONE reader of a PCZT's fee facts (B3b): the device reads them to judge the fee it is asked to
/// sign, and the coordinator reads them to check its own build before it asks anyone. It used to be a
/// count in each place (`action_count_of`, the device's bundle shape), and a fee rule whose two halves
/// count differently is the repo's most repeated defect. Reads the PCZT's own fields, so it works on
/// an unproven transaction too.
pub fn bundle_fee(pczt: &::pczt::Pczt, ironwood: bool) -> Result<BundleFee, String> {
    let (magnitude, negative) = if ironwood {
        *pczt.ironwood().value_sum()
    } else {
        *pczt.orchard().value_sum()
    };
    let actions = actions_in(pczt, ironwood);
    let pool = if ironwood { "ironwood" } else { "orchard" };
    let magnitude = i64::try_from(magnitude)
        .map_err(|_| format!("[fee] the {pool} bundle's value balance is out of range"))?;
    Ok(BundleFee {
        actions,
        value_balance: if negative { -magnitude } else { magnitude },
    })
}

/// The actions of one bundle, padding included: THE count, which the fee reads and the signing
/// request's size is bounded by.
fn actions_in(pczt: &::pczt::Pczt, ironwood: bool) -> usize {
    if ironwood {
        pczt.ironwood().actions().len()
    } else {
        pczt.orchard().actions().len()
    }
}

/// The logical actions of a PCZT across both pools, for a caller that sizes a request and does not
/// judge the balance. The same count `fee_and_actions` returns.
pub fn action_count(pczt: &::pczt::Pczt) -> usize {
    actions_in(pczt, false) + actions_in(pczt, true)
}

/// The fee a PCZT pays and the logical actions it carries, across BOTH shielded pools (a transaction
/// can carry an Orchard and an Ironwood bundle). The fee is the sum of the bundles' value balances,
/// which is the whole fee only when nothing else moves value (a vault transaction has no transparent
/// or Sapling part). A negative total is not a fee and is refused.
pub fn fee_and_actions(pczt: &::pczt::Pczt) -> Result<(u64, u64), String> {
    let (o, i) = (bundle_fee(pczt, false)?, bundle_fee(pczt, true)?);
    let fee = o
        .value_balance
        .checked_add(i.value_balance)
        .ok_or("[fee] the transaction's value balance is out of range")?;
    let fee = u64::try_from(fee).map_err(|_| {
        format!(
            "[fee] the transaction adds {} zatoshis to the shielded pools instead of paying a fee",
            fee.unsigned_abs()
        )
    })?;
    Ok((fee, (o.actions + i.actions) as u64))
}

/// What the action bound reads of one action of a bundle.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct ActionShape {
    /// The value of the spend when it awaits a signature (`spends_to_sign`; the caller has checked
    /// that such a spend is the vault's, see `bundle_shape`) and its value
    /// was bound to the action's nullifier under the vault's own viewing key (`verify_nullifier`).
    /// `None` for a spend that carries no signature slot for this vault, and on a reading that signs
    /// nothing (`SpendKey::NotChecked`), which checks no value.
    pub awaiting_value: Option<u64>,
    /// The value of the output, which the note commitment binds. `0` for padding.
    pub output_value: u64,
    /// Whether the output pays one of the vault's own receivers.
    pub to_vault: bool,
}

/// What the action bound reads of one bundle: the cross-address flag it is built under and one
/// `ActionShape` per action, padding included.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct BundleShape {
    /// Whether an action's spend and output may differ in address (Orchard in a v5 transaction,
    /// and Ironwood). Orchard in a v6 transaction does not allow it, so there a spend and an output
    /// never share an action (orchard `BundleType::num_actions`).
    pub cross_address: bool,
    pub actions: Vec<ActionShape>,
    /// False only for a reading that checks no spends (`SpendKey::NotChecked`): the count is not
    /// known, and `check_action_bound` leaves the whole transaction alone.
    pub bound_applies: bool,
}

impl BundleShape {
    /// Actions in the bundle, padding included.
    pub fn len(&self) -> usize {
        self.actions.len()
    }

    pub fn is_empty(&self) -> bool {
        self.actions.is_empty()
    }
}

/// What a reading has to check an awaiting spend's value with.
#[derive(Debug, Clone, Copy)]
pub enum SpendKey<'a> {
    /// The vault's own viewing key (`receivers::vault_fvk`): the reading a device signs on.
    Vault(&'a orchard::keys::FullViewingKey),
    /// The device holds none. An awaiting spend is refused (`[viewingkey]`) whatever value it
    /// declares, zero included: the device signs nothing it cannot verify.
    Absent,
    /// A reading that signs nothing (a preview, the SDK's) and checks no spend. Its spends count as
    /// nothing and the action bound is not applied to it (`BundleShape::bound_applies`).
    NotChecked,
}

impl<'a> From<Option<&'a orchard::keys::FullViewingKey>> for SpendKey<'a> {
    fn from(fvk: Option<&'a orchard::keys::FullViewingKey>) -> Self {
        fvk.map_or(SpendKey::Absent, SpendKey::Vault)
    }
}

/// Read what the action bound needs of one bundle. Call it after the bundle's outputs have been
/// checked against their note commitments: an output value is only as good as that check, and the
/// spend value is checked here against the action's nullifier.
///
/// It also relies on the caller having checked every awaiting spend against the vault's own key
/// (`spends_to_sign_for`): "awaits a signature" is read here as "is this vault's spend". The
/// device does that check (`parseAlphas`) before it reads the payment, and a test pins the order;
/// a second caller must do the same, or call it through a reading that does.
///
/// `receivers` are the vault's own raw receivers; `None` for a device that has none (it then never
/// concedes the zero-value change `check_action_bound` allows).
///
/// `key` is the vault's Orchard full viewing key, from `receivers::vault_fvk` (so its `ak` is the
/// vault's group key). A spend that awaits this vault's signature and carries a value is counted
/// only if `verify_nullifier` passes with it: the spend's recipient, value, `rho` and `rseed` give
/// the nullifier the action carries, which the sighash covers. A mismatch refuses the bundle
/// (`[commitment]`); a key that is not the vault's can only cause that refusal. With no key
/// (`SpendKey::Absent`) an awaiting spend is refused (`[viewingkey]`), whatever value it declares.
/// With the key, a spend with no value is refused (`[commitment]`): it cannot be checked. A reading
/// that signs nothing (`SpendKey::NotChecked`) checks no awaiting spend, with a value or without,
/// and the bound is not applied to it. A
/// bundle whose flags disagree with its pool and transaction version, or an Ironwood bundle with
/// cross-address transfers off, is refused (`[shape]`): no builder of ours makes one, and the wider
/// count they would get is the wrong answer for it.
pub fn bundle_shape(
    bundle: &orchard::pczt::Bundle,
    ironwood: bool,
    tx_version: u32,
    receivers: Option<&[[u8; 43]]>,
    key: SpendKey<'_>,
) -> Result<BundleShape, String> {
    let pool = if ironwood { "ironwood" } else { "orchard" };
    // `spends_to_sign` refuses a bundle that was never finalized (`[dummy]`) and says which spends
    // await this vault: the one predicate the ceremony signs by.
    let awaiting: Vec<usize> = spends_to_sign(bundle)?
        .into_iter()
        .map(|(i, _)| i)
        .collect();
    let cross_address = ironwood || tx_version == 5;
    // A bundle with no actions has nothing to count, and its flags are whatever the creator left.
    if !bundle.actions().is_empty() && bundle.flags().cross_address_enabled() != cross_address {
        return Err(format!(
            "[shape] the {pool} bundle's flags do not allow what a version {tx_version} transaction carries there"
        ));
    }
    let mut actions = Vec::with_capacity(bundle.actions().len());
    let mut bound_applies = true;
    for (i, action) in bundle.actions().iter().enumerate() {
        let awaiting_value = if awaiting.contains(&i) {
            match action.spend().value() {
                // A spend with no value cannot be checked against its nullifier. Counting it as
                // nothing would sign a spend the device never verified, so a reading that signs
                // refuses it; only a reading that signs nothing lets it count as nothing.
                None => match key {
                    SpendKey::Vault(_) => {
                        return Err(format!(
                            "[commitment] {pool} action {i} awaits a signature and carries no value to check against its nullifier"
                        ))
                    }
                    SpendKey::Absent => {
                        return Err(format!(
                            "[viewingkey] this device has no viewing key for the vault to check {pool} action {i}'s spend with"
                        ))
                    }
                    // A reading that signs nothing checks no spend, so it leaves the count alone.
                    SpendKey::NotChecked => {
                        bound_applies = false;
                        None
                    }
                },
                Some(v) => match key {
                    SpendKey::Vault(fvk) => {
                        action.spend().verify_nullifier(Some(fvk)).map_err(|e| {
                            format!(
                                "[commitment] {pool} action {i} does not match its nullifier: {e:?}"
                            )
                        })?;
                        Some(v.inner())
                    }
                    // With no key a declared zero is a claim like any other: the device cannot
                    // check it against the nullifier, so it signs nothing.
                    SpendKey::Absent => {
                        return Err(format!(
                            "[viewingkey] this device has no viewing key for the vault to check {pool} action {i}'s spend with"
                        ))
                    }
                    // A reading that signs nothing checks no value, a zero included, so it
                    // leaves the count alone.
                    SpendKey::NotChecked => {
                        bound_applies = false;
                        None
                    }
                },
            }
        } else {
            None
        };
        let output = action.output();
        actions.push(ActionShape {
            awaiting_value,
            output_value: output.value().map_or(0, |v| v.inner()),
            to_vault: match (output.recipient(), receivers) {
                (Some(a), Some(rs)) => rs.contains(&a.to_raw_address_bytes()),
                _ => false,
            },
        });
    }
    Ok(BundleShape {
        cross_address,
        actions,
        bound_applies,
    })
}

/// The ONE rule for how many actions a payment may carry: each bundle may hold the actions its
/// payments and change need, and no more than that. `marginal` is the marginal fee the transaction
/// pays (`epochs::marginal_paid`), so the exact fee is judged first.
///
/// ZIP 317 charges per action, so an action that moves nothing costs the vault its marginal fee.
/// What the device counts is what moves value:
/// - a spend counts when it awaits this vault's signature, its value was checked, and the value is
///   greater than the marginal fee (a note that does not pay for its own action is not a note the
///   wallet picks);
/// - an output counts when it carries value;
/// - when no output carrying value pays the vault anywhere in the transaction, one zero-value output
///   to the vault counts as well: the wallet makes one on purpose when its inputs close exactly.
///
/// With cross-address transfers allowed a spend and an output share an action, so a bundle needs
/// `max(spends, outputs)` actions. Without (Orchard in v6) they never do, so it needs one action
/// for each action that holds a counted spend or a counted output. A bundle needs no action when
/// nothing in it counts, and otherwise at least ZIP 317's two (`GRACE_ACTIONS`).
///
/// The count is per bundle, and for what a builder makes it is exactly the number of actions the
/// upstream builder gives that many spends and outputs (`orchard::builder::BundleType::num_actions`;
/// konclave-seal's tests read the two against each other), so an honest transaction is never over
/// it and one action more is.
///
/// What it does not bound: the valued outputs and spends themselves. Splitting change into more
/// valued outputs, or spending more of the vault's notes, raises what counts, and the fee with it.
pub fn check_action_bound(bundles: &[BundleShape], marginal: u64) -> Result<(), String> {
    use crate::epochs::GRACE_ACTIONS;
    // A reading that checked no spends has no count to bound (`SpendKey::NotChecked`).
    if bundles.iter().any(|b| !b.bound_applies) {
        return Ok(());
    }
    let counted_spend = |a: &ActionShape| a.awaiting_value.is_some_and(|v| v > marginal);
    let valued_to_vault = bundles
        .iter()
        .flat_map(|b| &b.actions)
        .any(|a| a.output_value > 0 && a.to_vault);
    // The one zero-value output to the vault that counts: the first, in the sighash's order. Where a
    // spend and an output never share an action, the output the builder pairs with each real spend
    // pays the spent note's own address, and it is part of that spend's action already: only one in
    // an action of its own can be the change.
    let zero_change = if valued_to_vault {
        None
    } else {
        bundles.iter().enumerate().find_map(|(bi, b)| {
            b.actions
                .iter()
                .position(|a| {
                    a.output_value == 0 && a.to_vault && (b.cross_address || !counted_spend(a))
                })
                .map(|ai| (bi, ai))
        })
    };
    for (bi, b) in bundles.iter().enumerate() {
        let counted_output =
            |ai: usize, a: &ActionShape| a.output_value > 0 || zero_change == Some((bi, ai));
        let needed = if b.cross_address {
            let spends = b.actions.iter().filter(|a| counted_spend(a)).count();
            let outputs = b
                .actions
                .iter()
                .enumerate()
                .filter(|(ai, a)| counted_output(*ai, a))
                .count();
            spends.max(outputs)
        } else {
            b.actions
                .iter()
                .enumerate()
                .filter(|(ai, a)| counted_spend(a) || counted_output(*ai, a))
                .count()
        };
        let allowed = if needed == 0 {
            0
        } else {
            needed.max(GRACE_ACTIONS as usize)
        };
        if b.len() > allowed {
            return Err(format!(
                "[fee] the transaction carries {} actions in one bundle where {allowed} are enough",
                b.len()
            ));
        }
    }
    Ok(())
}
