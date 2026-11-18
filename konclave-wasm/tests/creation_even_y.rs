// ZIP 312 key negation checked on what `creation::Creation` itself hands the app (its group key,
// key packages and public key package), with both parities of the raw key reached. The raw key is
// rebuilt from the revealed round-1 packages alone, never from the output under test. The negation
// is FROST's (inside `part3`, reached through `dkg::part3_wire`); this covers what Creation does
// with the result, which `dkg_even_y.rs` does not read.
use konclave_seal as seal;
use konclave_wasm::ceremony;
use konclave_wasm::creation::Creation;
use reddsa::frost::redpallas::keys::dkg::round1;
use reddsa::frost::redpallas::keys::{KeyPackage, PublicKeyPackage};
use reddsa::frost::redpallas::{Group, PallasGroup, VerifyingKey};

type P = <PallasGroup as Group>::Element;
const N: u16 = 3;
const T: u16 = 2;

fn odd_y(p: &P) -> bool {
    PallasGroup::serialize(p).unwrap()[31] & 0x80 != 0
}

struct Out {
    raw: P,
    group_vk: Vec<u8>,
    kps: Vec<KeyPackage>,
    pk: PublicKeyPackage,
}

fn run() -> Out {
    let secrets: Vec<[u8; 32]> = (0..N)
        .map(|_| seal::DeviceKey::generate().secret_bytes())
        .collect();
    let mut cs: Vec<Creation> = (1..=N)
        .map(|s| Creation::new(&secrets[s as usize - 1], s, N, T, &format!("m{s}")).unwrap())
        .collect();
    let ann: Vec<_> = cs
        .iter()
        .enumerate()
        .map(|(i, c)| {
            (
                i as u16 + 1,
                seal::DeviceKey::from_secret_bytes(&secrets[i]).public_bytes(),
                c.my_commitment(),
                c.my_reveal(),
            )
        })
        .collect();
    for c in cs.iter_mut() {
        for (s, pk, cm, _) in &ann {
            c.add_member(*s, pk, &format!("m{s}"), cm).unwrap();
        }
        for (s, _, _, (r1, n)) in &ann {
            c.add_reveal(*s, r1, n).unwrap();
        }
    }
    let codes: Vec<String> = cs
        .iter_mut()
        .map(|c| c.freeze(b"room", "quorum", "v", "m1", 1).unwrap())
        .collect();
    for c in cs.iter_mut() {
        c.confirm(&codes[0]).unwrap();
    }
    let mut boxes = Vec::new();
    for (i, c) in cs.iter_mut().enumerate() {
        for (to, b) in c.part2().unwrap() {
            boxes.push((i as u16 + 1, to, b));
        }
    }
    for (from, to, b) in boxes {
        cs[to as usize - 1].add_round2(from, &b).unwrap();
    }
    // Raw key from the revealed round-1 packages alone, never from the output under test.
    let raw = ann
        .iter()
        .fold(PallasGroup::identity(), |a, (_, _, _, (r1, _))| {
            a + round1::Package::deserialize(r1)
                .unwrap()
                .commitment()
                .coefficients()[0]
                .value()
        });
    let pk = PublicKeyPackage::deserialize(&cs[0].pubkeys()).unwrap();
    for c in &cs {
        assert!(c.done());
        assert_eq!(c.group_vk(), cs[0].group_vk());
        assert_eq!(PublicKeyPackage::deserialize(&c.pubkeys()).unwrap(), pk);
    }
    Out {
        raw,
        group_vk: cs[0].group_vk(),
        kps: cs
            .iter()
            .map(|c| KeyPackage::deserialize(&c.key_package()).unwrap())
            .collect(),
        pk,
    }
}

fn signs(kps: &[KeyPackage], pk: &PublicKeyPackage, vk: &VerifyingKey) -> bool {
    let msg = b"creation: zip 312";
    let signers: Vec<&KeyPackage> = kps.iter().take(T as usize).collect();
    let mut nonces = Vec::new();
    let mut comms = Vec::new();
    for kp in &signers {
        let (n, c) = ceremony::participant_round1(kp);
        nonces.push(n);
        comms.push((kp.identifier().serialize(), c));
    }
    let sp = ceremony::coordinator_signing_package(&comms, msg).unwrap();
    let seed = ceremony::coordinator_randomizer_seed(vk, &sp).unwrap();
    let mut shares = Vec::new();
    for (kp, n) in signers.iter().zip(nonces.iter_mut()) {
        shares.push((
            kp.identifier().serialize(),
            ceremony::participant_round2(&sp, n, kp, &seed, msg).unwrap(),
        ));
    }
    let sig = ceremony::coordinator_aggregate(&sp, vk, &seed, &shares, pk).unwrap();
    ceremony::verify(vk, &sp, &seed, msg, &sig).unwrap()
}

#[test]
fn creation_normalises_an_odd_raw_key_and_its_shares_sign() {
    let (mut saw_even, mut saw_odd) = (false, false);
    for _ in 0..64 {
        let o = run();
        let odd = odd_y(&o.raw);
        let vk = VerifyingKey::deserialize(&o.group_vk).unwrap();
        let want = if odd { -o.raw } else { o.raw };
        assert_eq!(
            vk.to_element(),
            want,
            "group_vk is -raw iff raw is odd (odd={odd})"
        );
        assert!(!odd_y(&vk.to_element()), "group_vk has even y");
        assert_eq!(&vk, o.pk.verifying_key(), "group_vk is the package's key");
        for kp in &o.kps {
            assert_eq!(kp.verifying_key(), &vk);
            assert_eq!(
                o.pk.verifying_shares().get(kp.identifier()),
                Some(kp.verifying_share())
            );
        }
        assert!(signs(&o.kps, &o.pk, &vk), "shares sign (odd={odd})");
        saw_odd |= odd;
        saw_even |= !odd;
        if saw_odd && saw_even {
            return;
        }
    }
    panic!("did not see both parities in 64 runs");
}
