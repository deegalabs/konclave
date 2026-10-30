//! A REAL NU7 transaction (testnet, 2026-10-26) through the device's own checks.
//!
//! The vector is a throwaway wallet's own 0.1 TAZ self-payment, built and proven by the patched
//! devtool while the testnet was past NU7: branch 0x77190AD9, one real spend. Public data only.
//!
//! In production the device has only the mainnet table, so there is nothing to read this with. Here a
//! table that exists only in this file stands in: NU7 as the testnet runs it (activation 4,465,026),
//! anchored a few blocks before the vector's own target so that a made-up clock reads its window. The
//! test is in its own file, not in lib.rs, so that adding it does not move a line of the module and
//! the committed `wasm-pkg` stays what the source builds.

use konclave_seal::epochs::Anchor;
use konclave_wasm::pczt_bridge::{read_for_signing_with, Epoch, NetworkRules, MAINNET};
use pczt::Pczt;

const NU7_TESTNET: &[u8] = include_bytes!("vectors/nu7_testnet.proven.pczt");
const NU7_BRANCH: u32 = 0x7719_0ad9;
const ANCHOR_UNIX: i64 = 1_800_000_000;

static TESTNET_NU7_ROWS: [Epoch; 1] = [Epoch {
    activation_height: 4_465_026,
    branch_id: NU7_BRANCH,
    tx_version: 6,
    version_group_id: 0xD884_B698,
    spacing_s: 25,
    expiry_delta: 120,
}];

fn expiry_of_vector() -> u32 {
    *Pczt::parse(NU7_TESTNET).unwrap().global().expiry_height()
}

fn testnet_rules(expiry: u32) -> NetworkRules {
    NetworkRules {
        epochs: &TESTNET_NU7_ROWS,
        anchor: Anchor {
            height: expiry - 130,
            unix: ANCHOR_UNIX,
        },
    }
}

#[test]
fn the_device_reads_a_real_nu7_testnet_transaction_through_every_check() {
    let pczt = Pczt::parse(NU7_TESTNET).unwrap();
    assert_eq!(*pczt.global().consensus_branch_id(), NU7_BRANCH);
    assert_eq!(*pczt.global().tx_version(), 6);
    let expiry = expiry_of_vector();
    // A clock whose estimate is the vector's own target (the expiry is 120 blocks past it).
    let got = read_for_signing_with(&testnet_rules(expiry), NU7_TESTNET, ANCHOR_UNIX + 25 * 10)
        .expect("the device reads a real NU7 transaction");
    assert_eq!(got.branch_id, NU7_BRANCH);
    assert_eq!(got.expiry_height, expiry);
    // The signer (pczt 0.10) holds the same value for the same transaction.
    assert_eq!(
        hex::encode(got.sighash),
        "e7002fa86ed26a033d10bbcb25dc19fd3daf0dd64c5b4028ac9af83092bd8392"
    );
}

#[test]
fn the_device_refuses_a_real_nu7_transaction_on_the_wrong_clock_or_the_wrong_table() {
    let expiry = expiry_of_vector();
    // The mainnet table: the expiry is far past anything its window allows.
    assert!(read_for_signing_with(&MAINNET, NU7_TESTNET, 1_793_892_293 + 3_600).is_err());
    // The testnet table with a clock a month late: the expiry is long past by that clock.
    let rules = testnet_rules(expiry);
    assert!(read_for_signing_with(&rules, NU7_TESTNET, ANCHOR_UNIX + 30 * 86_400).is_err());
    // And one before its anchor confirms nothing.
    assert!(read_for_signing_with(&rules, NU7_TESTNET, ANCHOR_UNIX - 30 * 86_400).is_err());
}
