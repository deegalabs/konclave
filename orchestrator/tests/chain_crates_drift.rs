//! The epoch table is a hand-kept copy of facts that `zcash_protocol` and `zcash_primitives` already
//! carry (activation height, branch id, transaction format, block spacing, default expiry), and the
//! device and the coordinator both read the copy. Nothing tied the two together: a crate bump that moved
//! one of them left the table saying the old thing, and a device then reasons about the chain with the
//! wrong numbers. These tests are that tie, so a bump of the pinned crates fails here, in CI, instead of
//! being found at an activation height.

use konclave_seal::epochs::{MAINNET, NU6_3, NU7};
use zcash_primitives::transaction::builder::default_tx_expiry_delta;
use zcash_primitives::transaction::fees::zip317;
use zcash_primitives::transaction::TxVersion;
use zcash_protocol::consensus::Network;
use zcash_protocol::consensus::{
    pow_target_spacing, BlockHeight, BranchId, NetworkUpgrade, Parameters, UPGRADES_IN_ORDER,
};

const NET: Network = Network::MainNetwork;

/// Every row of the mainnet table says what the crates say about the upgrade it names.
#[test]
fn every_mainnet_row_matches_the_chain_crates() {
    for row in MAINNET.epochs {
        let nu = UPGRADES_IN_ORDER
            .iter()
            .copied()
            .find(|nu| u32::from(nu.branch_id()) == row.branch_id)
            .unwrap_or_else(|| {
                panic!(
                    "row {:#x} names a branch the crate does not know",
                    row.branch_id
                )
            });
        let branch = nu.branch_id();
        assert_eq!(
            NET.activation_height(nu),
            Some(BlockHeight::from_u32(row.activation_height)),
            "{nu}: activation height"
        );
        let tx = TxVersion::suggested_for_branch(branch);
        assert_eq!(
            tx.header() & 0x7fff_ffff,
            row.tx_version,
            "{nu}: transaction version"
        );
        assert_eq!(
            tx.version_group_id(),
            row.version_group_id,
            "{nu}: version group id"
        );
        assert_eq!(
            pow_target_spacing(&NET, BlockHeight::from_u32(row.activation_height)).as_secs(),
            row.spacing_s as u64,
            "{nu}: block spacing"
        );
        assert_eq!(
            default_tx_expiry_delta(branch),
            row.expiry_delta,
            "{nu}: expiry delta"
        );
    }
}

/// The tripwire. An upgrade the chain crates schedule on mainnet from NU6.3 on must have a row, or a
/// device on this table refuses every transaction of that epoch (and a coordinator that never reads the
/// upgrade builds for the wrong one). It is red the day a crate bump brings in an upgrade the table lacks.
#[test]
fn every_scheduled_upgrade_from_nu6_3_on_has_a_row() {
    let first = NET
        .activation_height(NetworkUpgrade::Nu6_3)
        .expect("NU6.3 is scheduled");
    for nu in UPGRADES_IN_ORDER.iter().copied() {
        let Some(h) = NET.activation_height(nu) else {
            continue;
        };
        if h < first {
            continue;
        }
        assert!(
            MAINNET.epoch_by_branch(u32::from(nu.branch_id())).is_some(),
            "{nu} activates on mainnet at {h:?} and the epoch table has no row for it"
        );
    }
    // And the two ids the table names are the crate's.
    assert_eq!(u32::from(BranchId::Nu6_3), NU6_3);
    assert_eq!(u32::from(BranchId::Nu7), NU7);
}

/// The rows are in activation order, which `epoch_of` and `next_activation_after` rely on.
#[test]
fn the_rows_are_in_activation_order() {
    for pair in MAINNET.epochs.windows(2) {
        assert!(pair[0].activation_height < pair[1].activation_height);
    }
}

/// ZIP 317 is written out in the orchestrator (the fee a proposal is validated against) and in the
/// device (the fee it refuses above). Both are copies; the crate's are the reference.
#[test]
fn the_zip317_constants_the_coordinator_validates_with_are_the_crates() {
    assert_eq!(
        orchestrator::validation::MARGINAL_FEE,
        zip317::MARGINAL_FEE.into_u64()
    );
    assert_eq!(
        orchestrator::validation::GRACE_ACTIONS,
        zip317::GRACE_ACTIONS as u64
    );
}
