//! The destination decoder, read against the SAME proven vectors konclave-wasm's `ua_receiver`
//! tests use: the address a person typed (the output's `user_address`, set by an Updater) must
//! decode to the receiver the prover bound into the note (`recipient`). Both come from real sends
//! (the Orchard vectors on mainnet, the Ironwood one on testnet); neither is produced by the code
//! under test.
#![cfg(all(feature = "receivers", feature = "pczt"))]

mod support;
use konclave_seal::destination::{orchard_receiver, NetworkType};
use support::{with_bundle, Pool};

const V: &str = "../konclave-wasm/tests/vectors/";

/// (user_address, recipient) of every labelled output of a vector's bundle in `pool`.
fn labelled(name: &str, pool: Pool) -> Vec<(String, [u8; 43])> {
    let bytes = std::fs::read(format!("{V}{name}")).expect("vector");
    with_bundle(&bytes, pool, |b| {
        b.actions()
            .iter()
            .filter_map(|a| {
                let o = a.output();
                let ua = o.user_address().clone()?;
                let r = o.recipient().as_ref()?.to_raw_address_bytes();
                Some((ua, r))
            })
            .collect()
    })
}

#[test]
fn it_reproduces_what_the_prover_bound_into_the_note() {
    let mut seen = 0;
    // The Ironwood vector is a testnet send; the two Orchard vectors are mainnet sends.
    for (name, pool, net) in [
        (
            "ironwood_single_spend.proven.pczt",
            Pool::Ironwood,
            NetworkType::Test,
        ),
        (
            "orchard_mainnet_dkg_single_spend.proven.pczt",
            Pool::Orchard,
            NetworkType::Main,
        ),
        (
            "orchard_mainnet_two_spend.proven.pczt",
            Pool::Orchard,
            NetworkType::Main,
        ),
    ] {
        for (ua, recipient) in labelled(name, pool) {
            assert_eq!(
                orchard_receiver(&ua, net),
                Ok(recipient),
                "{name}: the decoded receiver must be the one in the note"
            );
            seen += 1;
        }
    }
    assert_eq!(seen, 3, "one labelled output in each of the three vectors");
}

#[test]
fn it_refuses_what_a_shielded_vault_cannot_pay() {
    for bad in ["", "not an address"] {
        assert!(orchard_receiver(bad, NetworkType::Main).is_err(), "{bad:?}");
    }
    // A real transparent address (valid checksum): it decodes, and has no Orchard receiver.
    let t = orchard_receiver("t1Hsc1LR8yKnbbe3twRp88p6vFfC5t7DLbs", NetworkType::Main).unwrap_err();
    assert!(t.starts_with("no Orchard receiver"), "{t}");
}

/// A testnet unified address WITHOUT an Orchard receiver (orchestrator/src/address.rs tests).
const TESTNET_UA_NO_ORCHARD: &str = "utest10c5kutapazdnf8ztl3pu43nkfsjx89fy3uuff8tsmxm6s86j37pe7uz94z5jhkl49pqe8yz75rlsaygexk6jpaxwx0esjr8wm5ut7d5s";

fn one(name: &str, pool: Pool) -> (String, [u8; 43]) {
    labelled(name, pool).pop().expect("a labelled output")
}

#[test]
fn it_refuses_an_address_of_another_network() {
    // The address of a testnet send, read as mainnet, and the reverse.
    let (test_ua, test_r) = one("ironwood_single_spend.proven.pczt", Pool::Ironwood);
    assert_eq!(orchard_receiver(&test_ua, NetworkType::Test), Ok(test_r));
    let refused = orchard_receiver(&test_ua, NetworkType::Main).unwrap_err();
    assert!(refused.contains("not Main"), "{refused}");
    let (main_ua, main_r) = one("orchard_mainnet_two_spend.proven.pczt", Pool::Orchard);
    assert_eq!(orchard_receiver(&main_ua, NetworkType::Main), Ok(main_r));
    assert!(orchard_receiver(&main_ua, NetworkType::Test).is_err());
}

#[test]
fn it_refuses_a_unified_address_with_no_orchard_receiver() {
    assert!(orchard_receiver(TESTNET_UA_NO_ORCHARD, NetworkType::Test).is_err());
}

#[test]
fn surrounding_whitespace_is_ignored_as_the_wasm_decoder_does() {
    // zcash_address trims too; this pins the behaviour, not who provides it.
    let (ua, r) = one("orchard_mainnet_two_spend.proven.pczt", Pool::Orchard);
    assert_eq!(
        orchard_receiver(&format!("  {ua}\n"), NetworkType::Main),
        Ok(r)
    );
}
