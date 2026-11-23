//! The action bound (`spends::check_action_bound`), read at the level of its rule: what a bundle
//! of a given shape may carry, with the numbers written here from the ZIP 317 fees and from the
//! upstream builder (`orchard::builder::BundleType::num_actions`), not from the function under test.
#![cfg(feature = "pczt")]

use konclave_seal::spends::{check_action_bound, ActionShape, BundleShape, SpendKey};
use orchard::builder::BundleType;
use orchard::bundle::Flags;

const MARGINAL: u64 = 5_000;
const NOTE: u64 = 1_000_000;

fn action(spend: Option<u64>, output: u64, to_vault: bool) -> ActionShape {
    ActionShape {
        awaiting_value: spend,
        output_value: output,
        to_vault,
    }
}

/// Cross-address allowed: a spend and an output share an action; padding fills up to `actions`.
fn shared(actions: usize, spends: usize, outputs: usize) -> BundleShape {
    BundleShape {
        cross_address: true,
        bound_applies: true,
        actions: (0..actions)
            .map(|i| {
                action(
                    (i < spends).then_some(NOTE),
                    if i < outputs { NOTE } else { 0 },
                    false,
                )
            })
            .collect(),
    }
}

const NONE: BundleShape = BundleShape {
    cross_address: true,
    bound_applies: true,
    actions: Vec::new(),
};

fn refused(r: Result<(), String>) -> String {
    let e = r.expect_err("the bound should refuse this");
    assert!(e.starts_with("[fee]"), "{e}");
    e
}

#[test]
fn a_third_action_for_one_spend_and_two_outputs_is_refused() {
    // The slack the old bound had: it added the spends that await a signature to the outputs.
    assert_eq!(
        check_action_bound(&[NONE, shared(2, 1, 2)], MARGINAL),
        Ok(())
    );
    refused(check_action_bound(&[NONE, shared(3, 1, 2)], MARGINAL));
    // And six actions for four spends and two outputs: the two spends past the outputs are real,
    // the other two actions are not.
    assert_eq!(
        check_action_bound(&[NONE, shared(4, 4, 2)], MARGINAL),
        Ok(())
    );
    refused(check_action_bound(&[NONE, shared(6, 4, 2)], MARGINAL));
}

#[test]
fn a_spend_that_moves_no_value_does_not_count() {
    // 3 actions: three spends await the vault's signature, two of them with no value, and one output.
    // Counted, the three spends would need three actions; the one that moves value needs two.
    let mut b = shared(3, 3, 1);
    b.actions[1].awaiting_value = Some(0);
    b.actions[2].awaiting_value = Some(0);
    refused(check_action_bound(&[NONE, b], MARGINAL));
    // A spend whose value the PCZT does not carry counts as nothing as well.
    let mut b = shared(3, 3, 1);
    b.actions[1].awaiting_value = None;
    b.actions[2].awaiting_value = None;
    refused(check_action_bound(&[NONE, b], MARGINAL));
}

#[test]
fn a_spend_counts_only_when_it_pays_for_its_action() {
    // Three actions need three counted spends against two outputs; the third carries exactly the
    // marginal fee, which is what its own action costs, and so is not counted. One zatoshi more is.
    let mut b = shared(3, 3, 2);
    b.actions[2].awaiting_value = Some(MARGINAL);
    refused(check_action_bound(&[NONE, b.clone()], MARGINAL));
    b.actions[2].awaiting_value = Some(MARGINAL + 1);
    assert_eq!(check_action_bound(&[NONE, b.clone()], MARGINAL), Ok(()));
    // The marginal is the one the transaction pays: at the lower rate the same note counts.
    b.actions[2].awaiting_value = Some(MARGINAL);
    assert_eq!(check_action_bound(&[NONE, b], 1_000), Ok(()));
}

#[test]
fn a_bundle_that_moves_nothing_is_refused_beside_one_that_does() {
    // An Orchard bundle of two actions with nothing in it, beside an Ironwood one of 2 actions, a
    // spend and two outputs.
    let nothing = shared(2, 0, 0);
    refused(check_action_bound(
        &[nothing.clone(), shared(2, 1, 2)],
        MARGINAL,
    ));
    // A bundle with no actions at all is the honest shape of a payment funded in one pool.
    assert_eq!(
        check_action_bound(&[NONE, shared(2, 1, 2)], MARGINAL),
        Ok(())
    );
    // Alone, an empty-looking bundle is refused as well.
    refused(check_action_bound(&[nothing], MARGINAL));
}

#[test]
fn a_zero_change_to_the_vault_counts_once_and_only_without_a_valued_one() {
    // A two-line payroll that empties one note: 1 spend, 2 valued outputs and a zero-value change
    // to the vault: 3 actions where cross-address actions are allowed.
    let mut b = shared(3, 1, 2);
    b.actions[2].to_vault = true;
    assert_eq!(check_action_bound(&[NONE, b.clone()], MARGINAL), Ok(()));
    // A second zero-value output to the vault is padding.
    let mut two = shared(4, 1, 2);
    two.actions[2].to_vault = true;
    two.actions[3].to_vault = true;
    refused(check_action_bound(&[NONE, two], MARGINAL));
    // With a valued output to the vault anywhere in the transaction, none is conceded, even in
    // the other bundle.
    let mut valued = shared(2, 1, 2);
    valued.actions[1].to_vault = true;
    refused(check_action_bound(&[valued, b.clone()], MARGINAL));
    // Without the vault's receivers (a device that has none) the output is not the vault's.
    b.actions[2].to_vault = false;
    refused(check_action_bound(&[NONE, b], MARGINAL));
}

#[test]
fn where_spends_and_outputs_never_share_an_action_each_needs_its_own() {
    // Orchard in v6: one spend and one change are two actions, a second spend makes three.
    let apart = |spends: usize, outputs: usize, padding: usize| BundleShape {
        cross_address: false,
        bound_applies: true,
        actions: (0..spends)
            .map(|_| action(Some(NOTE), 0, false))
            .chain((0..outputs).map(|_| action(Some(0), NOTE, false)))
            .chain((0..padding).map(|_| action(None, 0, false)))
            .collect(),
    };
    assert_eq!(
        check_action_bound(&[apart(1, 1, 0), NONE], MARGINAL),
        Ok(())
    );
    assert_eq!(
        check_action_bound(&[apart(2, 1, 0), NONE], MARGINAL),
        Ok(())
    );
    // An action beyond what the pairs need is refused.
    refused(check_action_bound(&[apart(2, 1, 1), NONE], MARGINAL));
}

#[test]
fn the_bound_is_what_the_upstream_builder_makes_and_one_more_is_refused() {
    // For every number of spends and outputs, with and without a zero-value change to the vault, and
    // under both flags, the actions orchard's builder produces are allowed and one more is not. The
    // expectation is the upstream crate's, so a release that changes how it pairs spends and outputs
    // turns this red.
    for cross in [true, false] {
        let flags = if cross {
            Flags::ENABLED
        } else {
            Flags::CROSS_ADDRESS_DISABLED
        };
        for spends in 0..=8usize {
            for outputs in 0..=8usize {
                for zero_change in [false, true] {
                    let requested_outputs = outputs + usize::from(zero_change);
                    let n = BundleType::DEFAULT
                        .num_actions(flags, spends, requested_outputs)
                        .unwrap();
                    let what = format!(
                        "cross={cross} spends={spends} outputs={outputs} zero_change={zero_change}"
                    );
                    let build = |len: usize| {
                        let mut actions: Vec<ActionShape> = vec![];
                        if cross {
                            for i in 0..len {
                                let out = if i < outputs { NOTE } else { 0 };
                                let zero = zero_change && i == outputs;
                                actions.push(action((i < spends).then_some(NOTE), out, zero));
                            }
                        } else {
                            // Each real spend is paired with a zero-value output to its own note's
                            // address (the vault's); each output with a zero-value spend.
                            for _ in 0..spends {
                                actions.push(action(Some(NOTE), 0, true));
                            }
                            for _ in 0..outputs {
                                actions.push(action(Some(0), NOTE, false));
                            }
                            if zero_change {
                                actions.push(action(Some(0), 0, true));
                            }
                            while actions.len() < len {
                                actions.push(action(None, 0, false));
                            }
                        }
                        BundleShape {
                            cross_address: cross,
                            bound_applies: true,
                            actions,
                        }
                    };
                    assert_eq!(
                        check_action_bound(&[build(n)], MARGINAL),
                        Ok(()),
                        "{what}: the builder's own {n} actions"
                    );
                    assert!(
                        check_action_bound(&[build(n + 1)], MARGINAL).is_err(),
                        "{what}: {} actions are one too many",
                        n + 1
                    );
                }
            }
        }
    }
}

#[test]
fn an_action_holding_a_spend_and_a_change_is_not_an_action_for_each() {
    // Orchard in v6, two spends and a change. The builder gives them three actions: a spend and its
    // zero-value counterpart each, then the change with a counterpart spend. A bundle that puts the
    // second spend and the change in ONE action (same receiver, so the circuit allows it) and fills
    // the third with nothing carries the same three actions for two that move value.
    let honest = BundleShape {
        cross_address: false,
        bound_applies: true,
        actions: vec![
            action(Some(NOTE), 0, true),
            action(Some(NOTE), 0, true),
            action(Some(0), NOTE, true),
        ],
    };
    assert_eq!(check_action_bound(&[honest, NONE], MARGINAL), Ok(()));
    let folded = BundleShape {
        cross_address: false,
        bound_applies: true,
        actions: vec![
            action(Some(NOTE), 0, true),
            action(Some(NOTE), NOTE, true),
            action(None, 0, false),
        ],
    };
    refused(check_action_bound(&[folded, NONE], MARGINAL));
}

/// A reading that checks no spend (`SpendKey::NotChecked`: a preview) has no count to judge: the bound
/// does not apply to the whole transaction, not even to a bundle read in full beside it.
#[test]
fn a_bundle_read_with_no_spend_checked_is_not_bounded() {
    let mut padded = shared(6, 1, 2);
    assert!(check_action_bound(&[NONE, padded.clone()], MARGINAL).is_err());
    padded.bound_applies = false;
    assert_eq!(
        check_action_bound(&[NONE, padded.clone()], MARGINAL),
        Ok(())
    );
    // Even beside a bundle that was read in full.
    assert_eq!(
        check_action_bound(&[shared(9, 1, 1), padded], MARGINAL),
        Ok(())
    );
}

/// No key is `Absent`, which refuses a valued spend, and never `NotChecked`, which reads none: the
/// conversion every signing reading goes through.
#[test]
fn no_key_is_absent_and_a_key_is_the_vaults() {
    assert!(matches!(SpendKey::from(None), SpendKey::Absent));
    let fvk = orchard::keys::FullViewingKey::from(
        &orchard::keys::SpendingKey::from_bytes([7; 32]).unwrap(),
    );
    assert!(matches!(SpendKey::from(Some(&fvk)), SpendKey::Vault(_)));
}
