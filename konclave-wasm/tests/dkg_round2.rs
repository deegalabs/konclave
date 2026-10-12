// Consistency of a DKG run over the wire bytes: the round-2 evaluations each device emits,
// interpolated at zero and summed, give the group key every device derives. A check on the
// arithmetic of the ceremony's wire format, independent of the relay and the UI.
use konclave_wasm::dkg::{identifier_bytes, part1_wire, part2_wire, part3_wire, WireItem};
use reddsa::frost::redpallas::keys::dkg::round2;
use reddsa::frost::redpallas::keys::PublicKeyPackage;
use reddsa::frost::redpallas::{Field, PallasScalarField, SigningKey, VerifyingKey};

#[test]
fn round2_packages_are_consistent_with_the_group_key() {
    type S = <PallasScalarField as Field>::Scalar;
    let scalar = |b: &[u8]| SigningKey::deserialize(b).unwrap().to_scalar();

    let (n, t) = (3u16, 2u16);
    let ids: Vec<Vec<u8>> = (1..=n).map(|i| identifier_bytes(i).unwrap()).collect();
    let mut r1_secrets = Vec::new();
    let mut r1_wire: Vec<WireItem> = Vec::new();
    for id in &ids {
        let (secret, pkg) = part1_wire(id, n, t).unwrap();
        r1_secrets.push(secret);
        r1_wire.push((id.clone(), pkg));
    }
    // packages[i] = every (recipient, f_i(recipient)) device i sends.
    let mut packages: Vec<Vec<WireItem>> = Vec::new();
    let mut r2_secrets = Vec::new();
    for id in &ids {
        let others: Vec<WireItem> =
            r1_wire.iter().filter(|(o, _)| o != id).cloned().collect();
        let (s2, out) = part2_wire(r1_secrets.remove(0), &others).unwrap();
        r2_secrets.push(s2);
        packages.push(out);
    }
    let group_vk = {
        let incoming: Vec<WireItem> = packages
            .iter()
            .enumerate()
            .filter(|(i, _)| *i != 0)
            .flat_map(|(i, out)| {
                out.iter()
                    .filter(|(r, _)| *r == ids[0])
                    .map(move |(_, p)| (identifier_bytes(i as u16 + 1).unwrap(), p.clone()))
            })
            .collect();
        let others: Vec<WireItem> =
            r1_wire.iter().filter(|(o, _)| *o != ids[0]).cloned().collect();
        let (_kp, pk) = part3_wire(&r2_secrets[0], &others, &incoming).unwrap();
        PublicKeyPackage::deserialize(&pk).unwrap().verifying_key().serialize().unwrap()
    };

    // Interpolate each f_i at 0 from its t evaluations, and add the constant terms.
    let mut secret = <PallasScalarField as Field>::zero();
    for out in &packages {
        let pts: Vec<(S, S)> = out
            .iter()
            .take(t as usize)
            .map(|(r, p)| {
                let share = round2::Package::deserialize(p).unwrap();
                (scalar(r), scalar(&share.signing_share().serialize()))
            })
            .collect();
        for (j, (xj, yj)) in pts.iter().enumerate() {
            let mut l = <PallasScalarField as Field>::one();
            for (m, (xm, _)) in pts.iter().enumerate() {
                if m != j {
                    l *= *xm * <PallasScalarField as Field>::invert(&(*xm - *xj)).unwrap();
                }
            }
            secret += l * *yj;
        }
    }
    // RedPallas DKG normalises the group key to an even y (ZIP 312), negating the shares
    // when needed, so the group secret is the sum or its negation: holding one is holding both.
    let vk = |s: S| VerifyingKey::from(&SigningKey::from_scalar(s).unwrap()).serialize().unwrap();
    let neg = <PallasScalarField as Field>::zero() - secret;
    assert!(vk(secret) == group_vk || vk(neg) == group_vk, "the packages rebuild the group key");
}
