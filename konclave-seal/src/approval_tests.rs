use super::*;
use crate::proposal::{
    content_hash, validate, Content, Context, Line, KIND_PAYMENT, NETWORK_TESTNET,
    ORCHARD_RECEIVER_LEN, RECEIVER_ORCHARD,
};

/// The proposal fixture's content (proposal_tests.rs), whose hash was computed outside Rust.
fn fixture_hash() -> ContentHash {
    let ctx = Context {
        network: NETWORK_TESTNET,
        vault_id: [0x11; 32],
        threshold: 2,
        total: 3,
        external: [0x44; ORCHARD_RECEIVER_LEN],
        change: [0x55; ORCHARD_RECEIVER_LEN],
    };
    let c = Content {
        network: NETWORK_TESTNET,
        vault_id: [0x11; 32],
        kind: KIND_PAYMENT,
        lines: vec![Line {
            receiver_type: RECEIVER_ORCHARD,
            receiver: [0x22; ORCHARD_RECEIVER_LEN],
            amount: 150_000,
            memo: "hi".into(),
        }],
        proposer: 1,
        expiry_unix: 1_800_000_000,
        threshold: 2,
        total: 3,
        salt: [0x33; 32],
        fee_cap: 15_000,
        extra: [0u8; 32],
    };
    content_hash(&validate(c, &ctx).unwrap())
}

/// Another content's hash: the same content with one more zatoshi.
#[cfg(feature = "share-sig")]
fn other_hash() -> ContentHash {
    let ctx = Context {
        network: NETWORK_TESTNET,
        vault_id: [0x11; 32],
        threshold: 2,
        total: 3,
        external: [0x44; ORCHARD_RECEIVER_LEN],
        change: [0x55; ORCHARD_RECEIVER_LEN],
    };
    let c = Content {
        network: NETWORK_TESTNET,
        vault_id: [0x11; 32],
        kind: KIND_PAYMENT,
        lines: vec![Line {
            receiver_type: RECEIVER_ORCHARD,
            receiver: [0x22; ORCHARD_RECEIVER_LEN],
            amount: 150_001,
            memo: "hi".into(),
        }],
        proposer: 1,
        expiry_unix: 1_800_000_000,
        threshold: 2,
        total: 3,
        salt: [0x33; 32],
        fee_cap: 15_000,
        extra: [0u8; 32],
    };
    content_hash(&validate(c, &ctx).unwrap())
}

const FIXTURE_HASH: [u8; 32] = [
    0xa9, 0xea, 0x4a, 0x80, 0x21, 0xac, 0xd3, 0xf7, 0x06, 0xff, 0x00, 0xbc, 0xa1, 0x51, 0xec, 0x3e,
    0x40, 0x78, 0xc8, 0xdd, 0xd8, 0xe3, 0xc9, 0x82, 0x24, 0x5f, 0x54, 0xcb, 0xad, 0x11, 0xfb, 0x03,
];

#[test]
fn the_fixture_content_still_hashes_to_the_value_computed_outside_rust() {
    assert_eq!(fixture_hash().as_bytes(), &FIXTURE_HASH);
}

#[test]
fn vote_message_v2_matches_the_hand_written_bytes() {
    let mut want = b"konclave-vote-v2\0".to_vec();
    want.extend([0x11; 32]); // vault id
    want.push(0x02); // refuse
    want.extend(FIXTURE_HASH); // content hash
    want.extend([0, 2]); // seat 2
    want.extend([0, 0, 1, 163, 24, 92, 80, 123]); // ts 1,800,000,000,123 ms
    want.extend([0, 0, 0, 4]); // nonce length
    want.extend(b"abcd"); // nonce
    want.extend([0x77; 32]); // reason hash
    let got = vote_message_v2(
        &[0x11; 32],
        VoteAction::Refuse,
        &fixture_hash(),
        2,
        1_800_000_000_123,
        "abcd",
        &[0x77; 32],
    );
    assert_eq!(got, want);
    assert_ne!(got.len(), 32, "ADR-0012 D2: never a sighash's length");
}

#[test]
fn an_approval_carries_action_byte_one() {
    let got = vote_message_v2(
        &[0x11; 32],
        VoteAction::Approve,
        &fixture_hash(),
        2,
        0,
        "n",
        &[0; 32],
    );
    let at = b"konclave-vote-v2\0".len() + 32;
    assert_eq!(got[at], 0x01);
    let refuse = vote_message_v2(
        &[0x11; 32],
        VoteAction::Refuse,
        &fixture_hash(),
        2,
        0,
        "n",
        &[0; 32],
    );
    assert_eq!(refuse[at], 0x02);
}

#[test]
fn signed_v1_matches_the_hand_written_bytes() {
    let mut want = b"konclave-signed-v1\0".to_vec();
    want.extend([0x11; 32]); // vault id
    want.extend(FIXTURE_HASH); // content hash
    want.extend([0x99; 32]); // sighash
    want.extend([0, 0, 0, 3]); // spend index 3
    want.extend([0, 2]); // seat 2
    want.extend([0, 0, 1, 163, 24, 92, 80, 123]); // ts
    let got = signed_v1(
        &[0x11; 32],
        &fixture_hash(),
        &[0x99; 32],
        3,
        2,
        1_800_000_000_123,
    );
    assert_eq!(got, want);
    assert_ne!(got.len(), 32);
}

#[test]
fn the_reason_hash_is_sha256_of_the_reason_or_zeros() {
    assert_eq!(reason_hash(""), [0u8; 32]);
    // SHA-256("no") computed outside Rust (Python hashlib).
    assert_eq!(
        crate::hex::encode_lower(&reason_hash("no")),
        "9390298f3fb0c5b160498935d79cb139aef28e1c47358b4bbba61862b9c26e59"
    );
}

#[cfg(feature = "share-sig")]
mod verify {
    use super::*;
    use ed25519_dalek::{Signer, SigningKey};

    /// Seat 2's write key, derived the way a device derives it, and seat 1's.
    fn key2() -> SigningKey {
        SigningKey::from_bytes(&crate::write_key_seed_from_share(b"seat 2 key package"))
    }
    fn key1() -> SigningKey {
        SigningKey::from_bytes(&crate::write_key_seed_from_share(b"seat 1 key package"))
    }
    fn keys() -> Vec<SeatKey> {
        vec![
            SeatKey {
                seat: 1,
                write_pub: key1().verifying_key().to_bytes(),
            },
            SeatKey {
                seat: 2,
                write_pub: key2().verifying_key().to_bytes(),
            },
        ]
    }

    fn signed(
        k: &SigningKey,
        seat: u16,
        action: VoteAction,
        hash: &ContentHash,
        reason: [u8; 32],
        nonce: &str,
    ) -> Envelope {
        let msg = vote_message_v2(
            &[0x11; 32],
            action,
            hash,
            seat,
            1_800_000_000_123,
            nonce,
            &reason,
        );
        Envelope {
            vault_id: [0x11; 32],
            action,
            content_hash: *hash.as_bytes(),
            seat,
            ts_ms: 1_800_000_000_123,
            nonce: nonce.into(),
            reason_hash: reason,
            sig: k.sign(&msg).to_bytes(),
        }
    }

    fn envelope(action: VoteAction, hash: &ContentHash, reason: [u8; 32]) -> Envelope {
        signed(&key2(), 2, action, hash, reason, "abcd")
    }

    fn check(env: &Envelope, hash: &ContentHash) -> Result<VerifiedVote, EnvelopeError> {
        verify_vote(&keys(), &[0x11; 32], env, hash, |_| false)
    }

    #[test]
    fn an_approval_and_a_refusal_verify_for_the_seat_that_signed() {
        let h = fixture_hash();
        let v = check(&envelope(VoteAction::Approve, &h, [0; 32]), &h).unwrap();
        assert_eq!(
            (v.seat(), v.action(), v.ts_ms()),
            (2, VoteAction::Approve, 1_800_000_000_123)
        );
        let v = check(&envelope(VoteAction::Refuse, &h, reason_hash("no")), &h).unwrap();
        assert_eq!(v.action(), VoteAction::Refuse);
    }

    #[test]
    fn a_seat_cannot_vote_in_another_seats_name() {
        // Seat 1's key signs a vote that says seat 2: it must not count for seat 2.
        let h = fixture_hash();
        let forged = signed(&key1(), 2, VoteAction::Approve, &h, [0; 32], "abcd");
        assert_eq!(check(&forged, &h), Err(EnvelopeError::BadSignature));
        // A seat with no registered key.
        let stranger = signed(&key1(), 3, VoteAction::Approve, &h, [0; 32], "abcd");
        assert_eq!(check(&stranger, &h), Err(EnvelopeError::UnknownSeat));
    }

    #[test]
    fn a_used_nonce_is_refused_before_the_signature_is_checked() {
        let h = fixture_hash();
        let env = envelope(VoteAction::Approve, &h, [0; 32]);
        let mut asked = None;
        let r = verify_vote(&keys(), &[0x11; 32], &env, &h, |n| {
            asked = Some(n.to_string());
            true
        });
        assert_eq!(r, Err(EnvelopeError::Replay));
        assert_eq!(asked.as_deref(), Some("abcd"));
    }

    #[test]
    fn a_vote_over_one_content_never_counts_for_another() {
        let (a, b) = (fixture_hash(), other_hash());
        let env = envelope(VoteAction::Approve, &a, [0; 32]);
        assert_eq!(check(&env, &b), Err(EnvelopeError::WrongContent));
        let mut relabelled = env;
        relabelled.content_hash = *b.as_bytes();
        assert_eq!(check(&relabelled, &b), Err(EnvelopeError::BadSignature));
    }

    #[test]
    fn a_v1_write_signature_never_verifies_as_a_v2_vote() {
        let h = fixture_hash();
        let hex_id = crate::hex::encode_lower(&[0x11; 32]);
        let v1 = crate::write_message(
            &hex_id,
            crate::WriteAction::Approve,
            &crate::proposal::proposal_id(&h),
            2,
            1_800_000_000_123,
            "abcd",
        );
        let mut env = envelope(VoteAction::Approve, &h, [0; 32]);
        env.sig = key2().sign(&v1).to_bytes();
        assert_eq!(check(&env, &h), Err(EnvelopeError::BadSignature));
        let v2 = vote_message_v2(
            &[0x11; 32],
            VoteAction::Approve,
            &h,
            2,
            1_800_000_000_123,
            "abcd",
            &[0; 32],
        );
        assert_ne!(v1, v2);
        assert!(!v2.starts_with(crate::domains::WRITE_V1));
    }

    #[test]
    fn every_field_is_covered_by_the_signature() {
        let h = fixture_hash();
        type Edit = fn(&mut Envelope);
        // From a refusal: every edit leaves a well-formed envelope, so only the signature can refuse it.
        let refusal = envelope(VoteAction::Refuse, &h, reason_hash("no"));
        let edits: [(&str, Edit); 4] = [
            ("ts", |e| e.ts_ms += 1),
            ("nonce", |e| e.nonce = "abce".into()),
            ("reason", |e| e.reason_hash = reason_hash("yes")),
            ("seat", |e| e.seat = 1),
        ];
        for (name, edit) in edits {
            let mut e = refusal.clone();
            edit(&mut e);
            assert_eq!(check(&e, &h), Err(EnvelopeError::BadSignature), "{name}");
        }
        // The action: an approval with zero reason relabelled as a refusal.
        let mut e = envelope(VoteAction::Approve, &h, [0; 32]);
        e.action = VoteAction::Refuse;
        assert_eq!(check(&e, &h), Err(EnvelopeError::BadSignature), "action");
    }

    #[test]
    fn it_refuses_another_vault_and_malformed_fields_and_takes_a_64_byte_nonce() {
        let h = fixture_hash();
        let env = envelope(VoteAction::Approve, &h, [0; 32]);
        assert_eq!(
            verify_vote(&keys(), &[0x12; 32], &env, &h, |_| false),
            Err(EnvelopeError::WrongVault)
        );
        let with_reason = envelope(VoteAction::Approve, &h, reason_hash("no"));
        assert_eq!(check(&with_reason, &h), Err(EnvelopeError::Malformed));
        for nonce in [String::new(), "n".repeat(NONCE_MAX_BYTES + 1)] {
            let mut e = env.clone();
            e.nonce = nonce;
            assert_eq!(check(&e, &h), Err(EnvelopeError::Malformed));
        }
        let at_limit = signed(
            &key2(),
            2,
            VoteAction::Approve,
            &h,
            [0; 32],
            &"n".repeat(NONCE_MAX_BYTES),
        );
        assert!(check(&at_limit, &h).is_ok());
    }

    #[test]
    fn a_registered_key_that_is_not_a_point_is_refused() {
        let h = fixture_hash();
        let env = envelope(VoteAction::Approve, &h, [0; 32]);
        let not_a_point = (0u8..=255)
            .map(|i| [i; 32])
            .find(|b| ed25519_dalek::VerifyingKey::from_bytes(b).is_err())
            .expect("some repeated byte is not a curve point");
        let bad = [SeatKey {
            seat: 2,
            write_pub: not_a_point,
        }];
        assert_eq!(
            verify_vote(&bad, &[0x11; 32], &env, &h, |_| false),
            Err(EnvelopeError::BadKey)
        );
    }

    #[test]
    fn a_small_order_key_never_verifies() {
        // The identity point as a key, with the signature (R = identity, s = 0): plain `verify`
        // accepts it for any message; `verify_strict` must not.
        let h = fixture_hash();
        let mut identity = [0u8; 32];
        identity[0] = 1;
        let mut env = envelope(VoteAction::Approve, &h, [0; 32]);
        let mut sig = [0u8; 64];
        sig[0] = 1;
        env.sig = sig;
        let weak = [SeatKey {
            seat: 2,
            write_pub: identity,
        }];
        assert!(verify_vote(&weak, &[0x11; 32], &env, &h, |_| false).is_err());
    }
}
