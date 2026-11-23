//! The action bound against every honest vector this repository holds, proven and published copies
//! alike, read with the fee each one paid (`docs/PROOF.md`). This is the test that protects payments:
//! a rule that is one action tighter than the builders are refuses one of these, and a published
//! copy that lost a field the rule reads would refuse every payment through it.
//!
//! The fee each vector paid comes from the reader of fee facts in `konclave-seal`, which has its own
//! test against the txids' fees, not from the function under test.

use konclave_seal::epochs::MAINNET as TABLE;
use konclave_seal::spends::fee_and_actions;
use konclave_wasm::pczt_bridge::{read_payment_with, MAINNET};
use pczt::Pczt;

mod support;
use support::{fvk_in, try_fvk_in};

const V: &str = "tests/vectors/";

fn vector(name: &str) -> Vec<u8> {
    std::fs::read(format!("{V}{name}")).unwrap_or_else(|e| panic!("{name}: {e}"))
}

/// The vault's key for a vector: the one its spends carry, or its proven sibling's when the vector
/// is a published copy (which clears it: the device brings its own).
fn vault_fvk(name: &str) -> Option<orchard::keys::FullViewingKey> {
    try_fvk_in(&vector(&name.replace(".published.", ".proven.")))
}

/// A clock inside the 5,000 era every vector was built in.
const CLOCK: i64 = TABLE.anchor.unix + 30 * 86_400;

/// Every honest vector: name, fee it paid, actions it carries.
const HONEST: &[(&str, u64, u64)] = &[
    ("ironwood_single_spend.proven.pczt", 20_000, 4),
    ("ironwood_single_spend.published.pczt", 20_000, 4),
    ("orchard_mainnet_dkg_single_spend.proven.pczt", 10_000, 2),
    ("orchard_mainnet_two_spend.proven.pczt", 10_000, 2),
    ("orchard_mainnet_two_spend.published.pczt", 10_000, 2),
    ("zf_zcash_sign_ironwood_v6.pczt", 25_000, 5),
];

/// Honest vectors whose spends carry no value: the Foundation's `zcash-sign` fixture. Every copy our
/// coordinator makes, proven or published, carries them.
const NO_SPEND_VALUES: &[&str] = &["zf_zcash_sign_ironwood_v6.pczt"];

#[test]
fn every_honest_vector_reads_at_the_fee_it_paid() {
    for (name, fee, actions) in HONEST {
        let bytes = vector(name);
        let (paid, n) = fee_and_actions(&Pczt::parse(&bytes).unwrap()).unwrap();
        assert_eq!((paid, n), (*fee, *actions), "{name}: the fee facts");
        if NO_SPEND_VALUES.contains(name) {
            // Built by another tool, with no value on its spends: a reading that signs cannot check
            // them and refuses, whatever key it holds. Its fee facts above still hold.
            let e = read_payment_with(&MAINNET, &bytes, CLOCK, None, None).unwrap_err();
            assert!(e.starts_with("[viewingkey]"), "{name}: {e}");
            continue;
        }
        let p = read_payment_with(&MAINNET, &bytes, CLOCK, None, vault_fvk(name).as_ref())
            .unwrap_or_else(|e| panic!("{name} is an honest transaction and must read: {e}"));
        assert_eq!(p.fee_zat, *fee, "{name}");
        assert_eq!(p.actions as u64, *actions, "{name}");
    }
}

#[test]
fn the_real_nu7_testnet_vector_reads_at_its_fee() {
    // 5 actions, one real spend, four of the five outputs change: the wallet's own change split.
    let bytes = vector("nu7_testnet.proven.pczt");
    let (paid, n) = fee_and_actions(&Pczt::parse(&bytes).unwrap()).unwrap();
    assert_eq!(n, 5);
    let clock = TABLE.anchor.unix + 30 * 86_400;
    // The nu7 vector is read against its own table in `nu7_real_vector.rs`; here only the bound:
    // the fee it paid is exact at 5,000 for 5 actions.
    assert_eq!(paid, 25_000);
    let r = read_payment_with(&MAINNET, &bytes, clock, None, Some(&fvk_in(&bytes)));
    // Whatever else the mainnet table says of a testnet transaction, it is not the action bound.
    if let Err(e) = r {
        assert!(!e.contains("actions in one bundle"), "{e}");
    }
}

#[test]
fn a_spend_still_carrying_a_dummy_key_is_refused_by_the_reader() {
    // The refusal came from counting the spends that await a signature; the rule reads the same
    // list, so a simplification of the rule to "values only" must not drop it.
    for name in [
        "ironwood_dummy_sk_spend.proven.pczt",
        "ironwood_dummy_sk_signed.pczt",
    ] {
        let e = read_payment_with(&MAINNET, &vector(name), CLOCK, None, None).unwrap_err();
        assert!(e.starts_with("[dummy]"), "{name}: {e}");
    }
}

#[test]
fn a_spend_value_its_nullifier_does_not_open_to_is_refused() {
    // `ironwood_zero_value_spend.proven.pczt` is the main vector with one spend's value field set to
    // zero and nothing else changed (the lib tests use it for the spend list). The nullifier the
    // action carries is that of the real note, so the field is not what the transaction carries:
    // refused, not counted as zero. The key is the vault's, from the main vector.
    let e = read_payment_with(
        &MAINNET,
        &vector("ironwood_zero_value_spend.proven.pczt"),
        CLOCK,
        None,
        vault_fvk("ironwood_single_spend.proven.pczt").as_ref(),
    )
    .unwrap_err();
    assert!(e.starts_with("[commitment]"), "{e}");
}

/// The spend values a vector's Ironwood bundle carries, in action order (`None` for no value), or
/// `None` when the bytes do not parse.
fn ironwood_spend_values(bytes: &[u8]) -> Option<Vec<Option<u64>>> {
    use pczt::roles::low_level_signer::{OrchardParseError, Signer};
    struct E;
    impl From<OrchardParseError> for E {
        fn from(_: OrchardParseError) -> Self {
            E
        }
    }
    let mut values = vec![];
    Signer::new(Pczt::parse(bytes).ok()?)
        .sign_ironwood_with(|_, b, _| {
            values = b
                .actions()
                .iter()
                .map(|a| a.spend().value().map(|v| v.inner()))
                .collect();
            Ok::<(), E>(())
        })
        .ok()?;
    Some(values)
}

/// The main vector with every spend's value field set to zero and nothing else changed (the way
/// `ironwood_zero_value_spend.proven.pczt` was made for one spend). A value is written
/// `01 || LEB128(value)` and becomes `01 00`; since the same run can stand for another field (an
/// output's value), a replacement is kept only when it reads back as exactly one spend's value
/// going to zero and every other spend unchanged.
fn every_spend_value_zeroed(bytes: &[u8]) -> Vec<u8> {
    let mut out = bytes.to_vec();
    loop {
        let now = ironwood_spend_values(&out).expect("the vector parses");
        let Some((idx, v)) = now
            .iter()
            .enumerate()
            .find_map(|(i, v)| v.filter(|v| *v != 0).map(|v| (i, v)))
        else {
            return out;
        };
        let mut run = vec![1u8];
        let mut x = v;
        loop {
            let b = (x & 0x7f) as u8;
            x >>= 7;
            if x == 0 {
                run.push(b);
                break;
            }
            run.push(b | 0x80);
        }
        let mut want = now.clone();
        want[idx] = Some(0);
        let found = (0..out.len().saturating_sub(run.len()))
            .filter(|i| out[*i..*i + run.len()] == run[..])
            .map(|i| {
                let mut p = out.clone();
                p.splice(i..i + run.len(), [1u8, 0u8]);
                p
            })
            .find(|p| ironwood_spend_values(p).as_ref() == Some(&want));
        out = found
            .unwrap_or_else(|| panic!("spend {idx}'s value {v} is not where a value is written"));
    }
}

#[test]
fn a_spend_that_declares_no_value_is_refused_without_a_key() {
    // Every awaiting spend declares zero. With no key the device cannot check that a zero is what
    // the note holds, so it signs nothing, as for any other value: a zero is a claim like any other.
    let bytes = every_spend_value_zeroed(&vector("ironwood_single_spend.proven.pczt"));
    let e = read_payment_with(&MAINNET, &bytes, CLOCK, None, None).unwrap_err();
    assert!(e.starts_with("[viewingkey]"), "{e}");
    // With the vault's key the zeros are checked, and they are not what the notes hold.
    let e = read_payment_with(
        &MAINNET,
        &bytes,
        CLOCK,
        None,
        vault_fvk("ironwood_single_spend.proven.pczt").as_ref(),
    )
    .unwrap_err();
    assert!(e.starts_with("[commitment]"), "{e}");
}

#[test]
fn the_published_vectors_read_with_the_vaults_key_and_without_one_they_do_not() {
    // These vectors carry no spend key, and the reading binds a spend's value with the vault's key.
    // Without that key it refuses, with its own code, not as a fee.
    for name in [
        "ironwood_single_spend.published.pczt",
        "orchard_mainnet_two_spend.published.pczt",
    ] {
        let bytes = vector(name);
        read_payment_with(&MAINNET, &bytes, CLOCK, None, vault_fvk(name).as_ref()).expect(name);
        let e = read_payment_with(&MAINNET, &bytes, CLOCK, None, None).unwrap_err();
        assert!(e.starts_with("[viewingkey]"), "{name}: {e}");
    }
}

/// A copy with every spend's value removed: what a coordinator that leaves the value out sends. The
/// value is outside the sighash, so removing it changes no signature, and the bytes still parse.
fn without_spend_values(bytes: &[u8]) -> Vec<u8> {
    pczt::roles::redactor::Redactor::new(Pczt::parse(bytes).unwrap())
        .redact_orchard_with(|mut b| b.redact_actions(|mut a| a.clear_spend_value()))
        .redact_ironwood_with(|mut b| b.redact_actions(|mut a| a.clear_spend_value()))
        .finish()
        .serialize()
        .unwrap()
}

#[test]
fn a_spend_awaiting_a_signature_with_no_value_is_refused_with_or_without_a_key() {
    // A spend with no value cannot be checked against its nullifier, and a device that counted it as
    // nothing would sign a spend it never verified. With the vault's key it is refused as a reading
    // not bound to what the transaction carries; with none, as a key the device lacks.
    for name in [
        "ironwood_single_spend.published.pczt",
        "orchard_mainnet_two_spend.published.pczt",
        "orchard_mainnet_two_spend.proven.pczt",
    ] {
        let bytes = without_spend_values(&vector(name));
        let e =
            read_payment_with(&MAINNET, &bytes, CLOCK, None, vault_fvk(name).as_ref()).unwrap_err();
        assert!(e.starts_with("[commitment]"), "{name} with the key: {e}");
        let e = read_payment_with(&MAINNET, &bytes, CLOCK, None, None).unwrap_err();
        assert!(e.starts_with("[viewingkey]"), "{name} without a key: {e}");
    }
}

#[test]
fn a_key_that_is_not_the_vaults_only_refuses_the_vectors() {
    // Another vault's key: the spends are not under it, whether the copy still carries its own key
    // (mismatch) or not (the note's address is not one this key scopes).
    let other = support::Key::new(77).fvk;
    for name in [
        "ironwood_single_spend.proven.pczt",
        "ironwood_single_spend.published.pczt",
        "orchard_mainnet_two_spend.proven.pczt",
        "orchard_mainnet_two_spend.published.pczt",
    ] {
        let e = read_payment_with(&MAINNET, &vector(name), CLOCK, None, Some(&other)).unwrap_err();
        assert!(e.starts_with("[commitment]"), "{name}: {e}");
    }
}
