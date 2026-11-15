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

    /// A write key derived the way a device derives it, from a key package's bytes.
    fn key() -> SigningKey {
        SigningKey::from_bytes(&crate::write_key_seed_from_share(b"a key package"))
    }

    fn envelope(
        k: &SigningKey,
        action: VoteAction,
        hash: &ContentHash,
        reason: [u8; 32],
    ) -> Envelope {
        let msg = vote_message_v2(
            &[0x11; 32],
            action,
            hash,
            2,
            1_800_000_000_123,
            "abcd",
            &reason,
        );
        Envelope {
            vault_id: [0x11; 32],
            action,
            content_hash: *hash.as_bytes(),
            seat: 2,
            ts_ms: 1_800_000_000_123,
            nonce: "abcd".into(),
            reason_hash: reason,
            sig: k.sign(&msg).to_bytes(),
        }
    }

    fn check(
        k: &SigningKey,
        env: &Envelope,
        hash: &ContentHash,
    ) -> Result<VoteAction, EnvelopeError> {
        verify_envelope(&k.verifying_key().to_bytes(), &[0x11; 32], env, hash)
    }

    #[test]
    fn an_approval_and_a_refusal_verify_and_say_which() {
        let k = key();
        let h = fixture_hash();
        assert_eq!(
            check(&k, &envelope(&k, VoteAction::Approve, &h, [0; 32]), &h),
            Ok(VoteAction::Approve)
        );
        assert_eq!(
            check(
                &k,
                &envelope(&k, VoteAction::Refuse, &h, reason_hash("no")),
                &h
            ),
            Ok(VoteAction::Refuse)
        );
    }

    #[test]
    fn a_vote_over_one_content_never_counts_for_another() {
        let k = key();
        let (a, b) = (fixture_hash(), other_hash());
        let env = envelope(&k, VoteAction::Approve, &a, [0; 32]);
        assert_eq!(check(&k, &env, &b), Err(EnvelopeError::WrongContent));
        // Relabelled to claim B, its signature is still over A.
        let mut relabelled = env;
        relabelled.content_hash = *b.as_bytes();
        assert_eq!(check(&k, &relabelled, &b), Err(EnvelopeError::BadSignature));
    }

    #[test]
    fn a_v1_write_signature_never_verifies_as_a_v2_vote() {
        let k = key();
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
        let mut env = envelope(&k, VoteAction::Approve, &h, [0; 32]);
        env.sig = k.sign(&v1).to_bytes();
        assert_eq!(check(&k, &env, &h), Err(EnvelopeError::BadSignature));
        // And the reverse: a v2 message is not a v1 one.
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
        let k = key();
        let h = fixture_hash();
        let good = envelope(&k, VoteAction::Refuse, &h, reason_hash("no"));
        let edits: [(&str, fn(&mut Envelope)); 5] = [
            ("action", |e| e.action = VoteAction::Approve),
            ("seat", |e| e.seat = 3),
            ("ts", |e| e.ts_ms += 1),
            ("nonce", |e| e.nonce = "abce".into()),
            ("reason", |e| e.reason_hash = reason_hash("yes")),
        ];
        for (name, edit) in edits {
            let mut e = good.clone();
            edit(&mut e);
            let r = check(&k, &e, &h);
            assert!(
                matches!(
                    r,
                    Err(EnvelopeError::BadSignature) | Err(EnvelopeError::Malformed)
                ),
                "{name}: {r:?}"
            );
            assert!(r.is_err(), "{name}");
        }
    }

    #[test]
    fn it_refuses_another_vault_another_key_and_malformed_fields() {
        let k = key();
        let h = fixture_hash();
        let env = envelope(&k, VoteAction::Approve, &h, [0; 32]);
        assert_eq!(
            verify_envelope(&k.verifying_key().to_bytes(), &[0x12; 32], &env, &h),
            Err(EnvelopeError::WrongVault)
        );
        let other = SigningKey::from_bytes(&[9; 32]);
        assert_eq!(check(&other, &env, &h), Err(EnvelopeError::BadSignature));
        // An approval carrying a reason.
        let with_reason = envelope(&k, VoteAction::Approve, &h, reason_hash("no"));
        assert_eq!(check(&k, &with_reason, &h), Err(EnvelopeError::Malformed));
        // Empty and oversized nonces.
        for nonce in [String::new(), "n".repeat(NONCE_MAX_BYTES + 1)] {
            let mut e = env.clone();
            e.nonce = nonce;
            assert_eq!(check(&k, &e, &h), Err(EnvelopeError::Malformed));
        }
        // A key that is not a curve point.
        assert_eq!(
            verify_envelope(&[0xff; 32], &[0x11; 32], &env, &h),
            Err(EnvelopeError::BadKey)
        );
    }
}
