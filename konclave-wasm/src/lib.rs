//! Konclave browser-signer core (WS1 of the konclave.app plan).
//!
//! Assembles the three de-risked probes into ONE module the browser calls:
//!   1. FROST-redpallas signing round   (wasm-signer-spike)
//!   2. Orchard action verification     (wasm-orchard-probe)
//!   3. ZIP-244 sig_digest recompute    (wasm-sighash-probe)
//! The point of this crate is that they **compile together** to wasm32 as a single
//! wasm-bindgen module — the "package the core as WASM" milestone. The full stateful API
//! (session handles, per-participant rounds over the wire) lands on top of this.

use std::collections::BTreeMap;

use frost::rerandomized;
use rand::rngs::OsRng;
use reddsa::frost::redpallas as frost;

// ---------- 1. FROST-redpallas signing round (self-test) ----------

/// Full 2-of-3 rerandomized redpallas ceremony (the Orchard signing path). Proven to verify
/// inside headless Chromium. Kept as a self-test entry so the module can prove itself in a
/// real browser; the product splits this into round1/round2/aggregate over the relay.
pub fn frost_selftest() -> Result<String, String> {
    let mut rng = OsRng;
    let (shares, pubkeys) =
        frost::keys::generate_with_dealer(3, 2, frost::keys::IdentifierList::Default, &mut rng)
            .map_err(|e| format!("keygen: {e}"))?;
    let key_packages: BTreeMap<_, _> = shares
        .into_iter()
        .map(|(id, s)| frost::keys::KeyPackage::try_from(s).map(|kp| (id, kp)))
        .collect::<Result<_, _>>()
        .map_err(|e| format!("key package: {e}"))?;
    let message = b"konclave-wasm: sig_digest placeholder";
    let mut nonces = BTreeMap::new();
    let mut commitments = BTreeMap::new();
    for (id, kp) in key_packages.iter().take(2) {
        let (n, c) = frost::round1::commit(kp.signing_share(), &mut rng);
        nonces.insert(*id, n);
        commitments.insert(*id, c);
    }
    let signing_package = frost::SigningPackage::new(commitments, message);
    let (randomized_params, seed) = rerandomized::RandomizedParams::new_from_commitments(
        pubkeys.verifying_key(),
        signing_package.signing_commitments(),
        OsRng,
    )
    .map_err(|e| format!("randomize: {e}"))?;
    let mut sig_shares = BTreeMap::new();
    for (id, n) in &nonces {
        let share =
            rerandomized::sign_with_randomizer_seed(&signing_package, n, &key_packages[id], &seed)
                .map_err(|e| format!("sign: {e}"))?;
        sig_shares.insert(*id, share);
    }
    let group_sig =
        rerandomized::aggregate(&signing_package, &sig_shares, &pubkeys, &randomized_params)
            .map_err(|e| format!("aggregate: {e}"))?;
    randomized_params
        .randomized_verifying_key()
        .verify(message, &group_sig)
        .map_err(|e| format!("verify: {e}"))?;
    Ok("OK: 2-of-3 rerandomized redpallas FROST VERIFIED".into())
}

// ---------- 3. ZIP-244 sig_digest surface (blake2b, Orchard-only) ----------

/// The ZIP-244 digest of an EMPTY transparent bundle — a fixed blake2b personalized hash,
/// computable with NO secp256k1 (the whole reason the Orchard-only path is wasm-clean). The
/// full sig_digest (header ‖ transparent ‖ sapling ‖ orchard) is built from this + the orchard
/// bundle digest; byte-exact validation vs konclave-signer is the next WS1 step.
pub fn empty_transparent_digest() -> [u8; 32] {
    let h = blake2b_simd::Params::new()
        .hash_length(32)
        .personal(b"ZTxIdTranspaHash")
        .hash(&[]);
    let mut out = [0u8; 32];
    out.copy_from_slice(h.as_bytes());
    out
}

// ---------- 2. Orchard verification surface (link check) ----------

/// Links the `orchard` types the browser inspects to bind its signature to a verified spend.
pub fn orchard_surface_ok() -> bool {
    core::mem::size_of::<orchard::value::ValueCommitment>() > 0
}

// ---------- wasm-bindgen exports ----------

#[cfg(target_arch = "wasm32")]
use wasm_bindgen::prelude::*;

/// Browser self-test: runs a full FROST ceremony, touches the Orchard + digest surfaces.
/// Returns "OK: …" or "ERR: …". Proves the assembled module runs in a real browser.
#[cfg(target_arch = "wasm32")]
#[wasm_bindgen]
pub fn selftest() -> String {
    if !orchard_surface_ok() {
        return "ERR: orchard surface".into();
    }
    if empty_transparent_digest() == [0u8; 32] {
        return "ERR: digest".into();
    }
    match frost_selftest() {
        Ok(s) => s,
        Err(e) => format!("ERR: {e}"),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn assembled_core_signs_verifies_and_hashes() {
        assert!(orchard_surface_ok());
        assert_ne!(empty_transparent_digest(), [0u8; 32]);
        assert!(frost_selftest().unwrap().starts_with("OK"));
    }
}


// ---------- 1b. Split ceremony: serializable round API (over the blind relay) ----------
//
// The real multi-device flow. The **share (KeyPackage) and nonces stay local** to each device;
// only PUBLIC material crosses the wire as bytes: commitments, the signing package, the
// randomizer seed, signature shares, the final signature. This is exactly what the blind relay
// carries. Native objects (KeyPackage/PublicKeyPackage/VerifyingKey) are the device's local
// vault material, not per-ceremony wire.
pub mod ceremony {
    use super::*;
    use frost::keys::{KeyPackage, PublicKeyPackage};
    use frost::round1::{SigningCommitments, SigningNonces};
    use frost::round2::SignatureShare;
    use frost::{Identifier, SigningPackage, VerifyingKey};
    use rerandomized::RandomizedParams;

    type E = String;
    fn e<T: core::fmt::Display>(x: T) -> E { x.to_string() }

    /// Participant device, round 1: produce local secret nonces + a public commitment (bytes).
    /// The nonces are kept in the browser session; only the commitment goes to the relay.
    pub fn participant_round1(kp: &KeyPackage) -> (SigningNonces, Vec<u8>) {
        let (nonces, commitments) = frost::round1::commit(kp.signing_share(), &mut OsRng);
        (nonces, commitments.serialize().expect("commitment serialize"))
    }

    /// Coordinator: assemble the signing package from the collected (id, commitment) pairs.
    pub fn coordinator_signing_package(commitments: &[(Vec<u8>, Vec<u8>)], message: &[u8]) -> Result<Vec<u8>, E> {
        let mut map = std::collections::BTreeMap::new();
        for (id_b, c_b) in commitments {
            let id = Identifier::deserialize(id_b).map_err(e)?;
            let c = SigningCommitments::deserialize(c_b).map_err(e)?;
            map.insert(id, c);
        }
        let sp = SigningPackage::new(map, message);
        sp.serialize().map_err(e)
    }

    /// Coordinator: derive the Orchard randomizer SEED (public) from the commitments in the
    /// package. Signers regenerate the randomizer from this seed — no need to trust the RNG.
    pub fn coordinator_randomizer_seed(group_vk: &VerifyingKey, sp_bytes: &[u8]) -> Result<Vec<u8>, E> {
        let sp = SigningPackage::deserialize(sp_bytes).map_err(e)?;
        let (_params, seed) = RandomizedParams::new_from_commitments(group_vk, sp.signing_commitments(), OsRng).map_err(e)?;
        Ok(seed)
    }

    /// Participant device, round 2: sign with the seed. Uses the LOCAL nonces + key package.
    pub fn participant_round2(sp_bytes: &[u8], nonces: &SigningNonces, kp: &KeyPackage, seed: &[u8]) -> Result<Vec<u8>, E> {
        let sp = SigningPackage::deserialize(sp_bytes).map_err(e)?;
        let share = rerandomized::sign_with_randomizer_seed(&sp, nonces, kp, seed).map_err(e)?;
        Ok(share.serialize())
    }

    /// Coordinator: rebuild the randomized params from the seed and aggregate the shares.
    pub fn coordinator_aggregate(sp_bytes: &[u8], group_vk: &VerifyingKey, seed: &[u8], shares: &[(Vec<u8>, Vec<u8>)], pubkeys: &PublicKeyPackage) -> Result<Vec<u8>, E> {
        let sp = SigningPackage::deserialize(sp_bytes).map_err(e)?;
        let params = RandomizedParams::regenerate_from_seed_and_commitments(group_vk, seed, sp.signing_commitments()).map_err(e)?;
        let mut map = std::collections::BTreeMap::new();
        for (id_b, s_b) in shares {
            let id = Identifier::deserialize(id_b).map_err(e)?;
            let s = SignatureShare::deserialize(s_b).map_err(e)?;
            map.insert(id, s);
        }
        let sig = rerandomized::aggregate(&sp, &map, pubkeys, &params).map_err(e)?;
        sig.serialize().map_err(e)
    }

    /// Verify a group signature against the RANDOMIZED verifying key (what lands on-chain).
    pub fn verify(group_vk: &VerifyingKey, sp_bytes: &[u8], seed: &[u8], message: &[u8], sig_bytes: &[u8]) -> Result<bool, E> {
        let sp = SigningPackage::deserialize(sp_bytes).map_err(e)?;
        let params = RandomizedParams::regenerate_from_seed_and_commitments(group_vk, seed, sp.signing_commitments()).map_err(e)?;
        let sig = frost::Signature::deserialize(sig_bytes).map_err(e)?;
        Ok(params.randomized_verifying_key().verify(message, &sig).is_ok())
    }

    #[cfg(test)]
    mod tests {
        use super::*;

        #[test]
        fn full_2of3_ceremony_through_serialized_wire() {
            // Trusted-dealer keygen (share distribution is the DKG's job; here we exercise signing).
            let (shares, pubkeys) =
                frost::keys::generate_with_dealer(3, 2, frost::keys::IdentifierList::Default, &mut OsRng).unwrap();
            let kps: std::collections::BTreeMap<_, _> = shares.into_iter()
                .map(|(id, s)| (id, KeyPackage::try_from(s).unwrap())).collect();
            let group_vk = *pubkeys.verifying_key();
            let message = b"konclave: a real Orchard sighash would go here";

            // Two devices (the quorum) round 1 — each keeps nonces LOCAL, sends commitment bytes.
            let signers: Vec<_> = kps.iter().take(2).collect();
            let mut local_nonces = Vec::new();
            let mut wire_commitments = Vec::new();
            for (id, kp) in &signers {
                let (nonces, commit_bytes) = participant_round1(kp);
                local_nonces.push((**id, nonces));
                wire_commitments.push((id.serialize(), commit_bytes));
            }

            // Coordinator: signing package + randomizer seed (both public, over the relay).
            let sp_bytes = coordinator_signing_package(&wire_commitments, message).unwrap();
            let seed = coordinator_randomizer_seed(&group_vk, &sp_bytes).unwrap();

            // Each device round 2 — sign with local nonces + seed, send share bytes.
            let mut wire_shares = Vec::new();
            for ((id, kp), (_id2, nonces)) in signers.iter().zip(local_nonces.iter()) {
                let share_bytes = participant_round2(&sp_bytes, nonces, kp, &seed).unwrap();
                wire_shares.push((id.serialize(), share_bytes));
            }

            // Coordinator aggregates + everyone can verify — all from serialized wire data.
            let sig_bytes = coordinator_aggregate(&sp_bytes, &group_vk, &seed, &wire_shares, &pubkeys).unwrap();
            assert!(verify(&group_vk, &sp_bytes, &seed, message, &sig_bytes).unwrap(),
                "the aggregated signature must verify against the randomized group key");
        }
    }
}


// ---------- wasm-bindgen JS API for the split ceremony (WS1) ----------
// Everything crosses the JS boundary as bytes (Uint8Array). This is exactly the surface the
// React app / relay client calls: a Coordinator that accumulates public wire material, and a
// participant round-1 that keeps its nonces local. Secrets never cross as anything but the
// device-local KeyPackage the caller already holds (from the unlocked share).
#[cfg(target_arch = "wasm32")]
mod js {
    use super::ceremony;
    use super::frost;
    use super::OsRng;
    use frost::keys::KeyPackage;
    use frost::round1::SigningNonces;
    use wasm_bindgen::prelude::*;

    fn je(e: impl core::fmt::Display) -> JsValue { JsValue::from_str(&e.to_string()) }

    /// Test-only trusted-dealer 2-of-3, so JS can drive a ceremony end-to-end. The product
    /// uses DKG; the key packages here stand in for the unlocked device shares.
    #[wasm_bindgen]
    pub struct TestVault { kps: Vec<Vec<u8>>, ids: Vec<Vec<u8>>, pubkeys: Vec<u8>, group_vk: Vec<u8> }

    #[wasm_bindgen]
    impl TestVault {
        #[wasm_bindgen(constructor)]
        pub fn new() -> Result<TestVault, JsValue> {
            let (shares, pubkeys) = frost::keys::generate_with_dealer(3, 2, frost::keys::IdentifierList::Default, &mut OsRng).map_err(je)?;
            let mut kps = Vec::new(); let mut ids = Vec::new();
            for (id, s) in shares.into_iter() {
                ids.push(id.serialize());
                kps.push(KeyPackage::try_from(s).map_err(je)?.serialize().map_err(je)?);
            }
            let group_vk = pubkeys.verifying_key().serialize().map_err(je)?;
            Ok(TestVault { kps, ids, pubkeys: pubkeys.serialize().map_err(je)?, group_vk })
        }
        pub fn key_package(&self, i: usize) -> Vec<u8> { self.kps[i].clone() }
        pub fn id(&self, i: usize) -> Vec<u8> { self.ids[i].clone() }
        pub fn pubkeys(&self) -> Vec<u8> { self.pubkeys.clone() }
        #[wasm_bindgen(js_name = groupVk)]
        pub fn group_vk(&self) -> Vec<u8> { self.group_vk.clone() }
    }

    /// Participant round-1 output: nonces stay on THIS device; commitment goes to the relay.
    #[wasm_bindgen]
    pub struct Round1 { nonces: Vec<u8>, commitment: Vec<u8> }
    #[wasm_bindgen]
    impl Round1 {
        pub fn nonces(&self) -> Vec<u8> { self.nonces.clone() }
        pub fn commitment(&self) -> Vec<u8> { self.commitment.clone() }
    }

    /// Participant device, round 1 (JS): from the local key-package bytes.
    #[wasm_bindgen(js_name = participantRound1)]
    pub fn participant_round1(kp_bytes: &[u8]) -> Result<Round1, JsValue> {
        let kp = KeyPackage::deserialize(kp_bytes).map_err(je)?;
        let (nonces, commitment) = ceremony::participant_round1(&kp);
        Ok(Round1 { nonces: nonces.serialize().map_err(je)?, commitment })
    }

    /// Participant device, round 2 (JS): sign with the local nonces + seed.
    #[wasm_bindgen(js_name = participantRound2)]
    pub fn participant_round2(sp: &[u8], nonces_bytes: &[u8], kp_bytes: &[u8], seed: &[u8]) -> Result<Vec<u8>, JsValue> {
        let nonces = SigningNonces::deserialize(nonces_bytes).map_err(je)?;
        let kp = KeyPackage::deserialize(kp_bytes).map_err(je)?;
        ceremony::participant_round2(sp, &nonces, &kp, seed).map_err(je)
    }

    /// Coordinator (JS): accumulates the public wire material and produces the signature.
    #[wasm_bindgen]
    pub struct Coordinator {
        message: Vec<u8>, group_vk: Vec<u8>, pubkeys: Vec<u8>,
        commitments: Vec<(Vec<u8>, Vec<u8>)>, shares: Vec<(Vec<u8>, Vec<u8>)>,
        sp: Vec<u8>, seed: Vec<u8>,
    }
    #[wasm_bindgen]
    impl Coordinator {
        #[wasm_bindgen(constructor)]
        pub fn new(group_vk: &[u8], pubkeys: &[u8], message: &[u8]) -> Coordinator {
            Coordinator { message: message.into(), group_vk: group_vk.into(), pubkeys: pubkeys.into(),
                commitments: vec![], shares: vec![], sp: vec![], seed: vec![] }
        }
        #[wasm_bindgen(js_name = addCommitment)]
        pub fn add_commitment(&mut self, id: &[u8], commitment: &[u8]) { self.commitments.push((id.into(), commitment.into())); }
        /// Build the signing package + randomizer seed (both public). Returns nothing; read via getters.
        pub fn prepare(&mut self) -> Result<(), JsValue> {
            self.sp = ceremony::coordinator_signing_package(&self.commitments, &self.message).map_err(je)?;
            let vk = frost::VerifyingKey::deserialize(&self.group_vk).map_err(je)?;
            self.seed = ceremony::coordinator_randomizer_seed(&vk, &self.sp).map_err(je)?;
            Ok(())
        }
        #[wasm_bindgen(js_name = signingPackage)]
        pub fn signing_package(&self) -> Vec<u8> { self.sp.clone() }
        pub fn seed(&self) -> Vec<u8> { self.seed.clone() }
        #[wasm_bindgen(js_name = addShare)]
        pub fn add_share(&mut self, id: &[u8], share: &[u8]) { self.shares.push((id.into(), share.into())); }
        pub fn aggregate(&self) -> Result<Vec<u8>, JsValue> {
            let vk = frost::VerifyingKey::deserialize(&self.group_vk).map_err(je)?;
            let pubkeys = frost::keys::PublicKeyPackage::deserialize(&self.pubkeys).map_err(je)?;
            ceremony::coordinator_aggregate(&self.sp, &vk, &self.seed, &self.shares, &pubkeys).map_err(je)
        }
        pub fn verify(&self, sig: &[u8]) -> Result<bool, JsValue> {
            let vk = frost::VerifyingKey::deserialize(&self.group_vk).map_err(je)?;
            ceremony::verify(&vk, &self.sp, &self.seed, &self.message, sig).map_err(je)
        }
    }
}
