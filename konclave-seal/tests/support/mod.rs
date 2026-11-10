//! Test-only helpers: read the spends of a real PCZT, rewrite its `rk` for a chosen key, and run
//! the vault check on it. The key a test passes is ALWAYS a literal or a seeded test key, never
//! one read back out of the PCZT under test (that would pass by construction).
#![allow(dead_code)]

use orchard::keys::{FullViewingKey, SpendValidatingKey, SpendingKey};
use pczt::{
    roles::low_level_signer::{OrchardParseError, Signer},
    Pczt,
};

#[derive(Clone, Copy)]
pub enum Pool {
    Orchard,
    Ironwood,
}

/// Run `f` on the one bundle of `pool`.
pub fn with_bundle<T>(bytes: &[u8], pool: Pool, f: impl FnOnce(&orchard::pczt::Bundle) -> T) -> T {
    let mut out = None;
    let run =
        |_: &Pczt, b: &mut orchard::pczt::Bundle, _: &mut u8| -> Result<(), OrchardParseError> {
            out = Some(f(b));
            Ok(())
        };
    let signer = Signer::new(Pczt::parse(bytes).expect("vector parses"));
    match pool {
        Pool::Orchard => signer.sign_orchard_with(run).map(|_| ()),
        Pool::Ironwood => signer.sign_ironwood_with(run).map(|_| ()),
    }
    .expect("bundle reads");
    out.expect("closure ran")
}

/// A deterministic test key: the `ak` of the viewing key of a seeded spending key.
pub fn test_ak(seed: u8) -> [u8; 32] {
    let sk = SpendingKey::from_bytes([seed; 32]).expect("a valid spending key");
    FullViewingKey::from(&sk).to_bytes()[..32]
        .try_into()
        .unwrap()
}

/// `(rk as the PCZT has it, alpha, rk this `ak` gives under that alpha)` per action with a randomizer.
pub fn rks(bytes: &[u8], pool: Pool, ak: &[u8; 32]) -> Vec<([u8; 32], [u8; 32], [u8; 32])> {
    let ak = SpendValidatingKey::from_bytes(ak).expect("a valid ak");
    with_bundle(bytes, pool, |b| {
        b.actions()
            .iter()
            .filter_map(|a| {
                let alpha = a.spend().alpha().as_ref()?;
                let enc = ff::PrimeField::to_repr(alpha);
                Some((
                    <[u8; 32]>::from(a.spend().rk()),
                    enc.as_ref().try_into().unwrap(),
                    <[u8; 32]>::from(&ak.randomize(alpha)),
                ))
            })
            .collect()
    })
}

/// Replace the one occurrence of `old` (the count is asserted, so a patch cannot land elsewhere).
pub fn patch_once(bytes: &[u8], old: &[u8; 32], new: &[u8; 32]) -> Vec<u8> {
    let at: Vec<usize> = (0..=bytes.len() - 32)
        .filter(|&i| bytes[i..i + 32] == old[..])
        .collect();
    assert_eq!(at.len(), 1, "the patched bytes occur exactly once");
    let mut out = bytes.to_vec();
    out[at[0]..at[0] + 32].copy_from_slice(new);
    out
}

/// The vector with every spend's `rk` rewritten to be `ak`'s under the spend's own randomizer.
pub fn rekey(bytes: &[u8], pool: Pool, ak: &[u8; 32]) -> Vec<u8> {
    rks(bytes, pool, ak)
        .iter()
        .fold(bytes.to_vec(), |acc, (old, _, new)| {
            patch_once(&acc, old, new)
        })
}

/// The vault check, on the bundle of `pool`.
pub fn check(bytes: &[u8], pool: Pool, ak: &[u8; 32]) -> Result<Vec<(usize, [u8; 32])>, String> {
    with_bundle(bytes, pool, |b| {
        konclave_seal::spends::spends_to_sign_for(b, ak)
    })
}
