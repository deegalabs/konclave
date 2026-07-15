//! Konclave browser-signer core (WS1 of the konclave.app plan).
//!
//! Assembles the three de-risked probes into ONE module the browser calls:
//!
//! 1. FROST-redpallas signing round (wasm-signer-spike)
//! 2. Orchard action verification (wasm-orchard-probe)
//! 3. ZIP-244 sig_digest recompute (wasm-sighash-probe)
//!
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
    fn e<T: core::fmt::Display>(x: T) -> E {
        x.to_string()
    }

    /// Participant device, round 1: produce local secret nonces + a public commitment (bytes).
    /// The nonces are kept in the browser session; only the commitment goes to the relay.
    pub fn participant_round1(kp: &KeyPackage) -> (SigningNonces, Vec<u8>) {
        let (nonces, commitments) = frost::round1::commit(kp.signing_share(), &mut OsRng);
        (
            nonces,
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
    /// package. Signers regenerate the randomizer from this seed — no need to trust the RNG.
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
    pub fn participant_round2(
        sp_bytes: &[u8],
        nonces: &SigningNonces,
        kp: &KeyPackage,
        seed: &[u8],
    ) -> Result<Vec<u8>, E> {
        let sp = SigningPackage::deserialize(sp_bytes).map_err(e)?;
        let share = rerandomized::sign_with_randomizer_seed(&sp, nonces, kp, seed).map_err(e)?;
        Ok(share.serialize())
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
            let sig_bytes =
                coordinator_aggregate(&sp_bytes, &group_vk, &seed, &wire_shares, &pubkeys).unwrap();
            assert!(
                verify(&group_vk, &sp_bytes, &seed, message, &sig_bytes).unwrap(),
                "the aggregated signature must verify against the randomized group key"
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
//           — each is a SECRET share-piece for ONE recipient, and MUST be sealed to that
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
    /// packages addressed TO this device `(sender_id, bytes)` — sender-keyed, opened locally.
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
        /// carries), then a 2-of-3 signing with the resulting shares — proving the vault the
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
            for ((id, kp), (_id2, nonces)) in signers.iter().zip(local_nonces.iter()) {
                let share =
                    super::super::ceremony::participant_round2(&sp, nonces, kp, &seed).unwrap();
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

// ---------- Social recovery: repair a lost share (Repairable Threshold Scheme) ----------
//
// Steward has this; now so do we. When a member loses their device, a QUORUM of the others
// helps rebuild that member's share — the group key is never touched, no share is revealed to
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
    /// Delta serializes to 32 bytes and is sealed to its recipient — the same blind path as DKG.
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
            for ((id, kp), (_id, nc)) in signers.iter().zip(nonces.iter()) {
                shares_wire.push((
                    id.serialize(),
                    super::super::ceremony::participant_round2(&sp, nc, kp, &seed).unwrap(),
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

// ---------- 3b. The confidential channel (seal the DKG's secret packages) ----------
//
// The DKG's round-2 packages are the ONE secret piece that must travel between devices.
// They must reach the relay already sealed to their recipient, so a blind (or hostile)
// relay carries only ciphertext. ECIES: an ephemeral X25519 key → HKDF-SHA256 → an
// XChaCha20-Poly1305 box. Confidentiality comes from here; sender-authenticity of the
// *plaintext* is guaranteed independently by the DKG (part3 checks each round-2 share
// against the sender's authenticated round-1 commitment) and by the transport signing every
// relay message. This is exactly the "confidential and authenticated channel" the round-2
// package docstring demands.
pub mod seal {
    use chacha20poly1305::aead::{Aead, KeyInit, Payload};
    use chacha20poly1305::{Key, XChaCha20Poly1305, XNonce};
    use hkdf::Hkdf;
    use rand::rngs::OsRng;
    use rand::RngCore;
    use sha2::Sha256;
    use x25519_dalek::{EphemeralSecret, PublicKey, StaticSecret};

    const INFO: &[u8] = b"konclave-dkg-seal-v1";
    const EPH_LEN: usize = 32;
    const NONCE_LEN: usize = 24;

    /// A device's long-term encryption keypair — separate from its FROST share. The public
    /// half rides in the invite/contacts; the secret half never leaves the device.
    pub struct DeviceKey {
        secret: StaticSecret,
    }

    impl DeviceKey {
        /// A fresh keypair from the OS CSPRNG.
        pub fn generate() -> DeviceKey {
            let mut b = [0u8; 32];
            OsRng.fill_bytes(&mut b);
            DeviceKey {
                secret: StaticSecret::from(b),
            }
        }
        /// Restore from the 32 secret bytes persisted on the device.
        pub fn from_secret_bytes(b: &[u8; 32]) -> DeviceKey {
            DeviceKey {
                secret: StaticSecret::from(*b),
            }
        }
        pub fn secret_bytes(&self) -> [u8; 32] {
            self.secret.to_bytes()
        }
        pub fn public_bytes(&self) -> [u8; 32] {
            PublicKey::from(&self.secret).to_bytes()
        }
    }

    fn derive_key(shared: &[u8; 32]) -> [u8; 32] {
        let hk = Hkdf::<Sha256>::new(None, shared);
        let mut okm = [0u8; 32];
        hk.expand(INFO, &mut okm)
            .expect("hkdf expand 32 bytes never fails");
        okm
    }

    /// Seal `plaintext` to `recipient_pub` (32-byte X25519 public key). `aad` binds context
    /// (e.g. the sender and recipient identifiers) into the tag. Wire layout:
    /// `ephemeral_pub(32) ‖ nonce(24) ‖ ciphertext`.
    pub fn seal(recipient_pub: &[u8; 32], plaintext: &[u8], aad: &[u8]) -> Result<Vec<u8>, String> {
        let eph = EphemeralSecret::random_from_rng(OsRng);
        let eph_pub = PublicKey::from(&eph);
        let shared = eph.diffie_hellman(&PublicKey::from(*recipient_pub));
        let key = derive_key(shared.as_bytes());
        let cipher = XChaCha20Poly1305::new(Key::from_slice(&key));
        let mut nonce = [0u8; NONCE_LEN];
        OsRng.fill_bytes(&mut nonce);
        let ct = cipher
            .encrypt(
                XNonce::from_slice(&nonce),
                Payload {
                    msg: plaintext,
                    aad,
                },
            )
            .map_err(|_| "seal: encrypt failed".to_string())?;
        let mut out = Vec::with_capacity(EPH_LEN + NONCE_LEN + ct.len());
        out.extend_from_slice(eph_pub.as_bytes());
        out.extend_from_slice(&nonce);
        out.extend_from_slice(&ct);
        Ok(out)
    }

    /// Open a sealed message with this device's secret. `aad` must equal what was sealed, or
    /// the tag check fails. A wrong key or any tampering is an error, never a silent bad open.
    pub fn open(device: &DeviceKey, sealed: &[u8], aad: &[u8]) -> Result<Vec<u8>, String> {
        if sealed.len() < EPH_LEN + NONCE_LEN {
            return Err("open: message too short".into());
        }
        let mut eph = [0u8; EPH_LEN];
        eph.copy_from_slice(&sealed[..EPH_LEN]);
        let mut nonce = [0u8; NONCE_LEN];
        nonce.copy_from_slice(&sealed[EPH_LEN..EPH_LEN + NONCE_LEN]);
        let ct = &sealed[EPH_LEN + NONCE_LEN..];
        let shared = device.secret.diffie_hellman(&PublicKey::from(eph));
        let key = derive_key(shared.as_bytes());
        let cipher = XChaCha20Poly1305::new(Key::from_slice(&key));
        cipher
            .decrypt(XNonce::from_slice(&nonce), Payload { msg: ct, aad })
            .map_err(|_| "open: wrong recipient or tampered message".to_string())
    }

    #[cfg(test)]
    mod tests {
        use super::*;

        #[test]
        fn a_sealed_package_opens_only_for_its_recipient() {
            let bob = DeviceKey::generate();
            let aad = b"alice->bob:round2";
            let secret_share = b"this stands in for a DKG round-2 secret package";
            let sealed = seal(&bob.public_bytes(), secret_share, aad).unwrap();

            // Bob opens it.
            assert_eq!(open(&bob, &sealed, aad).unwrap(), secret_share);

            // A different device cannot.
            let mallory = DeviceKey::generate();
            assert!(open(&mallory, &sealed, aad).is_err());
        }

        #[test]
        fn tampering_or_wrong_context_is_rejected() {
            let bob = DeviceKey::generate();
            let aad = b"alice->bob:round2";
            let mut sealed = seal(&bob.public_bytes(), b"payload", aad).unwrap();

            // Flip a ciphertext byte → tag fails.
            let last = sealed.len() - 1;
            sealed[last] ^= 0x01;
            assert!(open(&bob, &sealed, aad).is_err());

            // Right ciphertext, wrong AAD (different sender/recipient binding) → tag fails.
            let good = seal(&bob.public_bytes(), b"payload", aad).unwrap();
            assert!(open(&bob, &good, b"eve->bob:round2").is_err());
        }

        #[test]
        fn the_relay_only_ever_sees_ciphertext() {
            // The sealed bytes must not contain the plaintext anywhere (a blind relay holding
            // these learns nothing about the share).
            let bob = DeviceKey::generate();
            let plaintext = b"SECRET-SHARE-MATERIAL-0xdeadbeef";
            let sealed = seal(&bob.public_bytes(), plaintext, b"ctx").unwrap();
            assert!(
                !sealed.windows(plaintext.len()).any(|w| w == plaintext),
                "plaintext must never appear in the sealed bytes"
            );
        }

        #[test]
        fn a_persisted_device_key_round_trips() {
            let k = DeviceKey::generate();
            let restored = DeviceKey::from_secret_bytes(&k.secret_bytes());
            assert_eq!(k.public_bytes(), restored.public_bytes());
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
        nonces: Vec<u8>,
        commitment: Vec<u8>,
    }
    #[wasm_bindgen]
    impl Round1 {
        pub fn nonces(&self) -> Vec<u8> {
            self.nonces.clone()
        }
        pub fn commitment(&self) -> Vec<u8> {
            self.commitment.clone()
        }
    }

    /// Participant device, round 1 (JS): from the local key-package bytes.
    #[wasm_bindgen(js_name = participantRound1)]
    pub fn participant_round1(kp_bytes: &[u8]) -> Result<Round1, JsValue> {
        let kp = KeyPackage::deserialize(kp_bytes).map_err(je)?;
        let (nonces, commitment) = ceremony::participant_round1(&kp);
        Ok(Round1 {
            nonces: nonces.serialize().map_err(je)?,
            commitment,
        })
    }

    /// Participant device, round 2 (JS): sign with the local nonces + seed.
    #[wasm_bindgen(js_name = participantRound2)]
    pub fn participant_round2(
        sp: &[u8],
        nonces_bytes: &[u8],
        kp_bytes: &[u8],
        seed: &[u8],
    ) -> Result<Vec<u8>, JsValue> {
        let nonces = SigningNonces::deserialize(nonces_bytes).map_err(je)?;
        let kp = KeyPackage::deserialize(kp_bytes).map_err(je)?;
        ceremony::participant_round2(sp, &nonces, &kp, seed).map_err(je)
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
        r2_out: Vec<WireItem>, // (recipient_id, round-2 package) — SECRET, seal each before send
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
        /// the SAME value — the UI shows it so both tabs can confirm they built one vault.
        #[wasm_bindgen(js_name = groupVk)]
        pub fn group_vk(&self) -> Vec<u8> {
            self.group_vk.clone()
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
        #[wasm_bindgen(js_name = secretBytes)]
        pub fn secret_bytes(&self) -> Vec<u8> {
            self.inner.secret_bytes().to_vec()
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

    /// Seal `plaintext` to a recipient's 32-byte public key (used on each round-2 package so the
    /// relay only ever carries ciphertext). `aad` binds context (sender+recipient) into the tag.
    #[wasm_bindgen(js_name = sealTo)]
    pub fn seal_to(recipient_pub: &[u8], plaintext: &[u8], aad: &[u8]) -> Result<Vec<u8>, JsValue> {
        let pk: [u8; 32] = recipient_pub
            .try_into()
            .map_err(|_| je("recipient pub must be 32 bytes"))?;
        seal::seal(&pk, plaintext, aad).map_err(je)
    }

    /// Deterministic identifier bytes for participant number `index` (1-based), so every device
    /// agrees on who is who without a central registry.
    #[wasm_bindgen(js_name = identifierBytes)]
    pub fn identifier_bytes(index: u16) -> Result<Vec<u8>, JsValue> {
        dkg::identifier_bytes(index).map_err(je)
    }

    /// Verify a group signature against the vault's key — so EVERY device confirms the result
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
// recovering member combines the result. Deltas are secret — JS seals each to its recipient
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
        /// Register a helper's identifier — call once per helper seat, INCLUDING this one.
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
