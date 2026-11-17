//! The key derivation ZIP 2005 asks of a FROST-controlled Orchard account: `use_qsk = true`
//! (ZIP 2005, "Usage with FROST", and the § 4.2.3 "Orchard Key Components" text it puts into the
//! protocol spec). The participants agree on a secret `sk`; the DKG gives `ak`; from both:
//!
//! ```text
//! nk       = ToBase^Orchard(PRF^expand_sk([0x07]))
//! qsk      = truncate_32(PRF^expand_sk([0x0C]))
//! qk       = BLAKE3.derive_key("Zcash ZIP 2005 qk-derivation v1", qsk, 32)
//! rivk_ext = ToScalar^Orchard(PRF^expand_qk([0x0D] || I2LEOSP_256(ak) || I2LEOSP_256(nk)))
//! fvk      = ak || nk || rivk_ext
//! ```
//!
//! Written from the ZIP text and checked in CI against vectors produced elsewhere
//! (`tests/zip2005_use_qsk.rs`). No product path calls it yet: today a vault's viewing key is
//! minted at random (#428). When one does, it calls this function; a second copy of the
//! derivation is the failure CLAUDE.md §11 describes.
//!
//! `qsk` is a secret held as securely as a share (ZIP 2005: "at least as securely and reliably as
//! ask"). This function returns it so the vectors can be checked; a caller that does not need it
//! drops it.

use blake2b_simd::Params;
use ff::{FromUniformBytes, PrimeField};
use orchard::keys::FullViewingKey;
use pasta_curves_orchard::pallas;

/// The BLAKE3 key-derivation context ZIP 2005 fixes for `H^qk`.
pub const QK_CONTEXT: &str = "Zcash ZIP 2005 qk-derivation v1";

/// Why a pair `(sk, ak)` gives no viewing key.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Zip2005Error {
    /// `ak` has ỹ = 1. ZIP 2005 requires the last bit of `repr(ak)` to be 0, which is what the
    /// ZIP 312 DKG normalisation guarantees; a raw group key that was not normalised lands here.
    OddY,
    /// `ak` is not a valid spend validating key (the identity, or not on Pallas), or the derived
    /// key gives an `ivk` of 0 or ⊥, which Orchard refuses.
    InvalidKey,
}

/// What `derive_use_qsk` derives. Byte encodings are the ones the protocol spec uses.
pub struct UseQskKeys {
    pub nk: [u8; 32],
    pub qsk: [u8; 32],
    pub qk: [u8; 32],
    pub rivk_ext: [u8; 32],
    /// The 96-byte raw Orchard full viewing key `ak || nk || rivk_ext`, accepted by orchard.
    pub fvk: [u8; 96],
}

/// `PRF^expand_key(t)`: BLAKE2b-512 personalised with "Zcash_ExpandSeed" over `key || t`.
fn prf_expand(key: &[u8], t: &[&[u8]]) -> [u8; 64] {
    let mut h = Params::new()
        .hash_length(64)
        .personal(b"Zcash_ExpandSeed")
        .to_state();
    h.update(key);
    for part in t {
        h.update(part);
    }
    *h.finalize().as_array()
}

/// Derive the Orchard key components of a FROST account with `use_qsk = true`.
pub fn derive_use_qsk(sk: &[u8; 32], ak: &[u8; 32]) -> Result<UseQskKeys, Zip2005Error> {
    if ak[31] & 0x80 != 0 {
        return Err(Zip2005Error::OddY);
    }
    let nk = pallas::Base::from_uniform_bytes(&prf_expand(sk, &[&[0x07]])).to_repr();
    let mut qsk = [0u8; 32];
    qsk.copy_from_slice(&prf_expand(sk, &[&[0x0C]])[..32]);
    let qk = blake3::derive_key(QK_CONTEXT, &qsk);
    // With ỹ = 0, repr(ak_P) is I2LEOSP_256 of its x-coordinate, which is ak.
    let rivk_ext =
        pallas::Scalar::from_uniform_bytes(&prf_expand(&qk, &[&[0x0D], ak, &nk])).to_repr();

    let mut fvk = [0u8; 96];
    fvk[..32].copy_from_slice(ak);
    fvk[32..64].copy_from_slice(&nk);
    fvk[64..].copy_from_slice(&rivk_ext);
    // Orchard's own reader decides what a valid key is: ak a non-identity point with ỹ = 0,
    // nk and rivk canonical, and neither the external nor the internal ivk 0 or ⊥.
    FullViewingKey::from_bytes(&fvk).ok_or(Zip2005Error::InvalidKey)?;
    Ok(UseQskKeys {
        nk,
        qsk,
        qk,
        rivk_ext,
        fvk,
    })
}
