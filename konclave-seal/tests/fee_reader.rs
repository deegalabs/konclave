//! The one reader of a PCZT's fee and actions (`fee_and_actions`), read against real vectors whose
//! numbers come from OUTSIDE it: the mainnet txids' fees (docs/PROOF.md) and the transaction shapes
//! the device's own tests pin (`konclave-wasm`: `the_fixture_bundle_has_the_shape_the_fee_rule_reads`).
#![cfg(feature = "pczt")]

use konclave_seal::epochs::{fee_in, MAINNET};
use konclave_seal::spends::{action_count, bundle_fee, fee_and_actions};

const V: &str = "../konclave-wasm/tests/vectors/";
fn read(name: &str) -> pczt::Pczt {
    pczt::Pczt::parse(&std::fs::read(format!("{V}{name}")).expect("vector")).expect("a PCZT")
}

#[test]
fn a_four_action_ironwood_transaction_pays_four_marginal_fees() {
    let p = read("ironwood_single_spend.proven.pczt");
    assert_eq!(fee_and_actions(&p), Ok((20_000, 4)));
    assert_eq!(bundle_fee(&p, true).unwrap().actions, 4);
    assert_eq!(action_count(&p), 4);
}

#[test]
fn a_two_action_orchard_transaction_pays_the_grace_fee() {
    let p = read("orchard_mainnet_dkg_single_spend.proven.pczt");
    assert_eq!(fee_and_actions(&p), Ok((10_000, 2)));
}

#[test]
fn every_real_vector_is_in_the_5000_era_and_no_other_rate_reads_it() {
    // No vector of this repo pays 1,000 a action: none was ever built under ZIP 2009 (the height
    // is 3,590,000 and no wallet has built there). A real 1,000 vector needs a testnet build through
    // a non-deployed example; see the B3b report. What this pins is that the reader gives the
    // numbers the 5,000 rule is checked against, and that the 1,000 rule does not accept them.
    for (name, actions) in [
        ("ironwood_single_spend.proven.pczt", 4),
        ("orchard_mainnet_dkg_single_spend.proven.pczt", 2),
        ("orchard_mainnet_two_spend.proven.pczt", 2),
    ] {
        let (fee, n) = fee_and_actions(&read(name)).unwrap();
        assert_eq!(n, actions, "{name}");
        assert!(fee_in(fee, n, &[5_000]), "{name}");
        assert!(!fee_in(fee, n, &[1_000]), "{name}");
        assert!(fee_in(fee, n, MAINNET.fees[1].accepts), "{name}");
    }
}
