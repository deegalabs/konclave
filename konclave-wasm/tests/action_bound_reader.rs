//! The action bound at the reader: whole PCZTs, made by orchard's public builder (`tests/support`),
//! read by `read_payment_with` with the fee they pay. What the rule decides is tested apart in
//! `konclave-seal/tests/action_bound.rs`; this is that the reader gives it the right facts.

mod support;

use konclave_seal::epochs::MAINNET as TABLE;
use konclave_seal::spends::SpendKey;
use konclave_wasm::pczt_bridge::{read_payment_under, read_payment_with, MAINNET};
use orchard::keys::FullViewingKey;
use support::*;

const CLOCK: i64 = TABLE.anchor.unix + 30 * 86_400;

/// The vault in these tests is `Key::new(1)`: the device holds its viewing key.
fn vault_fvk() -> FullViewingKey {
    Key::new(1).fvk
}

fn read(pczt: &[u8], receivers: Option<&[[u8; 43]]>) -> Result<(u64, usize), String> {
    read_with(pczt, receivers, Some(&vault_fvk()))
}

fn read_with(
    pczt: &[u8],
    receivers: Option<&[[u8; 43]]>,
    fvk: Option<&FullViewingKey>,
) -> Result<(u64, usize), String> {
    read_payment_with(&MAINNET, pczt, CLOCK, receivers, fvk).map(|p| (p.fee_zat, p.actions))
}

#[test]
fn a_payment_and_change_from_one_note_reads() {
    let vault = Key::new(1);
    let payee = Key::new(2);
    let mut plan = Plan::new(true);
    plan.spends = vec![(&vault, 100_000)];
    plan.outputs = vec![(payee.external(), 60_000)];
    plan.changes = vec![(&vault, 30_000)];
    let p = pczt(None, Some(bundle(&plan)));
    assert_eq!(read(&p, None), Ok((10_000, 2)));
}

fn vault_receivers(vault: &Key) -> Vec<[u8; 43]> {
    vec![raw(&vault.external()), raw(&vault.internal())]
}

fn is_fee(r: Result<(u64, usize), String>) -> String {
    let e = r.expect_err("the bound should refuse this");
    assert!(e.starts_with("[fee]"), "{e}");
    e
}

/// 3 spends, a payment and change: the wallet may spend more notes than the payment needs, and each of
/// them counts while it awaits a signature. The same bundle with two of the spends already signed by
/// some other key has an action nothing needs.
///
/// What this layer does NOT do is check that an awaiting spend's `rk` is under the vault's key: that
/// is `spends_to_sign_for`, which the signing machine runs (`parseAlphas`) before it reads the
/// payment, and a test in the UI pins that order. It does check, with the vault's viewing key, that
/// every awaiting spend's note is the vault's (`verify_nullifier`).
fn three_notes(signed_by_other: bool) -> Vec<u8> {
    let vault = Key::new(1);
    let other = Key::new(3);
    let payee = Key::new(2);
    let mut plan = Plan::new(true);
    let holder = if signed_by_other { &other } else { &vault };
    plan.spends = vec![(&vault, 100_000), (holder, 50_000), (holder, 50_000)];
    plan.outputs = vec![(payee.external(), 120_000)];
    plan.changes = vec![(&vault, 65_000)];
    let mut b = bundle(&plan);
    if signed_by_other {
        for i in actions_spending(&b, 50_000) {
            sign_as(&mut b, i, &other);
        }
    }
    pczt(None, Some(b))
}

#[test]
fn at_this_layer_every_awaiting_vault_spend_counts_and_a_signed_one_does_not() {
    assert_eq!(read(&three_notes(false), None), Ok((15_000, 3)));
    is_fee(read(&three_notes(true), None));
}

/// What the old reading let through: spends of another key that await a signature. They are not the
/// vault's notes, and under the vault's key the nullifier check refuses them, whether the PCZT still
/// carries its own key (a mismatch) or the key was cleared as the published copy has it.
#[test]
fn an_awaiting_spend_of_another_key_is_refused_not_counted() {
    let vault = Key::new(1);
    let other = Key::new(3);
    let payee = Key::new(2);
    let mut plan = Plan::new(true);
    plan.spends = vec![(&vault, 100_000), (&other, 50_000), (&other, 50_000)];
    plan.outputs = vec![(payee.external(), 120_000)];
    plan.changes = vec![(&vault, 65_000)];
    let with_key = pczt(None, Some(bundle(&plan)));
    let e = read(&with_key, None).unwrap_err();
    assert!(e.starts_with("[commitment]"), "{e}");
    let cleared = redacted(&with_key, |b| b.redact_actions(|mut a| a.clear_spend_fvk()));
    let e = read(&cleared, None).unwrap_err();
    assert!(e.starts_with("[commitment]"), "{e}");
}

/// A two-line payroll that takes one note exactly: the wallet adds a zero-value change to the vault.
fn payroll_with_zero_changes(zero_changes: usize) -> Vec<u8> {
    let vault = Key::new(1);
    let (a, b) = (Key::new(4), Key::new(5));
    let mut plan = Plan::new(true);
    // 3 outputs make 3 actions (15,000); 4 make 4 (20,000).
    plan.spends = vec![(&vault, 100_000 + 5_000 * (zero_changes as u64 - 1))];
    plan.outputs = vec![(a.external(), 40_000), (b.external(), 45_000)];
    plan.changes = (0..zero_changes).map(|_| (&vault, 0)).collect();
    pczt(None, Some(bundle(&plan)))
}

#[test]
fn a_payroll_that_takes_a_note_exactly_reads_with_the_vaults_receivers() {
    let vault = Key::new(1);
    let receivers = vault_receivers(&vault);
    let one = payroll_with_zero_changes(1);
    assert_eq!(read(&one, Some(&receivers)), Ok((15_000, 3)));
    // A device with no receivers does not know the zero-value output is the vault's own.
    is_fee(read(&one, None));
    // A second zero-value change is padding.
    is_fee(read(&payroll_with_zero_changes(2), Some(&receivers)));
}

/// An Ironwood payment of one note, a payee and change, with `extra` paid on top of the 10,000 two
/// actions cost, beside an Orchard bundle that holds `orchard_padding` actions and nothing else.
fn payment_beside_padding(orchard_padding: bool) -> Vec<u8> {
    let vault = Key::new(1);
    let payee = Key::new(2);
    let extra = if orchard_padding { 10_000 } else { 0 };
    let mut iw = Plan::new(true);
    iw.spends = vec![(&vault, 100_000 + extra)];
    iw.outputs = vec![(payee.external(), 60_000)];
    iw.changes = vec![(&vault, 30_000)];
    let orchard = orchard_padding.then(|| {
        let mut o = Plan::new(false);
        o.required = true;
        bundle(&o)
    });
    pczt(orchard, Some(bundle(&iw)))
}

#[test]
fn an_orchard_bundle_that_moves_nothing_is_refused_beside_one_that_does() {
    assert_eq!(read(&payment_beside_padding(false), None), Ok((10_000, 2)));
    // Two more actions, paid at their exact ZIP 317 fee, and nothing in them.
    is_fee(read(&payment_beside_padding(true), None));
}

#[test]
fn orchard_after_the_upgrade_needs_an_action_for_each_spend_and_each_change() {
    let vault = Key::new(1);
    let receivers = vault_receivers(&vault);
    // One spend and one change: the builder gives each its own action (2), as it does for two
    // spends and a change (3). These are the shapes a vault that still holds Orchard notes sends.
    for (spends, fee) in [(vec![100_000], 10_000), (vec![60_000, 60_000], 15_000)] {
        let total: u64 = spends.iter().sum();
        let mut plan = Plan::new(false);
        plan.spends = spends.iter().map(|v| (&vault, *v)).collect();
        plan.changes = vec![(&vault, total - fee)];
        let p = pczt(Some(bundle(&plan)), None);
        let n = if spends.len() == 1 { 2 } else { 3 };
        assert_eq!(read(&p, None), Ok((fee, n)), "{spends:?}");
        assert_eq!(
            read(&p, Some(&receivers)),
            Ok((fee, n)),
            "{spends:?} with receivers"
        );
    }
}

#[test]
fn orchard_after_the_upgrade_takes_exactly_two_notes_with_a_zero_change() {
    // Two notes that cover their own fee exactly: two spends and a zero-value change, three actions.
    // The output the builder pairs with each spend pays the spent note's own address, which is the
    // vault's, so the change is the output in the action of its own.
    let vault = Key::new(1);
    let receivers = vault_receivers(&vault);
    let mut plan = Plan::new(false);
    plan.spends = vec![(&vault, 7_500), (&vault, 7_500)];
    plan.changes = vec![(&vault, 0)];
    let p = pczt(Some(bundle(&plan)), None);
    assert_eq!(read(&p, Some(&receivers)), Ok((15_000, 3)));
    is_fee(read(&p, None));
}

#[test]
fn ironwood_with_cross_address_transfers_off_is_refused_as_a_shape() {
    let vault = Key::new(1);
    let mut plan = Plan::new(true);
    plan.flags = Some(orchard::bundle::Flags::CROSS_ADDRESS_DISABLED);
    plan.spends = vec![(&vault, 100_000)];
    plan.changes = vec![(&vault, 90_000)];
    let p = pczt(None, Some(bundle(&plan)));
    let e = read(&p, None).unwrap_err();
    assert!(e.starts_with("[shape]"), "{e}");
}

fn redacted(
    pczt_bytes: &[u8],
    clear: impl FnOnce(&mut pczt::roles::redactor::orchard::OrchardRedactor<'_>),
) -> Vec<u8> {
    let p = pczt::Pczt::parse(pczt_bytes).unwrap();
    pczt::roles::redactor::Redactor::new(p)
        .redact_ironwood_with(|mut b| clear(&mut b))
        .finish()
        .serialize()
        .unwrap()
}

/// A copy with the spend key, the value blinding and the binding key cleared: the reading does not
/// need them.
fn without_blinding(pczt_bytes: &[u8]) -> Vec<u8> {
    redacted(pczt_bytes, |b| {
        b.clear_bsk();
        b.redact_actions(|mut a| {
            a.clear_spend_fvk();
            a.clear_rcv();
        })
    })
}

#[test]
fn the_reading_needs_the_note_and_the_key_and_not_the_blinding() {
    let honest = three_notes(false);
    assert_eq!(read(&honest, None), Ok((15_000, 3)));
    // The same reading from the note and the device's own key.
    assert_eq!(read(&without_blinding(&honest), None), Ok((15_000, 3)));
    // Each field the nullifier is rebuilt from is needed: a missing one cannot be checked.
    for (what, copy) in [
        (
            "recipient",
            redacted(&honest, |b| {
                b.redact_actions(|mut a| a.clear_spend_recipient())
            }),
        ),
        (
            "rho",
            redacted(&honest, |b| b.redact_actions(|mut a| a.clear_spend_rho())),
        ),
        (
            "rseed",
            redacted(&honest, |b| b.redact_actions(|mut a| a.clear_spend_rseed())),
        ),
    ] {
        // Some of these never parse (the reader's own parse says so) and some parse and fail the
        // check: none is read.
        let e = read(&copy, None).unwrap_err();
        assert!(
            e.starts_with("[commitment]") || e.starts_with("parse:"),
            "{what}: {e}"
        );
    }
    // No value at all: the value is one of those fields, so the spend cannot be checked either, and
    // it is refused rather than counted as nothing (a device would otherwise sign a spend it never
    // verified). Without the key, the refusal names the key.
    let no_value = redacted(&honest, |b| b.redact_actions(|mut a| a.clear_spend_value()));
    let e = read(&no_value, None).unwrap_err();
    assert!(e.starts_with("[commitment]"), "value: {e}");
    let e = read_with(&no_value, None, None).unwrap_err();
    assert!(e.starts_with("[viewingkey]"), "value, no key: {e}");
}

#[test]
fn a_key_that_is_not_the_vaults_refuses_and_never_counts() {
    let honest = three_notes(false);
    let stranger = Key::new(9).fvk;
    for copy in [honest.clone(), without_blinding(&honest)] {
        let e = read_with(&copy, None, Some(&stranger)).unwrap_err();
        assert!(e.starts_with("[commitment]"), "{e}");
    }
}

#[test]
fn without_the_vaults_key_a_valued_spend_is_refused_as_a_key_matter_not_a_fee() {
    let honest = three_notes(false);
    for copy in [honest.clone(), without_blinding(&honest)] {
        let e = read_with(&copy, None, None).unwrap_err();
        assert!(e.starts_with("[viewingkey]"), "{e}");
    }
    // Padding does not make up for it: with no key nothing is counted, and nothing is judged.
    let padded = payment_beside_padding(true);
    let e = read_with(&padded, None, None).unwrap_err();
    assert!(e.starts_with("[viewingkey]"), "{e}");
    // With the key the same padded transaction is refused as a fee, which is the bound.
    is_fee(read(&padded, None));
}

// --- The marginal fee the bound reads: the one the transaction pays, from the rates the clock accepts.

const OLD_ERA: i64 = TABLE.anchor.unix + 30 * 86_400;
/// A clock past the switch to the lower rate: both 5,000 and 1,000 are accepted.
const BOTH_ERAS: i64 = TABLE.anchor.unix + 400 * 86_400;

/// Three vault spends of 100,000 and the two given, a payment of 50,000 and the change, at `fee`.
fn three_spends(second: u64, third: u64, fee: u64) -> Vec<u8> {
    let vault = Key::new(1);
    let payee = Key::new(2);
    let mut plan = Plan::new(true);
    plan.spends = vec![(&vault, 100_000), (&vault, second), (&vault, third)];
    plan.outputs = vec![(payee.external(), 50_000)];
    plan.changes = vec![(&vault, 100_000 + second + third - 50_000 - fee)];
    pczt(None, Some(bundle(&plan)))
}

#[test]
fn a_spend_counts_when_it_is_worth_more_than_the_marginal_fee_the_transaction_pays() {
    // At 5,000 a action three actions cost 15,000. A spend of exactly 5,000 does not pay for its own
    // action and is not counted, so the third action has nothing to be for; 5,001 is counted.
    let e = read_payment_with(
        &MAINNET,
        &three_spends(5_001, 5_000, 15_000),
        OLD_ERA,
        None,
        Some(&vault_fvk()),
    )
    .expect_err("one of the two small spends is not counted");
    assert!(e.starts_with("[fee]"), "{e}");
    let p = read_payment_with(
        &MAINNET,
        &three_spends(5_001, 5_001, 15_000),
        OLD_ERA,
        None,
        Some(&vault_fvk()),
    )
    .expect("both are counted");
    assert_eq!((p.fee_zat, p.actions), (15_000, 3));
}

#[test]
fn the_marginal_is_the_rate_the_fee_matches_not_the_highest_or_the_lowest_accepted() {
    // With both rates accepted (past the switch), the same two spends of 5,000 are judged by the
    // rate the transaction pays: refused at 15,000 (5,000 a action), counted at 3,000 (1,000).
    let e = read_payment_with(
        &MAINNET,
        &three_spends(5_000, 5_000, 15_000),
        BOTH_ERAS,
        None,
        Some(&vault_fvk()),
    )
    .expect_err("at 5,000 a action these spends do not count");
    assert!(e.starts_with("[fee]"), "{e}");
    let p = read_payment_with(
        &MAINNET,
        &three_spends(5_000, 5_000, 3_000),
        BOTH_ERAS,
        None,
        Some(&vault_fvk()),
    )
    .expect("at 1,000 a action they do");
    assert_eq!((p.fee_zat, p.actions), (3_000, 3));
}

#[test]
fn a_fee_below_the_clock_is_judged_at_the_rate_it_matches_before_it_is_called_a_clock_matter() {
    // OLD_ERA accepts only 5,000 and knows 1,000, so 3,000 for three actions is a lower rate than
    // this clock allows. Spends of 1,000 do not pay for their own action at 1,000 and the third
    // action has nothing to be for: [fee], not [clock]. At 1,001 they count, and it is the clock.
    let e = read_payment_with(
        &MAINNET,
        &three_spends(1_000, 1_000, 3_000),
        OLD_ERA,
        None,
        Some(&vault_fvk()),
    )
    .expect_err("refused");
    assert!(e.starts_with("[fee]"), "{e}");
    let e = read_payment_with(
        &MAINNET,
        &three_spends(1_001, 1_001, 3_000),
        OLD_ERA,
        None,
        Some(&vault_fvk()),
    )
    .expect_err("refused");
    assert!(e.starts_with("[clock]"), "{e}");
}

// --- The vault's receivers, through the call the app makes.

use konclave_wasm::pczt_bridge::{read_for_signing, read_for_signing_with, receivers_from_hex};

#[test]
fn the_reading_the_device_signs_on_takes_the_receivers() {
    let vault = Key::new(1);
    let receivers = vault_receivers(&vault);
    let now = TABLE.anchor.unix + 3_600;
    let expiry = MAINNET.height_at(now) + 40;
    let (a, b) = (Key::new(4), Key::new(5));
    let mut plan = Plan::new(true);
    plan.spends = vec![(&vault, 100_000)];
    plan.outputs = vec![(a.external(), 40_000), (b.external(), 45_000)];
    plan.changes = vec![(&vault, 0)];
    let p = pczt_expiring(None, Some(bundle(&plan)), expiry);
    let got = read_for_signing_with(&MAINNET, &p, now, Some(&receivers), Some(&vault_fvk()))
        .expect("a payroll that takes a note exactly reads with the receivers");
    assert_eq!((got.payment.fee_zat, got.payment.actions), (15_000, 3));
    // The call the app's export makes, for the network this build signs for.
    let got = read_for_signing(&p, now, Some(&receivers), Some(&vault_fvk()))
        .expect("and through the export's call");
    assert_eq!(got.payment.actions, 3);
    let e = read_for_signing(&p, now, None, Some(&vault_fvk()))
        .map(|_| ())
        .expect_err("without them the export's call refuses it too");
    assert!(e.starts_with("[fee]"), "{e}");
    let e = read_for_signing_with(&MAINNET, &p, now, None, Some(&vault_fvk()))
        .map(|_| ())
        .expect_err("without them it does not");
    assert!(e.starts_with("[fee]"), "{e}");
}

#[test]
fn receivers_are_read_from_hex_as_43_bytes_each_and_a_bad_entry_refuses_the_list() {
    let vault = Key::new(1);
    let good = hex::encode(raw(&vault.external()));
    assert_eq!(receivers_from_hex(&[]).unwrap(), Vec::<[u8; 43]>::new());
    assert_eq!(
        receivers_from_hex(&[good.clone(), hex::encode(raw(&vault.internal()))]).unwrap(),
        vault_receivers(&vault)
    );
    for bad in [
        good[..84].to_string(), // 42 bytes
        format!("{good}00"),    // 44 bytes
        "zz".repeat(43),        // not hex
        String::new(),
    ] {
        let e = receivers_from_hex(&[good.clone(), bad.clone()]).unwrap_err();
        assert!(e.starts_with("[receivers]"), "{bad}: {e}");
    }
}

/// A reading that signs nothing (a preview, the SDK's) checks no spend and applies no bound: the
/// same transactions the signing reading refuses for want of a key read there.
#[test]
fn a_reading_that_signs_nothing_checks_no_spend() {
    for copy in [
        three_notes(false),
        without_blinding(&three_notes(false)),
        payment_beside_padding(true),
        // Spends with no value at all: the count is as unknown as with a value it did not check.
        redacted(&three_notes(false), |b| {
            b.redact_actions(|mut a| a.clear_spend_value())
        }),
    ] {
        read_payment_under(&MAINNET, &copy, CLOCK, None, SpendKey::NotChecked)
            .expect("a preview reads it");
    }
}
