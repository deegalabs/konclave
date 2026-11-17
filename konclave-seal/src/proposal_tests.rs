use super::*;

const EXTERNAL: [u8; ORCHARD_RECEIVER_LEN] = [0x44; ORCHARD_RECEIVER_LEN];
const CHANGE: [u8; ORCHARD_RECEIVER_LEN] = [0x55; ORCHARD_RECEIVER_LEN];

/// Testnet on purpose: the network (2), kind (1) and receiver type (1) bytes of the fixture then
/// differ from at least one neighbour, so a swap of two of them changes the bytes.
fn ctx() -> Context {
    Context {
        network: NETWORK_TESTNET,
        vault_id: [0x11; 32],
        threshold: 2,
        total: 3,
        external: EXTERNAL,
        change: CHANGE,
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
        network: NETWORK_TESTNET,
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
    b.push(0x02); // network: testnet
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
const FIXTURE_HASH: &str = "a9ea4a8021acd3f706ff00bca151ec3e4078c8ddd8e3c982245f54cbad11fb03";

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
    c.kind = KIND_PAYROLL;
    variants.push(("kind", c));
    for (name, v) in variants {
        assert_ne!(content_hash(&valid(v)), base, "{name} must change the hash");
    }
    // The fields checked against the context change the hash too, each alone: encode each under a
    // context that accepts it.
    let base_ctx = ctx();
    type Edit = fn(&mut Content, &mut Context);
    let cases: [(&str, Edit); 4] = [
        ("vault_id", |c, x| {
            c.vault_id = [0x12; 32];
            x.vault_id = [0x12; 32];
        }),
        ("network", |c, x| {
            c.network = NETWORK_MAINNET;
            x.network = NETWORK_MAINNET;
        }),
        ("threshold", |c, x| {
            c.threshold = 3;
            x.threshold = 3;
        }),
        ("total", |c, x| {
            c.total = 4;
            x.total = 4;
        }),
    ];
    for (name, f) in cases {
        let mut c = sample();
        let mut x = base_ctx;
        f(&mut c, &mut x);
        assert_ne!(content_hash(&validate(c, &x).unwrap()), base, "{name}");
    }
}

#[test]
fn it_refuses_a_content_for_another_vault_or_network() {
    let mut c = sample();
    c.vault_id = [0x12; 32];
    assert_eq!(refused(c), ContentError::VaultId);
    let mut c = sample();
    c.network = NETWORK_MAINNET;
    assert_eq!(refused(c), ContentError::Network);
    let mut c = sample();
    c.network = 0;
    assert_eq!(refused(c), ContentError::Network);
    // A network byte outside the known two is refused even when the context carries it.
    let mut c = sample();
    c.network = 3;
    let x = Context {
        network: 3,
        ..ctx()
    };
    assert_eq!(validate(c, &x).unwrap_err(), ContentError::Network);
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
    for own in [EXTERNAL, CHANGE] {
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
    // 513 bytes, ASCII and multi-byte (257 characters: measuring characters would pass it).
    let mut c = sample();
    c.lines[0].memo = "a".repeat(513);
    assert_eq!(refused(c), ContentError::Memo);
    let mut c = sample();
    c.lines[0].memo = format!("{}a", "é".repeat(256));
    assert_eq!(c.lines[0].memo.len(), 513);
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

fn expiring(expiry_unix: u64) -> ValidContent {
    let mut c = sample();
    c.expiry_unix = expiry_unix;
    valid(c)
}

#[test]
fn check_expiry_refuses_expired_and_too_far_and_takes_the_margin() {
    // An approval time that is NOT a whole second, so a millisecond boundary error shows.
    let ts = 1_800_000_000_123i64;
    let limit_ms = ts + EXPIRY_MAX_MS + EXPIRY_MARGIN_MS;
    // Open, within 72 h.
    assert_eq!(check_expiry(&expiring(1_800_003_600), ts, ts), Ok(()));
    // The last whole second at or under the limit is accepted; the next one is refused.
    let last_ok = (limit_ms / 1000) as u64;
    assert_eq!(check_expiry(&expiring(last_ok), ts, ts), Ok(()));
    assert_eq!(
        check_expiry(&expiring(last_ok + 1), ts, ts),
        Err(ContentError::ExpiryTooFar)
    );
    // The limit itself is accepted and one millisecond past it refused: an approval time whose
    // limit falls on a whole second, and one whose limit sits 1 ms before a whole second.
    let ts_even = 1_800_000_000_000i64;
    let at_limit = ((ts_even + EXPIRY_MAX_MS + EXPIRY_MARGIN_MS) / 1000) as u64;
    assert_eq!(check_expiry(&expiring(at_limit), ts_even, ts_even), Ok(()));
    let ts_999 = 1_800_000_000_999i64;
    let just_past = ((ts_999 + EXPIRY_MAX_MS + EXPIRY_MARGIN_MS + 1) / 1000) as u64;
    assert_eq!(
        check_expiry(&expiring(just_past), ts_999, ts_999),
        Err(ContentError::ExpiryTooFar)
    );
    // Expired at now == expiry, and after; open one millisecond before.
    let e = 1_800_003_600u64;
    let at = (e as i64) * 1000;
    assert_eq!(
        check_expiry(&expiring(e), ts, at),
        Err(ContentError::Expired)
    );
    assert_eq!(
        check_expiry(&expiring(e), ts, at + 1),
        Err(ContentError::Expired)
    );
    assert_eq!(check_expiry(&expiring(e), ts, at - 1), Ok(()));
    // No overflow on extreme inputs.
    assert_eq!(
        check_expiry(&expiring(u64::MAX), ts, ts),
        Err(ContentError::ExpiryTooFar)
    );
    assert_eq!(
        check_expiry(&expiring(1), i64::MIN, i64::MAX),
        Err(ContentError::Expired)
    );
}

#[test]
fn the_bounds_are_the_decided_numbers() {
    assert_eq!(EXPIRY_MAX_MS, 259_200_000);
    assert_eq!(EXPIRY_MARGIN_MS, 600_000);
    assert_eq!(CHANGE_SPLIT_MAX, 4);
    assert_eq!(MAX_MEMO_BYTES, 512);
    assert_eq!(MAX_LINES, 300);
    assert_eq!(MAX_MONEY, 2_100_000_000_000_000);
    assert_eq!(MAX_ACTIONS_FOR_CAP, 330);
    assert_eq!((NETWORK_MAINNET, NETWORK_TESTNET), (1, 2));
    assert_eq!((KIND_PAYMENT, KIND_PAYROLL), (1, 2));
    assert_eq!(RECEIVER_ORCHARD, 1);
}

#[test]
fn identical_payroll_lines_stay_two_lines() {
    // Paying the same line twice is two payments: allowed, and the device's matching (a later
    // change) is one-to-one, so two lines need two outputs.
    let mut c = sample();
    c.kind = KIND_PAYROLL;
    c.lines = vec![line(0x22, 7, "x"), line(0x22, 7, "x")];
    let two = content_hash(&valid(c.clone()));
    c.lines.pop();
    assert_ne!(content_hash(&valid(c)), two);
}

#[test]
fn memo_bytes_cannot_slide_between_lines() {
    // Length prefixes keep "a" + "bc" apart from "ab" + "c" on otherwise identical lines.
    let mut a = sample();
    a.kind = KIND_PAYROLL;
    a.lines = vec![line(0x22, 1, "a"), line(0x22, 1, "bc")];
    let mut b = a.clone();
    b.lines = vec![line(0x22, 1, "ab"), line(0x22, 1, "c")];
    assert_ne!(encode(&valid(a)), encode(&valid(b)));
}

#[test]
fn a_non_zero_extra_is_refused_until_a_device_can_show_it() {
    // `extra` is reserved for optional fields no screen shows yet: a content carrying them could be
    // neither approved nor refused by an honest device, so it is not a valid content.
    let mut c = sample();
    c.extra[0] = 1;
    assert_eq!(refused(c), ContentError::Extra);
    assert!(
        validate(sample(), &ctx()).is_ok(),
        "the twin: all-zero extra"
    );
}
