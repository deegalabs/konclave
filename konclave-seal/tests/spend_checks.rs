//! Each spend a device signs is checked against the vault's key (`spends_to_sign_for`). Keys here
//! are literals or seeded test keys; none is read back from the PCZT under test.
#![cfg(feature = "pczt")]

mod support;
use konclave_seal::hex::decode_exact;
use support::{check, patch_once, rekey, rks, test_ak, Pool};

const V: &str = "../konclave-wasm/tests/vectors/";
fn vector(name: &str) -> Vec<u8> {
    std::fs::read(format!("{V}{name}")).expect("vector")
}
fn ak(hex: &str) -> [u8; 32] {
    decode_exact(hex).unwrap()
}

/// A real vector rewritten for a seeded key, with that key.
fn rekeyed() -> (Vec<u8>, [u8; 32]) {
    let ak = test_ak(7);
    (
        rekey(
            &vector("ironwood_single_spend.proven.pczt"),
            Pool::Ironwood,
            &ak,
        ),
        ak,
    )
}

#[test]
fn a_bundle_built_for_the_vault_key_passes_and_selects_what_the_old_rule_selects() {
    let (pczt, key) = rekeyed();
    let spends = check(&pczt, Pool::Ironwood, &key).unwrap();
    assert_eq!(spends.len(), 4);
    let plain = support::with_bundle(&pczt, Pool::Ironwood, |b| {
        konclave_seal::spends::spends_to_sign(b).unwrap()
    });
    assert_eq!(spends, plain);
}

#[test]
fn a_spend_whose_key_is_not_the_vaults_under_its_randomizer_is_refused() {
    let (pczt, key) = rekeyed();
    let r = rks(&pczt, Pool::Ironwood, &key);
    // Swap two spends' keys: both are valid points, each is wrong under its own randomizer.
    let tmp = [9u8; 32];
    let p = patch_once(&pczt, &r[0].0, &tmp);
    let p = patch_once(&p, &r[1].0, &r[0].0);
    let p = patch_once(&p, &tmp, &r[1].0);
    assert!(check(&p, Pool::Ironwood, &key)
        .unwrap_err()
        .starts_with("[rk]"));
}

#[test]
fn a_spend_under_another_key_is_refused_even_when_it_carries_no_value() {
    // The zero-value spend a builder pairs with a payment is the vault's to sign like any other.
    let key = test_ak(7);
    let z = vector("ironwood_zero_value_spend.proven.pczt");
    let pczt = rekey(&z, Pool::Ironwood, &key);
    let other = rks(&z, Pool::Ironwood, &test_ak(8));
    let mine = rks(&pczt, Pool::Ironwood, &key);
    let p = patch_once(&pczt, &mine[1].0, &other[1].2);
    assert!(check(&p, Pool::Ironwood, &key)
        .unwrap_err()
        .starts_with("[rk]"));
}

#[test]
fn a_spend_with_an_empty_randomizer_is_refused() {
    let (pczt, key) = rekeyed();
    let r = rks(&pczt, Pool::Ironwood, &key);
    // Its key is consistent with the empty value (it is `ak` itself), so only this check sees it.
    let p = patch_once(&pczt, &r[1].1, &[0u8; 32]);
    let p = patch_once(&p, &r[1].0, &key);
    assert!(check(&p, Pool::Ironwood, &key)
        .unwrap_err()
        .starts_with("[alpha]"));
}

#[test]
fn two_spends_sharing_a_randomizer_are_refused() {
    let (pczt, key) = rekeyed();
    let r = rks(&pczt, Pool::Ironwood, &key);
    let p = patch_once(&pczt, &r[1].1, &r[0].1);
    let p = patch_once(&p, &r[1].0, &r[0].0);
    let e = check(&p, Pool::Ironwood, &key).unwrap_err();
    assert!(e.starts_with("[alpha]") && e.contains("share"), "{e}");
}

#[test]
fn another_vaults_key_refuses_and_an_unusable_key_refuses() {
    let (pczt, _) = rekeyed();
    let e = check(&pczt, Pool::Ironwood, &test_ak(8)).unwrap_err();
    assert!(e.starts_with("[rk]"), "{e}");
    for bad in [[0u8; 32], [0xff; 32]] {
        let e = check(&pczt, Pool::Ironwood, &bad).unwrap_err();
        assert!(e.starts_with("[vaultkey]"), "{e}");
    }
}

#[test]
fn the_dummy_rule_is_unchanged_and_answers_first() {
    let d = vector("ironwood_dummy_sk_spend.proven.pczt");
    let plain = support::with_bundle(&d, Pool::Ironwood, |b| {
        konclave_seal::spends::spends_to_sign(b).unwrap_err()
    });
    assert!(plain.starts_with("[dummy]"));
    // Whatever key is given, even an unusable one, the dummy refusal is the one a member gets.
    assert_eq!(check(&d, Pool::Ironwood, &[0u8; 32]).unwrap_err(), plain);
}

// Real vectors, each with the key of the vault it came from as a LITERAL. Where the repo records
// the vault (docs/HISTORY.md) the literal is that group key; the Ironwood and ZF vectors record
// none, so theirs was computed once, offline, and is pinned here.
#[test]
fn real_vectors_pass_with_their_own_vault_key_and_refuse_another() {
    let cases: [(&str, Pool, &str); 5] = [
        (
            "ironwood_single_spend.proven.pczt",
            Pool::Ironwood,
            "0a05787d30adc74909647d026a9034bf86399363ba230189cd187869d2935e1b",
        ),
        (
            "ironwood_zero_value_spend.proven.pczt",
            Pool::Ironwood,
            "0a05787d30adc74909647d026a9034bf86399363ba230189cd187869d2935e1b",
        ),
        // The evidence vault, group `a25c53f7...` (docs/HISTORY.md, Phase 5).
        (
            "orchard_mainnet_two_spend.proven.pczt",
            Pool::Orchard,
            "a25c53f7bf9a6f68b8b105503b23e6e22dd4033b00f5f9e6bb35b4bcd709a73a",
        ),
        // The DKG vault, group `6b207009...` (docs/HISTORY.md, Phase 11); action 0 is a signed pad.
        (
            "orchard_mainnet_dkg_single_spend.proven.pczt",
            Pool::Orchard,
            "6b207009592233c7ab835765f35093ed357380589a4380a4d0cfd3c9d0c00c0b",
        ),
        // The Foundation's fixture: one action awaits a signature, the other four are signed.
        (
            "zf_zcash_sign_ironwood_v6.pczt",
            Pool::Ironwood,
            "8a808fce4c4d811b2e94caefb96eb36c6aadf4c435488f39ccb6986ff33e8439",
        ),
    ];
    for (name, pool, key) in cases {
        let pczt = vector(name);
        let spends = check(&pczt, pool, &ak(key)).unwrap_or_else(|e| panic!("{name}: {e}"));
        assert!(!spends.is_empty(), "{name}");
        let e = check(&pczt, pool, &test_ak(7)).unwrap_err();
        assert!(e.starts_with("[rk]"), "{name}: {e}");
    }
}
