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
