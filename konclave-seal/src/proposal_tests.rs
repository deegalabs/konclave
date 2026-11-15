use super::*;

const OWN: [[u8; ORCHARD_RECEIVER_LEN]; 2] =
    [[0x44; ORCHARD_RECEIVER_LEN], [0x55; ORCHARD_RECEIVER_LEN]];

fn ctx() -> Context<'static> {
    Context {
        network: NETWORK_MAINNET,
        vault_id: [0x11; 32],
        threshold: 2,
        total: 3,
        own_receivers: &OWN,
    }
}

fn line(receiver: u8, amount: u64, memo: &str) -> Line {
    Line {
        receiver_type: RECEIVER_ORCHARD,
        receiver: [receiver; ORCHARD_RECEIVER_LEN],
        amount,
        memo: memo.to_string(),
    }
}

/// The content the hand-written fixture below spells.
fn sample() -> Content {
    Content {
        network: NETWORK_MAINNET,
        vault_id: [0x11; 32],
        kind: KIND_PAYMENT,
        lines: vec![line(0x22, 150_000, "hi")],
        proposer: 1,
        expiry_unix: 1_800_000_000,
        threshold: 2,
        total: 3,
        salt: [0x33; 32],
        fee_cap: 15_000,
        extra: [0u8; 32],
    }
}

fn valid(c: Content) -> ValidContent {
    validate(c, &ctx()).expect("valid content")
}

fn refused(c: Content) -> ContentError {
    validate(c, &ctx()).expect_err("content must be refused")
}

/// The canonical bytes, written out by hand field by field, NOT produced by `encode`.
fn fixture_bytes() -> Vec<u8> {
    let mut b = b"konclave-proposal-v1\0".to_vec();
    b.push(0x01); // network: mainnet
    b.extend([0x11; 32]); // vault id
    b.push(0x01); // kind: payment
    b.extend([0, 0, 0, 1]); // one line
    b.push(0x01); // receiver type: Orchard
    b.extend([0x22; 43]); // receiver
    b.extend([0, 0, 0, 0, 0, 0x02, 0x49, 0xF0]); // 150,000 zatoshis
    b.extend([0, 0, 0, 2]); // memo length
    b.extend(b"hi"); // memo
    b.extend([0, 1]); // proposer seat 1
    b.extend([0, 0, 0, 0, 0x6B, 0x49, 0xD2, 0x00]); // expiry 1,800,000,000
    b.extend([0, 2]); // threshold
    b.extend([0, 3]); // total
    b.extend([0x33; 32]); // salt
    b.extend([0, 0, 0, 0, 0, 0, 0x3A, 0x98]); // fee cap 15,000
    b.extend([0u8; 32]); // extra
    b
}

/// SHA-256("konclave-proposal-hash-v1\0" || fixture), computed outside Rust (Python hashlib).
const FIXTURE_HASH: &str = "12c0de0584c1e98641848c9b45358ca86a809b01549780a89d5bfc0654d455c8";

#[test]
fn encode_matches_the_hand_written_fixture() {
    assert_eq!(encode(&valid(sample())), fixture_bytes());
}

#[test]
fn the_hash_matches_one_computed_outside_rust() {
    let h = content_hash(&valid(sample()));
    assert_eq!(crate::hex::encode_lower(h.as_bytes()), FIXTURE_HASH);
}

#[test]
fn the_proposal_id_is_the_full_hash_in_lowercase_hex() {
    let h = content_hash(&valid(sample()));
    assert_eq!(proposal_id(&h), FIXTURE_HASH);
    assert_eq!(proposal_id(&h).len(), 64);
}

#[test]
fn a_payroll_encodes_every_line_in_order() {
    let mut c = sample();
    c.kind = KIND_PAYROLL;
    c.lines = vec![line(0x22, 1, ""), line(0x23, 2, "b")];
    let bytes = encode(&valid(c.clone()));
    let mut swapped = c;
    swapped.lines.swap(0, 1);
    assert_ne!(
        bytes,
        encode(&valid(swapped)),
        "line order is part of the content"
    );
    // An empty memo is encoded as length zero.
    let first_line = 21 + 1 + 32 + 1 + 4;
    let memo_len_at = first_line + 1 + 43 + 8;
    assert_eq!(&bytes[memo_len_at..memo_len_at + 4], &[0, 0, 0, 0]);
}

#[test]
fn changing_any_field_changes_the_hash() {
    let base = content_hash(&valid(sample()));
    let mut variants: Vec<(&str, Content)> = Vec::new();
    let mut c = sample();
    c.lines[0].receiver = [0x23; 43];
    variants.push(("receiver", c));
    let mut c = sample();
    c.lines[0].amount += 1;
    variants.push(("amount", c));
    let mut c = sample();
    c.lines[0].memo = "hj".into();
    variants.push(("memo", c));
    let mut c = sample();
    c.proposer = 2;
    variants.push(("proposer", c));
    let mut c = sample();
    c.expiry_unix += 1;
    variants.push(("expiry", c));
    let mut c = sample();
    c.salt[31] ^= 1;
    variants.push(("salt", c));
    let mut c = sample();
    c.fee_cap += 1;
    variants.push(("fee_cap", c));
    let mut c = sample();
    c.extra[0] = 1;
    variants.push(("extra", c));
    let mut c = sample();
    c.kind = KIND_PAYROLL;
    variants.push(("kind", c));
    for (name, v) in variants {
        assert_ne!(content_hash(&valid(v)), base, "{name} must change the hash");
    }
    // The fields checked against the context change the hash too: encode them under a context
    // that accepts them.
    let mut c = sample();
    c.vault_id = [0x12; 32];
    c.network = NETWORK_TESTNET;
    c.threshold = 3;
    c.total = 4;
    let other = Context {
        network: NETWORK_TESTNET,
        vault_id: [0x12; 32],
        threshold: 3,
        total: 4,
        own_receivers: &OWN,
    };
    let h = content_hash(&validate(c, &other).unwrap());
    assert_ne!(h, base);
}

#[test]
fn it_refuses_a_content_for_another_vault_or_network() {
    let mut c = sample();
    c.vault_id = [0x12; 32];
    assert_eq!(refused(c), ContentError::VaultId);
    let mut c = sample();
    c.network = NETWORK_TESTNET;
    assert_eq!(refused(c), ContentError::Network);
    let mut c = sample();
    c.network = 0;
    assert_eq!(refused(c), ContentError::Network);
}

#[test]
fn it_refuses_a_quorum_the_device_does_not_hold() {
    let mut c = sample();
    c.threshold = 1;
    assert_eq!(refused(c), ContentError::Quorum);
    let mut c = sample();
    c.total = 4;
    assert_eq!(refused(c), ContentError::Quorum);
}

#[test]
fn it_refuses_an_unknown_kind_or_a_payment_without_exactly_one_line() {
    let mut c = sample();
    c.kind = 3;
    assert_eq!(refused(c), ContentError::Kind);
    let mut c = sample();
    c.lines.push(line(0x23, 1, ""));
    assert_eq!(refused(c), ContentError::LineCount);
    let mut c = sample();
    c.lines.clear();
    assert_eq!(refused(c), ContentError::LineCount);
}

#[test]
fn a_payroll_takes_one_to_max_lines() {
    let mut c = sample();
    c.kind = KIND_PAYROLL;
    c.lines = vec![line(0x22, 1, ""); MAX_LINES];
    assert!(validate(c.clone(), &ctx()).is_ok());
    c.lines.push(line(0x22, 1, ""));
    assert_eq!(refused(c.clone()), ContentError::LineCount);
    c.lines.clear();
    assert_eq!(refused(c), ContentError::LineCount);
}

#[test]
fn it_refuses_a_line_paying_the_vaults_own_receivers() {
    for own in OWN {
        let mut c = sample();
        c.lines[0].receiver = own;
        assert_eq!(refused(c), ContentError::OwnReceiver);
    }
}

#[test]
fn it_refuses_an_unknown_receiver_type() {
    let mut c = sample();
    c.lines[0].receiver_type = 2;
    assert_eq!(refused(c), ContentError::ReceiverType);
}

#[test]
fn it_refuses_amounts_of_zero_or_beyond_the_money_supply() {
    let mut c = sample();
    c.lines[0].amount = 0;
    assert_eq!(refused(c), ContentError::Amount);
    let mut c = sample();
    c.lines[0].amount = MAX_MONEY + 1;
    assert_eq!(refused(c), ContentError::Amount);
    let mut c = sample();
    c.kind = KIND_PAYROLL;
    c.lines = vec![line(0x22, MAX_MONEY, ""), line(0x23, 1, "")];
    assert_eq!(refused(c), ContentError::TotalAmount);
    let mut c = sample();
    c.lines[0].amount = MAX_MONEY;
    assert!(validate(c, &ctx()).is_ok());
}

#[test]
fn memo_vectors() {
    // Empty: no memo.
    let mut c = sample();
    c.lines[0].memo = String::new();
    assert!(validate(c, &ctx()).is_ok());
    // Text.
    let mut c = sample();
    c.lines[0].memo = "pagamento de novembro".into();
    assert!(validate(c, &ctx()).is_ok());
    // Exactly 512 bytes (multi-byte characters count in bytes).
    let mut c = sample();
    c.lines[0].memo = "é".repeat(256);
    assert_eq!(c.lines[0].memo.len(), 512);
    assert!(validate(c, &ctx()).is_ok());
    // 513 bytes.
    let mut c = sample();
    c.lines[0].memo = "a".repeat(513);
    assert_eq!(refused(c), ContentError::Memo);
    // A NUL anywhere: a wire memo is NUL-padded, so a NUL in the text could not be compared.
    let mut c = sample();
    c.lines[0].memo = "a\0b".into();
    assert_eq!(refused(c), ContentError::Memo);
    // Non-UTF-8 is not representable: `memo` is a String, and the wire form (a later change)
    // deserializes into it.
}

#[test]
fn it_refuses_a_proposer_outside_the_seats() {
    let mut c = sample();
    c.proposer = 0;
    assert_eq!(refused(c), ContentError::Proposer);
    let mut c = sample();
    c.proposer = 4;
    assert_eq!(refused(c), ContentError::Proposer);
    let mut c = sample();
    c.proposer = 3;
    assert!(validate(c, &ctx()).is_ok());
}

#[test]
fn it_refuses_a_zero_expiry_or_an_all_zero_salt() {
    let mut c = sample();
    c.expiry_unix = 0;
    assert_eq!(refused(c), ContentError::Expiry);
    let mut c = sample();
    c.salt = [0u8; 32];
    assert_eq!(refused(c), ContentError::Salt);
}

#[test]
fn the_fee_cap_bounds_are_the_zip317_floor_and_the_block_budget() {
    // Lowest accepted rate (1,000, ZIP 2009) x 2 grace actions; highest (5,000) x 330 actions.
    assert_eq!(fee_cap_floor(), 2_000);
    assert_eq!(fee_cap_ceiling(), 1_650_000);
    for (cap, ok) in [
        (1_999, false),
        (2_000, true),
        (1_650_000, true),
        (1_650_001, false),
        (0, false),
        (u64::MAX, false),
    ] {
        let mut c = sample();
        c.fee_cap = cap;
        assert_eq!(validate(c, &ctx()).is_ok(), ok, "fee_cap {cap}");
    }
}

#[test]
fn check_expiry_refuses_expired_and_too_far_and_takes_the_margin() {
    let ts = 1_800_000_000_000i64; // approval time, ms
    let exp = |ms: i64| (ms / 1000) as u64;
    // Open, within 72 h.
    assert_eq!(check_expiry(exp(ts + 3_600_000), ts, ts), Ok(()));
    // Exactly at 72 h + margin: accepted.
    assert_eq!(
        check_expiry(exp(ts + EXPIRY_MAX_MS + EXPIRY_MARGIN_MS), ts, ts),
        Ok(())
    );
    // One second beyond: refused.
    assert_eq!(
        check_expiry(exp(ts + EXPIRY_MAX_MS + EXPIRY_MARGIN_MS) + 1, ts, ts),
        Err(ContentError::ExpiryTooFar)
    );
    // Expired at now == expiry, and after.
    let e = exp(ts + 3_600_000);
    assert_eq!(
        check_expiry(e, ts, (e as i64) * 1000),
        Err(ContentError::Expired)
    );
    assert_eq!(
        check_expiry(e, ts, (e as i64) * 1000 + 1),
        Err(ContentError::Expired)
    );
    assert_eq!(check_expiry(e, ts, (e as i64) * 1000 - 1), Ok(()));
    // No overflow on extreme inputs.
    assert_eq!(
        check_expiry(u64::MAX, ts, ts),
        Err(ContentError::ExpiryTooFar)
    );
    assert_eq!(
        check_expiry(0, i64::MIN, i64::MAX),
        Err(ContentError::Expired)
    );
}

#[test]
fn the_bounds_are_the_decided_numbers() {
    assert_eq!(EXPIRY_MAX_MS, 259_200_000);
    assert_eq!(EXPIRY_MARGIN_MS, 600_000);
    assert_eq!(CHANGE_SPLIT_MAX, 4);
    assert_eq!(MAX_MEMO_BYTES, 512);
}
