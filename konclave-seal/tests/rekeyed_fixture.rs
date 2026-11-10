//! The signing fixture the UI's ceremony tests use: a seeded 2-of-3 vault and the repo's Ironwood
//! vector with every spend's `rk` rewritten for that vault's group key. The vector's own key is a
//! different vault's, so a ceremony run on it with a freshly made key would (rightly) be refused.
//! Regenerate with `cargo test -p konclave-seal --all-features --test rekeyed_fixture -- --ignored`.
#![cfg(feature = "pczt")]

mod support;
use rand_chacha::{rand_core::SeedableRng, ChaCha8Rng};
use reddsa::frost::redpallas::keys::{generate_with_dealer, IdentifierList, KeyPackage};
use support::{rekey, rks, Pool};

const PATH: &str = "../konclave-wasm/tests/vectors/ironwood_single_spend.rekeyed.json";

fn hex(b: &[u8]) -> String {
    b.iter().map(|x| format!("{x:02x}")).collect()
}

/// One seeded vault of `t` of `n`, with the vector rewritten for its group key.
fn vault(t: u16, n: u16, seed: u64, extras: bool) -> (String, [u8; 32], Vec<u8>) {
    let mut rng = ChaCha8Rng::seed_from_u64(seed);
    let (shares, pk) = generate_with_dealer(n, t, IdentifierList::Default, &mut rng).unwrap();
    let kps: Vec<String> = shares
        .into_values()
        .map(|s| {
            format!(
                "\"{}\"",
                hex(&KeyPackage::try_from(s).unwrap().serialize().unwrap())
            )
        })
        .collect();
    let group_vk: [u8; 32] = pk.verifying_key().serialize().unwrap().try_into().unwrap();
    let vector =
        std::fs::read("../konclave-wasm/tests/vectors/ironwood_single_spend.proven.pczt").unwrap();
    let pczt = rekey(&vector, Pool::Ironwood, &group_vk);
    // The 2-of-3 vault also carries what the machine tests need beyond the one vector: the key
    // its first spend must have to carry an empty randomizer (the group key itself), and the key
    // that spend has now, and a second transaction (another payment) built for the same vault.
    let extra = if extras {
        let rk0 = rks(&vector, Pool::Ironwood, &group_vk)[0].2;
        let other =
            std::fs::read("../konclave-wasm/tests/vectors/zf_zcash_sign_ironwood_v6.pczt").unwrap();
        format!(
            ",\n    \"rk0\": \"{}\",\n    \"other\": \"{}\"",
            hex(&rk0),
            hex(&rekey(&other, Pool::Ironwood, &group_vk))
        )
    } else {
        String::new()
    };
    let json = format!(
        "{{\n    \"groupVk\": \"{}\",\n    \"pubkeys\": \"{}\",\n    \"keyPackages\": [{}],\n    \"pczt\": \"{}\"{extra}\n  }}",
        hex(&group_vk),
        hex(&pk.serialize().unwrap()),
        kps.join(", "),
        hex(&pczt)
    );
    (json, group_vk, pczt)
}

fn build() -> String {
    let a = vault(2, 3, 0x6b63_5f66_6978, true).0;
    let b = vault(3, 4, 0x6b63_5f66_6979, false).0;
    format!("{{\n  \"2of3\": {a},\n  \"3of4\": {b}\n}}\n")
}

#[test]
#[ignore]
fn regenerate() {
    std::fs::write(PATH, build()).unwrap();
}

#[test]
fn the_committed_fixture_is_what_the_generator_makes() {
    assert_eq!(std::fs::read_to_string(PATH).unwrap(), build());
}

#[test]
fn each_fixture_vault_signs_its_pczt_under_its_own_key_and_not_another() {
    // The seeded vaults' group keys, as literals: nothing here is read back from a PCZT.
    for (t, n, seed, vk) in [
        (
            2,
            3,
            0x6b63_5f66_6978,
            "d65a5af38aa554969843dc0fba8113043c09513fdd22a477d9a7b7ff5b89db35",
        ),
        (
            3,
            4,
            0x6b63_5f66_6979,
            "28a52531ad8d23ff9aa4a2c6dbd3b4b6a2e692a40c835f4a6f0a5e1ac72f5734",
        ),
    ] {
        let (json, group_vk, pczt) = vault(t, n, seed, t == 2);
        assert_eq!(hex(&group_vk), vk);
        assert!(std::fs::read_to_string(PATH).unwrap().contains(&json));
        let vk: [u8; 32] = konclave_seal::hex::decode_exact(vk).unwrap();
        assert_eq!(support::check(&pczt, Pool::Ironwood, &vk).unwrap().len(), 4);
        assert!(support::check(&pczt, Pool::Ironwood, &support::test_ak(7)).is_err());
    }
}
