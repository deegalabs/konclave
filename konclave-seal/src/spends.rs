//! Which spends of a PCZT bundle a vault signs. One rule, read by both signers: the browser
//! (`konclave-wasm`) and the native bridge (`konclave-signer`). It used to be two copies of the
//! same function, and a rule that lives twice is the repo's most repeated defect (CLAUDE.md §11).

use ff::PrimeField;

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
