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
