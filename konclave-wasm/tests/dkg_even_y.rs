// ZIP 312 key negation, checked on what Konclave's DKG gives a device. When the raw group key
// (the sum of the round-1 constant commitments) has ỹ = 1, the DKG output MUST be the negated
// key: -PK, every -sk_i and every -PK_i; when ỹ = 0 nothing is negated. Either way the result
// has ỹ = 0, which ZIP 2005 needs of an `ak`, and the shares sign under it.
//
// The raw values are rebuilt here from the wire bytes alone (the round-1 commitments and the
// round-2 evaluations every device sends), never read from the output under test, so a DKG that
// skipped the normalisation, or applied it to the wrong half, fails.
use konclave_wasm::ceremony;
use konclave_wasm::dkg::{identifier_bytes, part1_wire, part2_wire, part3_wire, WireItem};
use reddsa::frost::redpallas::keys::dkg::{round1, round2};
use reddsa::frost::redpallas::keys::{KeyPackage, PublicKeyPackage, SigningShare, VerifyingShare};
use reddsa::frost::redpallas::{
    Field, Group, Identifier, PallasGroup, PallasScalarField, SigningKey, VerifyingKey,
};

type S = <PallasScalarField as Field>::Scalar;
type P = <PallasGroup as Group>::Element;

const N: u16 = 3;
const T: u16 = 2;

/// One DKG over the wire, and the raw (pre-normalisation) values rebuilt from its wire bytes.
struct Run {
    raw_pk: P,
    raw_secret: S,
    /// (identifier, raw sk_i) for every seat.
    raw_shares: Vec<(Identifier, S)>,
    key_packages: Vec<KeyPackage>,
    pubkeys: PublicKeyPackage,
}

fn scalar(b: &[u8]) -> S {
    SigningKey::deserialize(b).unwrap().to_scalar()
}

fn odd_y(p: &P) -> bool {
    PallasGroup::serialize(p).unwrap()[31] & 0x80 != 0
}

fn base_mul(s: &S) -> P {
    PallasGroup::generator() * *s
}

/// f(x) for the degree-(t-1) polynomial through `pts`.
fn interpolate(pts: &[(S, S)], x: S) -> S {
    let mut acc = <PallasScalarField as Field>::zero();
    for (j, (xj, yj)) in pts.iter().enumerate() {
        let mut l = <PallasScalarField as Field>::one();
        for (m, (xm, _)) in pts.iter().enumerate() {
            if m != j {
                l *= (x - *xm) * <PallasScalarField as Field>::invert(&(*xj - *xm)).unwrap();
            }
        }
        acc += l * *yj;
    }
    acc
}

fn run_dkg() -> Run {
    let ids: Vec<Vec<u8>> = (1..=N).map(|i| identifier_bytes(i).unwrap()).collect();
    let mut r1_secrets = Vec::new();
    let mut r1_wire: Vec<WireItem> = Vec::new();
    for id in &ids {
        let (secret, pkg) = part1_wire(id, N, T).unwrap();
        r1_secrets.push(secret);
        r1_wire.push((id.clone(), pkg));
    }
    // sent[i] = every (recipient, f_i(recipient)) device i sends.
    let mut sent: Vec<Vec<WireItem>> = Vec::new();
    let mut r2_secrets = Vec::new();
    for id in &ids {
        let others: Vec<WireItem> = r1_wire.iter().filter(|(o, _)| o != id).cloned().collect();
        let (s2, out) = part2_wire(r1_secrets.remove(0), &others).unwrap();
        r2_secrets.push(s2);
        sent.push(out);
    }
    let mut key_packages = Vec::new();
    let mut pubkeys = None;
    for (j, id) in ids.iter().enumerate() {
        let incoming: Vec<WireItem> = sent
            .iter()
            .enumerate()
            .filter(|(i, _)| *i != j)
            .flat_map(|(i, out)| {
                out.iter()
                    .filter(|(r, _)| r == id)
                    .map(move |(_, p)| (ids_at(i), p.clone()))
            })
            .collect();
        let others: Vec<WireItem> = r1_wire.iter().filter(|(o, _)| o != id).cloned().collect();
        let (kp, pk) = part3_wire(&r2_secrets[j], &others, &incoming).unwrap();
        key_packages.push(KeyPackage::deserialize(&kp).unwrap());
        let pk = PublicKeyPackage::deserialize(&pk).unwrap();
        if let Some(prev) = &pubkeys {
            assert_eq!(
                prev, &pk,
                "every device derives the same public key package"
            );
        }
        pubkeys = Some(pk);
    }

    // Raw group key from the round-1 broadcasts: the sum of each constant commitment.
    let raw_pk = r1_wire.iter().fold(PallasGroup::identity(), |acc, (_, b)| {
        acc + round1::Package::deserialize(b)
            .unwrap()
            .commitment()
            .coefficients()[0]
            .value()
    });
    // Each f_i from its t evaluations on the wire, then the raw secret and raw shares.
    let polys: Vec<Vec<(S, S)>> = sent
        .iter()
        .map(|out| {
            out.iter()
                .take(T as usize)
                .map(|(r, p)| {
                    let share = round2::Package::deserialize(p).unwrap();
                    (scalar(r), scalar(&share.signing_share().serialize()))
                })
                .collect()
        })
        .collect();
    let zero = <PallasScalarField as Field>::zero();
    let raw_secret = polys.iter().fold(zero, |a, f| a + interpolate(f, zero));
    let raw_shares = ids
        .iter()
        .map(|id| {
            let x = scalar(id);
            let sk = polys.iter().fold(zero, |a, f| a + interpolate(f, x));
            (Identifier::deserialize(id).unwrap(), sk)
        })
        .collect();
    assert_eq!(
        base_mul(&raw_secret),
        raw_pk,
        "the wire rebuilds the raw key"
    );
    Run {
        raw_pk,
        raw_secret,
        raw_shares,
        key_packages,
        pubkeys: pubkeys.unwrap(),
    }
}

fn ids_at(i: usize) -> Vec<u8> {
    identifier_bytes(i as u16 + 1).unwrap()
}

/// The ZIP 312 rule, checked on one DKG output against its raw values. Returns whether the
/// output was negated; an output that follows neither branch whole is an error.
fn check_normalised(
    raw_pk: &P,
    raw_shares: &[(Identifier, S)],
    kps: &[KeyPackage],
    pk: &PublicKeyPackage,
) -> Result<bool, String> {
    let negate = odd_y(raw_pk);
    let sign = |s: S| if negate { -s } else { s };
    let want_pk = if negate { -*raw_pk } else { *raw_pk };
    if pk.verifying_key().to_element() != want_pk {
        return Err("group key".into());
    }
    if odd_y(&pk.verifying_key().to_element()) {
        return Err("the group key has odd y".into());
    }
    for (id, raw) in raw_shares {
        let kp = kps
            .iter()
            .find(|k| k.identifier() == id)
            .ok_or("missing key package")?;
        if kp.verifying_key() != pk.verifying_key() {
            return Err(format!("{id:?}: key package group key"));
        }
        if kp.signing_share().to_scalar() != sign(*raw) {
            return Err(format!("{id:?}: sk_i"));
        }
        let want_pki = base_mul(&sign(*raw));
        if kp.verifying_share().to_element() != want_pki {
            return Err(format!("{id:?}: PK_i in the key package"));
        }
        if pk.verifying_shares().get(id).map(|v| v.to_element()) != Some(want_pki) {
            return Err(format!("{id:?}: PK_i in the public key package"));
        }
    }
    Ok(negate)
}

/// A t-of-n rerandomized signature from `kps`, verified under the package's group key.
fn signs(kps: &[KeyPackage], pubkeys: &PublicKeyPackage) -> bool {
    let group_vk: VerifyingKey = *pubkeys.verifying_key();
    let message = b"konclave: zip 312 normalised key signs";
    let signers: Vec<&KeyPackage> = kps.iter().take(T as usize).collect();
    let mut nonces = Vec::new();
    let mut commitments = Vec::new();
    for kp in &signers {
        let (n, c) = ceremony::participant_round1(kp);
        nonces.push(n);
        commitments.push((kp.identifier().serialize(), c));
    }
    let sp = ceremony::coordinator_signing_package(&commitments, message).unwrap();
    let seed = ceremony::coordinator_randomizer_seed(&group_vk, &sp).unwrap();
    let mut shares = Vec::new();
    for (kp, n) in signers.iter().zip(nonces.iter_mut()) {
        let share = ceremony::participant_round2(&sp, n, kp, &seed, message).unwrap();
        shares.push((kp.identifier().serialize(), share));
    }
    let sig = ceremony::coordinator_aggregate(&sp, &group_vk, &seed, &shares, pubkeys).unwrap();
    ceremony::verify(&group_vk, &sp, &seed, message, &sig).unwrap()
}

/// DKG runs until both parities of the raw key have been seen (each has probability 1/2, so
/// 64 runs miss one with probability 2^-63).
fn one_of_each() -> (Run, Run) {
    let (mut even, mut odd) = (None, None);
    for _ in 0..64 {
        let r = run_dkg();
        if odd_y(&r.raw_pk) {
            odd.get_or_insert(r);
        } else {
            even.get_or_insert(r);
        }
        if even.is_some() && odd.is_some() {
            break;
        }
    }
    (even.expect("an even raw key"), odd.expect("an odd raw key"))
}

#[test]
fn an_odd_raw_key_is_negated_whole_and_an_even_one_is_left() {
    let (even, odd) = one_of_each();
    assert_eq!(
        check_normalised(
            &even.raw_pk,
            &even.raw_shares,
            &even.key_packages,
            &even.pubkeys
        ),
        Ok(false),
        "an even raw key is not negated"
    );
    assert_eq!(
        check_normalised(
            &odd.raw_pk,
            &odd.raw_shares,
            &odd.key_packages,
            &odd.pubkeys
        ),
        Ok(true),
        "an odd raw key gives -PK, every -sk_i and every -PK_i"
    );
    // The group secret behind the output is the negated raw secret.
    assert_eq!(
        VerifyingKey::from(&SigningKey::from_scalar(-odd.raw_secret).unwrap()),
        *odd.pubkeys.verifying_key()
    );
    assert!(
        signs(&even.key_packages, &even.pubkeys),
        "even: the shares sign"
    );
    assert!(
        signs(&odd.key_packages, &odd.pubkeys),
        "odd: the negated shares sign"
    );
}

#[test]
fn the_check_refuses_an_output_that_was_not_negated() {
    let (_, odd) = one_of_each();
    let pk = &odd.pubkeys;
    let kps = &odd.key_packages;
    let check = |kps: &[KeyPackage], pk: &PublicKeyPackage| {
        check_normalised(&odd.raw_pk, &odd.raw_shares, kps, pk)
    };
    assert_eq!(check(kps, pk), Ok(true));

    // What the DKG would give without the ZIP 312 step: the raw key and raw shares.
    let raw_pk = PublicKeyPackage::new(
        odd.raw_shares
            .iter()
            .map(|(id, s)| (*id, VerifyingShare::new(base_mul(s))))
            .collect(),
        VerifyingKey::new(odd.raw_pk),
        pk.min_signers(),
    );
    let raw_kps: Vec<KeyPackage> = odd
        .raw_shares
        .iter()
        .map(|(id, s)| {
            KeyPackage::new(
                *id,
                SigningShare::new(*s),
                VerifyingShare::new(base_mul(s)),
                VerifyingKey::new(odd.raw_pk),
                T,
            )
        })
        .collect();
    assert!(check(&raw_kps, &raw_pk).is_err(), "nothing negated");

    // Only the group key negated (the shares left as they were).
    let half: Vec<KeyPackage> = raw_kps
        .iter()
        .map(|k| {
            KeyPackage::new(
                *k.identifier(),
                *k.signing_share(),
                *k.verifying_share(),
                *pk.verifying_key(),
                T,
            )
        })
        .collect();
    let half_pk = PublicKeyPackage::new(
        raw_pk.verifying_shares().clone(),
        *pk.verifying_key(),
        pk.min_signers(),
    );
    assert!(
        check(&half, &half_pk).is_err(),
        "group key negated, shares not"
    );

    // One share left un-negated among negated ones.
    let mut one = kps.clone();
    let k = &one[0];
    one[0] = KeyPackage::new(
        *k.identifier(),
        SigningShare::new(-k.signing_share().to_scalar()),
        *k.verifying_share(),
        *k.verifying_key(),
        T,
    );
    assert_eq!(
        check(&one, pk),
        Err(format!("{:?}: sk_i", one[0].identifier()))
    );

    // One public share left un-negated in the public key package.
    let mut shares = pk.verifying_shares().clone();
    let id0 = *kps[0].identifier();
    let v = shares[&id0];
    shares.insert(id0, VerifyingShare::new(-v.to_element()));
    let bad_pk = PublicKeyPackage::new(shares, *pk.verifying_key(), pk.min_signers());
    assert_eq!(
        check(kps, &bad_pk),
        Err(format!("{id0:?}: PK_i in the public key package"))
    );

    // And the raw (un-negated) shares do not sign under the normalised key.
    assert!(!signs_or_false(&raw_kps, pk));
}

/// `signs`, but a refusal anywhere in the ceremony counts as not signing.
fn signs_or_false(kps: &[KeyPackage], pubkeys: &PublicKeyPackage) -> bool {
    std::panic::catch_unwind(|| signs(kps, pubkeys)).unwrap_or(false)
}
