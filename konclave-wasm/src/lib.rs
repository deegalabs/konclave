//! Konclave browser-signer core (WS1 of the konclave.xyz plan).
//!
//! Assembles the three de-risked probes into ONE module the browser calls:
//!
//! 1. FROST-redpallas signing round (wasm-signer-spike)
//! 2. Orchard action verification (wasm-orchard-probe)
//! 3. ZIP-244 sig_digest recompute (wasm-sighash-probe)
//!
//! The point of this crate is that they **compile together** to wasm32 as a single
//! wasm-bindgen module - the "package the core as WASM" milestone. The full stateful API
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
        frost::keys::generate_with_dealer(3, 2, frost::keys::IdentifierList::Default, rng)
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

// ---------- Room-message authentication (#392) — spike ----------
//
// Authenticate signing-room writes so an outsider who only knows the (public) room cannot hijack a
// seat or evict a live ceremony. A device signs its room messages with its FROST signing SHARE,
// DOMAIN-SEPARATED so the signed bytes can never be a transaction spend-auth signature, and any
// device verifies against that seat's public `verifying_share` - which every honest device already
// holds in the DKG's PublicKeyPackage (the trustless anchor, no new registration needed for the 26
// existing vaults). Safety rests on two disjointnesses: the base share is NOT the rerandomized key a
// spend auth needs (Orchard verifies under ak+alpha), and every room message carries a domain prefix
// so it never collides with a 32-byte tx sighash; the reddsa nonce is fresh per signature.
pub mod room_auth {
    use crate::frost;
    use rand::rngs::OsRng;
    use reddsa::orchard::SpendAuth;

    const DOMAIN: &[u8] = b"konclave-room-v1\x00";

    fn domain_msg(msg: &[u8]) -> Vec<u8> {
        let mut m = Vec::with_capacity(DOMAIN.len() + msg.len());
        m.extend_from_slice(DOMAIN);
        m.extend_from_slice(msg);
        m
    }

    /// Sign a room message with this device's FROST signing share. 64-byte RedPallas signature.
    pub fn sign_with_share(signing_share: &frost::keys::SigningShare, msg: &[u8]) -> [u8; 64] {
        let bytes: [u8; 32] = signing_share
            .serialize()
            .try_into()
            .expect("a redpallas signing share is 32 bytes");
        let sk = reddsa::SigningKey::<SpendAuth>::try_from(bytes).expect("valid share scalar");
        let sig = sk.sign(OsRng, &domain_msg(msg));
        <[u8; 64]>::from(sig)
    }

    /// True iff `sig` is `verifying_share`'s signature over the domain-separated `msg`.
    pub fn verify_against_share(
        verifying_share: &frost::keys::VerifyingShare,
        msg: &[u8],
        sig: &[u8; 64],
    ) -> bool {
        let vk_bytes: [u8; 32] = match verifying_share
            .serialize()
            .ok()
            .and_then(|v| v.try_into().ok())
        {
            Some(b) => b,
            None => return false,
        };
        let vk = match reddsa::VerificationKey::<SpendAuth>::try_from(vk_bytes) {
            Ok(v) => v,
            Err(_) => return false,
        };
        vk.verify(&domain_msg(msg), &reddsa::Signature::from(*sig))
            .is_ok()
    }

    #[cfg(test)]
    mod tests {
        use super::*;
        use crate::frost::keys::{generate_with_dealer, IdentifierList, KeyPackage};
        use rand::rngs::OsRng;

        #[test]
        fn a_room_message_binds_to_the_seat_that_signed_it() {
            // The #392 anchor: a device signs with its share; anyone verifies against that seat's
            // verifying_share from the DKG PublicKeyPackage - so a seat cannot be forged.
            let (shares, pubkeys) =
                generate_with_dealer(3, 2, IdentifierList::Default, OsRng).unwrap();
            let (id, secret) = shares.into_iter().next().unwrap();
            let kp = KeyPackage::try_from(secret).unwrap();
            let vshare = *pubkeys.verifying_shares().get(&id).unwrap();

            let msg = b"rejoin seat=1 room=abcd nonce=42";
            let sig = sign_with_share(kp.signing_share(), msg);

            assert!(
                verify_against_share(&vshare, msg, &sig),
                "signs and verifies for its own seat"
            );

            // A DIFFERENT seat's verifying_share must not verify (no seat forgery).
            let other = *pubkeys
                .verifying_shares()
                .iter()
                .find(|(oid, _)| **oid != id)
                .map(|(_, v)| v)
                .unwrap();
            assert!(
                !verify_against_share(&other, msg, &sig),
                "a different seat cannot claim it"
            );

            // A tampered message must not verify.
            assert!(!verify_against_share(
                &vshare,
                b"rejoin seat=2 room=abcd nonce=42",
                &sig
            ));
        }
    }
}

// ---------- 3. ZIP-244 sig_digest surface (blake2b, Orchard-only) ----------

/// The ZIP-244 digest of an EMPTY transparent bundle - a fixed blake2b personalized hash,
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
//
// TWO signing paths live here, and they are NOT interchangeable for Orchard:
//   - RANDOMIZER path (`participant_round2_with_randomizer` / `coordinator_aggregate_with_randomizer`
//     / `verify_with_randomizer`): signs under an explicit alpha (the PCZT's, from
//     `pczt_bridge::extract_randomizers`), so the signature verifies under `ak+alpha` and is the REAL
//     Orchard spend-authorization mechanism. This is what the live `/net` ceremony uses.
//   - SEED path (`coordinator_randomizer_seed` / `participant_round2` / `coordinator_aggregate` /
//     `verify`): the coordinator derives its OWN randomizer from the commitments. This proves group
//     signing over a message but is NOT a valid Orchard spend authorization. Used only by the
//     `/signer` group-signing demo.
pub mod ceremony {
    use super::*;
    use frost::keys::{KeyPackage, PublicKeyPackage};
    use frost::round1::{SigningCommitments, SigningNonces};
    use frost::round2::SignatureShare;
    use frost::{Identifier, SigningPackage, VerifyingKey};
    use rerandomized::RandomizedParams;

    type E = String;
    fn e<T: core::fmt::Display>(x: T) -> E {
        x.to_string()
    }

    /// What round 2 answers when the package it was handed signs something other than the message
    /// this device derived. The app matches on it to tell this refusal from a malformed package.
    pub const PACKAGE_SIGNS_ANOTHER_MESSAGE: &str =
        "the signing package signs a different message than the one this device derived";

    /// The one place a device's own message is held against the package it was handed. Both round-2
    /// functions call it before anything is signed, so neither path can sign a package it has not
    /// compared.
    fn require_message(sp: &SigningPackage, message: &[u8]) -> Result<(), E> {
        if sp.message().as_slice() != message {
            return Err(PACKAGE_SIGNS_ANOTHER_MESSAGE.to_string());
        }
        Ok(())
    }

    /// What a round-2 call answers when the nonce it was handed has already produced a share.
    pub const NONCE_ALREADY_USED: &str =
        "this device's signing nonce already produced a share; a new round 1 is needed";

    /// A signer's nonces for ONE signing round: they make one share and are then dropped. The rule
    /// lives here, in the thing both round-2 functions sign through.
    ///
    /// The nonces are spent only when a share came out. Every `Err` in the signing call comes before
    /// the share is computed, so a refusal (a package over another message, a commitment that is not
    /// this device's, a malformed input) emits nothing and leaves them in place for the next package.
    pub struct NonceSlot(Option<SigningNonces>);

    impl NonceSlot {
        pub fn new(nonces: SigningNonces) -> Self {
            NonceSlot(Some(nonces))
        }

        /// Run `sign` with the nonce and, only if it returns a share, drop the nonce (frost-core
        /// zeroizes `SigningNonces` on drop).
        fn sign_once(
            &mut self,
            sign: impl FnOnce(&SigningNonces) -> Result<SignatureShare, E>,
        ) -> Result<Vec<u8>, E> {
            let nonces = self
                .0
                .as_ref()
                .ok_or_else(|| NONCE_ALREADY_USED.to_string())?;
            let share = sign(nonces)?;
            self.0 = None;
            Ok(share.serialize())
        }
    }

    /// Participant device, round 1: produce local secret nonces + a public commitment (bytes).
    /// The nonces are kept in the browser session; only the commitment goes to the relay.
    pub fn participant_round1(kp: &KeyPackage) -> (NonceSlot, Vec<u8>) {
        let (nonces, commitments) = frost::round1::commit(kp.signing_share(), &mut OsRng);
        (
            NonceSlot::new(nonces),
            commitments.serialize().expect("commitment serialize"),
        )
    }

    /// Coordinator: assemble the signing package from the collected (id, commitment) pairs.
    pub fn coordinator_signing_package(
        commitments: &[(Vec<u8>, Vec<u8>)],
        message: &[u8],
    ) -> Result<Vec<u8>, E> {
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
    /// package. Signers regenerate the randomizer from this seed - no need to trust the RNG.
    pub fn coordinator_randomizer_seed(
        group_vk: &VerifyingKey,
        sp_bytes: &[u8],
    ) -> Result<Vec<u8>, E> {
        let sp = SigningPackage::deserialize(sp_bytes).map_err(e)?;
        let (_params, seed) =
            RandomizedParams::new_from_commitments(group_vk, sp.signing_commitments(), OsRng)
                .map_err(e)?;
        Ok(seed)
    }

    /// Participant device, round 2: sign with the seed. Uses the LOCAL nonces + key package.
    /// `message` is what this device holds for itself; the package is refused unless it signs
    /// exactly that, for the reason given on `participant_round2_with_randomizer`.
    pub fn participant_round2(
        sp_bytes: &[u8],
        nonces: &mut NonceSlot,
        kp: &KeyPackage,
        seed: &[u8],
        message: &[u8],
    ) -> Result<Vec<u8>, E> {
        let sp = SigningPackage::deserialize(sp_bytes).map_err(e)?;
        require_message(&sp, message)?;
        nonces.sign_once(|n| rerandomized::sign_with_randomizer_seed(&sp, n, kp, seed).map_err(e))
    }

    /// Coordinator: rebuild the randomized params from the seed and aggregate the shares.
    pub fn coordinator_aggregate(
        sp_bytes: &[u8],
        group_vk: &VerifyingKey,
        seed: &[u8],
        shares: &[(Vec<u8>, Vec<u8>)],
        pubkeys: &PublicKeyPackage,
    ) -> Result<Vec<u8>, E> {
        let sp = SigningPackage::deserialize(sp_bytes).map_err(e)?;
        let params = RandomizedParams::regenerate_from_seed_and_commitments(
            group_vk,
            seed,
            sp.signing_commitments(),
        )
        .map_err(e)?;
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
    pub fn verify(
        group_vk: &VerifyingKey,
        sp_bytes: &[u8],
        seed: &[u8],
        message: &[u8],
        sig_bytes: &[u8],
    ) -> Result<bool, E> {
        let sp = SigningPackage::deserialize(sp_bytes).map_err(e)?;
        let params = RandomizedParams::regenerate_from_seed_and_commitments(
            group_vk,
            seed,
            sp.signing_commitments(),
        )
        .map_err(e)?;
        let sig = frost::Signature::deserialize(sig_bytes).map_err(e)?;
        Ok(params
            .randomized_verifying_key()
            .verify(message, &sig)
            .is_ok())
    }

    // ---- signing with a SPECIFIC Orchard randomizer (alpha), for real transactions ----
    // An Orchard spend must be signed under the note's own re-randomization: the alpha carried in
    // the PCZT (read via pczt_bridge::extract_randomizers), NOT a commitment-derived seed. These
    // three functions take that alpha explicitly, so the FROST signature verifies under ak+alpha and
    // can be injected into the transaction (pczt_bridge::inject_sigs) and broadcast. The seed-based
    // functions above stay for the self-contained demo; these are the real-transaction path.

    /// Participant round 2, signing with the given Orchard randomizer (alpha), 32 canonical bytes.
    // frost-rerandomized deprecates the explicit-randomizer `sign` in favour of a seed the
    // coordinator generates - but an Orchard spend's alpha is FIXED by the transaction (read from the
    // PCZT), not freely chosen, so the seed path cannot express it. Signing under this exact
    // randomizer is required and correct here.
    //
    // `message` is what THIS device derived for itself (the ZIP-244 sighash of its own copy of the
    // transaction), and the share is refused unless the package signs exactly that. It is a
    // parameter of the function that signs, and not a check the caller makes beside it, because
    // the caller's check is the one that was missing: `frost_rerandomized::sign` signs the message
    // INSIDE the package, the package arrives from the coordinator, and a device that compared the
    // sighash it was TOLD about and then signed the package it was HANDED had verified one thing
    // and signed another. With the message required here there is no way to reach the signature
    // on the real-transaction path without binding it.
    #[allow(deprecated)]
    pub fn participant_round2_with_randomizer(
        sp_bytes: &[u8],
        nonces: &mut NonceSlot,
        kp: &KeyPackage,
        randomizer: &[u8],
        message: &[u8],
    ) -> Result<Vec<u8>, E> {
        let sp = SigningPackage::deserialize(sp_bytes).map_err(e)?;
        require_message(&sp, message)?;
        let r = rerandomized::Randomizer::deserialize(randomizer).map_err(e)?;
        nonces.sign_once(|n| frost_rerandomized::sign(&sp, n, kp, r).map_err(e))
    }

    /// Coordinator: aggregate the shares under the given randomizer (alpha) into a group signature.
    pub fn coordinator_aggregate_with_randomizer(
        sp_bytes: &[u8],
        group_vk: &VerifyingKey,
        randomizer: &[u8],
        shares: &[(Vec<u8>, Vec<u8>)],
        pubkeys: &PublicKeyPackage,
    ) -> Result<Vec<u8>, E> {
        let sp = SigningPackage::deserialize(sp_bytes).map_err(e)?;
        let r = rerandomized::Randomizer::deserialize(randomizer).map_err(e)?;
        let params = RandomizedParams::from_randomizer(group_vk, r);
        let mut map = std::collections::BTreeMap::new();
        for (id_b, s_b) in shares {
            let id = Identifier::deserialize(id_b).map_err(e)?;
            let s = SignatureShare::deserialize(s_b).map_err(e)?;
            map.insert(id, s);
        }
        let sig = rerandomized::aggregate(&sp, &map, pubkeys, &params).map_err(e)?;
        sig.serialize().map_err(e)
    }

    /// Coordinator: does this ONE share verify, for this signer, in this signing package, under
    /// this randomizer? The coordinator asks it of every share before the share counts, so a share
    /// that does not verify is not counted, and the next share from that signer is checked in its
    /// turn. A share of the wrong length or encoding is refused the same way.
    pub fn check_share_with_randomizer(
        sp_bytes: &[u8],
        group_vk: &VerifyingKey,
        randomizer: &[u8],
        id_bytes: &[u8],
        share_bytes: &[u8],
        pubkeys: &PublicKeyPackage,
    ) -> Result<(), E> {
        let sp = SigningPackage::deserialize(sp_bytes).map_err(e)?;
        let r = rerandomized::Randomizer::deserialize(randomizer).map_err(e)?;
        let params = RandomizedParams::from_randomizer(group_vk, r);
        let id = Identifier::deserialize(id_bytes).map_err(e)?;
        let share = SignatureShare::deserialize(share_bytes).map_err(e)?;
        // The shares are checked against the RANDOMIZED key, the one the signature is made under.
        // (frost-rerandomized does the same to the public key package inside `aggregate`: each
        // verifying share plus the randomizer's point, under the randomized verifying key.)
        let verifying_share = pubkeys
            .verifying_shares()
            .get(&id)
            .ok_or_else(|| "this signer is not part of the vault".to_string())?;
        let randomized_share = frost::keys::VerifyingShare::new(
            verifying_share.to_element() + *params.randomizer_element(),
        );
        frost_rerandomized::frost_core::verify_signature_share(
            id,
            &randomized_share,
            &share,
            &sp,
            params.randomized_verifying_key(),
        )
        .map_err(e)
    }

    /// Verify the group signature under the key re-randomized by the given alpha (what an Orchard
    /// spend commits to). This is the check `pczt_bridge::inject_sigs` will pass on-chain.
    pub fn verify_with_randomizer(
        group_vk: &VerifyingKey,
        randomizer: &[u8],
        message: &[u8],
        sig_bytes: &[u8],
    ) -> Result<bool, E> {
        let r = rerandomized::Randomizer::deserialize(randomizer).map_err(e)?;
        let params = RandomizedParams::from_randomizer(group_vk, r);
        let sig = frost::Signature::deserialize(sig_bytes).map_err(e)?;
        Ok(params
            .randomized_verifying_key()
            .verify(message, &sig)
            .is_ok())
    }

    #[cfg(test)]
    mod tests {
        use super::*;

        #[test]
        fn full_2of3_ceremony_through_serialized_wire() {
            // Trusted-dealer keygen (share distribution is the DKG's job; here we exercise signing).
            let (shares, pubkeys) = frost::keys::generate_with_dealer(
                3,
                2,
                frost::keys::IdentifierList::Default,
                OsRng,
            )
            .unwrap();
            let kps: std::collections::BTreeMap<_, _> = shares
                .into_iter()
                .map(|(id, s)| (id, KeyPackage::try_from(s).unwrap()))
                .collect();
            let group_vk = *pubkeys.verifying_key();
            let message = b"konclave: a real Orchard sighash would go here";

            // Two devices (the quorum) round 1 - each keeps nonces LOCAL, sends commitment bytes.
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

            // Each device round 2 - sign with local nonces + seed, send share bytes.
            let mut wire_shares = Vec::new();
            for ((id, kp), (_id2, nonces)) in signers.iter().zip(local_nonces.iter_mut()) {
                let share_bytes =
                    participant_round2(&sp_bytes, nonces, kp, &seed, message).unwrap();
                wire_shares.push((id.serialize(), share_bytes));
            }

            // Coordinator aggregates + everyone can verify - all from serialized wire data.
            let sig_bytes =
                coordinator_aggregate(&sp_bytes, &group_vk, &seed, &wire_shares, &pubkeys).unwrap();
            assert!(
                verify(&group_vk, &sp_bytes, &seed, message, &sig_bytes).unwrap(),
                "the aggregated signature must verify against the randomized group key"
            );
        }

        /// The package is the coordinator's; the message is the device's. A package built over any
        /// other message gets no share, however well formed it is.
        #[test]
        fn a_package_over_another_message_gets_no_share() {
            let alpha =
                hex::decode("b2ad61e8bf0de877dd01c52356526adf39b036ffed2e0217ece19407e1717624")
                    .unwrap();
            let (shares, _pubkeys) = frost::keys::generate_with_dealer(
                3,
                2,
                frost::keys::IdentifierList::Default,
                OsRng,
            )
            .unwrap();
            let kps: std::collections::BTreeMap<_, _> = shares
                .into_iter()
                .map(|(id, s)| (id, KeyPackage::try_from(s).unwrap()))
                .collect();
            let derived = b"the sighash this device derived from its own copy";
            let handed = b"the sighash of a transaction nobody here approved";

            let signers: Vec<_> = kps.iter().take(2).collect();
            let mut local_nonces = Vec::new();
            let mut wire_commitments = Vec::new();
            for (id, kp) in &signers {
                let (nonces, commit_bytes) = participant_round1(kp);
                local_nonces.push(nonces);
                wire_commitments.push((id.serialize(), commit_bytes));
            }
            // Built over the LIVE commitments, so nothing about it is malformed.
            let other_package = coordinator_signing_package(&wire_commitments, handed).unwrap();
            let own_package = coordinator_signing_package(&wire_commitments, derived).unwrap();

            let (_, kp) = signers[0];
            let outcome = participant_round2_with_randomizer(
                &other_package,
                &mut local_nonces[0],
                kp,
                &alpha,
                derived,
            );
            assert_eq!(
                outcome.unwrap_err(),
                PACKAGE_SIGNS_ANOTHER_MESSAGE,
                "a package over another message must be refused, and for this reason"
            );
            // The same device, the same nonces, the package over the derived message: the refusal above is about the
            // message and nothing else.
            assert!(
                participant_round2_with_randomizer(
                    &own_package,
                    &mut local_nonces[0],
                    kp,
                    &alpha,
                    derived
                )
                .is_ok(),
                "the package over the derived message is signed"
            );
        }

        /// Two devices of a 2-of-3 vault, their round 1 done: the key packages, the nonce slots, the
        /// commitments as they travel, and the vault's public keys.
        #[allow(clippy::type_complexity)]
        fn two_signers() -> (
            Vec<KeyPackage>,
            Vec<NonceSlot>,
            Vec<(Vec<u8>, Vec<u8>)>,
            Vec<Identifier>,
        ) {
            let (shares, _pubkeys) = frost::keys::generate_with_dealer(
                3,
                2,
                frost::keys::IdentifierList::Default,
                OsRng,
            )
            .unwrap();
            let kps: std::collections::BTreeMap<_, _> = shares
                .into_iter()
                .map(|(id, s)| (id, KeyPackage::try_from(s).unwrap()))
                .collect();
            let mut kp_list = Vec::new();
            let mut slots = Vec::new();
            let mut commitments = Vec::new();
            let mut ids = Vec::new();
            for (id, kp) in kps.iter().take(2) {
                let (slot, commit_bytes) = participant_round1(kp);
                kp_list.push(kp.clone());
                slots.push(slot);
                commitments.push((id.serialize(), commit_bytes));
                ids.push(*id);
            }
            (kp_list, slots, commitments, ids)
        }

        /// A nonce makes one share: the module refuses a second call with the same nonce, whatever
        /// the caller kept beside it.
        #[test]
        fn a_nonce_makes_one_share_on_the_randomizer_path() {
            let alpha =
                hex::decode("b2ad61e8bf0de877dd01c52356526adf39b036ffed2e0217ece19407e1717624")
                    .unwrap();
            let (kps, mut slots, commitments, _ids) = two_signers();
            let first = b"the sighash of the first payment";
            let second = b"the sighash of another payment";
            let sp1 = coordinator_signing_package(&commitments, first).unwrap();
            let sp2 = coordinator_signing_package(&commitments, second).unwrap();

            assert!(
                participant_round2_with_randomizer(&sp1, &mut slots[0], &kps[0], &alpha, first)
                    .is_ok(),
                "the first use of the nonce makes a share"
            );
            // The same nonce with a second package, over another message the device also holds.
            assert_eq!(
                participant_round2_with_randomizer(&sp2, &mut slots[0], &kps[0], &alpha, second)
                    .unwrap_err(),
                NONCE_ALREADY_USED,
                "the second use of the same nonce is refused, and for this reason"
            );
            // And the very same package again: also refused.
            assert_eq!(
                participant_round2_with_randomizer(&sp1, &mut slots[0], &kps[0], &alpha, first)
                    .unwrap_err(),
                NONCE_ALREADY_USED
            );
        }

        #[test]
        fn a_nonce_makes_one_share_on_the_seed_path() {
            let (shares, pubkeys) = frost::keys::generate_with_dealer(
                3,
                2,
                frost::keys::IdentifierList::Default,
                OsRng,
            )
            .unwrap();
            let group_vk = *pubkeys.verifying_key();
            let kps: std::collections::BTreeMap<_, _> = shares
                .into_iter()
                .map(|(id, s)| (id, KeyPackage::try_from(s).unwrap()))
                .collect();
            let first = b"the message of the first round";
            let second = b"the message of another round";
            let mut slots = Vec::new();
            let mut commitments = Vec::new();
            for (id, kp) in kps.iter().take(2) {
                let (slot, c) = participant_round1(kp);
                slots.push(slot);
                commitments.push((id.serialize(), c));
            }
            let sp1 = coordinator_signing_package(&commitments, first).unwrap();
            let sp2 = coordinator_signing_package(&commitments, second).unwrap();
            let seed1 = coordinator_randomizer_seed(&group_vk, &sp1).unwrap();
            let seed2 = coordinator_randomizer_seed(&group_vk, &sp2).unwrap();
            let kp = kps.values().next().unwrap();

            assert!(participant_round2(&sp1, &mut slots[0], kp, &seed1, first).is_ok());
            assert_eq!(
                participant_round2(&sp2, &mut slots[0], kp, &seed2, second).unwrap_err(),
                NONCE_ALREADY_USED,
                "the seed path spends the nonce too"
            );
        }

        /// The other half of the rule: a refusal makes no share, so it does not spend the nonce.
        #[test]
        fn a_refused_package_does_not_spend_the_nonce() {
            let alpha =
                hex::decode("b2ad61e8bf0de877dd01c52356526adf39b036ffed2e0217ece19407e1717624")
                    .unwrap();
            let (kps, mut slots, commitments, ids) = two_signers();
            let message = b"the sighash this device derived";
            let own_package = coordinator_signing_package(&commitments, message).unwrap();

            // A package over the right message that carries a commitment this device never made
            // for seat 1 (the one from another round 1): frost refuses it inside the signing call.
            let (_other_slot, other_commit) = participant_round1(&kps[0]);
            let foreign: Vec<(Vec<u8>, Vec<u8>)> =
                vec![(ids[0].serialize(), other_commit), commitments[1].clone()];
            let foreign_sp = coordinator_signing_package(&foreign, message).unwrap();
            let outcome = participant_round2_with_randomizer(
                &foreign_sp,
                &mut slots[0],
                &kps[0],
                &alpha,
                message,
            )
            .unwrap_err();
            assert_ne!(
                outcome, NONCE_ALREADY_USED,
                "the first call cannot find the nonce spent"
            );
            assert_ne!(
                outcome, PACKAGE_SIGNS_ANOTHER_MESSAGE,
                "the message is the right one"
            );
            assert!(
                outcome.to_lowercase().contains("commitment"),
                "refused because the commitment is not this device's, not for another reason: {outcome}"
            );

            // Malformed inputs fail before the signing call too.
            assert!(participant_round2_with_randomizer(
                &own_package,
                &mut slots[0],
                &kps[0],
                &[1, 2, 3],
                message
            )
            .is_err());

            // The nonce is still there for the package that does belong to it.
            assert!(
                participant_round2_with_randomizer(
                    &own_package,
                    &mut slots[0],
                    &kps[0],
                    &alpha,
                    message
                )
                .is_ok(),
                "the package that belongs to this device is answered after the refusals"
            );
        }

        /// The seed path signs the message inside the package too, so it is bound the same way: a
        /// package over another message gets no share on either path.
        #[test]
        fn the_seed_path_refuses_a_package_over_another_message() {
            let (shares, pubkeys) = frost::keys::generate_with_dealer(
                3,
                2,
                frost::keys::IdentifierList::Default,
                OsRng,
            )
            .unwrap();
            let group_vk = *pubkeys.verifying_key();
            let kps: std::collections::BTreeMap<_, _> = shares
                .into_iter()
                .map(|(id, s)| (id, KeyPackage::try_from(s).unwrap()))
                .collect();
            let derived = b"the message this device derived from its own copy";
            let handed = b"a message nobody here approved";

            let signers: Vec<_> = kps.iter().take(2).collect();
            let mut local_nonces = Vec::new();
            let mut wire_commitments = Vec::new();
            for (id, kp) in &signers {
                let (nonces, commit_bytes) = participant_round1(kp);
                local_nonces.push(nonces);
                wire_commitments.push((id.serialize(), commit_bytes));
            }
            let other_package = coordinator_signing_package(&wire_commitments, handed).unwrap();
            let own_package = coordinator_signing_package(&wire_commitments, derived).unwrap();
            let seed = coordinator_randomizer_seed(&group_vk, &own_package).unwrap();

            let (_, kp) = signers[0];
            let outcome =
                participant_round2(&other_package, &mut local_nonces[0], kp, &seed, derived);
            assert_eq!(
                outcome.unwrap_err(),
                PACKAGE_SIGNS_ANOTHER_MESSAGE,
                "a package over another message must be refused on the seed path, and for this reason"
            );
        }

        /// A share is checked on its own before it counts: one that does not verify, or is not even
        /// a share, is refused, so it never takes a signer's place.
        #[test]
        fn a_share_is_checked_before_it_counts() {
            let alpha =
                hex::decode("b2ad61e8bf0de877dd01c52356526adf39b036ffed2e0217ece19407e1717624")
                    .unwrap();
            let (shares, pubkeys) = frost::keys::generate_with_dealer(
                3,
                2,
                frost::keys::IdentifierList::Default,
                OsRng,
            )
            .unwrap();
            let kps: std::collections::BTreeMap<_, _> = shares
                .into_iter()
                .map(|(id, s)| (id, KeyPackage::try_from(s).unwrap()))
                .collect();
            let group_vk = *pubkeys.verifying_key();
            let message = b"konclave: a share that does not verify";
            let signers: Vec<_> = kps.iter().take(2).collect();
            let mut local_nonces = Vec::new();
            let mut wire_commitments = Vec::new();
            for (id, kp) in &signers {
                let (nonces, commit_bytes) = participant_round1(kp);
                local_nonces.push(nonces);
                wire_commitments.push((id.serialize(), commit_bytes));
            }
            let sp_bytes = coordinator_signing_package(&wire_commitments, message).unwrap();
            let own_share = participant_round2_with_randomizer(
                &sp_bytes,
                &mut local_nonces[0],
                signers[0].1,
                &alpha,
                message,
            )
            .unwrap();
            let id1 = signers[0].0.serialize();
            let id2 = signers[1].0.serialize();
            let check = |id: &[u8], share: &[u8]| {
                check_share_with_randomizer(&sp_bytes, &group_vk, &alpha, id, share, &pubkeys)
            };
            assert!(
                check(&id1, &own_share).is_ok(),
                "a share that verifies passes"
            );
            // Seat 1's share offered for seat 2: well formed, wrong for seat 2.
            assert!(
                check(&id2, &own_share).is_err(),
                "another signer's share is refused"
            );
            // The wrong length or encoding is refused the same way, before it can take a place.
            assert!(
                check(&id1, &own_share[..own_share.len() - 1]).is_err(),
                "too short"
            );
            assert!(
                check(&id1, &[own_share.clone(), vec![0]].concat()).is_err(),
                "too long"
            );
            assert!(check(&id1, &[0xff; 32]).is_err(), "not a scalar");
            assert!(check(&id1, &[]).is_err(), "empty");
        }

        #[test]
        fn signs_with_a_real_orchard_randomizer() {
            // The alpha of Konclave's real mainnet DKG-vault spend (aab00f90…) - a valid Orchard
            // randomizer. This is the path a real transaction takes: sign under the PCZT's alpha,
            // not a commitment-derived seed, so the signature can be injected and broadcast.
            let alpha =
                hex::decode("b2ad61e8bf0de877dd01c52356526adf39b036ffed2e0217ece19407e1717624")
                    .unwrap();
            let (shares, pubkeys) = frost::keys::generate_with_dealer(
                3,
                2,
                frost::keys::IdentifierList::Default,
                OsRng,
            )
            .unwrap();
            let kps: std::collections::BTreeMap<_, _> = shares
                .into_iter()
                .map(|(id, s)| (id, KeyPackage::try_from(s).unwrap()))
                .collect();
            let group_vk = *pubkeys.verifying_key();
            let message = b"konclave: a real Orchard shielded sighash";

            let signers: Vec<_> = kps.iter().take(2).collect();
            let mut local_nonces = Vec::new();
            let mut wire_commitments = Vec::new();
            for (id, kp) in &signers {
                let (nonces, commit_bytes) = participant_round1(kp);
                local_nonces.push((**id, nonces));
                wire_commitments.push((id.serialize(), commit_bytes));
            }
            let sp_bytes = coordinator_signing_package(&wire_commitments, message).unwrap();

            // Round 2 with the EXPLICIT Orchard alpha (no seed).
            let mut wire_shares = Vec::new();
            for ((id, kp), (_id2, nonces)) in signers.iter().zip(local_nonces.iter_mut()) {
                let share =
                    participant_round2_with_randomizer(&sp_bytes, nonces, kp, &alpha, message)
                        .unwrap();
                wire_shares.push((id.serialize(), share));
            }
            let sig = coordinator_aggregate_with_randomizer(
                &sp_bytes,
                &group_vk,
                &alpha,
                &wire_shares,
                &pubkeys,
            )
            .unwrap();

            // Verifies under ak+alpha (what an Orchard spend commits to)...
            assert!(
                verify_with_randomizer(&group_vk, &alpha, message, &sig).unwrap(),
                "signature must verify under the key randomized by the Orchard alpha"
            );
            // ...and a DIFFERENT randomizer must NOT verify - the alpha binds the signature.
            let other =
                hex::decode("557c4ff828ed56eb33e8ba7f508a43915338ccf3ad71d1ecedc98e6e861bfc0f")
                    .unwrap();
            assert!(
                !verify_with_randomizer(&group_vk, &other, message, &sig).unwrap(),
                "a mismatched randomizer must fail"
            );
        }
    }
}

// ---------- 1c. Distributed Key Generation over the blind relay (Milestone 3) ----------
//
// This is how a vault is BORN across devices, with no trusted dealer and the key never
// reconstituted. Three rounds, and the golden rule is which bytes may cross the wire:
//
//   part1 → a round1 SecretPackage (STAYS on the device) + a round1 Package (PUBLIC, broadcast)
//   part2 → a round2 SecretPackage (STAYS on the device) + one round2 Package PER OTHER member
//           - each is a SECRET share-piece for ONE recipient, and MUST be sealed to that
//           recipient before it touches the relay (that is the confidential channel, below)
//   part3 → combine everything received → this device's KeyPackage (its share) + the shared
//           PublicKeyPackage (the group). Every honest device derives the SAME group key.
//
// Here we exercise the protocol over *serialized* wire bytes (exactly what the relay moves),
// keeping every SecretPackage native/local. Identifiers label the wire (as in `ceremony`).
pub mod dkg {
    use super::*;
    use frost::keys::dkg::{part1, part2, part3, round1, round2};
    use frost::Identifier;

    type E = String;
    fn e<T: core::fmt::Display>(x: T) -> E {
        x.to_string()
    }

    /// One item on the wire: a 32-byte identifier label + serialized package bytes.
    pub type WireItem = (Vec<u8>, Vec<u8>);

    /// The 32-byte wire label for participant number `index` (1-based). Both devices derive
    /// their identifiers this way so everyone agrees on who is who without a central registry.
    pub fn identifier_bytes(index: u16) -> Result<Vec<u8>, E> {
        Ok(Identifier::try_from(index).map_err(e)?.serialize())
    }

    /// Round 1: keep the returned SecretPackage LOCAL; broadcast the returned bytes (public).
    pub fn part1_wire(
        my_id: &[u8],
        max_signers: u16,
        min_signers: u16,
    ) -> Result<(round1::SecretPackage, Vec<u8>), E> {
        let id = Identifier::deserialize(my_id).map_err(e)?;
        let (secret, pkg) = part1(id, max_signers, min_signers, OsRng).map_err(e)?;
        Ok((secret, pkg.serialize().map_err(e)?))
    }

    /// Round 2: consume the round1 secret + the OTHER members' round1 packages `(sender_id,
    /// bytes)`. Returns the round2 secret (kept LOCAL) and one package per recipient
    /// `(recipient_id, bytes)`. Each of those bytes is SECRET and must be sealed to its
    /// recipient before it goes on the relay.
    pub fn part2_wire(
        round1_secret: round1::SecretPackage,
        others_round1: &[WireItem],
    ) -> Result<(round2::SecretPackage, Vec<WireItem>), E> {
        let mut map = BTreeMap::new();
        for (id_b, pkg_b) in others_round1 {
            let id = Identifier::deserialize(id_b).map_err(e)?;
            let pkg = round1::Package::deserialize(pkg_b).map_err(e)?;
            map.insert(id, pkg);
        }
        let (secret2, outgoing) = part2(round1_secret, &map).map_err(e)?;
        let mut wire = Vec::new();
        for (recipient, pkg) in outgoing {
            wire.push((recipient.serialize(), pkg.serialize().map_err(e)?));
        }
        Ok((secret2, wire))
    }

    /// Round 3: combine the OTHER members' round1 packages `(sender_id, bytes)` and the round2
    /// packages addressed TO this device `(sender_id, bytes)` - sender-keyed, opened locally.
    /// Returns this device's serialized KeyPackage (its share) and the group PublicKeyPackage.
    pub fn part3_wire(
        round2_secret: &round2::SecretPackage,
        others_round1: &[WireItem],
        incoming_round2: &[WireItem],
    ) -> Result<(Vec<u8>, Vec<u8>), E> {
        let mut r1 = BTreeMap::new();
        for (id_b, pkg_b) in others_round1 {
            r1.insert(
                Identifier::deserialize(id_b).map_err(e)?,
                round1::Package::deserialize(pkg_b).map_err(e)?,
            );
        }
        let mut r2 = BTreeMap::new();
        for (id_b, pkg_b) in incoming_round2 {
            r2.insert(
                Identifier::deserialize(id_b).map_err(e)?,
                round2::Package::deserialize(pkg_b).map_err(e)?,
            );
        }
        let (kp, pubkeys) = part3(round2_secret, &r1, &r2).map_err(e)?;
        Ok((kp.serialize().map_err(e)?, pubkeys.serialize().map_err(e)?))
    }

    #[cfg(test)]
    mod tests {
        use super::*;
        use frost::keys::{KeyPackage, PublicKeyPackage};

        /// A full 3-party DKG driven entirely over serialized wire bytes (what the relay
        /// carries), then a 2-of-3 signing with the resulting shares - proving the vault the
        /// DKG produced is real and usable, and that the group key is agreed by all.
        #[test]
        fn three_party_dkg_over_the_wire_then_signs() {
            let n: u16 = 3;
            let t: u16 = 2;
            let ids: Vec<Vec<u8>> = (1..=n).map(|i| identifier_bytes(i).unwrap()).collect();

            // --- Round 1: each device keeps its secret, broadcasts its package. ---
            let mut r1_secrets = Vec::new();
            let mut r1_wire: Vec<(Vec<u8>, Vec<u8>)> = Vec::new(); // (id, package bytes)
            for id in &ids {
                let (secret, pkg) = part1_wire(id, n, t).unwrap();
                r1_secrets.push(secret);
                r1_wire.push((id.clone(), pkg));
            }

            // --- Round 2: each device consumes OTHERS' round1, emits a package per recipient. ---
            // round2_inbox[recipient_id] = Vec<(sender_id, package bytes)>  (sender-keyed at the recipient)
            let mut r2_secrets = Vec::new();
            let mut r2_inbox: std::collections::HashMap<Vec<u8>, Vec<WireItem>> =
                std::collections::HashMap::new();
            for (i, id) in ids.iter().enumerate() {
                let others_r1: Vec<(Vec<u8>, Vec<u8>)> = r1_wire
                    .iter()
                    .filter(|(oid, _)| oid != id)
                    .cloned()
                    .collect();
                let secret = r1_secrets.remove(0); // consume in order (part2 takes it by value)
                let (secret2, outgoing) = part2_wire(secret, &others_r1).unwrap();
                r2_secrets.push(secret2);
                // Route each outgoing (recipient, pkg) into that recipient's inbox, tagged by ME.
                for (recipient, pkg) in outgoing {
                    r2_inbox
                        .entry(recipient)
                        .or_default()
                        .push((id.clone(), pkg));
                }
                let _ = i;
            }

            // --- Round 3: each device combines what it received → its share + the group key. ---
            let mut group_keys = Vec::new();
            let mut key_packages = std::collections::BTreeMap::new();
            let mut pubkeys_bytes = None;
            for (i, id) in ids.iter().enumerate() {
                let others_r1: Vec<(Vec<u8>, Vec<u8>)> = r1_wire
                    .iter()
                    .filter(|(oid, _)| oid != id)
                    .cloned()
                    .collect();
                let incoming_r2 = r2_inbox.get(id).cloned().unwrap_or_default();
                let (kp_bytes, pk_bytes) =
                    part3_wire(&r2_secrets[i], &others_r1, &incoming_r2).unwrap();
                let kp = KeyPackage::deserialize(&kp_bytes).unwrap();
                let pubkeys = PublicKeyPackage::deserialize(&pk_bytes).unwrap();
                group_keys.push(pubkeys.verifying_key().serialize().unwrap());
                key_packages.insert(Identifier::deserialize(id).unwrap(), kp);
                pubkeys_bytes = Some(pk_bytes);
            }

            // Everyone agreed on the SAME group verifying key (the vault's identity).
            assert!(
                group_keys.windows(2).all(|w| w[0] == w[1]),
                "all DKG participants must derive the same group key"
            );

            // The shares actually sign: a 2-of-3 rerandomized redpallas ceremony verifies.
            let pubkeys = PublicKeyPackage::deserialize(&pubkeys_bytes.unwrap()).unwrap();
            let group_vk = *pubkeys.verifying_key();
            let message = b"konclave: a DKG-born vault signs";
            let signers: Vec<_> = key_packages.iter().take(t as usize).collect();
            let mut local_nonces = Vec::new();
            let mut wire_commitments = Vec::new();
            for (id, kp) in &signers {
                let (nonces, commit_bytes) = super::super::ceremony::participant_round1(kp);
                local_nonces.push((**id, nonces));
                wire_commitments.push((id.serialize(), commit_bytes));
            }
            let sp =
                super::super::ceremony::coordinator_signing_package(&wire_commitments, message)
                    .unwrap();
            let seed = super::super::ceremony::coordinator_randomizer_seed(&group_vk, &sp).unwrap();
            let mut wire_shares = Vec::new();
            for ((id, kp), (_id2, nonces)) in signers.iter().zip(local_nonces.iter_mut()) {
                let share =
                    super::super::ceremony::participant_round2(&sp, nonces, kp, &seed, message)
                        .unwrap();
                wire_shares.push((id.serialize(), share));
            }
            let sig = super::super::ceremony::coordinator_aggregate(
                &sp,
                &group_vk,
                &seed,
                &wire_shares,
                &pubkeys,
            )
            .unwrap();
            assert!(
                super::super::ceremony::verify(&group_vk, &sp, &seed, message, &sig).unwrap(),
                "a vault created by DKG must produce a verifying FROST signature"
            );
        }
    }
}

// ---------- Vault creation, version 2: what every member confirms is what the DKG consumes ----------
//
// One device's side of creating a vault. Every input the DKG uses (each seat's encryption key, name and
// round-1 package) enters through `add_member`/`add_reveal`, is bound into one transcript, and becomes
// a short code the members compare out of band. Round 2 runs only after `confirm` with that code, and it
// seals each package itself, to the key in the transcript, so no caller ever holds a round-2 package in
// the clear or can seal it to another key. Each seat commits to its round 1 before anyone reveals, so
// nobody who sees the others' material can choose its own to land on a matching code.
pub mod creation {
    use super::*;
    use frost::keys::dkg::{part1, part2, part3, round1, round2};
    use frost::Identifier;

    type E = String;
    fn e<T: core::fmt::Display>(x: T) -> E {
        x.to_string()
    }

    const COMMIT_PERSONAL: &[u8; 16] = b"konclaveDkgCmt2\0";
    const TRANSCRIPT_PERSONAL: &[u8; 16] = b"konclaveDkgTr2\0\0";
    const CROCKFORD: &[u8; 32] = b"0123456789ABCDEFGHJKMNPQRSTVWXYZ";
    const MAX_NAME: usize = 256; // bytes; the UI caps names at 64 characters

    fn lp(h: &mut blake2b_simd::State, x: &[u8]) {
        h.update(&(x.len() as u32).to_be_bytes());
        h.update(x);
    }

    fn hasher(personal: &[u8; 16]) -> blake2b_simd::State {
        blake2b_simd::Params::new()
            .hash_length(32)
            .personal(personal)
            .to_state()
    }

    fn id(seat: u16) -> Result<Identifier, E> {
        Identifier::try_from(seat).map_err(e)
    }

    /// The commitment a seat posts before anyone reveals: binds its key, its round 1 and a nonce.
    pub fn commitment(seat: u16, enc_pub: &[u8], r1: &[u8], nonce: &[u8]) -> [u8; 32] {
        let mut h = hasher(COMMIT_PERSONAL);
        h.update(&seat.to_be_bytes());
        lp(&mut h, enc_pub);
        lp(&mut h, r1);
        lp(&mut h, nonce);
        h.finalize().as_bytes().try_into().expect("32 bytes")
    }

    /// The 9-character code (about 45 bits) the members read to each other: 3-3-3, Crockford base32.
    pub fn code_of(digest: &[u8]) -> String {
        let mut out = String::new();
        let (mut bits, mut value) = (0u32, 0u64);
        for b in digest {
            value = (value << 8) | *b as u64;
            bits += 8;
            while bits >= 5 && out.len() < 9 {
                bits -= 5;
                out.push(CROCKFORD[((value >> bits) & 31) as usize] as char);
            }
            if out.len() == 9 {
                break;
            }
        }
        format!("{}-{}-{}", &out[0..3], &out[3..6], &out[6..9])
    }

    fn normalise(code: &str) -> String {
        code.chars()
            .filter(|c| c.is_ascii_alphanumeric())
            .map(|c| c.to_ascii_uppercase())
            .collect()
    }

    fn aad(kind: &str, from: u16, to: u16) -> Vec<u8> {
        let mut a = format!("konclave-dkg-v2 {kind} ").into_bytes();
        a.extend_from_slice(&from.to_be_bytes());
        a.extend_from_slice(&to.to_be_bytes());
        a
    }

    struct Member {
        enc_pub: [u8; 32],
        name: String,
        commit: [u8; 32],
        reveal: Option<(Vec<u8>, [u8; 32])>, // (round-1 package, nonce)
    }

    pub struct Creation {
        my_seat: u16,
        /// The name this device announced for itself (what its owner typed). The code binds every
        /// seat's name, so this seat's announcement is held to it like its key and commitment.
        my_name: String,
        n: u16,
        t: u16,
        device: seal::DeviceKey,
        r1_secret: Option<round1::SecretPackage>,
        r1: Vec<u8>,
        nonce: [u8; 32],
        members: BTreeMap<u16, Member>,
        code: Option<String>,
        confirmed: bool,
        r2_secret: Option<round2::SecretPackage>,
        r2_in: BTreeMap<u16, Vec<u8>>,
        key_package: Vec<u8>,
        pubkeys: Vec<u8>,
        group_vk: Vec<u8>,
    }

    impl Creation {
        /// Seated: run round 1 and draw the nonce. `device_secret` is the key whose public half
        /// this device announced in its hello.
        pub fn new(
            device_secret: &[u8; 32],
            my_seat: u16,
            n: u16,
            t: u16,
            my_name: &str,
        ) -> Result<Self, E> {
            if !(2..=32).contains(&n) || t < 1 || t > n || my_seat < 1 || my_seat > n {
                return Err("invalid seat or quorum".into());
            }
            let (secret, pkg) = part1(id(my_seat)?, n, t, OsRng).map_err(e)?;
            let mut nonce = [0u8; 32];
            rand::RngCore::fill_bytes(&mut OsRng, &mut nonce);
            Ok(Creation {
                my_seat,
                my_name: my_name.to_string(),
                n,
                t,
                device: seal::DeviceKey::from_secret_bytes(device_secret),
                r1_secret: Some(secret),
                r1: pkg.serialize().map_err(e)?,
                nonce,
                members: BTreeMap::new(),
                code: None,
                confirmed: false,
                r2_secret: None,
                r2_in: BTreeMap::new(),
                key_package: vec![],
                pubkeys: vec![],
                group_vk: vec![],
            })
        }

        pub fn my_commitment(&self) -> [u8; 32] {
            commitment(
                self.my_seat,
                &self.device.public_bytes(),
                &self.r1,
                &self.nonce,
            )
        }
        /// Revealed only after this device has seen every seat's commitment.
        pub fn my_reveal(&self) -> (Vec<u8>, [u8; 32]) {
            (self.r1.clone(), self.nonce)
        }

        /// A seat's announced key and name, and its commitment. Once per seat, before the code.
        pub fn add_member(
            &mut self,
            seat: u16,
            enc_pub: &[u8],
            name: &str,
            commit: &[u8],
        ) -> Result<(), E> {
            if self.code.is_some() {
                return Err("the roster is closed".into());
            }
            if seat < 1 || seat > self.n || self.members.contains_key(&seat) {
                return Err("unknown or repeated seat".into());
            }
            if name.len() > MAX_NAME {
                return Err("name too long".into());
            }
            let enc_pub: [u8; 32] = enc_pub.try_into().map_err(|_| "key must be 32 bytes")?;
            let commit: [u8; 32] = commit
                .try_into()
                .map_err(|_| "commitment must be 32 bytes")?;
            if seat == self.my_seat
                && (enc_pub != self.device.public_bytes()
                    || commit != self.my_commitment()
                    || name != self.my_name)
            {
                return Err("this seat's announcement is not this device's".into());
            }
            self.members.insert(
                seat,
                Member {
                    enc_pub,
                    name: name.to_string(),
                    commit,
                    reveal: None,
                },
            );
            Ok(())
        }

        /// True once every seat has a commitment: the moment this device may reveal.
        pub fn all_committed(&self) -> bool {
            self.members.len() == self.n as usize
        }

        /// A seat's round 1 and nonce, checked against its commitment. Refused before every seat
        /// has committed, so no one can reveal in reply to another's reveal.
        pub fn add_reveal(&mut self, seat: u16, r1: &[u8], nonce: &[u8]) -> Result<(), E> {
            if !self.all_committed() {
                return Err("reveal before every seat committed".into());
            }
            let m = self.members.get_mut(&seat).ok_or("unknown seat")?;
            if m.reveal.is_some() {
                return Err("repeated reveal".into());
            }
            if commitment(seat, &m.enc_pub, r1, nonce) != m.commit {
                return Err("reveal does not match its commitment".into());
            }
            round1::Package::deserialize(r1).map_err(e)?;
            m.reveal = Some((
                r1.to_vec(),
                nonce.try_into().map_err(|_| "nonce must be 32 bytes")?,
            ));
            Ok(())
        }

        /// Close the roster and return the code. Binds the room, the quorum, the governance, the
        /// vault's name, the creator's seat and name and, per seat, its key, name, round 1 and
        /// nonce, each length-prefixed, so every device that shows the code agrees on all of them.
        pub fn freeze(
            &mut self,
            room: &[u8],
            governance: &str,
            vault_name: &str,
            creator_name: &str,
            creator_seat: u16,
        ) -> Result<String, E> {
            if let Some(c) = &self.code {
                return Ok(c.clone());
            }
            if !self.all_committed() || self.members.values().any(|m| m.reveal.is_none()) {
                return Err("not every seat has revealed".into());
            }
            if !self.members.contains_key(&creator_seat) {
                return Err("the creator has no seat".into());
            }
            let mut h = hasher(TRANSCRIPT_PERSONAL);
            lp(&mut h, room);
            h.update(&self.n.to_be_bytes());
            h.update(&self.t.to_be_bytes());
            lp(&mut h, governance.as_bytes());
            lp(&mut h, vault_name.as_bytes());
            lp(&mut h, creator_name.as_bytes());
            h.update(&creator_seat.to_be_bytes());
            for (seat, m) in &self.members {
                let (r1, nonce) = m.reveal.as_ref().expect("checked");
                h.update(&seat.to_be_bytes());
                lp(&mut h, &m.enc_pub);
                lp(&mut h, m.name.as_bytes());
                lp(&mut h, r1);
                lp(&mut h, nonce);
            }
            let code = code_of(h.finalize().as_bytes());
            self.code = Some(code.clone());
            Ok(code)
        }

        pub fn code(&self) -> Option<String> {
            self.code.clone()
        }

        /// Unlocks round 2. This orders the protocol (no round 2 and no sealing before a code
        /// exists and is presented back); it is not the check itself. The app passes the device's
        /// own code once the members have compared it with every listed person on the screen: the
        /// gate against a changed view is that human comparison, which this cannot replace.
        pub fn confirm(&mut self, code: &str) -> Result<(), E> {
            match &self.code {
                Some(c) if normalise(c) == normalise(code) => {
                    self.confirmed = true;
                    Ok(())
                }
                Some(_) => Err("that code is not this vault's".into()),
                None => Err("no code yet".into()),
            }
        }

        /// Round 2: one package per other seat, each sealed to the key in the transcript.
        pub fn part2(&mut self) -> Result<Vec<(u16, Vec<u8>)>, E> {
            if !self.confirmed {
                return Err("round 2 before the code was confirmed".into());
            }
            let secret = self.r1_secret.take().ok_or("round 2 already ran")?;
            let mut others = BTreeMap::new();
            for (seat, m) in &self.members {
                if *seat == self.my_seat {
                    continue;
                }
                let (r1, _) = m.reveal.as_ref().expect("frozen");
                others.insert(id(*seat)?, round1::Package::deserialize(r1).map_err(e)?);
            }
            let (secret2, outgoing) = part2(secret, &others).map_err(e)?;
            self.r2_secret = Some(secret2);
            let mut out = Vec::new();
            for (seat, m) in &self.members {
                if *seat == self.my_seat {
                    continue;
                }
                let pkg = outgoing.get(&id(*seat)?).ok_or("missing round-2 package")?;
                let bytes = pkg.serialize().map_err(e)?;
                out.push((
                    *seat,
                    seal::seal(&m.enc_pub, &bytes, &aad("r2", self.my_seat, *seat))?,
                ));
            }
            Ok(out)
        }

        /// A round-2 box from another seat. Returns true when round 3 has completed.
        pub fn add_round2(&mut self, from: u16, sealed: &[u8]) -> Result<bool, E> {
            if self.r2_secret.is_none() {
                return Err("round 2 box before this device's round 2".into());
            }
            if from == self.my_seat
                || !self.members.contains_key(&from)
                || self.r2_in.contains_key(&from)
            {
                return Err("round 2 box from an unknown or repeated seat".into());
            }
            let opened = seal::open(&self.device, sealed, &aad("r2", from, self.my_seat))?;
            let pkg = round2::Package::deserialize(&opened).map_err(e)?;
            // The share must be the sender's polynomial at this seat, per the commitment it revealed;
            // a box that is not is refused before it is kept, so it cannot take the sender's place.
            let (r1, _) = self.members[&from].reveal.as_ref().expect("frozen");
            let commitment = round1::Package::deserialize(r1)
                .map_err(e)?
                .commitment()
                .clone();
            frost::keys::SecretShare::new(id(self.my_seat)?, *pkg.signing_share(), commitment)
                .verify()
                .map_err(|_| "round 2 share does not match its sender's commitment")?;
            self.r2_in.insert(from, opened);
            if self.r2_in.len() < self.n as usize - 1 {
                return Ok(false);
            }
            let mut r1 = BTreeMap::new();
            let mut r2 = BTreeMap::new();
            for (seat, m) in &self.members {
                if *seat == self.my_seat {
                    continue;
                }
                let (pkg, _) = m.reveal.as_ref().expect("frozen");
                r1.insert(id(*seat)?, round1::Package::deserialize(pkg).map_err(e)?);
                r2.insert(
                    id(*seat)?,
                    round2::Package::deserialize(&self.r2_in[seat]).map_err(e)?,
                );
            }
            let (kp, pk) = part3(self.r2_secret.as_ref().expect("checked"), &r1, &r2)
                .map_err(|x| format!("round 3 failed: {x}"))?;
            self.group_vk = pk.verifying_key().serialize().map_err(e)?;
            self.key_package = kp.serialize().map_err(e)?;
            self.pubkeys = pk.serialize().map_err(e)?;
            Ok(true)
        }

        /// Seal a payload (the vault secret) to a seat's key from the transcript. Confirmed only.
        pub fn seal_to_seat(&self, to: u16, payload: &[u8]) -> Result<Vec<u8>, E> {
            if !self.confirmed {
                return Err("sealing before the code was confirmed".into());
            }
            let m = self
                .members
                .get(&to)
                .filter(|_| to != self.my_seat)
                .ok_or("unknown seat")?;
            seal::seal(&m.enc_pub, payload, &aad("vsec", self.my_seat, to))
        }

        pub fn open_from_seat(&self, from: u16, sealed: &[u8]) -> Result<Vec<u8>, E> {
            if !self.confirmed || !self.members.contains_key(&from) {
                return Err("not from a confirmed seat".into());
            }
            seal::open(&self.device, sealed, &aad("vsec", from, self.my_seat))
        }

        pub fn done(&self) -> bool {
            !self.group_vk.is_empty()
        }
        pub fn key_package(&self) -> Vec<u8> {
            self.key_package.clone()
        }
        pub fn pubkeys(&self) -> Vec<u8> {
            self.pubkeys.clone()
        }
        pub fn group_vk(&self) -> Vec<u8> {
            self.group_vk.clone()
        }
        pub fn names(&self) -> Vec<String> {
            self.members.values().map(|m| m.name.clone()).collect()
        }
    }

    #[cfg(test)]
    mod tests {
        use super::*;

        struct Dev {
            secret: [u8; 32],
            c: Creation,
        }

        fn devices(n: u16, t: u16) -> Vec<Dev> {
            (1..=n)
                .map(|seat| {
                    let secret = seal::DeviceKey::generate().secret_bytes();
                    Dev {
                        secret,
                        c: Creation::new(&secret, seat, n, t, &format!("m{seat}")).unwrap(),
                    }
                })
                .collect()
        }

        fn pub_of(d: &Dev) -> [u8; 32] {
            seal::DeviceKey::from_secret_bytes(&d.secret).public_bytes()
        }

        /// Everyone sees the same roster and reveals: returns each device's code.
        fn exchange(ds: &mut [Dev]) -> Vec<String> {
            let ann: Vec<_> = ds
                .iter()
                .enumerate()
                .map(|(i, d)| {
                    (
                        (i + 1) as u16,
                        pub_of(d),
                        d.c.my_commitment(),
                        d.c.my_reveal(),
                    )
                })
                .collect();
            for d in ds.iter_mut() {
                for (seat, pk, cm, _) in &ann {
                    d.c.add_member(*seat, pk, &format!("m{seat}"), cm).unwrap();
                }
                for (seat, _, _, (r1, nonce)) in &ann {
                    d.c.add_reveal(*seat, r1, nonce).unwrap();
                }
            }
            ds.iter_mut()
                .map(|d| d.c.freeze(b"room", "quorum", "v", "m1", 1).unwrap())
                .collect()
        }

        fn finish(ds: &mut [Dev]) {
            let mut boxes = Vec::new();
            for (i, d) in ds.iter_mut().enumerate() {
                for (to, b) in d.c.part2().unwrap() {
                    boxes.push(((i + 1) as u16, to, b));
                }
            }
            for (from, to, b) in boxes {
                ds[to as usize - 1].c.add_round2(from, &b).unwrap();
            }
        }

        #[test]
        fn honest_members_get_one_code_and_one_vault() {
            for (n, t) in [(2, 2), (3, 2), (5, 3)] {
                let mut ds = devices(n, t);
                let codes = exchange(&mut ds);
                assert!(codes.windows(2).all(|w| w[0] == w[1]));
                for d in ds.iter_mut() {
                    d.c.confirm(&codes[0].to_lowercase().replace('-', " "))
                        .unwrap();
                }
                finish(&mut ds);
                assert!(ds
                    .iter()
                    .all(|d| d.c.done() && d.c.group_vk() == ds[0].c.group_vk()));
            }
        }

        #[test]
        fn round_two_waits_for_the_right_code() {
            let mut ds = devices(3, 2);
            let codes = exchange(&mut ds);
            assert!(ds[0].c.part2().is_err(), "no round 2 before confirm");
            assert!(ds[0].c.confirm("000-000-000").is_err());
            assert!(ds[0].c.part2().is_err(), "a wrong code unlocks nothing");
            assert!(ds[0].c.seal_to_seat(2, b"s").is_err());
            ds[0].c.confirm(&codes[0]).unwrap();
            assert_eq!(ds[0].c.part2().unwrap().len(), 2);
        }

        #[test]
        fn a_key_swapped_in_one_view_changes_that_view_code() {
            let mut ds = devices(3, 2);
            let ann: Vec<_> = ds
                .iter()
                .enumerate()
                .map(|(i, d)| {
                    (
                        (i + 1) as u16,
                        pub_of(d),
                        d.c.my_commitment(),
                        d.c.my_reveal(),
                    )
                })
                .collect();
            // In device 1's view, seat 2 carries an outsider's key (with a commitment that matches it).
            let outsider = seal::DeviceKey::generate().public_bytes();
            let swapped = commitment(2, &outsider, &ann[1].3 .0, &ann[1].3 .1);
            for (i, d) in ds.iter_mut().enumerate() {
                for (seat, pk, cm, _) in &ann {
                    let (pk, cm) = if i == 0 && *seat == 2 {
                        (outsider, swapped)
                    } else {
                        (*pk, *cm)
                    };
                    d.c.add_member(*seat, &pk, &format!("m{seat}"), &cm)
                        .unwrap();
                }
                for (seat, _, _, (r1, nonce)) in &ann {
                    d.c.add_reveal(*seat, r1, nonce).unwrap();
                }
            }
            let codes: Vec<_> = ds
                .iter_mut()
                .map(|d| d.c.freeze(b"room", "quorum", "v", "m1", 1).unwrap())
                .collect();
            assert_ne!(codes[0], codes[1]);
            assert_eq!(codes[1], codes[2]);
        }

        #[test]
        fn a_different_round_one_in_one_view_changes_that_view_code() {
            let mut ds = devices(3, 2);
            let ann: Vec<_> = ds
                .iter()
                .enumerate()
                .map(|(i, d)| {
                    (
                        (i + 1) as u16,
                        pub_of(d),
                        d.c.my_commitment(),
                        d.c.my_reveal(),
                    )
                })
                .collect();
            // In device 1's view, seat 3 committed to and revealed another round 1 (same key).
            let (r1x, nx) =
                Creation::new(&seal::DeviceKey::generate().secret_bytes(), 3, 3, 2, "m3")
                    .unwrap()
                    .my_reveal();
            let cx = commitment(3, &ann[2].1, &r1x, &nx);
            for (i, d) in ds.iter_mut().enumerate() {
                let view = |seat: u16| {
                    if i == 0 && seat == 3 {
                        (cx, r1x.clone(), nx)
                    } else {
                        let a = &ann[seat as usize - 1];
                        (a.2, a.3 .0.clone(), a.3 .1)
                    }
                };
                for (seat, pk, _, _) in &ann {
                    d.c.add_member(*seat, pk, &format!("m{seat}"), &view(*seat).0)
                        .unwrap();
                }
                for (seat, _, _, _) in &ann {
                    let (_, r1, nonce) = view(*seat);
                    d.c.add_reveal(*seat, &r1, &nonce).unwrap();
                }
            }
            let codes: Vec<_> = ds
                .iter_mut()
                .map(|d| d.c.freeze(b"room", "quorum", "v", "m1", 1).unwrap())
                .collect();
            assert_ne!(codes[0], codes[1]);
            assert_eq!(codes[1], codes[2]);
        }

        #[test]
        fn commit_and_reveal_are_enforced() {
            let mut ds = devices(2, 2);
            let a = (pub_of(&ds[0]), ds[0].c.my_commitment(), ds[0].c.my_reveal());
            let b = (pub_of(&ds[1]), ds[1].c.my_commitment(), ds[1].c.my_reveal());
            let d = &mut ds[0].c;
            d.add_member(1, &a.0, "m1", &a.1).unwrap();
            assert!(
                d.add_reveal(1, &a.2 .0, &a.2 .1).is_err(),
                "no reveal before every seat committed"
            );
            assert!(
                d.add_member(1, &a.0, "m1", &a.1).is_err(),
                "a seat commits once"
            );
            d.add_member(2, &b.0, "m2", &b.1).unwrap();
            assert!(
                d.add_reveal(2, &a.2 .0, &b.2 .1).is_err(),
                "a reveal must match its commitment"
            );
            d.add_reveal(2, &b.2 .0, &b.2 .1).unwrap();
            assert!(
                d.add_reveal(2, &b.2 .0, &b.2 .1).is_err(),
                "a seat reveals once"
            );
            assert!(
                d.freeze(b"room", "quorum", "v", "a", 1).is_err(),
                "not every seat revealed"
            );
            d.add_reveal(1, &a.2 .0, &a.2 .1).unwrap();
            d.freeze(b"room", "quorum", "v", "a", 1).unwrap();
            assert!(
                d.add_member(2, &b.0, "m2", &b.1).is_err(),
                "the roster is closed"
            );
        }

        /// The code the members compare binds every seat's name, so a device also refuses a
        /// transcript that gives ITS OWN seat a name other than the one its owner typed.
        #[test]
        fn this_device_seat_must_carry_its_own_name() {
            let mut ds = devices(2, 2);
            let pk = pub_of(&ds[0]);
            let cm = ds[0].c.my_commitment();
            assert_eq!(
                ds[0].c.add_member(1, &pk, "someone else", &cm).unwrap_err(),
                "this seat's announcement is not this device's",
                "own key and commitment, another name"
            );
            // The refusal left the seat free: the right announcement is still taken.
            assert!(ds[0].c.add_member(1, &pk, "m1", &cm).is_ok());
            let other = pub_of(&ds[1]);
            let ocm = ds[1].c.my_commitment();
            assert!(ds[0].c.add_member(2, &other, "anything", &ocm).is_ok());
        }

        #[test]
        fn this_device_seat_must_carry_its_own_key() {
            let mut ds = devices(2, 2);
            let other = seal::DeviceKey::generate().public_bytes();
            let cm = ds[0].c.my_commitment();
            assert!(ds[0].c.add_member(1, &other, "m1", &cm).is_err());
        }

        #[test]
        fn every_transcript_field_changes_the_code() {
            let d = devices(3, 2);
            let ann: Vec<_> = d
                .iter()
                .enumerate()
                .map(|(i, x)| {
                    (
                        (i + 1) as u16,
                        pub_of(x),
                        x.c.my_commitment(),
                        x.c.my_reveal(),
                    )
                })
                .collect();
            // Seat 2's view of the same material, frozen over one changed field at a time.
            #[derive(Clone)]
            struct V<'a> {
                names: [&'a str; 3],
                room: &'a [u8],
                gov: &'a str,
                vn: &'a str,
                cn: &'a str,
                creator: u16,
                t: u16,
                nonce1: Option<[u8; 32]>,
                r1_1: Option<Vec<u8>>,
                pub1: Option<[u8; 32]>,
            }
            // Another round 1 and another key for seat 1, each with a commitment that matches it.
            let other_r1 =
                Creation::new(&seal::DeviceKey::generate().secret_bytes(), 1, 3, 2, "m1")
                    .unwrap()
                    .my_reveal()
                    .0;
            let other_pub = seal::DeviceKey::generate().public_bytes();
            let base = V {
                names: ["a", "b", "c"],
                room: b"r",
                gov: "quorum",
                vn: "v",
                cn: "a",
                creator: 1,
                t: 2,
                nonce1: None,
                r1_1: None,
                pub1: None,
            };
            let code = |v: V| {
                let mut o = Creation::new(&d[1].secret, 2, 3, v.t, v.names[1]).unwrap();
                o.r1 = ann[1].3 .0.clone();
                o.nonce = ann[1].3 .1;
                let seat1 = |i: usize, r1: &Vec<u8>, n: &[u8; 32], pk: &[u8; 32]| {
                    if i == 0 {
                        (
                            v.r1_1.clone().unwrap_or(r1.clone()),
                            v.nonce1.unwrap_or(*n),
                            v.pub1.unwrap_or(*pk),
                        )
                    } else {
                        (r1.clone(), *n, *pk)
                    }
                };
                for (i, (seat, pk, _, (r1, n))) in ann.iter().enumerate() {
                    let (r1, n, pk) = seat1(i, r1, n, pk);
                    o.add_member(*seat, &pk, v.names[i], &commitment(*seat, &pk, &r1, &n))
                        .unwrap();
                }
                for (i, (seat, pk, _, (r1, n))) in ann.iter().enumerate() {
                    let (r1, n, _) = seat1(i, r1, n, pk);
                    o.add_reveal(*seat, &r1, &n).unwrap();
                }
                o.freeze(v.room, v.gov, v.vn, v.cn, v.creator).unwrap()
            };
            let reference = code(base.clone());
            assert_eq!(reference, code(base.clone()), "deterministic");
            assert_ne!(
                reference,
                code(V {
                    names: ["a", "x", "c"],
                    ..base.clone()
                }),
                "a name"
            );
            assert_ne!(
                reference,
                code(V {
                    names: ["ab", "", "c"],
                    ..base.clone()
                }),
                "a name boundary"
            );
            assert_ne!(
                reference,
                code(V {
                    room: b"s",
                    ..base.clone()
                }),
                "the room"
            );
            assert_ne!(
                reference,
                code(V {
                    gov: "open",
                    ..base.clone()
                }),
                "the governance"
            );
            assert_ne!(
                reference,
                code(V {
                    cn: "b",
                    ..base.clone()
                }),
                "the creator's name"
            );
            assert_ne!(
                reference,
                code(V {
                    vn: "w",
                    ..base.clone()
                }),
                "the vault's name"
            );
            assert_ne!(
                reference,
                code(V {
                    creator: 2,
                    ..base.clone()
                }),
                "the creator's seat"
            );
            assert_ne!(
                reference,
                code(V {
                    t: 3,
                    ..base.clone()
                }),
                "the quorum"
            );
            assert_ne!(
                reference,
                code(V {
                    nonce1: Some([7u8; 32]),
                    ..base.clone()
                }),
                "a nonce"
            );
            assert_ne!(
                reference,
                code(V {
                    r1_1: Some(other_r1.clone()),
                    ..base.clone()
                }),
                "a round 1, same nonce"
            );
            assert_ne!(
                reference,
                code(V {
                    pub1: Some(other_pub),
                    ..base.clone()
                }),
                "a key, same round 1"
            );
            // Adjacent fields: without length prefixes these two would hash the same bytes.
            assert_ne!(
                code(V {
                    vn: "ab",
                    cn: "",
                    ..base.clone()
                }),
                code(V {
                    vn: "a",
                    cn: "b",
                    ..base.clone()
                }),
                "a field boundary"
            );
        }

        #[test]
        fn a_round_two_box_that_is_not_the_senders_share_is_refused_and_does_not_take_its_place() {
            let mut ds = devices(3, 2);
            let codes = exchange(&mut ds);
            for d in ds.iter_mut() {
                d.c.confirm(&codes[0]).unwrap();
            }
            let honest = ds[0]
                .c
                .part2()
                .unwrap()
                .into_iter()
                .find(|(to, _)| *to == 2)
                .unwrap()
                .1;
            ds[1].c.part2().unwrap();
            // Anyone can seal to seat 2's public key: a box with someone else's share for seat 2.
            let mut other = devices(3, 2);
            let oc = exchange(&mut other);
            other[0].c.confirm(&oc[0]).unwrap();
            let foreign = other[0]
                .c
                .part2()
                .unwrap()
                .into_iter()
                .find(|(to, _)| *to == 2)
                .unwrap()
                .1;
            let opened = seal::open(
                &seal::DeviceKey::from_secret_bytes(&other[1].secret),
                &foreign,
                &aad("r2", 1, 2),
            )
            .unwrap();
            let forged = seal::seal(&pub_of(&ds[1]), &opened, &aad("r2", 1, 2)).unwrap();
            assert!(
                ds[1].c.add_round2(1, &forged).is_err(),
                "not the sender's polynomial at this seat"
            );
            assert!(
                !ds[1].c.add_round2(1, &honest).unwrap(),
                "the honest box is still taken"
            );
        }

        #[test]
        fn round_two_boxes_come_only_from_roster_seats_and_open_only_for_their_recipient() {
            let mut ds = devices(3, 2);
            let codes = exchange(&mut ds);
            for d in ds.iter_mut() {
                d.c.confirm(&codes[0]).unwrap();
            }
            let to2 = ds[0]
                .c
                .part2()
                .unwrap()
                .into_iter()
                .find(|(to, _)| *to == 2)
                .unwrap()
                .1;
            assert!(
                ds[1].c.add_round2(1, &to2).is_err(),
                "not before this device's own round 2"
            );
            ds[1].c.part2().unwrap();
            ds[2].c.part2().unwrap();
            assert!(
                ds[2].c.add_round2(1, &to2).is_err(),
                "a box for seat 2 does not open at seat 3"
            );
            assert!(ds[1].c.add_round2(4, &to2).is_err(), "no seat 4");
            assert!(ds[1].c.add_round2(2, &to2).is_err(), "not from itself");
            assert!(
                ds[1].c.add_round2(3, &to2).is_err(),
                "not under another sender's label"
            );
            assert!(!ds[1].c.add_round2(1, &to2).unwrap());
            assert!(ds[1].c.add_round2(1, &to2).is_err(), "once per seat");
            // Boxes that do open (the right label) but come from outside the roster, or from itself.
            let pkg = seal::open(
                &seal::DeviceKey::from_secret_bytes(&ds[1].secret),
                &to2,
                &aad("r2", 1, 2),
            )
            .unwrap();
            let from4 = seal::seal(&pub_of(&ds[1]), &pkg, &aad("r2", 4, 2)).unwrap();
            assert!(
                ds[1].c.add_round2(4, &from4).is_err(),
                "seat 4 is not in the roster"
            );
            let from2 = seal::seal(&pub_of(&ds[1]), &pkg, &aad("r2", 2, 2)).unwrap();
            assert!(ds[1].c.add_round2(2, &from2).is_err(), "not from itself");
        }
    }
}

// ---------- Social recovery: repair a lost share (Repairable Threshold Scheme) ----------
//
// Steward has this; now so do we. When a member loses their device, a QUORUM of the others
// helps rebuild that member's share - the group key is never touched, no share is revealed to
// anyone, and the repaired share is byte-identical to the lost one (repair in place). This is
// the RTS of <https://eprint.iacr.org/2017/1155>, which frost-core ships as `repair_share_*`.
// Only "delta"/"sigma" scalars cross between helpers (blindable public material), so this rides
// the same blind relay as the DKG and the signing.
pub mod recovery {
    use super::*;
    use frost::keys::repairable::{
        repair_share_part1, repair_share_part2, repair_share_part3, Delta, Sigma,
    };
    use frost::keys::KeyPackage;
    use frost::Identifier;

    /// One wire item: a 32-byte identifier label + serialized bytes (a delta or a package).
    pub type WirePair = (Vec<u8>, Vec<u8>);

    /// A helper's round-1 output for repairing `lost`'s share: one Delta per helper (keyed by
    /// recipient). Takes the helper's own KeyPackage (what the DKG produced). Over the relay each
    /// Delta serializes to 32 bytes and is sealed to its recipient - the same blind path as DKG.
    pub fn helper_deltas(
        helpers: &[Identifier],
        helper_kp: &KeyPackage,
        lost: Identifier,
    ) -> Result<std::collections::BTreeMap<Identifier, Delta>, String> {
        repair_share_part1::<frost::PallasBlake2b512, _>(helpers, helper_kp, &mut OsRng, lost)
            .map_err(|e| e.to_string())
    }

    /// A helper sums the Deltas it received (from every helper) into its Sigma.
    pub fn helper_sigma(deltas: &[Delta]) -> Sigma {
        repair_share_part2(deltas)
    }

    /// Combine the helpers' Sigmas into the repaired member's KeyPackage. The group key and the
    /// other members' shares are untouched; the repaired share is the same one that was lost.
    pub fn repaired_key_package(
        sigmas: &[Sigma],
        lost: Identifier,
        pubkeys: &frost::keys::PublicKeyPackage,
    ) -> Result<KeyPackage, String> {
        let kp = repair_share_part3(sigmas, lost, pubkeys).map_err(|e| e.to_string())?;
        // Validate at the boundary (§6.8): repair_share_part3 does NOT check its result, so a
        // wrong or malicious helper set would yield a silently-wrong share. The repaired share
        // must match the group's known public share for that member, or we refuse it.
        let expected = pubkeys
            .verifying_shares()
            .get(&lost)
            .ok_or_else(|| "recovery: unknown member for this vault".to_string())?;
        if kp.verifying_share() != expected {
            return Err("recovery: repaired share does not match the group's public share".into());
        }
        Ok(kp)
    }

    // ---- wire helpers (bytes over the blind relay) ----

    /// Round 1 over the wire: `(recipient_id_bytes, delta_bytes)` per helper. Each delta is
    /// SECRET (it carries share info to its recipient) → seal it to that recipient before it
    /// touches the relay, exactly like a DKG round-2 package.
    pub fn helper_deltas_wire(
        helpers: &[Identifier],
        helper_kp: &KeyPackage,
        lost: Identifier,
    ) -> Result<Vec<WirePair>, String> {
        let map = helper_deltas(helpers, helper_kp, lost)?;
        Ok(map
            .into_iter()
            .map(|(id, d)| (id.serialize(), d.serialize()))
            .collect())
    }

    /// Round 2 over the wire: sum the deltas this helper received into its sigma bytes.
    pub fn helper_sigma_wire(delta_bytes: &[Vec<u8>]) -> Result<Vec<u8>, String> {
        let deltas: Vec<Delta> = delta_bytes
            .iter()
            .map(|b| Delta::deserialize(b))
            .collect::<Result<_, _>>()
            .map_err(|e| e.to_string())?;
        Ok(helper_sigma(&deltas).serialize())
    }

    /// Round 3 over the wire: combine the sigmas into the repaired member's KeyPackage bytes
    /// (validated against the group's public share).
    pub fn repaired_wire(
        sigma_bytes: &[Vec<u8>],
        lost: Identifier,
        pubkeys: &frost::keys::PublicKeyPackage,
    ) -> Result<Vec<u8>, String> {
        let sigmas: Vec<Sigma> = sigma_bytes
            .iter()
            .map(|b| Sigma::deserialize(b))
            .collect::<Result<_, _>>()
            .map_err(|e| e.to_string())?;
        let kp = repaired_key_package(&sigmas, lost, pubkeys)?;
        kp.serialize().map_err(|e| e.to_string())
    }

    #[cfg(test)]
    mod tests {
        use super::*;
        use frost::keys::IdentifierList;

        #[test]
        fn a_quorum_repairs_a_lost_share_and_it_still_signs() {
            let (n, t) = (3u16, 2u16);
            let (shares, pubkeys) =
                frost::keys::generate_with_dealer(n, t, IdentifierList::Default, OsRng).unwrap();
            let kps: std::collections::BTreeMap<Identifier, KeyPackage> = shares
                .into_iter()
                .map(|(id, s)| (id, KeyPackage::try_from(s).unwrap()))
                .collect();
            let ids: Vec<Identifier> = kps.keys().copied().collect();
            let lost = ids[2]; // member 3 lost their device
            let helpers = vec![ids[0], ids[1]]; // a quorum of t helpers rebuilds it, key never assembled

            // Step 1: each helper makes a Delta for every helper (incl. itself), for this repair.
            let mut deltas_by_helper = std::collections::BTreeMap::new();
            for h in &helpers {
                deltas_by_helper.insert(*h, helper_deltas(&helpers, &kps[h], lost).unwrap());
            }
            // Step 2: each helper j sums the Deltas it received from all helpers -> sigma_j.
            let sigmas: Vec<Sigma> = helpers
                .iter()
                .map(|j| {
                    let deltas_for_j: Vec<Delta> =
                        helpers.iter().map(|h| deltas_by_helper[h][j]).collect();
                    helper_sigma(&deltas_for_j)
                })
                .collect();
            // Step 3: the repaired member's KeyPackage, from the public group data + the sigmas.
            let repaired = repaired_key_package(&sigmas, lost, &pubkeys).unwrap();

            // Correctness: the repaired share matches the group's known public share for that member.
            assert_eq!(
                repaired.verifying_share(),
                pubkeys.verifying_shares().get(&lost).unwrap(),
                "the repaired share must match the group's public share for that member"
            );

            // And it still signs: a 2-of-3 with {helper 1, repaired member 3} verifies.
            let group_vk = *pubkeys.verifying_key();
            let message = b"konclave: a repaired share signs again";
            let signers = [(helpers[0], kps[&helpers[0]].clone()), (lost, repaired)];
            let mut nonces = Vec::new();
            let mut commits = Vec::new();
            for (id, kp) in &signers {
                let (nc, c) = super::super::ceremony::participant_round1(kp);
                nonces.push((*id, nc));
                commits.push((id.serialize(), c));
            }
            let sp =
                super::super::ceremony::coordinator_signing_package(&commits, message).unwrap();
            let seed = super::super::ceremony::coordinator_randomizer_seed(&group_vk, &sp).unwrap();
            let mut shares_wire = Vec::new();
            for ((id, kp), (_id, nc)) in signers.iter().zip(nonces.iter_mut()) {
                shares_wire.push((
                    id.serialize(),
                    super::super::ceremony::participant_round2(&sp, nc, kp, &seed, message)
                        .unwrap(),
                ));
            }
            let sig = super::super::ceremony::coordinator_aggregate(
                &sp,
                &group_vk,
                &seed,
                &shares_wire,
                &pubkeys,
            )
            .unwrap();
            assert!(
                super::super::ceremony::verify(&group_vk, &sp, &seed, message, &sig).unwrap(),
                "the repaired share must produce a verifying signature"
            );
        }

        #[test]
        fn recovery_works_over_the_serialized_wire() {
            // Same repair, but every Delta/Sigma crosses as bytes (what the relay carries).
            let (n, t) = (3u16, 2u16);
            let (shares, pubkeys) =
                frost::keys::generate_with_dealer(n, t, IdentifierList::Default, OsRng).unwrap();
            let kps: std::collections::BTreeMap<Identifier, KeyPackage> = shares
                .into_iter()
                .map(|(id, s)| (id, KeyPackage::try_from(s).unwrap()))
                .collect();
            let ids: Vec<Identifier> = kps.keys().copied().collect();
            let lost = ids[2];
            let helpers = vec![ids[0], ids[1]];

            // Round 1: each helper emits (recipient_id, delta_bytes); route into each recipient's inbox.
            let mut inbox: std::collections::HashMap<Vec<u8>, Vec<Vec<u8>>> =
                std::collections::HashMap::new();
            for h in &helpers {
                for (recip, delta) in helper_deltas_wire(&helpers, &kps[h], lost).unwrap() {
                    inbox.entry(recip).or_default().push(delta);
                }
            }
            // Round 2: each helper sums the delta bytes it received → sigma bytes.
            let sigmas: Vec<Vec<u8>> = helpers
                .iter()
                .map(|h| helper_sigma_wire(&inbox[&h.serialize()]).unwrap())
                .collect();
            // Round 3: combine sigma bytes → repaired KeyPackage bytes; must match the group share.
            let kp_bytes = repaired_wire(&sigmas, lost, &pubkeys).unwrap();
            let repaired = KeyPackage::deserialize(&kp_bytes).unwrap();
            assert_eq!(
                repaired.verifying_share(),
                pubkeys.verifying_shares().get(&lost).unwrap(),
                "the wire-repaired share must match the group's public share"
            );
        }
    }
}

// The confidential-channel primitive (ECIES seal/open) now lives in the shared `konclave-seal`
// crate so the hosted helper can seal a SignRequest with the SAME implementation (#63). Aliased
// as `seal` so every `seal::...` reference in this crate keeps resolving.
pub use konclave_seal as seal;

// ---------- the FROST<->PCZT bridge, ported from konclave-signer (browser parity) ----------
// Slice 1 of "real-transaction browser signing": extract the per-spend randomizers from a proven
// PCZT and inject the FROST redpallas signatures back, in wasm-clean Rust. The shielded sighash is
// **passed in** (it is public - it is the message that gets signed - and computing it from the full
// tx needs the heavy native tx machinery); the client only parses the PCZT and applies signatures,
// which rides on `orchard` (already linked). Pinned to byte-for-byte parity with konclave-signer by
// the same real mainnet golden vectors used to close audit C6.
pub mod pczt_bridge {
    use konclave_seal::spends::spends_to_sign;
    use orchard::primitives::redpallas::{self, SpendAuth};
    use pczt::{
        roles::low_level_signer::{OrchardParseError, Signer},
        Pczt,
    };

    // Error type for the signing closure (must be `From<OrchardParseError>`); payloads are carried
    // for `Debug` diagnostics, not matched on.
    #[derive(Debug)]
    #[allow(dead_code)]
    enum OErr {
        Parse(OrchardParseError),
        Sign(orchard::pczt::SignerError),
        BadIndex(usize),
        Extract(orchard::pczt::TxExtractorError),
        Commitment(orchard::bundle::CommitmentError),
        /// A device refusing what it read, in words meant for the member (#610).
        Refuse(String),
    }
    impl From<OrchardParseError> for OErr {
        fn from(e: OrchardParseError) -> Self {
            OErr::Parse(e)
        }
    }

    // Ironwood (NU6.3) reuses `orchard::pczt::Bundle`, so the spend/output reading is identical for
    // both pools - only the `low_level_signer` method (`sign_orchard_with` vs `sign_ironwood_with`)
    // differs. A single Konclave send spends from ONE pool; we read Orchard first and fall back to
    // Ironwood, matching konclave-signer's pool-aware bridge (§ Phase 12).

    // Which spends of a bundle this vault signs is `konclave_seal::spends::spends_to_sign`, the one
    // rule konclave-signer reads too: the spends still awaiting a signature, and a refusal for any
    // spend that still carries `dummy_sk`.

    fn orchard_spends(pczt: &Pczt) -> Result<Vec<(usize, [u8; 32])>, String> {
        let mut r = Ok(vec![]);
        Signer::new(pczt.clone())
            .sign_orchard_with(|_pczt, bundle, _| {
                r = spends_to_sign(bundle);
                Ok::<(), OErr>(())
            })
            .map_err(|e| format!("orchard parse: {:?}", e))?;
        r
    }

    fn ironwood_spends(pczt: &Pczt) -> Result<Vec<(usize, [u8; 32])>, String> {
        let mut r = Ok(vec![]);
        Signer::new(pczt.clone())
            .sign_ironwood_with(|_pczt, bundle, _| {
                r = spends_to_sign(bundle);
                Ok::<(), OErr>(())
            })
            .map_err(|e| format!("ironwood parse: {:?}", e))?;
        r
    }

    /// The pool decision itself, over nothing but the two answers.
    ///
    /// Pulled out as a pure function for two reasons. It is the rule three callers need, and it is
    /// the only part of the rule that can be TESTED without a mixed PCZT - which does not exist in
    /// this repo and is not cheap to build. Taking booleans means every branch, including the mixed
    /// one that has never run against a fixture, is exercised.
    ///
    /// `Ok(true)` = Ironwood, `Ok(false)` = Orchard.
    fn decide_pool(has_orchard: bool, has_ironwood: bool) -> Result<bool, String> {
        match (has_orchard, has_ironwood) {
            (true, false) => Ok(false),
            (false, true) => Ok(true),
            (false, false) => Err("no real shielded spends to sign in this PCZT".into()),
            // Worded to match konclave-signer's refusal exactly. A member who hits this on one
            // runtime and then the other must not be told two different things about one cause.
            (true, true) => {
                Err("mixed Orchard+Ironwood spends are not supported by this bridge".into())
            }
        }
    }

    /// Which pool this transaction's FROST spends live in (Orchard pre-NU6.3, Ironwood post-NU6.3).
    fn active_pool(pczt: &Pczt) -> Result<bool, String> {
        decide_pool(
            !orchard_spends(pczt)?.is_empty(),
            !ironwood_spends(pczt)?.is_empty(),
        )
    }

    /// Parse a proven PCZT and return the `(action_index, alpha)` randomizers of the real spends
    /// that need a FROST signature, from whichever pool the tx spends from.
    ///
    /// This used to answer the pool question ITSELF - `if !orchard.is_empty() { return orchard }`,
    /// falling through to Ironwood - four lines below an `active_pool` it did not call (#364). Its
    /// two siblings in this module, `describe_outputs` and `inject_sigs`, did call it. So on a mixed
    /// PCZT the browser returned only the ORCHARD SUBSET and raised nothing, while the native signer
    /// refused: the device would contribute signatures for half the spends and stay quiet about the
    /// rest. It is the repo's most repeated defect (one rule, two implementations, one of them
    /// diverged) and the diverged copy was the one the live ceremony consumes.
    pub fn extract_randomizers(pczt_bytes: &[u8]) -> Result<Vec<(usize, [u8; 32])>, String> {
        let pczt = Pczt::parse(pczt_bytes).map_err(|e| format!("failed to parse PCZT: {:?}", e))?;
        if active_pool(&pczt)? {
            ironwood_spends(&pczt)
        } else {
            orchard_spends(&pczt)
        }
    }

    /// One output as the device reads it from a proven PCZT, for the "what am I signing?" check
    /// before a device joins the ceremony. Every field here has been checked against the note
    /// commitment the signature covers (`read_payment`); none of it is taken on the builder's word.
    #[derive(Debug, Clone, PartialEq, Eq)]
    pub struct OutputInfo {
        /// The user-facing address label (the `user_address` an Updater set), if present. Shown to
        /// the human, never the basis of the approval decision. Change outputs carry `None`.
        pub address: Option<String>,
        /// The output value in zatoshis, checked against the note commitment.
        pub value: Option<u64>,
        /// The raw 43-byte Orchard/Ironwood receiver, hex-encoded, checked against the note
        /// commitment. This is what the on-device money gate (#281) compares with the approved
        /// recipients.
        pub recipient: Option<String>,
        /// The memo the recipient will read, opened on the device from the output's own
        /// ciphertext: the text, or `""` for an empty memo. `None` on outputs that move no value
        /// and on a memo that is not text.
        pub memo: Option<String>,
    }

    /// What a proven PCZT pays, as the device can confirm it on its own.
    #[derive(Debug, Clone, PartialEq, Eq)]
    pub struct Payment {
        /// Every output of the Orchard bundle, then of the Ironwood bundle (the sighash's order).
        pub outputs: Vec<OutputInfo>,
        /// The fee in zatoshis: what the two bundles take out of the shielded pools, which the
        /// sighash covers. Exactly the ZIP 317 fee for the transaction's actions.
        pub fee_zat: u64,
        /// Actions across both bundles.
        pub actions: usize,
        /// Actions in the Orchard bundle and in the Ironwood bundle, and the values the Ironwood
        /// bundle pays: what tells a canonical ZIP 318 crossing apart (`is_canonical_crossing`).
        pub orchard_actions: usize,
        pub ironwood_actions: usize,
        pub ironwood_values: Vec<u64>,
        /// Each bundle's value balance (what it gives out of its pool; negative when it takes in).
        pub orchard_balance: i64,
        pub ironwood_balance: i64,
    }

    /// ZIP 317: the conventional fee is `MARGINAL_FEE * max(GRACE_ACTIONS, logical_actions)`, and
    /// for a shielded-only V6 transaction the logical actions are the Orchard actions plus the
    /// Ironwood actions.
    /// The network a build signs for: per network upgrade, where the device's clock is anchored and
    /// which transaction headers it accepts. A build constant, never read from the PCZT, whose
    /// heights the builder writes. (The PCZT's `coin_type` is not readable through pczt's API and
    /// is not in the sighash; another network shows here as a branch, a version or heights outside
    /// the window: testnet shares NU6.3's branch id but runs hundreds of thousands of blocks ahead.)
    ///
    /// The table, the height rules and the margin are `konclave_seal::epochs`: one implementation,
    /// read by the coordinator too (#638). What stays here is what only a device does.
    pub use konclave_seal::epochs::{Epoch, HeightBounds, Table as NetworkRules, MAINNET, NU6_3};

    #[derive(Clone, Copy, Debug)]
    pub struct TxHeader {
        pub tx_version: u32,
        pub version_group_id: u32,
        pub branch_id: u32,
        pub lock_time: u32,
        pub expiry_height: u32,
    }

    /// One transaction this device's share went into, as its record keeps it: the hash of its
    /// sighash and the expiry and branch THIS device read in the header it checked (never a wire
    /// value). A record written before the branch was kept reads as NU6.3.
    #[derive(Clone, Debug, PartialEq, Eq)]
    pub struct SignedTx {
        pub sighash: String,
        pub expiry: u32,
        pub branch: u32,
    }

    /// Whether a transaction of `branch` expiring at `expiry` may still be mined, by this device's
    /// clock: the last height it can be in a block (its expiry, or the block before the next upgrade)
    /// plus the reorg margin is not below the window's floor. The one test `approval_decision` and
    /// `lapses_at` both read, so what the screen says and what the device decides cannot drift; the
    /// rule itself is `epochs`', the coordinator's `settle` reads the same one with the chain tip.
    fn still_counted(rules: &NetworkRules, expiry: u32, branch: u32, now_unix: i64) -> bool {
        rules.can_still_be_mined(branch, expiry, rules.height_bounds(now_unix).lo)
    }

    /// The first moment (unix seconds) this device stops counting a transaction of `branch` that
    /// expires at `expiry`: from then on a new transaction for the same approval is `AfterExpiry`,
    /// not `Second`. The screen says this time ("until about ..."), so it is the rule's own turning
    /// point, not an estimate of when the block comes (the chain runs behind the nominal spacing, so
    /// that estimate would be hours early). None when it is not found within the table's reach, when
    /// the transaction never ceases to count, or when the branch is not in the table.
    pub fn lapses_at(rules: &NetworkRules, expiry: u32, branch: u32) -> Option<i64> {
        let mut lo = rules.anchor.unix;
        let last = rules.minable_until(branch, expiry)?;
        if !still_counted(rules, expiry, branch, lo) {
            return Some(lo);
        }
        if last == u32::MAX {
            return None;
        }
        // The floor of the window rises at most one block per spacing, and at least ~99% of that,
        // so twice the nominal time to the last height (plus the margin) is always past the turn.
        let slowest = rules.epochs.iter().map(|e| e.spacing_s).max()?;
        let blocks = (i64::from(last) - i64::from(rules.anchor.height)).max(0) + 1_000;
        let mut hi = rules.anchor.unix + blocks * slowest * 2;
        if still_counted(rules, expiry, branch, hi) {
            return None;
        }
        // Counted at `lo`, not at `hi`: the floor never falls as the clock advances.
        while hi - lo > 1 {
            let mid = lo + (hi - lo) / 2;
            if still_counted(rules, expiry, branch, mid) {
                lo = mid;
            } else {
                hi = mid;
            }
        }
        Some(hi)
    }

    /// What a device can confirm about a transaction's header before its share leaves: the network
    /// (consensus branch, version, version group) is the one this build signs for in the
    /// epoch its clock is in; nothing locks it to a later time; and it expires inside the window the
    /// device's own clock allows, so whoever holds it signed cannot broadcast it much later.
    /// A canonical ZIP 318 pool crossing, as the released engine builds it when one Orchard note pays
    /// a `{1,2,5} x 10^k` amount: two Orchard actions (the spend and its change or a dummy) and one
    /// Ironwood action carrying the single canonical output.
    /// The value must also actually cross: the Orchard bundle gives value out (a positive balance)
    /// and the Ironwood bundle takes exactly its one output (a balance of minus that output, so its
    /// spend side is a zero dummy). Without this, a vault holding only Ironwood notes could have a
    /// transaction of this action count signed with the crossing's long expiry.
    pub fn is_canonical_crossing(
        orchard_actions: usize,
        ironwood_actions: usize,
        ironwood_values: &[u64],
        orchard_balance: i64,
        ironwood_balance: i64,
    ) -> bool {
        use zcash_protocol::{value::Zatoshis, zip318};
        orchard_actions == zip318::CROSSING_SOURCE_ACTIONS
            && ironwood_actions == zip318::CROSSING_DESTINATION_ACTIONS
            && orchard_balance > 0
            && matches!(ironwood_values, [v] if Zatoshis::from_u64(*v).is_ok_and(zip318::is_canonical_denomination)
                && i64::try_from(*v).is_ok_and(|v| ironwood_balance == -v))
    }

    #[derive(Clone, Copy, Debug, PartialEq, Eq)]
    pub enum ApprovalDecision {
        First,
        Same,
        AfterExpiry,
        /// `first_expiry` is the latest expiry among the earlier transactions still counted;
        /// `until_unix` the moment the last of them stops counting, from the SAME rule the decision
        /// reads (`lapses_at`), so the time on the screen is where the decision turns. `None` when
        /// some earlier transaction never stops counting (no expiry, no later upgrade): the decision
        /// then has no turning point, and a time on the screen would be a promise it cannot keep.
        ///
        /// `by_epoch`: the earlier transaction that lasts longest is ended by a network upgrade
        /// rather than by its own expiry, which the screen words apart; `until_height` is then the
        /// last block it can be mined in (the block before the upgrade). Both are unset when the
        /// time is unknown.
        Second {
            first_expiry: u32,
            until_unix: Option<i64>,
            until_height: Option<u32>,
            by_epoch: bool,
        },
    }

    /// The height at which the last upgrade in the table activates: the number the app's upgrade notice
    /// reads, so the notice carries no height of its own (the table is the one home of it).
    pub fn latest_upgrade_height(rules: &NetworkRules) -> u32 {
        rules.epochs.last().map_or(0, |row| row.activation_height)
    }

    /// What a new transaction is, for an approval this device already put its share into: `signed`
    /// is this device's record of those transactions (their sighash, expiry and branch). `Same` is a
    /// ceremony restarted on the same transaction; `AfterExpiry` a new one once every earlier one can
    /// no longer be mined by this device's clock (past the last height it can be in a block, by the
    /// reorg margin below the window's floor); `Second` a new one while an earlier one may still be
    /// mined, which pays twice if both are: the member confirms it, told until when the earlier one
    /// stays valid.
    pub fn approval_decision(
        rules: &NetworkRules,
        signed: &[SignedTx],
        sighash: &str,
        now_unix: i64,
    ) -> ApprovalDecision {
        let s = sighash.trim().to_ascii_lowercase();
        if signed.is_empty() {
            return ApprovalDecision::First;
        }
        if signed
            .iter()
            .any(|t| t.sighash.trim().eq_ignore_ascii_case(&s))
        {
            return ApprovalDecision::Same;
        }
        let counted: Vec<&SignedTx> = signed
            .iter()
            .filter(|t| still_counted(rules, t.expiry, t.branch, now_unix))
            .collect();
        match counted.iter().map(|t| t.expiry).max() {
            Some(first_expiry) => {
                // The one that stops counting last decides what the screen says and until when. If
                // any counted one never stops, there is no time to give.
                let turns: Option<Vec<(i64, &SignedTx)>> = counted
                    .iter()
                    .map(|t| lapses_at(rules, t.expiry, t.branch).map(|at| (at, *t)))
                    .collect();
                let last = turns.and_then(|v| v.into_iter().max_by_key(|(at, _)| *at));
                let by_epoch = last.is_some_and(|(_, t)| rules.capped_by_next(t.branch, t.expiry));
                ApprovalDecision::Second {
                    first_expiry,
                    until_unix: last.map(|(at, _)| at),
                    until_height: last
                        .filter(|_| by_epoch)
                        .and_then(|(_, t)| rules.minable_until(t.branch, t.expiry)),
                    by_epoch,
                }
            }
            None => ApprovalDecision::AfterExpiry,
        }
    }

    /// Read the device's record as `"sighash:expiry[:branch],..."`. An entry without a branch was
    /// written before the branch was kept and reads as NU6.3 (the only upgrade any such record can
    /// have been signed under). A malformed entry, or a branch this table does not know, is an
    /// error and never skipped: a record the device cannot judge must not read as "nothing signed".
    pub fn parse_signed(rules: &NetworkRules, signed: &str) -> Result<Vec<SignedTx>, String> {
        let mut records = vec![];
        for entry in signed.split(',').map(str::trim).filter(|e| !e.is_empty()) {
            let parts: Vec<&str> = entry.split(':').collect();
            if !(2..=3).contains(&parts.len()) {
                return Err("[record] malformed entry".into());
            }
            let expiry: u32 = parts[1]
                .parse()
                .map_err(|_| "[record] malformed expiry".to_string())?;
            let branch: u32 = match parts.get(2) {
                None => NU6_3,
                Some(b) => b
                    .parse()
                    .map_err(|_| "[record] malformed branch".to_string())?,
            };
            if rules.epoch_by_branch(branch).is_none() {
                return Err(
                    "[record] this device's record names a network upgrade this app does not know"
                        .into(),
                );
            }
            records.push(SignedTx {
                sighash: parts[0].to_string(),
                expiry,
                branch,
            });
        }
        Ok(records)
    }

    /// `check_header`, with ZIP 318's rolling expiry accepted for a canonical crossing: exactly what
    /// `Table::crossing_expiry` gives for a target height the device's clock allows and the header's
    /// own branch covers (the modulus is 34,560 blocks before NU7 and 103,680 from it, and the table is
    /// the one home of that), never any other long expiry. Below its window the expiry is refused as
    /// for any transaction.
    ///
    /// What a header must be, from the device's clock alone (never the coordinator's height, never
    /// the PCZT's own claims): its branch, version and version group are a row of the table; it has
    /// no lock time; it expires inside the window the clock allows, so whoever holds it signed
    /// cannot broadcast it much later; and the heights it could be mined at (the window, cut at the
    /// last height its branch is valid) meet that branch's own range. Far from an upgrade one row
    /// qualifies; around it both do, which is the device's own uncertainty.
    pub fn check_header_for(
        rules: &NetworkRules,
        h: &TxHeader,
        now_unix: i64,
        crossing: bool,
    ) -> Result<(), String> {
        if now_unix < rules.anchor.unix {
            return Err(
                "[expiry] this device's clock is earlier than the network this app signs for"
                    .into(),
            );
        }
        let network_err = || {
            format!(
                "[network] the transaction is for another network or upgrade (branch {:08x}, v{})",
                h.branch_id, h.tx_version
            )
        };
        let Some(row) = rules.epoch_by_branch(h.branch_id) else {
            return Err(network_err());
        };
        if h.tx_version != row.tx_version || h.version_group_id != row.version_group_id {
            return Err(network_err());
        }
        if h.lock_time != 0 {
            return Err(format!(
                "[locktime] the transaction cannot be mined before {}",
                h.lock_time
            ));
        }
        let b = rules.height_bounds(now_unix);
        let e = h.expiry_height;
        let plain = if e == 0 {
            Err("[expiry] the transaction never expires".to_string())
        } else if e <= b.lo {
            Err(format!(
                "[expiry] the transaction expires at block {e}, already past by this device's clock"
            ))
        } else if e > b.hi {
            Err(format!(
                "[expiry] the transaction stays valid until block {e}, much later than a payment built now"
            ))
        } else {
            Ok(())
        };
        if let Err(plain_err) = plain {
            let last = rules
                .next_activation_after(h.branch_id)
                .map_or(u32::MAX, |a| a - 1);
            let target_hi = b.top.min(last);
            let is_zip318 =
                crossing && e > b.lo && rules.is_crossing_expiry(e, h.branch_id, b.lo, target_hi);
            if !is_zip318 {
                return Err(plain_err);
            }
        }
        if !rules.header_may_be_mined(h.branch_id, e, b.lo, b.hi) {
            return Err(format!(
                "[network] by this device's clock the network is no longer on the upgrade this transaction is for (branch {:08x})",
                h.branch_id
            ));
        }
        Ok(())
    }

    pub fn check_header(rules: &NetworkRules, h: &TxHeader, now_unix: i64) -> Result<(), String> {
        check_header_for(rules, h, now_unix, false)
    }

    const MARGINAL_FEE: u64 = 5_000;
    const GRACE_ACTIONS: u64 = 2;

    /// What the fee rule needs to know about one bundle.
    #[derive(Debug, Clone, Copy, PartialEq, Eq)]
    struct BundleShape {
        /// Actions in the bundle, padding included.
        actions: usize,
        /// Spends still awaiting this vault's signature (the ceremony's own predicate).
        to_sign: usize,
        /// Outputs that move value, read after the commitment check.
        paying: usize,
    }

    /// The fee this transaction pays, or the refusal when it is not exactly what ZIP 317 sets for it.
    ///
    /// Nothing on the signing path bounded the fee before #610. A builder could pay every approved
    /// line exactly and return less change, and the difference went to the miner: every device
    /// signed it, because every check looked at the outputs and none at what they did not add up
    /// to. The fee here comes from the bundles' value balance, which the sighash covers.
    ///
    /// The ZIP 317 fee grows with the number of actions, so a fee check alone would let a builder
    /// add empty padding actions and raise the fee it must pay by 5000 zatoshis each. So each
    /// bundle may carry at most `max(2, to_sign + paying)` actions. That covers both ways a builder
    /// pairs spends with outputs: one action per spend-or-output where cross-address transfers are
    /// allowed (Ironwood), and a spend and an output in separate actions where they are not
    /// (Orchard after NU6.3), whose fabricated zero-value spends are ours to sign and so counted.
    ///
    /// What this does NOT bound: the builder chooses both terms. It can split change into more
    /// outputs, spend more of the vault's notes, or add zero-value spends left for the vault to
    /// sign (`spends_to_sign` does not check a spend's `rk` against the vault's key), and each such
    /// action raises the fee by 5000 zatoshis, paid to the network. Nothing on the device caps
    /// the number of actions; the relay's 128 KiB message cap is the only bound today. A real bound
    /// needs the device to know which notes a payment should spend.
    fn check_fee(fee: i64, bundles: &[BundleShape]) -> Result<u64, String> {
        let fee = u64::try_from(fee).map_err(|_| {
            format!(
                "[fee] the transaction adds {} zatoshis to the shielded pools instead of paying a fee",
                fee.unsigned_abs()
            )
        })?;
        for b in bundles {
            let enough = (b.to_sign + b.paying).max(GRACE_ACTIONS as usize);
            if b.actions > enough {
                return Err(format!(
                    "[fee] the transaction carries {} actions in one bundle where {enough} are enough",
                    b.actions
                ));
            }
        }
        let actions: u64 = bundles.iter().map(|b| b.actions as u64).sum();
        // Exactly ZIP 317's fee for the transaction's actions: every honest send pays exactly that
        // (all twenty in docs/PROOF.md, payroll and migration included). Above it the builder keeps
        // the difference from the change; below it the network may not relay the transaction, which
        // then sits signed with whoever built it.
        let zip317 = MARGINAL_FEE * actions.max(GRACE_ACTIONS);
        if fee != zip317 {
            return Err(format!(
                "[fee] the transaction pays {fee} zatoshis in fee, not the {zip317} that ZIP 317 sets for its {actions} actions"
            ));
        }
        Ok(fee)
    }

    /// Read one Orchard-shaped bundle's outputs, refusing any output whose fields its note
    /// commitment does not bind.
    ///
    /// `recipient` and `value` travel BESIDE `cmx` in a PCZT, and the builder writes all three.
    /// The sighash covers `cmx`, not the fields (#610). Before this check a builder could commit to
    /// a note paying one party and write another party, or another amount, into the fields every
    /// reader here used: the gate compared them with the approved lines and the screen showed them.
    /// `verify_note_commitment` recomputes the commitment from `recipient`, `value`, `rseed` and the
    /// action's own nullifier, so a field that disagrees with `cmx` is refused. A missing field
    /// cannot be checked and is refused too: a device that cannot confirm an output must not sign.
    fn read_bundle(
        pool: &str,
        bundle: &orchard::pczt::Bundle,
    ) -> Result<(Vec<OutputInfo>, BundleShape, i64), String> {
        let mut out = Vec::with_capacity(bundle.actions().len());
        for (i, action) in bundle.actions().iter().enumerate() {
            let o = action.output();
            o.verify_note_commitment(action.spend()).map_err(|e| {
                format!("[commitment] {pool} output {i} does not match its note commitment: {e:?}")
            })?;
            let recipient = o
                .recipient()
                .as_ref()
                .map(|a| hex::encode(a.to_raw_address_bytes()));
            // The label is what the member reads on the signing screen, so it must name the
            // receiver the commitment pays. The pczt crate asks this of every Signer: "parse this
            // address (if present) and confirm that it contains `recipient`".
            if let Some(label) = o.user_address() {
                let named = ua_receiver(label).map_err(|e| {
                    format!("[label] {pool} output {i} carries a label that is not a payable address: {e}")
                })?;
                if Some(&named) != recipient.as_ref() {
                    return Err(format!(
                        "[label] {pool} output {i} is labelled with an address it does not pay"
                    ));
                }
            }
            let value = o.value().map(|v| v.inner());
            // A paying output must open, and what it opens to is the memo the recipient will read.
            // Padding carries no memo worth reading, and a zero-value output paired with an
            // external spend has a random ciphertext by design, so neither is opened.
            let memo = if value.unwrap_or(0) > 0 {
                let opened = open_output(action).ok_or_else(|| {
                    format!(
                        "[undecryptable] {pool} output {i} pays a note its recipient cannot open"
                    )
                })?;
                memo_text(&opened)
            } else {
                None
            };
            out.push(OutputInfo {
                // Trimmed, as `ua_receiver` read it: the label that was checked is the one shown.
                address: o.user_address().as_ref().map(|a| a.trim().to_string()),
                value,
                recipient,
                memo,
            });
        }
        let shape = BundleShape {
            actions: bundle.actions().len(),
            to_sign: spends_to_sign(bundle)?.len(),
            paying: out.iter().filter(|o| o.value.unwrap_or(0) > 0).count(),
        };
        let value_balance = i64::try_from(*bundle.value_sum())
            .map_err(|_| format!("[fee] the {pool} bundle's value balance is out of range"))?;
        Ok((out, shape, value_balance))
    }

    /// Open one output the way its recipient will, and return the memo plaintext.
    ///
    /// The ephemeral secret key is derived from the note itself (`rseed` and `rho`), so the device
    /// needs no viewing key: with the note's fields already checked against `cmx`, it encrypts to
    /// the same key the builder did. Recovery also checks that the opened note matches `cmx` and
    /// the ephemeral public key, so an output that opens is the output the commitment describes.
    /// `None` when any field is missing or the ciphertext does not open.
    fn open_output(action: &orchard::pczt::Action) -> Option<[u8; 512]> {
        use orchard::note_encryption::{IronwoodDomain, OrchardDomain};
        let o = action.output();
        let rho = Option::from(orchard::note::Rho::from_bytes(
            &action.spend().nullifier().to_bytes(),
        ))?;
        let note = Option::from(orchard::Note::from_parts(
            (*o.recipient())?,
            (*o.value())?,
            rho,
            (*o.rseed())?,
            *o.note_version(),
        ))?;
        match o.note_version() {
            orchard::NoteVersion::V2 => {
                recover_memo(OrchardDomain::for_pczt_action(action), &note, action)
            }
            orchard::NoteVersion::V3 => {
                recover_memo(IronwoodDomain::for_pczt_action(action), &note, action)
            }
        }
    }

    fn recover_memo<D>(
        domain: D,
        note: &orchard::Note,
        action: &orchard::pczt::Action,
    ) -> Option<[u8; 512]>
    where
        D: zcash_note_encryption::Domain<Note = orchard::Note, Memo = [u8; 512]>,
        orchard::pczt::Action: zcash_note_encryption::ShieldedOutput<D>,
    {
        let esk = D::derive_esk(note)?;
        let pk_d = D::get_pk_d(note);
        zcash_note_encryption::try_output_recovery_with_pkd_esk(&domain, pk_d, esk, action)
            .map(|(_, _, memo)| memo)
    }

    /// A memo as the proposal records it: the text, `""` for the empty memo, and `None` for any
    /// memo that is not text (which no Konclave proposal makes, so it never matches a line).
    fn memo_text(bytes: &[u8; 512]) -> Option<String> {
        use zcash_protocol::memo::{Memo, MemoBytes};
        match Memo::try_from(MemoBytes::from_bytes(bytes).ok()?).ok()? {
            Memo::Empty => Some(String::new()),
            Memo::Text(t) => Some(String::from(&*t)),
            _ => None,
        }
    }

    /// Run `read` over one pool's bundle, keeping a refusal's own words and wrapping a parse error.
    fn with_bundle<T>(
        pczt: &Pczt,
        ironwood_pool: bool,
        read: impl FnOnce(&orchard::pczt::Bundle) -> Result<T, String>,
    ) -> Result<T, String> {
        let mut out: Option<T> = None;
        let run = |_: &Pczt, bundle: &mut orchard::pczt::Bundle, _: &mut u8| -> Result<(), OErr> {
            out = Some(read(bundle).map_err(OErr::Refuse)?);
            Ok(())
        };
        let signer = Signer::new(pczt.clone());
        let res = if ironwood_pool {
            signer.sign_ironwood_with(run)
        } else {
            signer.sign_orchard_with(run)
        };
        match res {
            Ok(_) => out.ok_or_else(|| "parse: the bundle was not read".to_string()),
            Err(OErr::Refuse(msg)) => Err(msg),
            Err(e) => Err(format!("parse: {:?}", e)),
        }
    }

    /// The bundles a transaction of this version signs, and the parts a vault payment never has.
    ///
    /// Over nothing but the facts, so every branch is testable without a PCZT of that shape (the
    /// `decide_pool` pattern): this repo has no transparent, Sapling, v4 or v7 fixture, and a rule
    /// only a fixture could exercise is a rule no test exercises. The reading covers exactly what
    /// `shielded_sighash` covers: Orchard for v5; Orchard then Ironwood for v6. The fee is the
    /// shielded value balance, which is the whole fee only when nothing else moves value, so a
    /// transparent or Sapling part is refused (the sighash refuses them too, for its own reason).
    fn signed_pools(
        tx_version: u32,
        has_transparent: bool,
        has_sapling: bool,
    ) -> Result<&'static [(bool, &'static str)], String> {
        if has_transparent {
            return Err(
                "[shape] the transaction has a transparent part, which a vault spend never has"
                    .into(),
            );
        }
        if has_sapling {
            return Err(
                "[shape] the transaction has a Sapling part, which a vault spend never has".into(),
            );
        }
        match tx_version {
            5 => Ok(&[(false, "orchard")]),
            6 => Ok(&[(false, "orchard"), (true, "ironwood")]),
            v => Err(format!("[shape] unsupported transaction version {v}")),
        }
    }

    /// Read what a proven PCZT pays, every output checked against its note commitment, across BOTH
    /// shielded bundles. A V6 transaction can carry both: an Orchard-to-Ironwood migration spends
    /// from Orchard and pays into Ironwood, and reading only the pool the spends come from would
    /// miss where the money lands. The order is the sighash's: Orchard, then Ironwood.
    pub fn read_payment(pczt_bytes: &[u8]) -> Result<Payment, String> {
        let pczt = Pczt::parse(pczt_bytes).map_err(|e| format!("failed to parse PCZT: {:?}", e))?;
        let tx_version = *pczt.global().tx_version();
        let pools = signed_pools(
            tx_version,
            !pczt.transparent().inputs().is_empty() || !pczt.transparent().outputs().is_empty(),
            !pczt.sapling().spends().is_empty() || !pczt.sapling().outputs().is_empty(),
        )?;
        // A bundle with no actions enters the digest as the empty-bundle commitment, which carries
        // no value balance, so a non-zero one there is refused below; summed into the fee, it could
        // offset a fee raised in the other bundle. And a version 5 transaction has no Ironwood slot
        // in its digest, so an Ironwood bundle in one is signed by nobody: refused, not read.
        if tx_version == 5 {
            let (_, iw, balance) = with_bundle(&pczt, true, |b| read_bundle("ironwood", b))?;
            if iw.actions > 0 || balance != 0 {
                return Err(
                    "[shape] a version 5 transaction carries an Ironwood bundle its signature does not cover"
                        .into(),
                );
            }
        }
        let mut outputs = vec![];
        let mut shapes = vec![];
        let mut fee: i64 = 0;
        let (mut orchard_actions, mut ironwood_actions) = (0, 0);
        let (mut orchard_balance, mut ironwood_balance) = (0i64, 0i64);
        let mut ironwood_values = vec![];
        for &(ironwood_pool, pool) in pools {
            let (part, shape, balance) =
                with_bundle(&pczt, ironwood_pool, |b| read_bundle(pool, b))?;
            if shape.actions == 0 && balance != 0 {
                return Err(format!(
                    "[shape] the {pool} bundle has no actions and a value balance its signature does not cover"
                ));
            }
            fee = fee
                .checked_add(balance)
                .ok_or("[fee] the transaction's value balance is out of range")?;
            if ironwood_pool {
                ironwood_actions = shape.actions;
                ironwood_balance = balance;
                ironwood_values = part
                    .iter()
                    .filter_map(|o| o.value)
                    .filter(|v| *v > 0)
                    .collect();
            } else {
                orchard_actions = shape.actions;
                orchard_balance = balance;
            }
            outputs.extend(part);
            shapes.push(shape);
        }
        let fee_zat = check_fee(fee, &shapes)?;
        let actions = shapes.iter().map(|s| s.actions).sum();
        Ok(Payment {
            outputs,
            fee_zat,
            actions,
            orchard_actions,
            ironwood_actions,
            ironwood_values,
            orchard_balance,
            ironwood_balance,
        })
    }

    /// What a device signs on, read once: what the transaction pays (`read_payment`), its header
    /// checked against the network this build signs for and the device's own clock (`check_header`),
    /// the sighash its share will cover, and the txid that sighash gives (for a transaction with no
    /// transparent input, ZIP 244's signature digest is the txid digest, as the orchestrator's
    /// `txid_from_sighash` relies on). The one call a signing driver makes before its share leaves.
    pub struct ForSigning {
        pub payment: Payment,
        pub sighash: [u8; 32],
        pub txid: String,
        pub expiry_height: u32,
        /// The consensus branch of the header THIS device read and checked: what the signed record
        /// keeps beside the expiry, never a value the coordinator sends.
        pub branch_id: u32,
    }

    fn header_of(pczt: &Pczt) -> Result<TxHeader, String> {
        let g = pczt.global();
        let lock_time = pczt::common::determine_lock_time(g, pczt.transparent().inputs())
            .ok_or("[locktime] incompatible lock times in the transaction")?;
        Ok(TxHeader {
            tx_version: *g.tx_version(),
            version_group_id: *g.version_group_id(),
            branch_id: *g.consensus_branch_id(),
            lock_time,
            expiry_height: *g.expiry_height(),
        })
    }

    pub fn read_for_signing_with(
        rules: &NetworkRules,
        pczt_bytes: &[u8],
        now_unix: i64,
    ) -> Result<ForSigning, String> {
        let pczt = Pczt::parse(pczt_bytes).map_err(|e| format!("failed to parse PCZT: {:?}", e))?;
        let header = header_of(&pczt)?;
        let payment = read_payment(pczt_bytes)?;
        let crossing = is_canonical_crossing(
            payment.orchard_actions,
            payment.ironwood_actions,
            &payment.ironwood_values,
            payment.orchard_balance,
            payment.ironwood_balance,
        );
        check_header_for(rules, &header, now_unix, crossing)?;
        let sighash = shielded_sighash(&pczt)?;
        let txid = sighash.iter().rev().map(|b| format!("{b:02x}")).collect();
        Ok(ForSigning {
            payment,
            sighash,
            txid,
            expiry_height: header.expiry_height,
            branch_id: header.branch_id,
        })
    }

    /// `read_for_signing_with` for the network this build signs for.
    pub fn read_for_signing(pczt_bytes: &[u8], now_unix: i64) -> Result<ForSigning, String> {
        read_for_signing_with(&MAINNET, pczt_bytes, now_unix)
    }

    /// Every output of a proven PCZT - what this transaction actually pays - so each device can
    /// verify it against the human-approved proposal BEFORE contributing its signature. The same
    /// reading as `read_payment`, so it carries the same checks: there is one reader of a PCZT's
    /// outputs in this crate, and it refuses what it cannot confirm. Dummy padding outputs surface
    /// as `value: Some(0)` with no address, so the caller can ignore them.
    pub fn describe_outputs(pczt_bytes: &[u8]) -> Result<Vec<OutputInfo>, String> {
        read_payment(pczt_bytes).map(|p| p.outputs)
    }

    /// The raw Orchard receiver of a unified address, hex-encoded - directly comparable to an
    /// output's `recipient` from `describe_outputs`.
    ///
    /// This is the other half of the money gate (#281). The gate decides in RECIPIENT BYTES, because
    /// that is the only field the note commitment (and so the sighash) is bound to; the approved
    /// destination, however, is stored as the unified address a human typed. Something has to bring
    /// the two into the same space, and it has to be the device doing it - asking the coordinator to
    /// supply the approved receiver would hand the decision back to the party the gate exists to
    /// distrust.
    ///
    /// One decode covers both pools. Per ZIP 326 a receiver "is scoped to the Orchard protocol, not
    /// to a pool", and an exposed Orchard receiver takes funds in either pool - which is why an
    /// Ironwood send's outputs carry Orchard-shaped 43-byte receivers and match an Orchard receiver
    /// decoded here.
    ///
    /// Errors rather than guessing: an address with no Orchard receiver (a bare Sapling or
    /// transparent one) cannot be paid by a shielded vault spend, and returning something for it
    /// would let the gate "match" a destination the vault can never actually reach.
    pub fn ua_receiver(ua: &str) -> Result<String, String> {
        use zcash_address::unified::{Container, Receiver};
        use zcash_address::{unified, ConversionError, TryFromAddress, ZcashAddress};

        /// Carries out the ONE thing wanted: the Orchard receiver's raw bytes. Every other address
        /// kind is refused, so a Sapling or transparent destination cannot silently decode to
        /// nothing and be read as "matches".
        struct OrchardOnly([u8; 43]);
        impl TryFromAddress for OrchardOnly {
            type Error = String;
            fn try_from_unified(
                _: zcash_protocol::consensus::NetworkType,
                ua: unified::Address,
            ) -> Result<Self, ConversionError<Self::Error>> {
                ua.items()
                    .into_iter()
                    .find_map(|r| match r {
                        Receiver::Orchard(bytes) => Some(OrchardOnly(bytes)),
                        _ => None,
                    })
                    .ok_or_else(|| {
                        ConversionError::User(
                            "this unified address has no Orchard receiver, so a shielded vault \
                             spend cannot pay it"
                                .into(),
                        )
                    })
            }
        }

        let addr = ZcashAddress::try_from_encoded(ua.trim())
            .map_err(|e| format!("not a Zcash address: {e}"))?;
        let OrchardOnly(bytes) = addr
            .convert::<OrchardOnly>()
            .map_err(|e| format!("no Orchard receiver: {e}"))?;
        Ok(hex::encode(bytes))
    }

    /// Apply external redpallas signatures to the given Orchard spend action indices and return the
    /// signed PCZT bytes. `sighash` is the shielded sighash the signatures commit to; each signature
    /// is verified against it as it is applied, so a bad signature or out-of-range index is an error,
    /// never a silently-broken transaction.
    pub fn inject_sigs(
        pczt_bytes: &[u8],
        sighash: [u8; 32],
        sigs: &[(usize, [u8; 64])],
    ) -> Result<Vec<u8>, String> {
        let pczt = Pczt::parse(pczt_bytes).map_err(|e| format!("failed to parse PCZT: {:?}", e))?;
        let ironwood = active_pool(&pczt)?;
        let apply = |_pczt: &Pczt, bundle: &mut orchard::pczt::Bundle, _: &mut u8| {
            let actions = bundle.actions_mut();
            for (idx, sig) in sigs {
                if *idx >= actions.len() {
                    return Err(OErr::BadIndex(*idx));
                }
                let signature = redpallas::Signature::<SpendAuth>::from(*sig);
                actions[*idx]
                    .apply_signature(sighash, signature)
                    .map_err(OErr::Sign)?;
            }
            Ok::<(), OErr>(())
        };
        let signer = Signer::new(pczt);
        // Apply the FROST signatures to whichever pool the tx spends from (Orchard or Ironwood).
        let signer = if ironwood {
            signer.sign_ironwood_with(apply)
        } else {
            signer.sign_orchard_with(apply)
        }
        .map_err(|e| format!("signing failed: {:?}", e))?;
        signer
            .finish()
            .serialize()
            .map_err(|e| format!("serialize PCZT: {:?}", e))
    }

    // ---------- ZIP-244 shielded sig_digest, recomputed ON-DEVICE from the PCZT ----------
    //
    // The device must NEVER sign a sighash handed to it over the relay: a malicious helper could
    // show a benign PCZT but pass the sighash of an attacker's transaction (issue #62 / ADR-0007
    // invariant I2, the transaction-swap attack). This recomputes the sighash from the device's OWN
    // proven PCZT, so the FROST quorum signs exactly the transaction it inspected - nothing else.
    //
    // Byte-exact mirror of `pczt::roles::signer::Signer::shielded_sighash` (librustzcash rev
    // 42ffd0d), which is `sighash(tx_data.digest(TxIdDigester))` = ZIP-244 §S with `SignableInput::
    // Shielded`. That path pulls in `zcash_primitives` (secp256k1 (C) + zcash_script (C++)), breaking
    // wasm; we rebuild it from the pieces that ARE wasm-clean:
    //   - the header / empty-transparent / empty-sapling digests are fixed personalized BLAKE2b-256
    //     hashes (`zcash_primitives::transaction::txid` + `sighash_v5`), computed here directly;
    //   - the Orchard / Ironwood bundle txid commitments come from the linked `orchard` crate
    //     (`Bundle::commitment`, via the wasm-clean `orchard::pczt::Bundle::extract_effects`), exactly
    //     as `TxIdDigester::digest_{orchard,ironwood}` do.
    // The tx version, version_group_id, consensus_branch_id, lock time and expiry all come from the
    // PCZT `global()` - nothing is hardcoded.
    //
    // Scope: shielded-only sends (no transparent or Sapling components), which is every Konclave
    // browser transaction. A transparent or Sapling bundle is rejected rather than silently hashed
    // wrong - the sig_digest is security-critical, so an unsupported shape must fail loudly.

    // ZIP-244 personalizations (see `zcash_primitives::transaction::txid`).
    const P_HEADERS: &[u8; 16] = b"ZTxIdHeadersHash";
    const P_TRANSPARENT: &[u8; 16] = b"ZTxIdTranspaHash";
    const P_SAPLING: &[u8; 16] = b"ZTxIdSaplingHash";
    const P_OUTER_PREFIX: &[u8; 12] = b"ZcashTxHash_";

    /// One 32-byte BLAKE2b hash personalized by `personal` over `data` (the ZIP-244 node hash).
    fn blake2b32(personal: &[u8; 16], data: &[u8]) -> [u8; 32] {
        let h = blake2b_simd::Params::new()
            .hash_length(32)
            .personal(personal)
            .hash(data);
        let mut out = [0u8; 32];
        out.copy_from_slice(h.as_bytes());
        out
    }

    /// The ZIP-244 txid commitment of one Orchard-shaped bundle (Orchard or Ironwood pool), or
    /// `None` when the bundle has no actions (an absent bundle, which the outer digest substitutes
    /// with the protocol-defined empty-bundle commitment). Mirrors `TxIdDigester::digest_orchard` /
    /// `digest_ironwood`: `bundle.extract_effects().map(|b| b.commitment(tx_version))`.
    fn bundle_txid_commitment(
        pczt: &Pczt,
        ironwood_pool: bool,
        tx_version: orchard::bundle::TxVersion,
    ) -> Result<Option<[u8; 32]>, String> {
        let mut out: Option<[u8; 32]> = None;
        let read =
            |_pczt: &Pczt, bundle: &mut orchard::pczt::Bundle, _: &mut u8| -> Result<(), OErr> {
                if let Some(effects) = bundle.extract_effects::<i64>().map_err(OErr::Extract)? {
                    let commitment = effects.commitment(tx_version).map_err(OErr::Commitment)?;
                    let mut b = [0u8; 32];
                    b.copy_from_slice(commitment.0.as_bytes());
                    out = Some(b);
                }
                Ok(())
            };
        let signer = Signer::new(pczt.clone());
        let res = if ironwood_pool {
            signer.sign_ironwood_with(read)
        } else {
            signer.sign_orchard_with(read)
        };
        res.map_err(|e| format!("bundle commitment: {:?}", e))?;
        Ok(out)
    }

    /// Compute the ZIP-244 shielded `sig_digest` for a proven shielded-only PCZT, ON-DEVICE. This is
    /// the exact message the FROST quorum must sign; a device signs THIS and nothing passed to it.
    ///
    /// Returns an error if the PCZT carries a transparent or Sapling component (out of scope for the
    /// browser signer) or an unsupported transaction version. Byte-for-byte equal to
    /// `konclave-signer`'s `shielded_sighash` on the same PCZT (proven by the `IW_SIGHASH` vector).
    pub fn shielded_sighash(pczt: &Pczt) -> Result<[u8; 32], String> {
        let g = pczt.global();
        let tx_version = *g.tx_version();
        let version_group_id = *g.version_group_id();
        let consensus_branch_id = *g.consensus_branch_id();
        let expiry_height = *g.expiry_height();

        // Shielded-only guard: a transparent or Sapling bundle would make the empty digests below
        // wrong. Reject loudly rather than produce a silently-incorrect sig_digest.
        if !pczt.transparent().inputs().is_empty() || !pczt.transparent().outputs().is_empty() {
            return Err("transparent components are not supported by the browser sighash".into());
        }
        if !pczt.sapling().spends().is_empty() || !pczt.sapling().outputs().is_empty() {
            return Err("Sapling components are not supported by the browser sighash".into());
        }

        // nLockTime per BIP-370 (the PCZT's own rule); for a shielded-only tx this is the fallback
        // lock time (0 in practice), but read it authoritatively rather than assume.
        let lock_time = pczt::common::determine_lock_time(g, pczt.transparent().inputs())
            .ok_or("incompatible lock times in PCZT")?;

        // v5 (Orchard, NU5..NU6.2) vs v6 (Ironwood, NU6.3+). The Orchard-slot commitment domain
        // differs per version, and only v6 carries an Ironwood digest in the outer tree.
        let (is_v6, orchard_tx_version) = match tx_version {
            5 => (false, orchard::bundle::TxVersion::V5),
            6 => (true, orchard::bundle::TxVersion::V6),
            v => return Err(format!("unsupported PCZT tx version {v} (expected 5 or 6)")),
        };

        // T.1 header digest - tx header (overwintered bit | version), version_group_id,
        // consensus_branch_id, lock_time, expiry_height, all u32 little-endian.
        let mut header_bytes = Vec::with_capacity(20);
        header_bytes.extend_from_slice(&(0x8000_0000u32 | tx_version).to_le_bytes());
        header_bytes.extend_from_slice(&version_group_id.to_le_bytes());
        header_bytes.extend_from_slice(&consensus_branch_id.to_le_bytes());
        header_bytes.extend_from_slice(&lock_time.to_le_bytes());
        header_bytes.extend_from_slice(&expiry_height.to_le_bytes());
        let header_digest = blake2b32(P_HEADERS, &header_bytes);

        // T.2 transparent sig-digest and T.3 Sapling digest: both empty (shielded-only, no bundle).
        let transparent_digest = blake2b32(P_TRANSPARENT, &[]);
        let sapling_digest = blake2b32(P_SAPLING, &[]);

        // T.4 Orchard digest: the Orchard bundle commitment, or the empty-bundle commitment when the
        // tx spends only from Ironwood (the Orchard bundle then has no actions).
        let orchard_digest = match bundle_txid_commitment(pczt, false, orchard_tx_version)? {
            Some(d) => d,
            None => empty_bundle_commitment(orchard::ValuePool::Orchard, orchard_tx_version)?,
        };

        // Outer digest: personalized "ZcashTxHash_" || consensus_branch_id, over
        // header ‖ transparent ‖ sapling ‖ orchard [‖ ironwood for v6].
        let mut personal = [0u8; 16];
        personal[..12].copy_from_slice(P_OUTER_PREFIX);
        personal[12..].copy_from_slice(&consensus_branch_id.to_le_bytes());

        let mut body = Vec::with_capacity(32 * 5);
        body.extend_from_slice(&header_digest);
        body.extend_from_slice(&transparent_digest);
        body.extend_from_slice(&sapling_digest);
        body.extend_from_slice(&orchard_digest);
        if is_v6 {
            let ironwood_digest =
                match bundle_txid_commitment(pczt, true, orchard::bundle::TxVersion::V6)? {
                    Some(d) => d,
                    None => empty_bundle_commitment(
                        orchard::ValuePool::Ironwood,
                        orchard::bundle::TxVersion::V6,
                    )?,
                };
            body.extend_from_slice(&ironwood_digest);
        }
        Ok(blake2b32(&personal, &body))
    }

    /// The protocol-defined empty-bundle txid commitment for a pool/version (substituted for an
    /// absent bundle in the outer digest), from the linked `orchard` crate.
    fn empty_bundle_commitment(
        value_pool: orchard::ValuePool,
        tx_version: orchard::bundle::TxVersion,
    ) -> Result<[u8; 32], String> {
        let h = orchard::bundle::commitments::hash_bundle_txid_empty(value_pool, tx_version)
            .map_err(|e| format!("empty bundle commitment: {:?}", e))?;
        let mut out = [0u8; 32];
        out.copy_from_slice(h.as_bytes());
        Ok(out)
    }

    // Parity tests: the WASM bridge must reproduce konclave-signer's output on the same real mainnet
    // PCZT vectors (DKG-vault send `aab00f90…`, funding send `7f8e59bb…`). The sighashes below are the
    // ones konclave-signer extracted (and that the broadcast signatures commit to).
    #[cfg(test)]
    mod tests {
        use super::*;

        // Real Ironwood (NU6.3 / V6, pczt v2) vectors, shared byte-for-byte with konclave-signer's
        // parity suite. The WASM bridge must reproduce the canonical signer's output on the SAME
        // v2 PCZT the engine produces post-Ironwood (a 4-spend `create-max` Ironwood tx).
        const IW_PROVEN: &[u8] =
            include_bytes!("../tests/vectors/ironwood_single_spend.proven.pczt");

        // What the coordinator publishes into the signing room is a copy of the proven PCZT with an
        // optional per-spend field removed (`orchestrator::pczt::published_copy`, whose output for
        // these two vectors is committed beside them and pinned byte for byte by that crate's
        // tests). Everything a device runs on a request must answer the same on it as on the full
        // PCZT, or removing the field would change what a device shows or signs.
        const IW_PUBLISHED: &[u8] =
            include_bytes!("../tests/vectors/ironwood_single_spend.published.pczt");
        const OR_PROVEN: &[u8] =
            include_bytes!("../tests/vectors/orchard_mainnet_two_spend.proven.pczt");
        const OR_PUBLISHED: &[u8] =
            include_bytes!("../tests/vectors/orchard_mainnet_two_spend.published.pczt");

        #[test]
        fn a_device_reads_the_published_copy_exactly_as_it_reads_the_full_pczt() {
            for (name, full, published) in [
                ("ironwood", IW_PROVEN, IW_PUBLISHED),
                ("orchard", OR_PROVEN, OR_PUBLISHED),
            ] {
                assert_ne!(full, published, "{name}: the copy must really differ");
                assert_eq!(
                    shielded_sighash(&Pczt::parse(published).unwrap()),
                    shielded_sighash(&Pczt::parse(full).unwrap()),
                    "{name}: the message the quorum signs"
                );
                assert_eq!(
                    extract_randomizers(published),
                    extract_randomizers(full),
                    "{name}: what each seat signs with"
                );
                assert_eq!(
                    describe_outputs(published),
                    describe_outputs(full),
                    "{name}: the outputs a device lists"
                );
                assert_eq!(
                    read_payment(published),
                    read_payment(full),
                    "{name}: the payment a device shows before it signs"
                );
            }
        }

        /// The comparison above is blind if both sides fail the same way, so the vectors that are
        /// meant to be readable must be.
        #[test]
        fn the_published_copy_of_each_readable_vector_is_readable() {
            assert!(read_payment(IW_PUBLISHED).is_ok());
            assert!(describe_outputs(IW_PUBLISHED).is_ok());
            assert!(describe_outputs(OR_PUBLISHED).is_ok());
        }

        #[test]
        fn a_signature_applies_to_the_published_copy() {
            // `inject_sigs` checks each signature against the spend's key and the sighash as it
            // applies it, so this is the device-side proof that signing needs nothing the copy lacks.
            let signed = inject_sigs(IW_PUBLISHED, IW_SIGHASH, &[(0, sig64(IW_SIG0))]);
            assert!(signed.is_ok(), "{:?}", signed.err());
        }

        // #364. The pool decision used to live TWICE in this module: once in `active_pool`, which
        // `describe_outputs` and `inject_sigs` call, and once inline in `extract_randomizers`, which
        // is the function the live browser ceremony consumes. They disagreed on exactly one input.
        //
        // These take booleans on purpose. A mixed PCZT does not exist in this repo and is not cheap
        // to build, so every behaviour test here is blind to the one case that matters. Testing the
        // DECISION instead of the parse makes the mixed branch reachable, and it is the branch that
        // had never run.
        #[test]
        fn decide_pool_answers_every_combination() {
            assert_eq!(decide_pool(true, false), Ok(false), "orchard only");
            assert_eq!(decide_pool(false, true), Ok(true), "ironwood only");

            let empty = decide_pool(false, false).unwrap_err();
            assert!(
                empty.contains("no real shielded spends"),
                "nothing to sign must say so, got: {empty}"
            );

            let mixed = decide_pool(true, true).unwrap_err();
            assert!(
                mixed.contains("mixed Orchard+Ironwood"),
                "a mix must be refused, not silently resolved to one pool, got: {mixed}"
            );
        }

        // The refusal a member reads must not depend on which runtime they hit. The native signer
        // says this exact sentence; a browser saying something else about one cause is how a wrong
        // failure costs hours (#364's own words).
        #[test]
        fn the_mixed_refusal_is_worded_exactly_as_the_native_signers() {
            assert_eq!(
                decide_pool(true, true).unwrap_err(),
                "mixed Orchard+Ironwood spends are not supported by this bridge"
            );
        }

        // THE GUARD THAT ACTUALLY CATCHES THIS, and the reason it is a source scan.
        //
        // Every behaviour test in this module is blind to #364, and that is worth stating rather
        // than discovering later: the only fixture is Ironwood-only, and on an Ironwood-only PCZT
        // the diverged implementation and the correct one return the SAME thing. Restoring the old
        // `if !orchard.is_empty() { return orchard }` leaves all 22 tests green - measured, not
        // assumed. A test that looks like a guard and is not is worse than no test, and this repo
        // has already shipped one (a cross-crate test that built the message with the same function
        // it verified, self-consistent by construction).
        //
        // So the rule is checked where it is written: the pool question has ONE answer in this
        // module, and the ceremony's reader must ask it rather than answer it.
        #[test]
        fn the_pool_question_is_answered_in_one_place() {
            let src = include_str!("lib.rs");
            let body = src
                .split("pub fn extract_randomizers")
                .nth(1)
                .expect("extract_randomizers exists")
                .split("\n    }")
                .next()
                .expect("its body is delimited");

            assert!(
                body.contains("active_pool("),
                "extract_randomizers must ASK active_pool, not decide the pool itself (#364)"
            );
            assert!(
                !body.contains("is_empty()"),
                "deciding the pool by emptiness here is the #364 divergence, restored: {body}"
            );
        }

        // The regression this closes, stated as the property rather than the fix: the function the
        // ceremony calls and the function the preview calls must agree on EVERY PCZT. Before #364
        // they disagreed on the mixed one, and only the preview refused.
        #[test]
        fn the_ceremony_and_the_preview_agree_on_the_pool() {
            let pczt = Pczt::parse(IW_PROVEN).expect("fixture parses");
            let via_active_pool = active_pool(&pczt).expect("the fixture has real spends");
            assert!(via_active_pool, "the fixture is an Ironwood tx");

            // extract_randomizers must now reach the SAME answer, and return that pool's spends.
            let spends = extract_randomizers(IW_PROVEN).expect("extraction succeeds");
            let ironwood = ironwood_spends(&pczt).expect("ironwood parse");
            assert_eq!(
                spends, ironwood,
                "the ceremony must read the pool active_pool named"
            );
            assert!(!spends.is_empty(), "and it must find the real spends");
        }
        const IW_SIGNED: &[u8] =
            include_bytes!("../tests/vectors/ironwood_single_spend.signed.pczt");
        const IW_SIG0: &[u8] = include_bytes!("../tests/vectors/ironwood_single_spend.sig0.raw");

        // A wallet-controlled ZERO-VALUE spend still awaiting a signature: the same vector above
        // with action 1's spend value set to 0, so it differs in exactly the field under test.
        // Post-NU6.3 the builder fabricates such a counterpart under the cross-address restriction
        // and it is OURS to sign, unlike a protocol padding dummy (which carries `dummy_sk`, is
        // signed by the IO Finalizer, and therefore arrives with `spend_auth_sig == Some`).
        const IW_ZERO_VALUE: &[u8] =
            include_bytes!("../tests/vectors/ironwood_zero_value_spend.proven.pczt");

        // The same vector with `dummy_sk` set on action 1 and nothing else changed (the bytes
        // after action 1's `alpha` read `zip32_derivation: None, dummy_sk: None`; the second byte
        // became `Some(sk)`). Action 1 is a spend the vault signs; the key left on it is what a
        // padding dummy carries before the IO Finalizer signs and clears it. It awaits a
        // signature, so the predicate alone took it as ours.
        // konclave-signer carries the identical file.
        const IW_DUMMY_SK: &[u8] =
            include_bytes!("../tests/vectors/ironwood_dummy_sk_spend.proven.pczt");
        const IW_DUMMY_SK_SIGNED: &[u8] =
            include_bytes!("../tests/vectors/ironwood_dummy_sk_signed.pczt");

        const IW_SIGHASH: [u8; 32] =
            hex_literal("332de126200c22131337474ae50367218ec87815c23d297dcdc8278ecb8903b0");

        // const-fn hex decoder so the expected sighashes read as hex in the source.
        const fn hex_literal(s: &str) -> [u8; 32] {
            let b = s.as_bytes();
            let mut out = [0u8; 32];
            let mut i = 0;
            while i < 32 {
                out[i] = nib(b[i * 2]) * 16 + nib(b[i * 2 + 1]);
                i += 1;
            }
            out
        }
        const fn nib(c: u8) -> u8 {
            match c {
                b'0'..=b'9' => c - b'0',
                b'a'..=b'f' => c - b'a' + 10,
                _ => 0,
            }
        }

        fn sig64(bytes: &[u8]) -> [u8; 64] {
            bytes.try_into().expect("fixture signature is 64 bytes")
        }

        #[test]
        fn extract_matches_signer_ironwood() {
            // The WASM must read the SAME real Ironwood spends the canonical signer reads from the
            // v2 PCZT (a `create-max` tx spending 4 notes; every action is a real Ironwood spend).
            let r = extract_randomizers(IW_PROVEN).unwrap();
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
        fn a_zero_value_spend_awaiting_a_signature_is_collected() {
            // Parity with konclave-signer's test of the same name, on the same bytes. Selecting by
            // `value != 0` skipped this spend, nobody signed it, and the send died at extract with
            // `MissingSpendAuthSig` (#86). The browser signer must not diverge from the native one
            // here: two signers that disagree about WHICH spends need a signature produce a
            // transaction that one of them thinks is complete (#365).
            let r = extract_randomizers(IW_ZERO_VALUE).unwrap();
            let indices: Vec<usize> = r.iter().map(|(i, _)| *i).collect();
            assert_eq!(
                indices,
                vec![0, 1, 2, 3],
                "every unsigned spend must be collected, including the zero-value one at index 1",
            );
        }

        #[test]
        fn a_spend_still_carrying_dummy_sk_is_refused() {
            // "Signers MUST reject PCZTs that contain `dummy_sk` values" (pczt, orchard). Taken as
            // ours, such a spend joined the ceremony, raised the action count the fee is read from,
            // and failed at injection. The device must refuse it before it signs or shows a fee,
            // on both readers: the randomizers the ceremony uses and the payment it shows.
            let err = extract_randomizers(IW_DUMMY_SK).unwrap_err();
            assert!(err.contains("dummy_sk"), "{err}");
            let shown = read_payment(IW_DUMMY_SK).map(|_| ()).unwrap_err();
            assert_eq!(shown, err, "one refusal, worded once");
        }

        #[test]
        fn a_signed_spend_still_carrying_dummy_sk_is_refused_too() {
            // The specification refuses the PCZT, not the spend: a key left on an action that is
            // already signed (`ironwood_single_spend.signed.pczt` with `dummy_sk` set on action
            // 0; konclave-signer carries the identical file) is refused as well, though that
            // action would not join the ceremony.
            let err = extract_randomizers(IW_DUMMY_SK_SIGNED).unwrap_err();
            assert!(err.contains("dummy_sk"), "{err}");
        }

        #[test]
        fn an_already_signed_spend_is_not_collected() {
            // The other half: the predicate must not become "collect everything". An action an
            // earlier signer authorized carries a signature and is skipped, which is what keeps a
            // signed action out of a second ceremony.
            let signed = inject_sigs(IW_PROVEN, IW_SIGHASH, &[(0, sig64(IW_SIG0))]).unwrap();
            let r = extract_randomizers(&signed).unwrap();
            let indices: Vec<usize> = r.iter().map(|(i, _)| *i).collect();
            assert_eq!(
                indices,
                vec![1, 2, 3],
                "action 0 now carries a signature and must not be collected again",
            );
        }

        #[test]
        fn ironwood_tx_is_detected_as_ironwood_pool() {
            // Orchard-first, Ironwood-fallback: a pure-Ironwood tx yields no Orchard spends.
            assert!(orchard_spends(&Pczt::parse(IW_PROVEN).unwrap())
                .unwrap()
                .is_empty());
            assert!(!ironwood_spends(&Pczt::parse(IW_PROVEN).unwrap())
                .unwrap()
                .is_empty());
        }

        #[test]
        fn inject_reproduces_signed_ironwood_pczt() {
            let signed = inject_sigs(IW_PROVEN, IW_SIGHASH, &[(0, sig64(IW_SIG0))]).unwrap();
            assert_eq!(
                signed.as_slice(),
                IW_SIGNED,
                "WASM inject must reproduce the exact signed v2 PCZT the canonical signer produces",
            );
        }

        #[test]
        fn inject_rejects_out_of_range_index() {
            assert!(inject_sigs(IW_PROVEN, IW_SIGHASH, &[(99, sig64(IW_SIG0))]).is_err());
        }

        #[test]
        fn inject_rejects_wrong_signature() {
            assert!(inject_sigs(IW_PROVEN, IW_SIGHASH, &[(0, [0u8; 64])]).is_err());
        }

        #[test]
        fn describe_outputs_reads_ironwood_outputs() {
            // The v2 Ironwood tx's outputs are readable from the Ironwood bundle (pool-aware), so a
            // device can confirm "what am I signing" before contributing its share.
            let outs = describe_outputs(IW_PROVEN).unwrap();
            assert!(!outs.is_empty(), "the Ironwood tx has outputs to display");
            assert!(
                outs.iter().any(|o| o.value.is_some()),
                "at least one output exposes a value",
            );
        }

        #[test]
        fn describe_outputs_exposes_recipient_bytes_for_the_money_gate() {
            // The on-device money gate (#281) decides on `recipient`, not the advisory `user_address`.
            // Every real output of this proven send must expose its 43-byte receiver as 86 hex chars,
            // so the gate has the ground truth to compare against the approved recipients.
            let outs = describe_outputs(IW_PROVEN).unwrap();
            for o in &outs {
                let r = o
                    .recipient
                    .as_ref()
                    .expect("every real output exposes a recipient");
                assert_eq!(
                    r.len(),
                    86,
                    "a raw Orchard receiver is 43 bytes = 86 hex chars"
                );
                assert!(r.bytes().all(|b| b.is_ascii_hexdigit()), "recipient is hex");
            }
            // This send's shape, decoded: a payment output that carries a user_address, and a change
            // output that does NOT (it pays the vault's internal scope). The gate cannot tell change
            // from the external receive address, which is exactly why `ourReceivers` is supplied.
            let payment = outs
                .iter()
                .find(|o| o.address.is_some())
                .expect("a payment output carries a user_address label");
            assert!(payment.value.unwrap_or(0) > 0);
            let change = outs
                .iter()
                .find(|o| o.address.is_none() && o.value.unwrap_or(0) > 0)
                .expect("a change output has value but no user_address");
            assert_ne!(
                change.recipient, payment.recipient,
                "change pays the vault's internal scope, a different receiver than the payment",
            );
        }

        #[test]
        fn ua_receiver_reproduces_what_the_prover_bound_into_the_note() {
            // The strongest form this test can take, and the reason it is worth having: both sides
            // come from the SAME mainnet-proven send. The `user_address` is the label a human typed
            // and an Updater stored; the `recipient` is what the Prover actually bound into the note
            // commitment the sighash covers. If `ua_receiver` reproduces one from the other, the
            // money gate is comparing the approved destination against the paid destination in a
            // single space - which is the whole claim of #281.
            //
            // It is deliberately NOT a round-trip through our own encoder. A test that built the
            // address with the same code it verifies would be self-consistent by construction, which
            // is the near-miss recorded in CLAUDE.md: a cross-crate test that caught nothing because
            // it made the message with the function it checked.
            let outs = describe_outputs(IW_PROVEN).unwrap();
            let payment = outs
                .iter()
                .find(|o| o.address.is_some() && o.value.unwrap_or(0) > 0)
                .expect("the proven send has a labelled payment output");
            let ua = payment.address.as_ref().unwrap();
            let decoded =
                ua_receiver(ua).expect("the approved address decodes to an Orchard receiver");
            assert_eq!(
                &decoded,
                payment.recipient.as_ref().unwrap(),
                "the decoded receiver must equal the one the prover bound into the note",
            );
        }

        #[test]
        fn ua_receiver_refuses_what_a_shielded_vault_cannot_pay() {
            // Refusing is the safe answer. An address with no Orchard receiver cannot be paid by a
            // vault spend at all, so decoding it to anything would let the gate "match" a
            // destination the money can never reach - and a gate that matches is a gate that signs.
            assert!(ua_receiver("").is_err());
            assert!(ua_receiver("not an address").is_err());
            // A transparent address: syntactically real, decodable, and unpayable here.
            assert!(ua_receiver("t1KsBQjhRZ1Y3vFPnGjbn6h9gK8FBS3W6xr").is_err());
        }

        #[test]
        fn describe_outputs_rejects_garbage() {
            assert!(describe_outputs(b"not a pczt").is_err());
        }

        // ---------- #610: the fields a device reads must be the ones the signature covers ----------
        //
        // A PCZT output carries `recipient` and `value` NEXT TO its note commitment `cmx`, and the
        // party that builds the PCZT writes all three. The sighash covers `cmx`, not the two fields
        // beside it. So these tests change a field in the serialized bytes and leave `cmx` alone:
        // the result is exactly what a hostile coordinator would hand a device - the same
        // transaction under the signature, a different payment in the fields the gate reads.

        /// Replace the ONLY occurrence of `needle` in `hay`. Postcard has no length prefix on a
        /// struct, so a field may change length as long as the pattern is unique; the uniqueness
        /// assertion is what keeps the patch from landing somewhere else.
        fn patch_once(hay: &[u8], needle: &[u8], with: &[u8]) -> Vec<u8> {
            let at: Vec<usize> = hay
                .windows(needle.len())
                .enumerate()
                .filter(|(_, w)| *w == needle)
                .map(|(i, _)| i)
                .collect();
            assert_eq!(at.len(), 1, "the patched pattern must occur exactly once");
            [&hay[..at[0]], with, &hay[at[0] + needle.len()..]].concat()
        }

        /// Postcard's varint (unsigned LEB128), the encoding of a `u64` field.
        fn varint(mut v: u64) -> Vec<u8> {
            let mut out = vec![];
            loop {
                let byte = (v & 0x7f) as u8;
                v >>= 7;
                if v == 0 {
                    out.push(byte);
                    return out;
                }
                out.push(byte | 0x80);
            }
        }

        /// One output of the fixture as it sits on the wire: the tail of its `out_ciphertext`
        /// (the field serialized right before `recipient`), its recipient bytes and its value.
        struct WireOutput {
            anchor: Vec<u8>,
            recipient: Vec<u8>,
            value: u64,
        }

        impl WireOutput {
            /// `out_ciphertext` tail ++ `Some(recipient)` ++ `Some(value)`, with the two fields
            /// replaced. The anchor is what makes the pattern unique: in this fixture the payment
            /// pays the same receiver as one of the notes it spends, so `recipient ++ value` alone
            /// also matches that spend.
            fn wire(&self, recipient: &[u8], value: u64) -> Vec<u8> {
                [&self.anchor[..], &[1u8], recipient, &[1u8], &varint(value)].concat()
            }
            fn as_is(&self) -> Vec<u8> {
                self.wire(&self.recipient, self.value)
            }
        }

        /// The fixture's labelled payment and unlabelled change, read before any patch.
        fn payment_and_change() -> (WireOutput, WireOutput) {
            let mut outs: Vec<(bool, WireOutput)> = vec![];
            Signer::new(Pczt::parse(IW_PROVEN).unwrap())
                .sign_ironwood_with(|_, bundle, _| {
                    for a in bundle.actions() {
                        let o = a.output();
                        let value = o.value().map(|v| v.inner()).unwrap_or(0);
                        if value == 0 {
                            continue;
                        }
                        let oc = &o.encrypted_note().out_ciphertext;
                        outs.push((
                            o.user_address().is_some(),
                            WireOutput {
                                anchor: oc[oc.len() - 16..].to_vec(),
                                recipient: o.recipient().unwrap().to_raw_address_bytes().to_vec(),
                                value,
                            },
                        ));
                    }
                    Ok::<(), OErr>(())
                })
                .unwrap();
            let mut take = |labelled: bool| {
                let i = outs
                    .iter()
                    .position(|(l, _)| *l == labelled)
                    .expect("present");
                outs.remove(i).1
            };
            let pay = take(true);
            let chg = take(false);
            (pay, chg)
        }

        fn assert_refused(pczt: &[u8], code: &str) {
            let err = describe_outputs(pczt).expect_err("a device must refuse this PCZT");
            assert!(err.starts_with(code), "expected {code}, got: {err}");
        }

        #[test]
        fn a_patched_field_leaves_the_signature_unchanged() {
            // The premise of every test below, checked rather than assumed: if patching a field
            // changed the sighash, the attack would not exist and the tests would prove nothing.
            let (pay, chg) = payment_and_change();
            let swapped = patch_once(
                IW_PROVEN,
                &chg.as_is(),
                &chg.wire(&pay.recipient, chg.value),
            );
            assert_eq!(
                shielded_sighash(&Pczt::parse(&swapped).unwrap()).unwrap(),
                IW_SIGHASH,
                "the recipient field is outside the sighash",
            );
            let revalued = patch_once(IW_PROVEN, &pay.as_is(), &pay.wire(&pay.recipient, 1));
            assert_eq!(
                shielded_sighash(&Pczt::parse(&revalued).unwrap()).unwrap(),
                IW_SIGHASH,
                "the value field is outside the sighash",
            );
        }

        #[test]
        fn a_recipient_the_commitment_does_not_bind_is_refused() {
            // The change output claims to pay someone else. The note it commits to still pays the
            // vault, so the field describes a payment the transaction does not make.
            let (pay, chg) = payment_and_change();
            let tampered = patch_once(
                IW_PROVEN,
                &chg.as_is(),
                &chg.wire(&pay.recipient, chg.value),
            );
            assert_refused(&tampered, "[commitment]");
        }

        #[test]
        fn a_value_the_commitment_does_not_bind_is_refused() {
            let (pay, _) = payment_and_change();
            let tampered = patch_once(
                IW_PROVEN,
                &pay.as_is(),
                &pay.wire(&pay.recipient, pay.value - 1),
            );
            assert_refused(&tampered, "[commitment]");
        }

        #[test]
        fn a_paying_output_cannot_pass_for_padding() {
            // The gate ignores zero-value outputs, so a real payment that CLAIMS zero would not be
            // checked against any approved line at all. The commitment says what it really pays.
            let (pay, _) = payment_and_change();
            let tampered = patch_once(IW_PROVEN, &pay.as_is(), &pay.wire(&pay.recipient, 0));
            assert_refused(&tampered, "[commitment]");
        }

        /// A real testnet unified address whose only receiver is `receiver`.
        fn testnet_ua(receiver: &[u8]) -> String {
            use zcash_address::unified::{Address, Encoding, Receiver, Revision, Uitem};
            let r: [u8; 43] = receiver.try_into().unwrap();
            Address::try_from_items(Revision::R0, vec![Uitem::Data(Receiver::Orchard(r))])
                .unwrap()
                .encode(&zcash_protocol::consensus::NetworkType::Test)
        }

        /// The fixture's payment label, as it sits on the wire: `Some(len ++ utf8)`.
        fn label_wire(label: &str) -> Vec<u8> {
            [&[1u8][..], &varint(label.len() as u64), label.as_bytes()].concat()
        }

        #[test]
        fn a_label_that_names_another_receiver_is_refused() {
            // The commitment pays the payee and the label names the vault's change receiver: a
            // member reading the screen sees one address while the money goes to another. The
            // pczt crate asks a Signer to confirm that `user_address` contains `recipient`.
            let (_, chg) = payment_and_change();
            let label = describe_outputs(IW_PROVEN)
                .unwrap()
                .into_iter()
                .find_map(|o| o.address)
                .unwrap();
            let other = testnet_ua(&chg.recipient);
            assert_ne!(other, label);
            let tampered = patch_once(IW_PROVEN, &label_wire(&label), &label_wire(&other));
            assert_refused(&tampered, "[label]");
        }

        #[test]
        fn a_label_that_is_not_an_address_is_refused() {
            let label = describe_outputs(IW_PROVEN)
                .unwrap()
                .into_iter()
                .find_map(|o| o.address)
                .unwrap();
            let tampered = patch_once(IW_PROVEN, &label_wire(&label), &label_wire("Alice"));
            assert_refused(&tampered, "[label]");
        }

        #[test]
        fn a_fee_below_zip317_is_refused() {
            // The fee is exactly what ZIP 317 sets for the transaction's actions: every honest send
            // on mainnet pays exactly that. A lower one is a transaction the network may not relay.
            let tampered = patch_once(IW_PROVEN, &varint(20000), &varint(15000));
            assert_refused(&tampered, "[fee]");
        }

        // The header a device can check before its share leaves, from its own clock and the network
        // the build is for, never from the coordinator's height or the PCZT's own claims.
        const T_ANCHOR: i64 = 1_785_247_643; // block 3,428,143 (NU6.3 activation), header time
        /// What the device read before NU7's row existed: the NU6.3 row alone, with mainnet's anchor.
        /// The tests that pin the behaviour that did not change (the pinned window, the turning point of
        /// a record, a record that never stops counting) read it, because past the real upgrade height
        /// the real table rightly answers differently. They are tests of the rule, not of the date.
        const ONE_ROW: NetworkRules = NetworkRules {
            epochs: &[MAINNET.epochs[0]],
            anchor: MAINNET.anchor,
        };
        /// A record entry of an NU6.3 transaction, as every record written so far is.
        fn signed(sighash: &str, expiry: u32) -> SignedTx {
            SignedTx {
                sighash: sighash.into(),
                expiry,
                branch: NU6_3,
            }
        }
        /// What `Second` is for an NU6.3 transaction expiring at `first_expiry`: the time shown is
        /// the rule's own turning point (`lapses_at`) on the one-row table, which is what the pinned tests read.
        fn second(first_expiry: u32) -> ApprovalDecision {
            ApprovalDecision::Second {
                first_expiry,
                until_unix: lapses_at(&ONE_ROW, first_expiry, NU6_3),
                until_height: None,
                by_epoch: false,
            }
        }
        fn honest(now: i64) -> TxHeader {
            let b = MAINNET.height_bounds(now);
            // An honest builder: the chain runs slower than 75 s a block, so its tip is behind `est`.
            TxHeader {
                tx_version: 6,
                version_group_id: 0xD884_B698,
                branch_id: 0x37a5_165b,
                lock_time: 0,
                expiry_height: b.est - 412 + 41,
            }
        }

        #[test]
        fn height_bounds_hold_a_margin_that_grows_with_time_since_the_anchor() {
            let b = MAINNET.height_bounds(T_ANCHOR);
            assert_eq!(
                (b.lo, b.est, b.hi),
                (3_428_143 - 144, 3_428_143, 3_428_143 + 40 + 144)
            );
            let b = MAINNET.height_bounds(T_ANCHOR + 75 * 87_500);
            assert_eq!(b.est, 3_428_143 + 87_500);
            assert_eq!(b.est - b.lo, 144 + 875);
            assert_eq!(b.hi - b.est, 40 + 144 + 875);
        }

        // Characterisation (#638): what the device's clock gives TODAY, captured from the code
        // BEFORE the table moved to konclave-seal::epochs. Literals on purpose: the refactor must
        // reproduce these, not re-derive them. (clock offset from the anchor, lo, est, hi)
        const PINNED_BOUNDS: [(i64, u32, u32, u32); 28] = [
            (0, 3427999, 3428143, 3428327),
            (1, 3427999, 3428143, 3428327),
            (74, 3427999, 3428143, 3428327),
            (75, 3427999, 3428144, 3428329),
            (76, 3427999, 3428144, 3428329),
            (149, 3427999, 3428144, 3428329),
            (150, 3428000, 3428145, 3428330),
            (3600, 3428046, 3428191, 3428376),
            (10800, 3428141, 3428287, 3428473),
            (86399, 3429138, 3429294, 3429490),
            (86400, 3429139, 3429295, 3429491),
            (604800, 3435982, 3436207, 3436472),
            (2592000, 3462213, 3462703, 3463233),
            (5000000, 3493998, 3494809, 3495660),
            (6562500, 3514624, 3515643, 3516702),
            (7776000, 3530642, 3531823, 3533044),
            (8640000, 3542047, 3543343, 3544679),
            (10000000, 3559998, 3561476, 3562994),
            (15552000, 3633285, 3635503, 3637761),
            (20000000, 3691998, 3694809, 3697660),
            (31536000, 3844274, 3848623, 3853012),
            (40000000, 3955998, 3961476, 3966994),
            (63072000, 4260549, 4269103, 4277697),
            (94608000, 4676824, 4689583, 4702382),
            (126144000, 5093099, 5110063, 5127067),
            (157680000, 5509375, 5530543, 5551751),
            (315360000, 7590751, 7632943, 7675175),
            (1000000000, 16627998, 16761476, 16894994),
        ];
        // (expiry, the moment the device stops counting a transaction that expires there)
        const PINNED_LAPSES: [(u32, i64); 7] = [
            (1, 1785247643),
            (3_428_000, 1785248618),
            (3_428_143, 1785259418),
            (3_428_183, 1785262418),
            (3_430_000, 1785400118),
            (3_600_000, 1798278893),
            (7_000_000, 2055854618),
        ];

        #[test]
        fn height_bounds_reproduce_what_the_device_gave_before_the_table_moved() {
            for (d, lo, est, hi) in PINNED_BOUNDS {
                let b = ONE_ROW.height_bounds(T_ANCHOR + d);
                assert_eq!((b.lo, b.est, b.hi), (lo, est, hi), "clock anchor+{d}");
            }
            // A clock before the anchor confirms nothing: the empty window.
            for d in [-86_400i64, -1] {
                let b = ONE_ROW.height_bounds(T_ANCHOR + d);
                assert_eq!((b.lo, b.est, b.hi), (u32::MAX, 0, 0), "clock anchor{d}");
            }
        }

        #[test]
        fn lapses_at_reproduces_what_the_device_gave_before_the_table_moved() {
            for (expiry, t) in PINNED_LAPSES {
                assert_eq!(
                    lapses_at(&ONE_ROW, expiry, NU6_3),
                    Some(t),
                    "expiry {expiry}"
                );
            }
        }

        #[test]
        fn the_decision_turns_ten_blocks_below_the_floor_across_the_sweep() {
            // The oracle is today's rule written out (`expiry + 10 >= lo`), with its own literal 10:
            // the production rule must agree with it at every clock, on both sides of the turn.
            for (d, lo, _, _) in PINNED_BOUNDS {
                let now = T_ANCHOR + d;
                for (expiry, counted) in [(lo - 11, false), (lo - 10, true), (lo - 9, true)] {
                    let got = approval_decision(&ONE_ROW, &[signed("aa", expiry)], "bb", now);
                    let want = if counted {
                        second(expiry)
                    } else {
                        ApprovalDecision::AfterExpiry
                    };
                    assert_eq!(got, want, "clock anchor+{d}, expiry {expiry}");
                }
            }
        }

        #[test]
        fn an_honest_header_passes_today() {
            let now = T_ANCHOR + 75 * 87_500;
            check_header(&MAINNET, &honest(now), now).unwrap();
        }

        #[test]
        fn a_header_outside_what_the_device_can_confirm_is_refused() {
            let now = T_ANCHOR + 75 * 87_500;
            let h = honest(now);
            let b = MAINNET.height_bounds(now);
            let refused = |h: TxHeader, tag: &str| {
                let e = check_header(&MAINNET, &h, now).unwrap_err();
                assert!(e.starts_with(tag), "{tag}: {e}");
            };
            refused(
                TxHeader {
                    expiry_height: 0,
                    ..h
                },
                "[expiry]",
            );
            refused(
                TxHeader {
                    expiry_height: b.lo,
                    ..h
                },
                "[expiry]",
            );
            refused(
                TxHeader {
                    expiry_height: b.hi + 1,
                    ..h
                },
                "[expiry]",
            );
            refused(
                TxHeader {
                    branch_id: 0xc8e7_1055,
                    ..h
                },
                "[network]",
            );
            refused(TxHeader { tx_version: 5, ..h }, "[network]");
            refused(
                TxHeader {
                    version_group_id: 0x26a7_270a,
                    ..h
                },
                "[network]",
            );
            refused(TxHeader { lock_time: 1, ..h }, "[locktime]");
            check_header(
                &MAINNET,
                &TxHeader {
                    expiry_height: b.lo + 1,
                    ..h
                },
                now,
            )
            .unwrap();
            check_header(
                &MAINNET,
                &TxHeader {
                    expiry_height: b.hi,
                    ..h
                },
                now,
            )
            .unwrap();
        }

        // A network table anchored where this testnet fixture was built, so its honest header
        // passes: the fixture's expiry is its builder's tip + 40.
        fn rules_for_fixture() -> (NetworkRules, i64) {
            rules_for(IW_PROVEN)
        }

        /// The same for any PCZT of the fixture's family (its branch, whatever it is).
        fn rules_for(pczt: &[u8]) -> (NetworkRules, i64) {
            let p = Pczt::parse(pczt).unwrap();
            let expiry = *p.global().expiry_height();
            let e: &'static [Epoch] = Box::leak(Box::new([Epoch {
                activation_height: expiry - 41,
                spacing_s: 75,
                expiry_delta: 40,
                branch_id: *p.global().consensus_branch_id(),
                tx_version: 6,
                version_group_id: 0xD884_B698,
            }]));
            let anchor = konclave_seal::epochs::Anchor {
                height: expiry - 41,
                unix: T_ANCHOR,
            };
            (NetworkRules { epochs: e, anchor }, T_ANCHOR)
        }

        #[test]
        fn read_for_signing_gives_the_payment_the_sighash_and_the_txid_it_gives() {
            let (r, now) = rules_for_fixture();
            let f = read_for_signing_with(&r, IW_PROVEN, now).unwrap();
            assert_eq!(f.payment.fee_zat, read_payment(IW_PROVEN).unwrap().fee_zat);
            // Expected values from other implementations, not from the code under test: the sighash
            // is `konclave-signer extract`'s and the txid `zcash-devtool pczt inspect`'s, for this same
            // vector (orchestrator/src/pczt.rs).
            let hex = |b: &[u8]| b.iter().map(|x| format!("{x:02x}")).collect::<String>();
            assert_eq!(
                hex(&f.sighash),
                "332de126200c22131337474ae50367218ec87815c23d297dcdc8278ecb8903b0"
            );
            assert_eq!(
                f.txid,
                "b00389cb8e27c8cd7d293dc21578c88e216703e54a47371313220c2026e12d33"
            );
        }

        #[test]
        fn read_for_signing_refuses_what_the_header_check_refuses() {
            // The same testnet transaction, read by a mainnet build today: outside its window.
            let e = match read_for_signing(IW_PROVEN, T_ANCHOR + 75 * 87_500) {
                Err(e) => e,
                Ok(_) => panic!("a testnet transaction passed a mainnet build"),
            };
            assert!(
                e.starts_with("[expiry]") || e.starts_with("[network]"),
                "{e}"
            );
            // And the device's clock moved past the window refuses it too.
            let (r, now) = rules_for_fixture();
            let late = now + 75 * 10_000;
            let e = match read_for_signing_with(&r, IW_PROVEN, late) {
                Err(e) => e,
                Ok(_) => panic!("an expired transaction passed"),
            };
            assert!(e.starts_with("[expiry]"), "{e}");
        }

        // ZIP 318: the released engine builds a canonical pool crossing (one Orchard note paying a
        // {1,2,5}x10^k amount into Ironwood) with a rolling expiry one to two months ahead. A device
        // accepts that long expiry for exactly that shape and that exact expiry, nothing else.
        #[test]
        fn the_crossing_shape_is_recognised_exactly() {
            // Orchard gives the amount and the fee (its balance is positive); Ironwood takes exactly
            // the amount (its spend is a zero dummy, so its balance is minus the output).
            let x = |o, i, v: &[u64], ob, ib| is_canonical_crossing(o, i, v, ob, ib);
            assert!(x(2, 1, &[1_000_000], 1_015_000, -1_000_000));
            assert!(x(2, 1, &[50_000_000], 50_015_000, -50_000_000));
            assert!(
                !x(2, 1, &[1_230_000], 1_245_000, -1_230_000),
                "not a canonical amount"
            );
            assert!(
                !x(3, 1, &[1_000_000], 1_020_000, -1_000_000),
                "more Orchard actions"
            );
            assert!(
                !x(2, 2, &[1_000_000, 5_000], 1_025_000, -1_005_000),
                "more Ironwood outputs"
            );
            assert!(!x(2, 1, &[], 15_000, 0), "nothing crosses");
            assert!(
                !x(2, 1, &[1_000_000], 15_000, 0),
                "an Ironwood note spent into it: Ironwood pays itself, nothing crosses"
            );
            assert!(
                !x(2, 1, &[1_000_000], -985_000, 1_000_000),
                "value leaving Ironwood is not a crossing into it"
            );
        }

        /// ZIP 318's rolling expiry for a target height `t`.
        fn zip318_expiry(t: u32) -> u32 {
            t - t % 34_560 + 69_120
        }

        #[test]
        fn a_crossing_still_needs_the_right_network_and_no_lock_time() {
            // The exemption is for the expiry only: the rest of the header is checked as always.
            let now = T_ANCHOR + 75 * 87_500;
            let b = MAINNET.height_bounds(now);
            let long = zip318_expiry(b.est - 412);
            let h = TxHeader {
                branch_id: 0xc8e7_1055,
                expiry_height: long,
                ..honest(now)
            };
            let e = check_header_for(&MAINNET, &h, now, true).unwrap_err();
            assert!(e.starts_with("[network]"), "{e}");
            let h = TxHeader {
                lock_time: 1,
                expiry_height: long,
                ..honest(now)
            };
            let e = check_header_for(&MAINNET, &h, now, true).unwrap_err();
            assert!(e.starts_with("[locktime]"), "{e}");
        }

        #[test]
        fn a_crossing_expiry_is_zip318_exactly_even_where_the_window_straddles_a_period() {
            let period = 34_560u32;
            let k = 3_428_143 / period + 3;
            let since = k * period + 5 - 3_428_143;
            let now = T_ANCHOR + 75 * since as i64;
            let b = MAINNET.height_bounds(now);
            let target_hi = b.hi - 40;
            assert!(
                zip318_expiry(b.lo) < zip318_expiry(target_hi),
                "the window straddles a period"
            );
            let h = TxHeader {
                expiry_height: zip318_expiry(b.lo) + 1,
                ..honest(now)
            };
            assert!(
                check_header_for(&MAINNET, &h, now, true).is_err(),
                "a non-ZIP-318 long expiry passed"
            );
            let h = TxHeader {
                expiry_height: zip318_expiry(target_hi),
                ..honest(now)
            };
            check_header_for(&MAINNET, &h, now, true).unwrap();
        }

        #[test]
        fn a_crossing_expiry_one_period_early_is_refused() {
            let now = T_ANCHOR + 75 * 87_500;
            let b = MAINNET.height_bounds(now);
            let h = TxHeader {
                expiry_height: zip318_expiry(b.lo) - 34_560,
                ..honest(now)
            };
            assert!(
                h.expiry_height > b.hi,
                "a long expiry, outside the plain window"
            );
            assert!(
                check_header_for(&MAINNET, &h, now, true).is_err(),
                "one period before ZIP 318's passed"
            );
        }

        #[test]
        fn a_second_transaction_is_judged_by_the_latest_earlier_one() {
            // The screen says until when the earlier attempts can go out: the last of them.
            let now = T_ANCHOR + 75 * 87_500;
            let b = MAINNET.height_bounds(now);
            let d = approval_decision(
                &MAINNET,
                &[signed("aa", b.est + 41), signed("cc", b.est + 30)],
                "bb",
                now,
            );
            assert_eq!(d, second(b.est + 41));
        }

        #[test]
        fn a_crossing_may_carry_the_zip318_expiry_and_nothing_else_may() {
            let now = T_ANCHOR + 75 * 87_500;
            let h = honest(now);
            let b = MAINNET.height_bounds(now);
            let target = b.est - 412;
            let zip318 = target - target % 34_560 + 69_120;
            let long = TxHeader {
                expiry_height: zip318,
                ..h
            };
            check_header_for(&MAINNET, &long, now, true).unwrap();
            assert!(check_header_for(&MAINNET, &long, now, false)
                .unwrap_err()
                .starts_with("[expiry]"));
            // A long expiry that is not ZIP 318's, even on a crossing, is refused.
            let off = TxHeader {
                expiry_height: zip318 + 34_560,
                ..h
            };
            assert!(check_header_for(&MAINNET, &off, now, true)
                .unwrap_err()
                .starts_with("[expiry]"));
            let off = TxHeader {
                expiry_height: zip318 - 1,
                ..h
            };
            assert!(check_header_for(&MAINNET, &off, now, true)
                .unwrap_err()
                .starts_with("[expiry]"));
            // An ordinary expiry still passes on a crossing.
            check_header_for(&MAINNET, &h, now, true).unwrap();
        }

        // One approval, one transaction: this device's record of the transactions its share went
        // into for a proposal decides what a new one is. Only a second transaction while the first
        // can still be mined asks the member to confirm, naming when the first stops being valid.
        #[test]
        fn a_new_transaction_for_an_approval_is_judged_against_what_this_device_signed() {
            let now = T_ANCHOR + 75 * 87_500;
            let b = MAINNET.height_bounds(now);
            let alive = b.est + 41;
            let dead = b.lo - 11;
            assert_eq!(
                approval_decision(&MAINNET, &[], "aa", now),
                ApprovalDecision::First
            );
            assert_eq!(
                approval_decision(&MAINNET, &[signed("aa", alive)], "AA", now),
                ApprovalDecision::Same
            );
            assert_eq!(
                approval_decision(&MAINNET, &[signed("aa", alive)], "bb", now),
                second(alive)
            );
            assert_eq!(
                approval_decision(&MAINNET, &[signed("aa", dead)], "bb", now),
                ApprovalDecision::AfterExpiry
            );
            // Any signed transaction still alive counts, whichever came first.
            assert_eq!(
                approval_decision(
                    &MAINNET,
                    &[signed("aa", dead), signed("cc", alive)],
                    "bb",
                    now
                ),
                second(alive)
            );
            // Just past the window's floor is not yet dead: ten blocks of margin.
            assert_eq!(
                approval_decision(&MAINNET, &[signed("aa", b.lo - 5)], "bb", now),
                second(b.lo - 5)
            );
        }

        #[test]
        fn the_time_an_approval_lapses_is_where_the_rule_turns() {
            // What the screen says ("until about ...") is the moment approval_decision stops counting
            // the earlier transaction, not a second estimate of when its block comes: one turns
            // exactly when the other does, for expiries across months.
            for days in [1i64, 30, 76, 200] {
                let built = T_ANCHOR + days * 86_400;
                let expiry = ONE_ROW.height_bounds(built).est + 40;
                let t =
                    lapses_at(&ONE_ROW, expiry, NU6_3).expect("an expiry above the anchor lapses");
                let rec = [signed("aa", expiry)];
                assert_eq!(
                    approval_decision(&ONE_ROW, &rec, "bb", t - 1),
                    second(expiry),
                    "{days}d: still counted one second before"
                );
                assert_eq!(
                    approval_decision(&ONE_ROW, &rec, "bb", t),
                    ApprovalDecision::AfterExpiry,
                    "{days}d: lapsed at the time shown"
                );
                assert!(t > built, "{days}d: never in the past of when it was built");
            }
            assert_eq!(
                lapses_at(&ONE_ROW, 1, NU6_3),
                Some(T_ANCHOR),
                "below the anchor: lapsed from the start"
            );
        }

        #[test]
        fn a_device_clock_before_the_anchor_confirms_nothing() {
            let h = honest(T_ANCHOR);
            let e = check_header(&MAINNET, &h, T_ANCHOR - 86_400).unwrap_err();
            assert!(e.starts_with("[expiry]"), "{e}");
        }

        // ---- The epoch rules across an upgrade (#638). The mainnet table has no row after NU6.3 yet, so
        // these run on a table WITH one, defined here and nowhere in production code.
        const NU7_TEST: u32 = 0x7719_0ad9;
        const A_TEST: u32 = 3_500_000;
        const NEXT: NetworkRules = NetworkRules {
            epochs: &[
                Epoch {
                    activation_height: 3_428_143,
                    branch_id: NU6_3,
                    tx_version: 6,
                    version_group_id: 0xD884_B698,
                    spacing_s: 75,
                    expiry_delta: 40,
                },
                Epoch {
                    activation_height: A_TEST,
                    branch_id: NU7_TEST,
                    tx_version: 6,
                    version_group_id: 0xD884_B698,
                    spacing_s: 25,
                    expiry_delta: 120,
                },
            ],
            anchor: konclave_seal::epochs::Anchor {
                height: 3_428_143,
                unix: T_ANCHOR,
            },
        };
        /// The clock at which block A_TEST is estimated.
        fn t_a() -> i64 {
            T_ANCHOR + 75 * i64::from(A_TEST - 3_428_143)
        }
        fn hdr(branch_id: u32, expiry_height: u32) -> TxHeader {
            TxHeader {
                tx_version: 6,
                version_group_id: 0xD884_B698,
                branch_id,
                lock_time: 0,
                expiry_height,
            }
        }

        #[test]
        fn a_record_entry_without_a_branch_reads_as_nu6_3_and_an_unknown_branch_refuses() {
            let r = parse_signed(&NEXT, &format!("aa:3500050,bb:3500060:{NU7_TEST}")).unwrap();
            assert_eq!(r[0].branch, NU6_3, "no branch: NU6.3");
            assert_eq!(r[1].branch, NU7_TEST);
            assert_eq!(
                parse_signed(&NEXT, &format!("aa:5:{NU6_3}")).unwrap()[0].branch,
                NU6_3
            );
            // The table of this build does not know the branch: the device cannot judge, so it refuses.
            let e = parse_signed(&NEXT, "aa:5:12345").unwrap_err();
            assert!(e.starts_with("[record]"), "{e}");
            // Mainnet knows NU7 since its row was added (#638): a record naming it is judged, and a branch
            // it does not know is not.
            assert_eq!(
                parse_signed(&MAINNET, &format!("aa:5:{NU7_TEST}")).unwrap()[0].branch,
                NU7_TEST
            );
            assert!(parse_signed(&ONE_ROW, &format!("aa:5:{NU7_TEST}")).is_err());
            assert!(parse_signed(&MAINNET, "aa:5:12345").is_err());
            assert!(parse_signed(&MAINNET, "aa").is_err());
            assert!(parse_signed(&MAINNET, "aa:x").is_err());
            assert!(parse_signed(&MAINNET, "aa:5:x").is_err());
            assert!(parse_signed(&MAINNET, "aa:5:6:7").is_err());
            assert_eq!(parse_signed(&MAINNET, "").unwrap(), vec![]);
        }

        #[test]
        fn an_nu6_3_record_past_the_upgrade_is_afterexpiry_once_the_floor_passes_a_plus_nine() {
            // Signed under NU6.3 with an expiry after A (a crossing's is weeks away): it can never be
            // mined at or after A, so the device stops counting it ten blocks after A, not at its expiry.
            let expiry = A_TEST + 34_560;
            let rec = [signed("aa", expiry)];
            let t = lapses_at(&NEXT, expiry, NU6_3).expect("it lapses");
            let lo = |t: i64| NEXT.height_bounds(t).lo;
            assert!(
                lo(t) > A_TEST - 1 + 10 && lo(t - 1) <= A_TEST - 1 + 10,
                "the turn is at A+9"
            );
            assert_eq!(
                approval_decision(&NEXT, &rec, "bb", t - 1),
                ApprovalDecision::Second {
                    first_expiry: expiry,
                    until_unix: Some(t),
                    until_height: Some(A_TEST - 1),
                    by_epoch: true
                }
            );
            assert_eq!(
                approval_decision(&NEXT, &rec, "bb", t),
                ApprovalDecision::AfterExpiry
            );
            // Without the later row the same record is still counted at that moment: the cap does it.
            assert!(matches!(
                approval_decision(&ONE_ROW, &[signed("aa", expiry)], "bb", t),
                ApprovalDecision::Second { .. }
            ));
        }

        // ---- The same rules on the REAL mainnet table, with NU7's real height (#638). The tests above
        // use a table with a made-up height so they stay true whatever the chain does; these pin what
        // this build does at block 3,543,405.
        const A_MAIN: u32 = 3_543_405;
        const NU7_MAIN: u32 = 0x7719_0ad9;
        /// The clock at which block A_MAIN is estimated on mainnet (75 s a block from the anchor).
        const T_A_MAIN: i64 = T_ANCHOR + 75 * (A_MAIN as i64 - 3_428_143);

        #[test]
        fn the_app_is_told_the_height_of_the_last_upgrade_in_the_table() {
            // The dashboard's notice reads it through WASM, so the app carries no height of its own.
            assert_eq!(latest_upgrade_height(&MAINNET), A_MAIN);
            assert_eq!(latest_upgrade_height(&ONE_ROW), 3_428_143);
        }

        #[test]
        fn on_mainnet_an_nu7_header_is_accepted_only_once_the_clock_can_reach_the_upgrade() {
            let nu7 = |expiry| hdr(NU7_MAIN, expiry);
            // Seventy-five days after the anchor the window is nowhere near A: NU7 is refused.
            let early = T_ANCHOR + 75 * 86_400;
            let b = MAINNET.height_bounds(early);
            let e = check_header(&MAINNET, &nu7(b.est + 100), early).unwrap_err();
            assert!(e.starts_with("[network]"), "{e}");
            // At the estimated moment of A the window straddles it: both branches are accepted.
            let b = MAINNET.height_bounds(T_A_MAIN);
            assert!(b.lo < A_MAIN && b.top > A_MAIN);
            check_header(&MAINNET, &nu7(A_MAIN + 100), T_A_MAIN).unwrap();
            check_header(&MAINNET, &hdr(NU6_3, A_MAIN - 20), T_A_MAIN).unwrap();
            // Three days later the floor is past A: an NU6.3 header (which cannot be mined) is refused,
            // an NU7 one still accepted.
            let late = T_A_MAIN + 3 * 86_400;
            let b = MAINNET.height_bounds(late);
            assert!(b.lo > A_MAIN);
            assert_eq!(
                b.hi - b.top,
                120,
                "an ordinary NU7 transaction expires 120 blocks past its target"
            );
            let e = check_header(&MAINNET, &hdr(NU6_3, b.est + 40), late).unwrap_err();
            assert!(e.starts_with("[network]"), "{e}");
            check_header(&MAINNET, &nu7(b.est + 100), late).unwrap();
        }

        #[test]
        fn on_mainnet_a_zip318_crossing_after_the_upgrade_is_accepted_at_its_new_scale() {
            // Past A the modulus is 103,680 blocks (ZIP 318 at 25 s blocks): an honest crossing built by
            // the new engine has that expiry, and the device must not read it with the old 34,560.
            let late = T_A_MAIN + 3 * 86_400;
            let b = MAINNET.height_bounds(late);
            let new_scale = MAINNET.crossing_expiry(b.est);
            assert_eq!(new_scale % 103_680, 0);
            check_header_for(&MAINNET, &hdr(NU7_MAIN, new_scale), late, true).unwrap();
            // The old scale for a target past A is a pre-NU7 builder's: refused.
            let old_scale = b.est - b.est % 34_560 + 69_120;
            assert!(check_header_for(&MAINNET, &hdr(NU7_MAIN, old_scale), late, true).is_err());
            // A crossing built just before A at the old scale is still accepted around A.
            let around = T_A_MAIN;
            let b = MAINNET.height_bounds(around);
            let before = MAINNET.crossing_expiry(A_MAIN - 50);
            check_header_for(&MAINNET, &hdr(NU6_3, before), around, true).unwrap();
            assert!(b.lo < A_MAIN);
        }

        #[test]
        fn on_mainnet_a_crossing_expiry_is_accepted_only_at_the_scale_of_its_own_branch() {
            // Around A the window straddles both scales; the header's branch decides which one is honest.
            let b = MAINNET.height_bounds(T_A_MAIN);
            assert!(b.lo < A_MAIN && b.top > A_MAIN);
            let (old_scale, new_scale) = (
                MAINNET.crossing_expiry(A_MAIN - 1),
                MAINNET.crossing_expiry(A_MAIN),
            );
            assert_ne!(old_scale, new_scale);
            check_header_for(&MAINNET, &hdr(NU6_3, old_scale), T_A_MAIN, true).unwrap();
            check_header_for(&MAINNET, &hdr(NU7_MAIN, new_scale), T_A_MAIN, true).unwrap();
            assert!(check_header_for(&MAINNET, &hdr(NU7_MAIN, old_scale), T_A_MAIN, true).is_err());
            assert!(check_header_for(&MAINNET, &hdr(NU6_3, new_scale), T_A_MAIN, true).is_err());
        }

        #[test]
        fn on_mainnet_an_nu63_record_turns_after_expiry_a_few_blocks_after_the_upgrade() {
            // Signed under NU6.3 before A and not mined, expiring after A (a crossing's is weeks away):
            // dead at A, so the device stops warning "pays twice" once its floor is past A + 9.
            for expiry in [A_MAIN + 50, A_MAIN + 34_560] {
                let rec = [signed("aa", expiry)];
                let t = lapses_at(&MAINNET, expiry, NU6_3).expect("it lapses");
                let lo = |t: i64| MAINNET.height_bounds(t).lo;
                assert!(
                    lo(t) > A_MAIN - 1 + 10 && lo(t - 1) <= A_MAIN - 1 + 10,
                    "expiry {expiry}: the turn is at A + 9"
                );
                assert_eq!(
                    approval_decision(&MAINNET, &rec, "bb", t - 1),
                    ApprovalDecision::Second {
                        first_expiry: expiry,
                        until_unix: Some(t),
                        until_height: Some(A_MAIN - 1),
                        by_epoch: true
                    },
                    "expiry {expiry}"
                );
                assert_eq!(
                    approval_decision(&MAINNET, &rec, "bb", t),
                    ApprovalDecision::AfterExpiry,
                    "expiry {expiry}"
                );
                // About a day after A with the NU6.3 anchor: the slack there is 27 hours.
                assert!(
                    (T_A_MAIN..T_A_MAIN + 40 * 3_600).contains(&t),
                    "expiry {expiry}: turns {} h after A",
                    (t - T_A_MAIN) / 3_600
                );
            }
        }

        #[test]
        fn the_time_second_carries_is_the_moment_the_decision_turns_afterexpiry() {
            // For records of several shapes: an ordinary one before A, one capped by A, and a NU7 one.
            for (expiry, branch) in [
                (A_TEST - 5_000, NU6_3),
                (A_TEST + 40, NU6_3),
                (A_TEST + 69_120, NU6_3),
                (A_TEST + 100, NU7_TEST),
            ] {
                let rec = [SignedTx {
                    sighash: "aa".into(),
                    expiry,
                    branch,
                }];
                let t = lapses_at(&NEXT, expiry, branch).expect("lapses");
                let before = approval_decision(&NEXT, &rec, "bb", t - 1);
                let ApprovalDecision::Second {
                    until_unix,
                    until_height,
                    by_epoch,
                    ..
                } = before
                else {
                    panic!("{expiry}/{branch}: not Second one second before the turn: {before:?}");
                };
                assert_eq!(until_unix, Some(t), "{expiry}/{branch}");
                // Only a record the upgrade ends (not its own expiry) is worded as the upgrade's.
                assert_eq!(
                    by_epoch,
                    branch == NU6_3 && expiry >= A_TEST,
                    "{expiry}/{branch}"
                );
                // The block the screen names is the last one the earlier transaction can be mined in.
                assert_eq!(
                    until_height,
                    by_epoch.then_some(A_TEST - 1),
                    "{expiry}/{branch}"
                );
                assert_eq!(
                    approval_decision(&NEXT, &rec, "bb", t),
                    ApprovalDecision::AfterExpiry,
                    "{expiry}/{branch}"
                );
            }
            // A record whose branch is unknown has no turn to show.
            assert_eq!(lapses_at(&NEXT, 5, 12345), None);
        }

        #[test]
        fn a_record_that_never_stops_counting_gives_no_time() {
            // Expiry 0 and no later upgrade: the decision has no turning point. A time on the screen
            // would say the warning stops somewhere it does not (the moment of another record's turn).
            let now = T_ANCHOR + 75 * 87_500;
            let b = ONE_ROW.height_bounds(now);
            let rec = [signed("aa", 0), signed("cc", b.est + 41)];
            let d = approval_decision(&ONE_ROW, &rec, "bb", now);
            let ApprovalDecision::Second {
                until_unix,
                until_height,
                by_epoch,
                ..
            } = d
            else {
                panic!("{d:?}")
            };
            assert_eq!((until_unix, until_height, by_epoch), (None, None, false));
            // And it is still Second long after the other record's turn: nothing was promised.
            let later = now + 86_400 * 400;
            assert!(matches!(
                approval_decision(&ONE_ROW, &rec, "bb", later),
                ApprovalDecision::Second { .. }
            ));
        }

        #[test]
        fn the_window_and_its_floor_never_fall_across_the_upgrade_on_the_device() {
            let mut prev = NEXT.height_bounds(t_a() - 300_000);
            let mut t = t_a() - 300_000;
            while t < t_a() + 600_000 {
                t += 1_013;
                let b = NEXT.height_bounds(t);
                assert!(b.lo >= prev.lo && b.est >= prev.est, "fell at {t}");
                prev = b;
            }
        }

        #[test]
        fn a_header_is_accepted_by_the_heights_it_could_be_mined_at() {
            let near = |dt: i64| t_a() + dt;
            let e = |r: Result<(), String>| r.unwrap_err();
            // Far before A: an NU7 header is refused, an NU6.3 one accepted.
            let now = near(-10 * 86_400);
            let b = NEXT.height_bounds(now);
            assert!(b.hi < A_TEST);
            assert!(
                e(check_header(&NEXT, &hdr(NU7_TEST, b.est + 41), now)).starts_with("[network]")
            );
            check_header(&NEXT, &hdr(NU6_3, b.est + 41), now).unwrap();
            // Where the clock's window crosses A both are accepted: the device's own uncertainty.
            let now = near(0);
            let b = NEXT.height_bounds(now);
            assert!(b.lo < A_TEST && b.top >= A_TEST);
            check_header(&NEXT, &hdr(NU7_TEST, b.est + 41), now).unwrap();
            check_header(&NEXT, &hdr(NU6_3, b.est + 41), now).unwrap();
            // Once the floor has passed A an NU6.3 header is refused: it cannot be mined any more.
            let now = near(5 * 86_400);
            let b = NEXT.height_bounds(now);
            assert!(b.lo > A_TEST);
            assert!(e(check_header(&NEXT, &hdr(NU6_3, b.est + 41), now)).starts_with("[network]"));
            check_header(&NEXT, &hdr(NU7_TEST, b.est + 41), now).unwrap();
            // The expiry limits still apply to either row: an NU7 header expiring at 120 past a target
            // far beyond the window is refused for its expiry, not accepted for its branch.
            let e2 = e(check_header(&NEXT, &hdr(NU7_TEST, b.hi + 1), now));
            assert!(e2.starts_with("[expiry]"), "{e2}");
        }

        #[test]
        fn a_crossing_under_nu6_3_is_accepted_before_the_upgrade_and_refused_after_the_floor_passes_it(
        ) {
            let crossing_expiry = |target: u32| target - target % 34_560 + 69_120;
            let now = t_a() - 3 * 86_400;
            let b = NEXT.height_bounds(now);
            let long = crossing_expiry(b.est - 412);
            assert!(long > b.hi, "a long expiry, outside the plain window");
            check_header_for(&NEXT, &hdr(NU6_3, long), now, true).unwrap();
            let now = t_a() + 5 * 86_400;
            let b = NEXT.height_bounds(now);
            let long = crossing_expiry(b.est - 412);
            let e = check_header_for(&NEXT, &hdr(NU6_3, long), now, true).unwrap_err();
            assert!(
                e.starts_with("[network]") || e.starts_with("[expiry]"),
                "{e}"
            );
            // And the same long expiry on an NU6.3 header can never be accepted past the floor: the
            // interval it could be mined at is empty.
            assert!(!NEXT.header_may_be_mined(NU6_3, long, b.lo, b.hi));
        }

        #[test]
        fn a_clock_before_the_anchor_gives_an_empty_window_with_a_later_row_too() {
            let now = T_ANCHOR - 86_400;
            let b = NEXT.height_bounds(now);
            assert_eq!((b.lo, b.est, b.hi), (u32::MAX, 0, 0));
            let e = check_header(&NEXT, &hdr(NU6_3, 3_500_000), now).unwrap_err();
            assert!(e.starts_with("[expiry]"), "{e}");
            let e = check_header(&NEXT, &hdr(NU7_TEST, 3_500_000), now).unwrap_err();
            assert!(e.starts_with("[expiry]"), "{e}");
        }

        #[test]
        fn what_a_device_reads_gives_the_branch_of_the_header_it_checked() {
            // The branch the record keeps is the one in the header THIS device read and checked. The
            // fixture is NU6.3, which a constant would also return, so the same PCZT is patched onto
            // ANOTHER branch the pczt crate knows (NU6; it refuses a branch it does not know) and a
            // table that has it: only a reading of the header gives that back.
            const OTHER_KNOWN_BRANCH: u32 = 0xc8e7_1055;
            let (r, now) = rules_for_fixture();
            let f = read_for_signing_with(&r, IW_PROVEN, now).unwrap();
            let p = Pczt::parse(IW_PROVEN).unwrap();
            assert_eq!(f.branch_id, *p.global().consensus_branch_id());
            assert_eq!(f.branch_id, NU6_3);
            let other = patch_once(
                IW_PROVEN,
                &varint(u64::from(NU6_3)),
                &varint(u64::from(OTHER_KNOWN_BRANCH)),
            );
            assert_eq!(
                *Pczt::parse(&other).unwrap().global().consensus_branch_id(),
                OTHER_KNOWN_BRANCH
            );
            let (r, now) = rules_for(&other);
            let f = read_for_signing_with(&r, &other, now).unwrap();
            assert_eq!(f.branch_id, OTHER_KNOWN_BRANCH);
            assert_ne!(f.branch_id, NU6_3);
        }

        #[test]
        fn a_fee_above_zip317_is_refused() {
            // The bundle's value balance is what leaves the shielded pool, and with no transparent
            // or Sapling part it is the fee. Raising it is how a builder pays every approved line
            // and returns less change: the difference goes to the miner. 20000 is this fixture's
            // fee, 4 actions at 5000; 25000 is one more than the transaction's actions allow.
            assert_eq!(varint(20000), [0xa0, 0x9c, 0x01]);
            let tampered = patch_once(IW_PROVEN, &varint(20000), &varint(25000));
            assert_refused(&tampered, "[fee]");
        }

        fn shape(actions: usize, to_sign: usize, paying: usize) -> BundleShape {
            BundleShape {
                actions,
                to_sign,
                paying,
            }
        }
        const EMPTY: BundleShape = BundleShape {
            actions: 0,
            to_sign: 0,
            paying: 0,
        };

        #[test]
        fn the_fee_rule_accepts_what_an_honest_builder_makes() {
            // This fixture: an Ironwood bundle of 4 actions, 4 spends, a payment and change.
            assert_eq!(check_fee(20_000, &[EMPTY, shape(4, 4, 2)]), Ok(20_000));
            // A fee below ZIP 317's is refused too: the network may not relay that transaction, and
            // it would sit signed with whoever built it.
            assert!(check_fee(10_000, &[EMPTY, shape(4, 4, 2)])
                .unwrap_err()
                .starts_with("[fee]"));
            // One spend, a payment and change: two actions where spends and outputs share them,
            // three where the builder keeps them apart.
            assert_eq!(check_fee(10_000, &[EMPTY, shape(2, 1, 2)]), Ok(10_000));
            assert_eq!(check_fee(15_000, &[EMPTY, shape(3, 1, 2)]), Ok(15_000));
            // An Orchard-to-Ironwood migration: two Orchard spends paired with zero-value outputs,
            // and an Ironwood bundle whose padding spends arrive already signed.
            assert_eq!(
                check_fee(20_000, &[shape(2, 2, 0), shape(2, 0, 1)]),
                Ok(20_000)
            );
        }

        #[test]
        fn the_fee_rule_refuses_a_fee_above_zip317() {
            let err = check_fee(25_000, &[EMPTY, shape(4, 4, 2)]).unwrap_err();
            assert!(err.starts_with("[fee]"), "{err}");
        }

        #[test]
        fn the_fee_rule_refuses_padding_that_raises_its_own_fee() {
            // Six actions for one spend and two outputs: their exact ZIP 317 fee would be 30000,
            // and the three extra actions are there only to raise it.
            let err = check_fee(30_000, &[EMPTY, shape(6, 1, 2)]).unwrap_err();
            assert!(err.starts_with("[fee]"), "{err}");
        }

        #[test]
        fn the_fee_rule_refuses_value_flowing_into_the_pool() {
            let err = check_fee(-1, &[EMPTY, shape(2, 1, 2)]).unwrap_err();
            assert!(err.starts_with("[fee]"), "{err}");
        }

        /// 32 bytes from the middle of the payment output's encrypted note (the memo region).
        fn payment_ciphertext_slice() -> Vec<u8> {
            let mut slice = vec![];
            Signer::new(Pczt::parse(IW_PROVEN).unwrap())
                .sign_ironwood_with(|_, bundle, _| {
                    let a = bundle
                        .actions()
                        .iter()
                        .find(|a| a.output().user_address().is_some())
                        .unwrap();
                    slice = a.output().encrypted_note().enc_ciphertext.0[200..232].to_vec();
                    Ok::<(), OErr>(())
                })
                .unwrap();
            slice
        }

        #[test]
        fn a_paying_output_its_recipient_cannot_decrypt_is_refused() {
            // The ciphertext is inside the sighash, so a builder can sign away a real payment in a
            // ciphertext nobody can open: the recipient never finds the note, and the money is
            // gone. The device derives the note's ephemeral key from `rseed` and opens it itself.
            let slice = payment_ciphertext_slice();
            let flipped: Vec<u8> = slice.iter().map(|b| b ^ 0xff).collect();
            let tampered = patch_once(IW_PROVEN, &slice, &flipped);
            assert_refused(&tampered, "[undecryptable]");
        }

        #[test]
        fn the_device_reads_each_paying_outputs_memo() {
            // The honest fixture's payment and change both open, and each carries a memo the
            // device can compare with the approved line (empty, here, is still a memo).
            let outs = describe_outputs(IW_PROVEN).unwrap();
            for o in outs.iter().filter(|o| o.value.unwrap_or(0) > 0) {
                assert!(o.memo.is_some(), "a paying output's memo is read: {o:?}");
            }
            for o in outs.iter().filter(|o| o.value.unwrap_or(0) == 0) {
                assert_eq!(o.memo, None, "padding carries no memo worth reading");
            }
        }

        #[test]
        fn the_honest_fixture_reads_its_fee() {
            let p = read_payment(IW_PROVEN).unwrap();
            assert_eq!(p.fee_zat, 20_000, "4 actions at 5000");
            assert_eq!(p.actions, 4);
        }

        // Honest shapes beyond the one Ironwood fixture, so the checks above are also shown NOT to
        // refuse what a real builder makes. The two Orchard sends are real mainnet PCZTs (pczt v1,
        // V5, `dkg_single_spend` and `evidence_two_spend` before their rename), retired in 1d4eb42
        // when the browser moved to the Ironwood pin and brought back for this: they are the only Orchard
        // pool, note version 2, shapes in the repo. The third is the Zcash Foundation's own
        // `zcash-sign` test fixture (frost-tools 06c0dbd, `zcash-sign/tests/fixtures/ironwood_v6.pczt`,
        // MIT/Apache like this repo): an Ironwood send whose change is split into four outputs, so
        // five outputs pay and the padding bound has to allow every one of them.
        const OR_MAINNET_DKG: &[u8] =
            include_bytes!("../tests/vectors/orchard_mainnet_dkg_single_spend.proven.pczt");
        const OR_MAINNET_TWO: &[u8] =
            include_bytes!("../tests/vectors/orchard_mainnet_two_spend.proven.pczt");
        const ZF_IW_SPLIT_CHANGE: &[u8] =
            include_bytes!("../tests/vectors/zf_zcash_sign_ironwood_v6.pczt");

        #[test]
        fn real_mainnet_orchard_sends_read_with_their_fee_and_memos() {
            for pczt in [OR_MAINNET_DKG, OR_MAINNET_TWO] {
                let p = read_payment(pczt).expect("an honest mainnet Orchard send reads");
                assert_eq!(p.fee_zat, 10_000, "2 actions at 5000");
                assert_eq!(p.actions, 2);
                let paying: Vec<_> = p
                    .outputs
                    .iter()
                    .filter(|o| o.value.unwrap_or(0) > 0)
                    .collect();
                assert_eq!(paying.len(), 2, "a payment and its change");
                for o in &paying {
                    assert_eq!(
                        o.memo.as_deref(),
                        Some(""),
                        "opened as a note version 2 output"
                    );
                }
                let labelled = paying.iter().find_map(|o| o.address.as_ref()).unwrap();
                assert!(
                    labelled.starts_with("u1"),
                    "a mainnet address, checked against its receiver"
                );
            }
        }

        #[test]
        fn a_change_split_into_four_outputs_reads_within_the_padding_bound() {
            let p = read_payment(ZF_IW_SPLIT_CHANGE).expect("the Foundation's fixture reads");
            assert_eq!(p.fee_zat, 25_000, "5 actions at 5000");
            assert_eq!(p.actions, 5);
            let paying: Vec<_> = p
                .outputs
                .iter()
                .filter(|o| o.value.unwrap_or(0) > 0)
                .collect();
            assert_eq!(paying.len(), 5, "one payment and four change outputs");
            assert_eq!(paying.iter().filter(|o| o.address.is_some()).count(), 1);
        }

        // The reading must cover exactly what the sighash covers, and no more. Two ways it did not,
        // both found in review of the first version: a bundle with no actions is replaced in the
        // digest by the empty-bundle commitment, so its value balance is signed by nobody; and a
        // version 5 transaction has no Ironwood slot in the digest at all.

        fn first_ironwood_cv_net() -> [u8; 32] {
            let mut cv = [0u8; 32];
            Signer::new(Pczt::parse(IW_PROVEN).unwrap())
                .sign_ironwood_with(|_, bundle, _| {
                    cv = bundle.actions()[0].cv_net().to_bytes();
                    Ok::<(), OErr>(())
                })
                .unwrap();
            cv
        }

        #[test]
        fn an_empty_bundle_cannot_hide_a_fee() {
            // Raise the Ironwood fee from 20000 to 1000000, then add an Orchard bundle with no
            // actions and a value balance of -980000: summed, the two read as the honest 20000.
            const N: u64 = 980_000;
            let inflated = patch_once(IW_PROVEN, &varint(20_000), &varint(20_000 + N));
            let cv0 = first_ironwood_cv_net();
            // The empty Orchard bundle (`None`) sits just before the Ironwood one, whose first
            // action starts with its `cv_net`.
            let needle = [&[0x00u8, 0x01, 0x04, 0x01][..], &cv0[..]].concat();
            let empty_orchard = [
                &[0x00u8][..],  // actions: none
                &[0x00u8][..],  // flags
                &varint(N)[..], // value_sum magnitude
                &[0x01u8][..],  // value_sum is negative
                &[0x00u8][..],  // anchor: None
                &[0x01u8][..],  // note version
                &[0x00u8][..],  // zkproof: None
                &[0x00u8][..],  // bsk: None
            ]
            .concat();
            let with = [
                &[0x01u8][..],
                &empty_orchard[..],
                &[0x01u8, 0x04, 0x01][..],
                &cv0[..],
            ]
            .concat();
            let tampered = patch_once(&inflated, &needle, &with);

            assert_eq!(
                shielded_sighash(&Pczt::parse(&inflated).unwrap()).unwrap(),
                shielded_sighash(&Pczt::parse(&tampered).unwrap()).unwrap(),
                "the empty Orchard bundle is outside the sighash",
            );
            assert!(read_payment(&inflated).unwrap_err().starts_with("[fee]"));
            assert_refused(&tampered, "[shape]");
        }

        #[test]
        fn a_version_5_transaction_cannot_carry_an_ironwood_bundle() {
            let head6 = [
                &b"PCZT"[..],
                &2u32.to_le_bytes()[..],
                &varint(6)[..],
                &varint(0xD884_B698)[..],
            ]
            .concat();
            let head5 = [
                &b"PCZT"[..],
                &2u32.to_le_bytes()[..],
                &varint(5)[..],
                &varint(0x26A7_270A)[..],
            ]
            .concat();
            let v5 = patch_once(IW_PROVEN, &head6, &head5);
            let v5_other = patch_once(&v5, &varint(20_000), &varint(25_000));
            assert_eq!(
                shielded_sighash(&Pczt::parse(&v5).unwrap()).unwrap(),
                shielded_sighash(&Pczt::parse(&v5_other).unwrap()).unwrap(),
                "in v5 the Ironwood bundle does not reach the sighash",
            );
            assert_refused(&v5, "[shape]");
        }

        #[test]
        fn signed_pools_answers_every_shape() {
            assert_eq!(signed_pools(5, false, false), Ok(&[(false, "orchard")][..]));
            assert_eq!(
                signed_pools(6, false, false),
                Ok(&[(false, "orchard"), (true, "ironwood")][..])
            );
            for (v, t, s) in [
                (4, false, false),
                (7, false, false),
                (6, true, false),
                (6, false, true),
                (5, true, true),
            ] {
                let err = signed_pools(v, t, s).unwrap_err();
                assert!(err.starts_with("[shape]"), "v{v} t{t} s{s}: {err}");
            }
        }

        #[test]
        fn read_payment_asks_signed_pools() {
            // The shape rules are tested above over booleans; this keeps the reader from answering
            // them itself again, which is how the pool question once drifted (#364).
            let src = include_str!("lib.rs");
            let body = src
                .split("pub fn read_payment(pczt_bytes")
                .nth(1)
                .expect("read_payment exists")
                .split("\n    }")
                .next()
                .unwrap();
            // ...and must hand it every part a vault payment never has, each one able to refuse on
            // its own, in the position signed_pools reads it. Naming the parts in the body was not
            // enough: `&&` for `||`, a dead `false && ...`, or naming them and passing `false` all
            // kept that scan green (#610 third review). Whitespace-insensitive, so rustfmt is free.
            let flat: String = body.chars().filter(|c| !c.is_whitespace()).collect();
            // `?` included: a refusal that is swallowed (`unwrap_or`, a retry with `false`) is none.
            let call = concat!(
                "letpools=signed_pools(tx_version,",
                "!pczt.transparent().inputs().is_empty()||!pczt.transparent().outputs().is_empty(),",
                "!pczt.sapling().spends().is_empty()||!pczt.sapling().outputs().is_empty(),",
                ")?;"
            );
            assert!(
                flat.contains(call),
                "read_payment must hand signed_pools each part, any one refusing, and return its refusal"
            );
        }

        #[test]
        fn the_shape_counts_spends_to_sign_apart_from_actions() {
            // Two fixtures where the vault signs fewer spends than the bundle has actions: the
            // padding bound is computed from `to_sign`, so it must not be the action count.
            let pczt = Pczt::parse(OR_MAINNET_DKG).unwrap();
            let (_, s, _) = with_bundle(&pczt, false, |b| read_bundle("orchard", b)).unwrap();
            assert_eq!(s, shape_of(2, 1, 2));
            let pczt = Pczt::parse(ZF_IW_SPLIT_CHANGE).unwrap();
            let (_, s, _) = with_bundle(&pczt, true, |b| read_bundle("ironwood", b)).unwrap();
            assert_eq!(s, shape_of(5, 1, 5));
        }

        #[test]
        fn the_fixture_bundle_has_the_shape_the_fee_rule_reads() {
            // 4 actions, 4 spends this vault signs, a payment and change: the numbers the padding
            // bound and the exact ZIP 317 fee are computed from.
            let pczt = Pczt::parse(IW_PROVEN).unwrap();
            let (_, shape, balance) =
                with_bundle(&pczt, true, |b| read_bundle("ironwood", b)).unwrap();
            assert_eq!(shape, shape_of(4, 4, 2));
            assert_eq!(balance, 20_000);
        }

        fn shape_of(actions: usize, to_sign: usize, paying: usize) -> BundleShape {
            BundleShape {
                actions,
                to_sign,
                paying,
            }
        }

        #[test]
        fn a_label_is_shown_as_it_was_checked() {
            // `ua_receiver` trims what it decodes, so the label that passed the check is the trimmed
            // one, and that is what the screen shows; an untrimmed label used to come out as no label.
            let label = describe_outputs(IW_PROVEN)
                .unwrap()
                .into_iter()
                .find_map(|o| o.address)
                .unwrap();
            let padded = format!(" {label} ");
            let tampered = patch_once(IW_PROVEN, &label_wire(&label), &label_wire(&padded));
            let shown = describe_outputs(&tampered)
                .expect("a padded label naming the paid receiver is fine")
                .into_iter()
                .find_map(|o| o.address)
                .unwrap();
            assert_eq!(shown, label);
        }

        #[test]
        fn the_honest_fixture_still_reads() {
            // The other half of every refusal above: the untouched PCZT passes the same checks.
            let outs = describe_outputs(IW_PROVEN).expect("an honest PCZT reads");
            assert_eq!(outs.len(), 4, "four actions, four outputs");
        }

        #[test]
        fn shielded_sighash_of_an_nu7_pczt_matches_the_signer_on_the_stable_crates() {
            // The same fixture with its branch rewritten to NU7 (see konclave-signer's `as_nu7`): the device's
            // hand-written ZIP-244 recompute must meet the crate's (zcash_primitives 0.31, pczt 0.10) on one
            // value, and that value commits to the new branch.
            let nu7 = patch_once(IW_PROVEN, &varint(0x37a5_165b), &varint(0x7719_0ad9));
            let got = shielded_sighash(&Pczt::parse(&nu7).unwrap()).unwrap();
            assert_ne!(
                hex::encode(got),
                hex::encode(IW_SIGHASH),
                "the branch id is hashed in"
            );
            assert_eq!(
                hex::encode(got),
                "9b869f2332ef5a0d8e987612e9bdbe67275a6fdc1d742b77b929d4bbb0a0601d"
            );
        }

        #[test]
        fn shielded_sighash_matches_signer_ironwood() {
            // THE GATE (issue #62 / I2): the on-device ZIP-244 recompute must equal, byte-for-byte,
            // the sighash konclave-signer extracted from the SAME real mainnet Ironwood PCZT (the
            // message the broadcast FROST signatures actually committed to). A single real-vector
            // match this exact is strong proof the algorithm is byte-correct.
            let pczt = Pczt::parse(IW_PROVEN).unwrap();
            let got = shielded_sighash(&pczt).unwrap();
            assert_eq!(
                hex::encode(got),
                hex::encode(IW_SIGHASH),
                "on-device sighash must equal konclave-signer's extracted sighash",
            );
        }

        #[test]
        fn shielded_sighash_binds_the_signature() {
            // End-to-end: the recomputed sighash is exactly what `inject_sigs` (which verifies each
            // signature against the sighash) accepts. If the recompute were off by a byte, the real
            // broadcast signature would not verify under it.
            let pczt = Pczt::parse(IW_PROVEN).unwrap();
            let got = shielded_sighash(&pczt).unwrap();
            let signed = inject_sigs(IW_PROVEN, got, &[(0, sig64(IW_SIG0))]).unwrap();
            assert_eq!(
                signed.as_slice(),
                IW_SIGNED,
                "signature verifies under the on-device-recomputed sighash",
            );
        }

        #[test]
        fn shielded_sighash_rejects_garbage() {
            assert!(Pczt::parse(b"not a pczt").is_err());
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
    use wasm_bindgen::prelude::*;

    fn je(e: impl core::fmt::Display) -> JsValue {
        JsValue::from_str(&e.to_string())
    }

    /// Test-only trusted-dealer 2-of-3, so JS can drive a ceremony end-to-end. The product
    /// uses DKG; the key packages here stand in for the unlocked device shares.
    #[wasm_bindgen]
    pub struct TestVault {
        kps: Vec<Vec<u8>>,
        ids: Vec<Vec<u8>>,
        pubkeys: Vec<u8>,
        group_vk: Vec<u8>,
    }

    #[wasm_bindgen]
    impl TestVault {
        #[wasm_bindgen(constructor)]
        pub fn new() -> Result<TestVault, JsValue> {
            let (shares, pubkeys) = frost::keys::generate_with_dealer(
                3,
                2,
                frost::keys::IdentifierList::Default,
                &mut OsRng,
            )
            .map_err(je)?;
            let mut kps = Vec::new();
            let mut ids = Vec::new();
            for (id, s) in shares.into_iter() {
                ids.push(id.serialize());
                kps.push(
                    KeyPackage::try_from(s)
                        .map_err(je)?
                        .serialize()
                        .map_err(je)?,
                );
            }
            let group_vk = pubkeys.verifying_key().serialize().map_err(je)?;
            Ok(TestVault {
                kps,
                ids,
                pubkeys: pubkeys.serialize().map_err(je)?,
                group_vk,
            })
        }
        pub fn key_package(&self, i: usize) -> Vec<u8> {
            self.kps[i].clone()
        }
        pub fn id(&self, i: usize) -> Vec<u8> {
            self.ids[i].clone()
        }
        pub fn pubkeys(&self) -> Vec<u8> {
            self.pubkeys.clone()
        }
        #[wasm_bindgen(js_name = groupVk)]
        pub fn group_vk(&self) -> Vec<u8> {
            self.group_vk.clone()
        }
    }

    /// Participant round-1 output: nonces stay on THIS device; commitment goes to the relay.
    #[wasm_bindgen]
    pub struct Round1 {
        nonces: ceremony::NonceSlot,
        commitment: Vec<u8>,
    }
    #[wasm_bindgen]
    impl Round1 {
        pub fn commitment(&self) -> Vec<u8> {
            self.commitment.clone()
        }
    }

    /// Participant device, round 1 (JS): from the local key-package bytes.
    #[wasm_bindgen(js_name = participantRound1)]
    pub fn participant_round1(kp_bytes: &[u8]) -> Result<Round1, JsValue> {
        let kp = KeyPackage::deserialize(kp_bytes).map_err(je)?;
        let (nonces, commitment) = ceremony::participant_round1(&kp);
        Ok(Round1 { nonces, commitment })
    }

    /// Participant device, round 2 (JS): sign with the local nonces + seed. `message` is what this
    /// device holds for itself; the share is refused unless the package signs exactly that.
    #[wasm_bindgen(js_name = participantRound2)]
    pub fn participant_round2(
        sp: &[u8],
        round1: &mut Round1,
        kp_bytes: &[u8],
        seed: &[u8],
        message: &[u8],
    ) -> Result<Vec<u8>, JsValue> {
        let kp = KeyPackage::deserialize(kp_bytes).map_err(je)?;
        ceremony::participant_round2(sp, &mut round1.nonces, &kp, seed, message).map_err(je)
    }

    /// Participant device, round 2 (JS), REAL-TRANSACTION path: sign with the given Orchard
    /// randomizer (the 32-byte alpha from pczt_bridge.extractRandomizers) instead of a seed, so the
    /// signature can be injected into the PCZT and broadcast.
    ///
    /// `message` is the sighash THIS device computed from its own copy of the transaction. The
    /// share is refused unless the signing package signs exactly that message, so a device cannot
    /// be handed a package built over something else.
    #[wasm_bindgen(js_name = participantRound2WithRandomizer)]
    pub fn participant_round2_with_randomizer(
        sp: &[u8],
        round1: &mut Round1,
        kp_bytes: &[u8],
        randomizer: &[u8],
        message: &[u8],
    ) -> Result<Vec<u8>, JsValue> {
        let kp = KeyPackage::deserialize(kp_bytes).map_err(je)?;
        ceremony::participant_round2_with_randomizer(
            sp,
            &mut round1.nonces,
            &kp,
            randomizer,
            message,
        )
        .map_err(je)
    }

    /// Coordinator (JS): accumulates the public wire material and produces the signature.
    #[wasm_bindgen]
    pub struct Coordinator {
        message: Vec<u8>,
        group_vk: Vec<u8>,
        pubkeys: Vec<u8>,
        commitments: Vec<(Vec<u8>, Vec<u8>)>,
        shares: Vec<(Vec<u8>, Vec<u8>)>,
        sp: Vec<u8>,
        seed: Vec<u8>,
    }
    #[wasm_bindgen]
    impl Coordinator {
        #[wasm_bindgen(constructor)]
        pub fn new(group_vk: &[u8], pubkeys: &[u8], message: &[u8]) -> Coordinator {
            Coordinator {
                message: message.into(),
                group_vk: group_vk.into(),
                pubkeys: pubkeys.into(),
                commitments: vec![],
                shares: vec![],
                sp: vec![],
                seed: vec![],
            }
        }
        #[wasm_bindgen(js_name = addCommitment)]
        pub fn add_commitment(&mut self, id: &[u8], commitment: &[u8]) {
            self.commitments.push((id.into(), commitment.into()));
        }
        /// Build the signing package + randomizer seed (both public). Returns nothing; read via getters.
        pub fn prepare(&mut self) -> Result<(), JsValue> {
            self.sp = ceremony::coordinator_signing_package(&self.commitments, &self.message)
                .map_err(je)?;
            let vk = frost::VerifyingKey::deserialize(&self.group_vk).map_err(je)?;
            self.seed = ceremony::coordinator_randomizer_seed(&vk, &self.sp).map_err(je)?;
            Ok(())
        }
        #[wasm_bindgen(js_name = signingPackage)]
        pub fn signing_package(&self) -> Vec<u8> {
            self.sp.clone()
        }
        pub fn seed(&self) -> Vec<u8> {
            self.seed.clone()
        }
        #[wasm_bindgen(js_name = addShare)]
        pub fn add_share(&mut self, id: &[u8], share: &[u8]) {
            self.shares.push((id.into(), share.into()));
        }
        /// Does this one share verify, for this signer, in this package, under this randomizer
        /// (alpha)? Throws when it does not, or is not a share at all. Ask it of every share before
        /// `addShare`: one that fails never takes the signer's place.
        #[wasm_bindgen(js_name = checkShare)]
        pub fn check_share(
            &self,
            id: &[u8],
            share: &[u8],
            randomizer: &[u8],
        ) -> Result<(), JsValue> {
            let vk = frost::VerifyingKey::deserialize(&self.group_vk).map_err(je)?;
            let pubkeys = frost::keys::PublicKeyPackage::deserialize(&self.pubkeys).map_err(je)?;
            ceremony::check_share_with_randomizer(&self.sp, &vk, randomizer, id, share, &pubkeys)
                .map_err(je)
        }
        pub fn aggregate(&self) -> Result<Vec<u8>, JsValue> {
            let vk = frost::VerifyingKey::deserialize(&self.group_vk).map_err(je)?;
            let pubkeys = frost::keys::PublicKeyPackage::deserialize(&self.pubkeys).map_err(je)?;
            ceremony::coordinator_aggregate(&self.sp, &vk, &self.seed, &self.shares, &pubkeys)
                .map_err(je)
        }
        pub fn verify(&self, sig: &[u8]) -> Result<bool, JsValue> {
            let vk = frost::VerifyingKey::deserialize(&self.group_vk).map_err(je)?;
            ceremony::verify(&vk, &self.sp, &self.seed, &self.message, sig).map_err(je)
        }

        /// REAL-TRANSACTION path: aggregate the accumulated shares under the given Orchard randomizer
        /// (alpha) instead of the seed. The message must be the shielded sighash and the shares must
        /// have been produced by `participantRound2WithRandomizer` with the SAME alpha.
        #[wasm_bindgen(js_name = aggregateWithRandomizer)]
        pub fn aggregate_with_randomizer(&self, randomizer: &[u8]) -> Result<Vec<u8>, JsValue> {
            let vk = frost::VerifyingKey::deserialize(&self.group_vk).map_err(je)?;
            let pubkeys = frost::keys::PublicKeyPackage::deserialize(&self.pubkeys).map_err(je)?;
            ceremony::coordinator_aggregate_with_randomizer(
                &self.sp,
                &vk,
                randomizer,
                &self.shares,
                &pubkeys,
            )
            .map_err(je)
        }

        /// Verify a group signature under the key re-randomized by the given alpha - the exact check
        /// an Orchard spend passes on-chain.
        #[wasm_bindgen(js_name = verifyWithRandomizer)]
        pub fn verify_with_randomizer(
            &self,
            randomizer: &[u8],
            sig: &[u8],
        ) -> Result<bool, JsValue> {
            let vk = frost::VerifyingKey::deserialize(&self.group_vk).map_err(je)?;
            ceremony::verify_with_randomizer(&vk, randomizer, &self.message, sig).map_err(je)
        }
    }
}

// ---------- wasm-bindgen JS API for DKG + the confidential channel (Milestone 3c) ----------
// The stateful surface the /net page drives to create a vault across devices. The DKG's
// SecretPackages live INSIDE the session (native, never crossing to JS); only wire bytes move:
// public round-1 packages, and round-2 packages that JS seals (sealTo) before handing them to
// the relay and opens (DeviceKey.open) on arrival. The share (KeyPackage) is produced locally
// by part3 and stays on the device.
#[cfg(target_arch = "wasm32")]
mod js_dkg {
    use super::dkg::{self, WireItem};
    use super::frost;
    use super::seal;
    use frost::keys::dkg::{round1, round2};
    use wasm_bindgen::prelude::*;

    fn je(e: impl core::fmt::Display) -> JsValue {
        JsValue::from_str(&e.to_string())
    }

    /// A device's stateful DKG session. Round 1 runs on construction; JS then exchanges the
    /// wire bytes over the relay and calls part2/part3. SecretPackages never leave this struct.
    #[wasm_bindgen]
    pub struct DkgSession {
        my_id: Vec<u8>,
        r1_secret: Option<round1::SecretPackage>,
        r2_secret: Option<round2::SecretPackage>,
        r1_in: Vec<WireItem>,  // (sender_id, round-1 package) from the OTHERS
        r2_in: Vec<WireItem>,  // (sender_id, round-2 package) addressed to me, already opened
        r1_pkg: Vec<u8>,       // my round-1 package (public, to broadcast)
        r2_out: Vec<WireItem>, // (recipient_id, round-2 package) - SECRET, seal each before send
        key_package: Vec<u8>,
        pubkeys: Vec<u8>,
        group_vk: Vec<u8>,
    }

    #[wasm_bindgen]
    impl DkgSession {
        /// Round 1 on construction: keeps the round-1 secret local, exposes the public package.
        #[wasm_bindgen(constructor)]
        pub fn new(
            my_id: &[u8],
            max_signers: u16,
            min_signers: u16,
        ) -> Result<DkgSession, JsValue> {
            let (secret, pkg) = dkg::part1_wire(my_id, max_signers, min_signers).map_err(je)?;
            Ok(DkgSession {
                my_id: my_id.to_vec(),
                r1_secret: Some(secret),
                r2_secret: None,
                r1_in: vec![],
                r2_in: vec![],
                r1_pkg: pkg,
                r2_out: vec![],
                key_package: vec![],
                pubkeys: vec![],
                group_vk: vec![],
            })
        }

        #[wasm_bindgen(js_name = round1Package)]
        pub fn round1_package(&self) -> Vec<u8> {
            self.r1_pkg.clone()
        }

        #[wasm_bindgen(js_name = myId)]
        pub fn my_id(&self) -> Vec<u8> {
            self.my_id.clone()
        }

        /// Accept another member's round-1 package (public). Our own id is ignored.
        #[wasm_bindgen(js_name = addRound1)]
        pub fn add_round1(&mut self, sender_id: &[u8], pkg: &[u8]) {
            if sender_id != self.my_id.as_slice() {
                self.r1_in.push((sender_id.to_vec(), pkg.to_vec()));
            }
        }

        /// Round 2: consume the round-1 secret + collected round-1 packages. Produces one
        /// round-2 package per recipient (read via round2Count/Recipient/Package). Each is
        /// SECRET → JS must sealTo its recipient before it touches the relay.
        pub fn part2(&mut self) -> Result<(), JsValue> {
            let secret = self
                .r1_secret
                .take()
                .ok_or_else(|| je("part2 called out of order"))?;
            let (secret2, outgoing) = dkg::part2_wire(secret, &self.r1_in).map_err(je)?;
            self.r2_secret = Some(secret2);
            self.r2_out = outgoing;
            Ok(())
        }

        #[wasm_bindgen(js_name = round2Count)]
        pub fn round2_count(&self) -> usize {
            self.r2_out.len()
        }
        #[wasm_bindgen(js_name = round2Recipient)]
        pub fn round2_recipient(&self, i: usize) -> Vec<u8> {
            self.r2_out[i].0.clone()
        }
        #[wasm_bindgen(js_name = round2Package)]
        pub fn round2_package(&self, i: usize) -> Vec<u8> {
            self.r2_out[i].1.clone()
        }

        /// Accept a round-2 package addressed to me (already opened via DeviceKey.open),
        /// keyed by the SENDER's id.
        #[wasm_bindgen(js_name = addRound2)]
        pub fn add_round2(&mut self, sender_id: &[u8], pkg: &[u8]) {
            self.r2_in.push((sender_id.to_vec(), pkg.to_vec()));
        }

        /// Round 3: combine everything into this device's share + the shared group key.
        pub fn part3(&mut self) -> Result<(), JsValue> {
            let secret2 = self
                .r2_secret
                .as_ref()
                .ok_or_else(|| je("part3 called out of order"))?;
            let (kp, pubkeys) = dkg::part3_wire(secret2, &self.r1_in, &self.r2_in).map_err(je)?;
            let pk = frost::keys::PublicKeyPackage::deserialize(&pubkeys).map_err(je)?;
            self.group_vk = pk.verifying_key().serialize().map_err(je)?;
            self.key_package = kp;
            self.pubkeys = pubkeys;
            Ok(())
        }

        #[wasm_bindgen(js_name = keyPackage)]
        pub fn key_package(&self) -> Vec<u8> {
            self.key_package.clone()
        }
        pub fn pubkeys(&self) -> Vec<u8> {
            self.pubkeys.clone()
        }
        /// The vault's identity: the 32-byte group verifying key. Every honest device derives
        /// the SAME value - the UI shows it so both tabs can confirm they built one vault.
        #[wasm_bindgen(js_name = groupVk)]
        pub fn group_vk(&self) -> Vec<u8> {
            self.group_vk.clone()
        }
    }

    /// One device's side of creating a vault (version 2). A thin wrapper over
    /// `creation::Creation`: every rule lives there. JS passes the relay's messages in and shows
    /// the code; it never holds a round-2 package in the clear or seals to a key itself.
    #[wasm_bindgen]
    pub struct CreationSession {
        inner: super::creation::Creation,
    }

    #[wasm_bindgen]
    impl CreationSession {
        #[wasm_bindgen(constructor)]
        pub fn new(
            device: &DeviceKey,
            my_seat: u16,
            n: u16,
            t: u16,
            my_name: &str,
        ) -> Result<CreationSession, JsValue> {
            let secret = device.inner.secret_bytes();
            Ok(CreationSession {
                inner: super::creation::Creation::new(&secret, my_seat, n, t, my_name)
                    .map_err(je)?,
            })
        }
        #[wasm_bindgen(js_name = myCommitment)]
        pub fn my_commitment(&self) -> Vec<u8> {
            self.inner.my_commitment().to_vec()
        }
        #[wasm_bindgen(js_name = myRound1)]
        pub fn my_round1(&self) -> Vec<u8> {
            self.inner.my_reveal().0
        }
        #[wasm_bindgen(js_name = myNonce)]
        pub fn my_nonce(&self) -> Vec<u8> {
            self.inner.my_reveal().1.to_vec()
        }
        #[wasm_bindgen(js_name = addMember)]
        pub fn add_member(
            &mut self,
            seat: u16,
            enc_pub: &[u8],
            name: &str,
            commit: &[u8],
        ) -> Result<(), JsValue> {
            self.inner
                .add_member(seat, enc_pub, name, commit)
                .map_err(je)
        }
        #[wasm_bindgen(js_name = allCommitted)]
        pub fn all_committed(&self) -> bool {
            self.inner.all_committed()
        }
        #[wasm_bindgen(js_name = addReveal)]
        pub fn add_reveal(&mut self, seat: u16, r1: &[u8], nonce: &[u8]) -> Result<(), JsValue> {
            self.inner.add_reveal(seat, r1, nonce).map_err(je)
        }
        pub fn freeze(
            &mut self,
            room: &[u8],
            governance: &str,
            vault_name: &str,
            creator_name: &str,
            creator_seat: u16,
        ) -> Result<String, JsValue> {
            self.inner
                .freeze(room, governance, vault_name, creator_name, creator_seat)
                .map_err(je)
        }
        pub fn code(&self) -> Option<String> {
            self.inner.code()
        }
        pub fn confirm(&mut self, code: &str) -> Result<(), JsValue> {
            self.inner.confirm(code).map_err(je)
        }
        /// Round 2. Returns, for each other seat, `[to_hi, to_lo, ...sealed box]` flattened into one
        /// array per seat inside a JS array.
        pub fn part2(&mut self) -> Result<js_sys::Array, JsValue> {
            let out = js_sys::Array::new();
            for (to, sealed) in self.inner.part2().map_err(je)? {
                let mut v = to.to_be_bytes().to_vec();
                v.extend_from_slice(&sealed);
                out.push(&js_sys::Uint8Array::from(v.as_slice()));
            }
            Ok(out)
        }
        #[wasm_bindgen(js_name = addRound2)]
        pub fn add_round2(&mut self, from: u16, sealed: &[u8]) -> Result<bool, JsValue> {
            self.inner.add_round2(from, sealed).map_err(je)
        }
        #[wasm_bindgen(js_name = sealToSeat)]
        pub fn seal_to_seat(&self, to: u16, payload: &[u8]) -> Result<Vec<u8>, JsValue> {
            self.inner.seal_to_seat(to, payload).map_err(je)
        }
        #[wasm_bindgen(js_name = openFromSeat)]
        pub fn open_from_seat(&self, from: u16, sealed: &[u8]) -> Result<Vec<u8>, JsValue> {
            self.inner.open_from_seat(from, sealed).map_err(je)
        }
        pub fn done(&self) -> bool {
            self.inner.done()
        }
        #[wasm_bindgen(js_name = keyPackage)]
        pub fn key_package(&self) -> Vec<u8> {
            self.inner.key_package()
        }
        pub fn pubkeys(&self) -> Vec<u8> {
            self.inner.pubkeys()
        }
        #[wasm_bindgen(js_name = groupVk)]
        pub fn group_vk(&self) -> Vec<u8> {
            self.inner.group_vk()
        }
    }

    /// A device's long-term encryption keypair for the confidential channel (round-2 sealing).
    /// The public half rides in the invite; the secret half never leaves the device.
    #[wasm_bindgen]
    pub struct DeviceKey {
        inner: seal::DeviceKey,
    }

    #[wasm_bindgen]
    impl DeviceKey {
        #[allow(clippy::new_without_default)]
        #[wasm_bindgen(constructor)]
        pub fn new() -> DeviceKey {
            DeviceKey {
                inner: seal::DeviceKey::generate(),
            }
        }
        #[wasm_bindgen(js_name = fromSecret)]
        pub fn from_secret(bytes: &[u8]) -> Result<DeviceKey, JsValue> {
            let b: [u8; 32] = bytes
                .try_into()
                .map_err(|_| je("secret must be 32 bytes"))?;
            Ok(DeviceKey {
                inner: seal::DeviceKey::from_secret_bytes(&b),
            })
        }
        /// This device's PERSISTENT comms identity for a vault, derived from its FROST share
        /// (serialized KeyPackage). Reproduced on every unlock with nothing stored (#63). The
        /// public half (`publicBytes`) is what the device registers so the helper can seal to it.
        #[wasm_bindgen(js_name = fromShare)]
        pub fn from_share(key_package: &[u8]) -> DeviceKey {
            DeviceKey {
                inner: seal::device_key_from_share(key_package),
            }
        }
        #[wasm_bindgen(js_name = publicBytes)]
        pub fn public_bytes(&self) -> Vec<u8> {
            self.inner.public_bytes().to_vec()
        }
        /// Open a package sealed to this device. Errors on a wrong key or any tampering.
        pub fn open(&self, sealed: &[u8], aad: &[u8]) -> Result<Vec<u8>, JsValue> {
            seal::open(&self.inner, sealed, aad).map_err(je)
        }
    }

    /// This device's Ed25519 write-verifying key for a vault, hex (#288 / ADR-0011 D1).
    ///
    /// Derived from the FROST share under its own HKDF label, so it is reproduced on every unlock
    /// with nothing stored. This PUBLIC half is what the device registers with the helper; the
    /// secret half is derived on demand inside WASM to sign, and is never returned to JS.
    #[wasm_bindgen(js_name = deviceWritePubHex)]
    pub fn device_write_pub_hex(key_package: &[u8]) -> String {
        let seed = seal::write_key_seed_from_share(key_package);
        let vk = ed25519_dalek::SigningKey::from_bytes(&seed).verifying_key();
        vk.as_bytes().iter().map(|b| format!("{b:02x}")).collect()
    }

    /// Sign a governance write with this device's Ed25519 key (#288 / ADR-0011).
    ///
    /// It BUILDS the canonical message itself, from `konclave_seal::write_message` - the same
    /// function the helper recomputes with. The bytes are therefore never assembled in TypeScript,
    /// which is the whole point: a second implementation of the format could drift, and the failure
    /// it produces in the field is "your vote was refused" with nothing pointing at the cause.
    ///
    /// `action` is "approve", "refuse" or "rename"; anything else is rejected here rather than
    /// silently signed as something the helper will not recognise. `target` is the proposal id, or
    /// `old\0new` for a rename.
    ///
    /// Returns the 64-byte signature as hex. The signing key exists only for this call and never
    /// reaches JS.
    #[wasm_bindgen(js_name = signWrite)]
    pub fn sign_write(
        key_package: &[u8],
        vault_id: &str,
        action: &str,
        target: &str,
        seat: u16,
        ts: f64,
        nonce: &str,
    ) -> Result<String, JsValue> {
        use ed25519_dalek::Signer;
        let action = match action {
            "approve" => seal::WriteAction::Approve,
            "refuse" => seal::WriteAction::Refuse,
            "rename" => seal::WriteAction::Rename,
            "propose" => seal::WriteAction::Propose,
            "send" => seal::WriteAction::Send,
            other => return Err(JsValue::from_str(&format!("unknown write action: {other}"))),
        };
        let msg = seal::write_message(vault_id, action, target, seat, ts as i64, nonce);
        let seed = seal::write_key_seed_from_share(key_package);
        let sk = ed25519_dalek::SigningKey::from_bytes(&seed);
        Ok(sk
            .sign(&msg)
            .to_bytes()
            .iter()
            .map(|b| format!("{b:02x}"))
            .collect())
    }

    /// Seal `plaintext` to a recipient's 32-byte public key (used on each round-2 package so the
    /// relay only ever carries ciphertext). `aad` binds context (sender+recipient) into the tag.
    #[wasm_bindgen(js_name = sealTo)]
    pub fn seal_to(recipient_pub: &[u8], plaintext: &[u8], aad: &[u8]) -> Result<Vec<u8>, JsValue> {
        let pk: [u8; 32] = recipient_pub
            .try_into()
            .map_err(|_| je("recipient pub must be 32 bytes"))?;
        seal::seal(&pk, plaintext, aad).map_err(je)
    }

    /// Encrypt a body ONCE under a raw 32-byte key (hybrid sealing, #63): the helper seals the key to
    /// each device, so the SignRequest wire stays flat in the signer count. Exposed for parity/tests.
    #[wasm_bindgen(js_name = sealBody)]
    pub fn seal_body(key: &[u8], plaintext: &[u8]) -> Result<Vec<u8>, JsValue> {
        let k: [u8; 32] = key.try_into().map_err(|_| je("key must be 32 bytes"))?;
        Ok(seal::seal_body(&k, plaintext))
    }

    /// Decrypt the shared body of a sealed request, with the 32-byte key this device recovered from
    /// its own box (`DeviceKey.open`). A wrong key or any tampering is an error.
    #[wasm_bindgen(js_name = openBody)]
    pub fn open_body(key: &[u8], sealed: &[u8]) -> Result<Vec<u8>, JsValue> {
        let k: [u8; 32] = key.try_into().map_err(|_| je("key must be 32 bytes"))?;
        seal::open_body(&k, sealed).map_err(je)
    }

    /// Deterministic identifier bytes for participant number `index` (1-based), so every device
    /// agrees on who is who without a central registry.
    #[wasm_bindgen(js_name = identifierBytes)]
    pub fn identifier_bytes(index: u16) -> Result<Vec<u8>, JsValue> {
        dkg::identifier_bytes(index).map_err(je)
    }

    /// Sign a signing-room message with this device's share (room-auth, #392). 64-byte signature.
    /// Domain-separated so it can never be a transaction spend-auth signature (see `room_auth`).
    #[wasm_bindgen(js_name = signRoomMsg)]
    pub fn sign_room_msg(key_package: &[u8], msg: &[u8]) -> Result<Vec<u8>, JsValue> {
        let kp = crate::frost::keys::KeyPackage::deserialize(key_package).map_err(je)?;
        Ok(crate::room_auth::sign_with_share(kp.signing_share(), msg).to_vec())
    }

    /// Verify a room message was signed by SEAT `seat`'s share (1-based), against the DKG
    /// PublicKeyPackage every device holds (#392). The seat's identity is its `verifying_share` -
    /// no trusted registry - so an outsider cannot forge a seat it does not hold the share for.
    #[wasm_bindgen(js_name = verifyRoomSig)]
    pub fn verify_room_sig(
        pubkeys: &[u8],
        seat: u16,
        msg: &[u8],
        sig: &[u8],
    ) -> Result<bool, JsValue> {
        let sig64: [u8; 64] = sig.try_into().map_err(|_| je("sig must be 64 bytes"))?;
        let pk = crate::frost::keys::PublicKeyPackage::deserialize(pubkeys).map_err(je)?;
        let id = crate::frost::Identifier::try_from(seat).map_err(je)?;
        Ok(match pk.verifying_shares().get(&id) {
            Some(vs) => crate::room_auth::verify_against_share(vs, msg, &sig64),
            None => false,
        })
    }

    /// Verify a group signature against the vault's key - so EVERY device confirms the result
    /// for itself, not on the coordinator's word. All inputs are public (signing package, seed,
    /// message, signature); the share never enters.
    #[wasm_bindgen(js_name = verifyRedpallas)]
    pub fn verify_redpallas(
        group_vk: &[u8],
        sp: &[u8],
        seed: &[u8],
        message: &[u8],
        sig: &[u8],
    ) -> Result<bool, JsValue> {
        let vk = frost::VerifyingKey::deserialize(group_vk).map_err(je)?;
        super::ceremony::verify(&vk, sp, seed, message, sig).map_err(je)
    }
}

// ---------- wasm-bindgen JS API for social recovery (RTS over the relay) ----------
// Two roles: helpers (who still have their shares) rebuild a lost member's share; the
// recovering member combines the result. Deltas are secret - JS seals each to its recipient
// with sealTo (same confidential path as the DKG's round-2), so the relay stays blind.
#[cfg(target_arch = "wasm32")]
mod js_recovery {
    use super::frost;
    use super::recovery;
    use frost::keys::{KeyPackage, PublicKeyPackage};
    use frost::Identifier;
    use wasm_bindgen::prelude::*;

    fn je(e: impl core::fmt::Display) -> JsValue {
        JsValue::from_str(&e.to_string())
    }

    /// A helper's recovery session. Register the helper set (including self), compute the
    /// per-recipient deltas (round 1), then sum the deltas received into this helper's sigma
    /// (round 2). The helper's own KeyPackage stays local; only deltas/sigma cross the wire.
    #[wasm_bindgen]
    pub struct RecoveryHelper {
        my_kp: Vec<u8>,
        lost: Vec<u8>,
        helper_ids: Vec<Vec<u8>>,
        out: Vec<(Vec<u8>, Vec<u8>)>, // (recipient id, delta bytes)
        incoming: Vec<Vec<u8>>,       // delta bytes addressed to me (already opened)
    }

    #[wasm_bindgen]
    impl RecoveryHelper {
        #[wasm_bindgen(constructor)]
        pub fn new(my_key_package: &[u8], lost_id: &[u8]) -> RecoveryHelper {
            RecoveryHelper {
                my_kp: my_key_package.into(),
                lost: lost_id.into(),
                helper_ids: vec![],
                out: vec![],
                incoming: vec![],
            }
        }
        /// Register a helper's identifier - call once per helper seat, INCLUDING this one.
        #[wasm_bindgen(js_name = addHelper)]
        pub fn add_helper(&mut self, id: &[u8]) {
            self.helper_ids.push(id.into());
        }
        /// Round 1: produce one delta per helper (read via deltaCount/deltaRecipient/delta).
        #[wasm_bindgen(js_name = computeDeltas)]
        pub fn compute_deltas(&mut self) -> Result<(), JsValue> {
            let kp = KeyPackage::deserialize(&self.my_kp).map_err(je)?;
            let lost = Identifier::deserialize(&self.lost).map_err(je)?;
            let helpers: Vec<Identifier> = self
                .helper_ids
                .iter()
                .map(|b| Identifier::deserialize(b))
                .collect::<Result<_, _>>()
                .map_err(je)?;
            self.out = recovery::helper_deltas_wire(&helpers, &kp, lost).map_err(je)?;
            Ok(())
        }
        #[wasm_bindgen(js_name = deltaCount)]
        pub fn delta_count(&self) -> usize {
            self.out.len()
        }
        #[wasm_bindgen(js_name = deltaRecipient)]
        pub fn delta_recipient(&self, i: usize) -> Vec<u8> {
            self.out[i].0.clone()
        }
        pub fn delta(&self, i: usize) -> Vec<u8> {
            self.out[i].1.clone()
        }
        /// Collect a delta (already opened) addressed to me, from any helper.
        #[wasm_bindgen(js_name = addIncomingDelta)]
        pub fn add_incoming_delta(&mut self, delta: &[u8]) {
            self.incoming.push(delta.into());
        }
        /// Round 2: sum the received deltas into this helper's sigma bytes (sealed to the member).
        pub fn sigma(&self) -> Result<Vec<u8>, JsValue> {
            recovery::helper_sigma_wire(&self.incoming).map_err(je)
        }
    }

    /// The recovering member: collect the helpers' sigmas and combine them into the repaired
    /// KeyPackage (validated against the group's public share). Runs entirely on this device.
    #[wasm_bindgen]
    pub struct RecoveryCombiner {
        lost: Vec<u8>,
        pubkeys: Vec<u8>,
        sigmas: Vec<Vec<u8>>,
    }

    #[wasm_bindgen]
    impl RecoveryCombiner {
        #[wasm_bindgen(constructor)]
        pub fn new(lost_id: &[u8], pubkeys: &[u8]) -> RecoveryCombiner {
            RecoveryCombiner {
                lost: lost_id.into(),
                pubkeys: pubkeys.into(),
                sigmas: vec![],
            }
        }
        #[wasm_bindgen(js_name = addSigma)]
        pub fn add_sigma(&mut self, sigma: &[u8]) {
            self.sigmas.push(sigma.into());
        }
        /// Combine → the repaired KeyPackage bytes. Errors if the result doesn't match the group.
        #[wasm_bindgen(js_name = keyPackage)]
        pub fn key_package(&self) -> Result<Vec<u8>, JsValue> {
            let lost = Identifier::deserialize(&self.lost).map_err(je)?;
            let pubkeys = PublicKeyPackage::deserialize(&self.pubkeys).map_err(je)?;
            recovery::repaired_wire(&self.sigmas, lost, &pubkeys).map_err(je)
        }
    }
}

// ---------- wasm-bindgen JS API for the FROST<->PCZT bridge ----------
// The browser calls these to sign a real Orchard transaction: `extractRandomizers` reads the
// per-spend alphas out of a proven PCZT (so each device knows what to sign), and `injectSigs`
// writes the FROST signatures back into the PCZT. Bytes only, no secrets cross the boundary.
// Wire encoding (all little-endian): a randomizer record is 4-byte u32 index then 32-byte alpha
// (36 bytes); a signature record is 4-byte u32 index then 64-byte signature (68 bytes).
#[cfg(target_arch = "wasm32")]
mod js_pczt {
    use super::pczt_bridge;
    use wasm_bindgen::prelude::*;

    fn je(e: impl core::fmt::Display) -> JsValue {
        JsValue::from_str(&e.to_string())
    }

    /// Read the `(action_index, alpha)` randomizers of the real Orchard spends from a proven PCZT.
    /// Returns a flat buffer of 36-byte records: u32-LE index then 32-byte alpha.
    #[wasm_bindgen(js_name = extractRandomizers)]
    pub fn extract_randomizers(pczt: &[u8]) -> Result<Vec<u8>, JsValue> {
        let rs = pczt_bridge::extract_randomizers(pczt).map_err(je)?;
        let mut out = Vec::with_capacity(rs.len() * 36);
        for (idx, alpha) in rs {
            out.extend_from_slice(&(idx as u32).to_le_bytes());
            out.extend_from_slice(&alpha);
        }
        Ok(out)
    }

    /// The raw Orchard receiver of a unified address, hex - the approved destination in the same
    /// space as an output's `recipient`, so the money gate can compare them (#281).
    ///
    /// Errors for an address a shielded vault spend cannot pay. The caller must let that error
    /// through rather than treating it as "no match": a gate that cannot decode what was approved
    /// does not know what it is signing, and must refuse rather than guess in either direction.
    #[wasm_bindgen(js_name = uaReceiver)]
    pub fn ua_receiver(ua: &str) -> Result<String, JsValue> {
        pczt_bridge::ua_receiver(ua).map_err(je)
    }

    /// A JSON string literal. A memo is free text a member typed, so unlike the addresses and hex
    /// beside it, it needs escaping.
    fn json_str(s: &str) -> String {
        let mut out = String::with_capacity(s.len() + 2);
        out.push('"');
        for c in s.chars() {
            match c {
                '"' => out.push_str("\\\""),
                '\\' => out.push_str("\\\\"),
                c if (c as u32) < 0x20 => out.push_str(&format!("\\u{:04x}", c as u32)),
                c => out.push(c),
            }
        }
        out.push('"');
        out
    }

    /// The outputs as a JSON array of `{"address","value","recipient","memo"}`, built by hand (no
    /// serde in this crate).
    fn outputs_json(outs: &[pczt_bridge::OutputInfo]) -> String {
        let mut s = String::from("[");
        for (i, o) in outs.iter().enumerate() {
            if i > 0 {
                s.push(',');
            }
            let addr = match &o.address {
                Some(a) if a.bytes().all(|b| b.is_ascii_alphanumeric()) => format!("\"{}\"", a),
                Some(_) => "null".to_string(), // reject anything non-bech32m rather than emit unsafe JSON
                None => "null".to_string(),
            };
            let val = match o.value {
                Some(v) => v.to_string(),
                None => "null".to_string(),
            };
            // recipient is hex ([a-f0-9]), always JSON-safe.
            let recip = match &o.recipient {
                Some(r) => format!("\"{}\"", r),
                None => "null".to_string(),
            };
            let memo = match &o.memo {
                Some(m) => json_str(m),
                None => "null".to_string(),
            };
            s.push_str(&format!(
                "{{\"address\":{},\"value\":{},\"recipient\":{},\"memo\":{}}}",
                addr, val, recip, memo
            ));
        }
        s.push(']');
        s
    }

    /// Every output of a proven PCZT as a JSON array of `{"address": string|null, "value":
    /// number|null, "recipient": hex|null, "memo": string|null}`, each checked against its note
    /// commitment (see `readPayment`, which this is the outputs of). Values are zatoshis.
    #[wasm_bindgen(js_name = describeOutputs)]
    pub fn describe_outputs(pczt: &[u8]) -> Result<String, JsValue> {
        let outs = pczt_bridge::describe_outputs(pczt).map_err(je)?;
        Ok(outputs_json(&outs))
    }

    /// What a proven PCZT pays, as THIS device can confirm it, as JSON: `{"outputs": [...as
    /// describeOutputs...], "feeZat": number, "actions": number}`. This is the reading a device
    /// signs on (#610): every output checked against its note commitment, its address label against
    /// the receiver it pays, each paying output opened for its memo, and the fee bounded by ZIP 317.
    /// A refusal is an error whose message starts with a bracketed code (`[commitment]`, `[label]`,
    /// `[undecryptable]`, `[fee]`, `[shape]`) so the caller can tell the member why.
    #[wasm_bindgen(js_name = readPayment)]
    pub fn read_payment(pczt: &[u8]) -> Result<String, JsValue> {
        let p = pczt_bridge::read_payment(pczt).map_err(je)?;
        Ok(format!(
            "{{\"outputs\":{},\"feeZat\":{},\"actions\":{}}}",
            outputs_json(&p.outputs),
            p.fee_zat,
            p.actions
        ))
    }

    /// The height at which the last upgrade in this build's table activates (NU7 on mainnet). The app
    /// reads it for the notice it shows before a payment: the same number the device and the
    /// coordinator use, never one typed in the app.
    #[wasm_bindgen(js_name = upgradeHeight)]
    pub fn upgrade_height() -> u32 {
        pczt_bridge::latest_upgrade_height(&pczt_bridge::MAINNET)
    }

    /// What a new transaction is for an approval this device already signed (`approval_decision`),
    /// with the DEVICE's own clock read here. `signed` is this device's record as
    /// `"sighash:expiry[:branch],..."` (no branch = NU6.3); the answer is JSON `{"kind":
    /// "first"|"same"|"afterExpiry"|"second", "firstExpiry"?: number, "untilUnix"?: number|null, "untilHeight"?: number|null,
    /// "byEpoch"?: boolean}`. A
    /// malformed entry, or a branch this build does not know, is an error, never skipped: a record
    /// that cannot be read must not read as "nothing signed".
    #[wasm_bindgen(js_name = approvalDecision)]
    pub fn approval_decision(signed: &str, sighash: &str) -> Result<String, JsValue> {
        let records = pczt_bridge::parse_signed(&pczt_bridge::MAINNET, signed).map_err(je)?;
        let now_unix = (js_sys::Date::now() / 1000.0) as i64;
        Ok(
            match pczt_bridge::approval_decision(&pczt_bridge::MAINNET, &records, sighash, now_unix)
            {
                pczt_bridge::ApprovalDecision::First => "{\"kind\":\"first\"}".to_string(),
                pczt_bridge::ApprovalDecision::Same => "{\"kind\":\"same\"}".to_string(),
                pczt_bridge::ApprovalDecision::AfterExpiry => {
                    "{\"kind\":\"afterExpiry\"}".to_string()
                }
                pczt_bridge::ApprovalDecision::Second {
                    first_expiry,
                    until_unix,
                    until_height,
                    by_epoch,
                } => {
                    let num = |n: Option<String>| n.unwrap_or_else(|| "null".to_string());
                    format!(
                        "{{\"kind\":\"second\",\"firstExpiry\":{first_expiry},\"untilUnix\":{},\"untilHeight\":{},\"byEpoch\":{by_epoch}}}",
                        num(until_unix.map(|n| n.to_string())),
                        num(until_height.map(|n| n.to_string())),
                    )
                }
            },
        )
    }

    /// What this device signs on, as JSON: `{"outputs": [...], "feeZat", "actions", "sighash": hex,
    /// "txid": hex, "expiry": number, "branch": number}`. `readPayment`'s reading plus the header checked against the
    /// network this build signs for, with the DEVICE's own clock read here (never passed in by a
    /// caller, never the coordinator's height). The one call a signing driver makes before its share
    /// leaves; a refusal is an error starting with a bracketed code (`[expiry]`, `[network]`,
    /// `[locktime]`, plus `readPayment`'s).
    #[wasm_bindgen(js_name = readForSigning)]
    pub fn read_for_signing(pczt: &[u8]) -> Result<String, JsValue> {
        let now_unix = (js_sys::Date::now() / 1000.0) as i64;
        let f = pczt_bridge::read_for_signing(pczt, now_unix).map_err(je)?;
        let sighash: String = f.sighash.iter().map(|b| format!("{b:02x}")).collect();
        Ok(format!(
            "{{\"outputs\":{},\"feeZat\":{},\"actions\":{},\"sighash\":\"{}\",\"txid\":\"{}\",\"expiry\":{},\"branch\":{}}}",
            outputs_json(&f.payment.outputs),
            f.payment.fee_zat,
            f.payment.actions,
            sighash,
            f.txid,
            f.expiry_height,
            f.branch_id
        ))
    }

    /// Apply FROST redpallas signatures to a proven PCZT and return the signed PCZT bytes.
    /// `sighash` is the 32-byte shielded sighash; `sigs` is a flat buffer of 68-byte records:
    /// u32-LE index then 64-byte signature.
    #[wasm_bindgen(js_name = injectSigs)]
    pub fn inject_sigs(pczt: &[u8], sighash: &[u8], sigs: &[u8]) -> Result<Vec<u8>, JsValue> {
        let sighash: [u8; 32] = sighash
            .try_into()
            .map_err(|_| je("sighash must be exactly 32 bytes"))?;
        if sigs.len() % 68 != 0 {
            return Err(je(
                "sigs buffer must be a multiple of 68 bytes (u32 index + 64-byte sig)",
            ));
        }
        let mut parsed: Vec<(usize, [u8; 64])> = Vec::with_capacity(sigs.len() / 68);
        for rec in sigs.chunks_exact(68) {
            let idx = u32::from_le_bytes(rec[0..4].try_into().unwrap()) as usize;
            let sig: [u8; 64] = rec[4..68].try_into().unwrap();
            parsed.push((idx, sig));
        }
        pczt_bridge::inject_sigs(pczt, sighash, &parsed).map_err(je)
    }

    /// Recompute the ZIP-244 shielded sig_digest from THIS device's own proven PCZT, returning the
    /// 32-byte sighash. The signing driver signs this value, never a sighash handed over the relay -
    /// the on-device defence against the transaction-swap attack (issue #62 / ADR-0007 I2). Errors
    /// if the PCZT is not a shielded-only v5/v6 transaction.
    #[wasm_bindgen(js_name = pcztSighash)]
    pub fn pczt_sighash(pczt: &[u8]) -> Result<Vec<u8>, JsValue> {
        let parsed =
            pczt::Pczt::parse(pczt).map_err(|e| je(format!("failed to parse PCZT: {:?}", e)))?;
        let digest = pczt_bridge::shielded_sighash(&parsed).map_err(je)?;
        Ok(digest.to_vec())
    }
}
