//! Authenticating a governance write (#288, ADR-0011).
//!
//! `approve`, `refuse` and `rename` are unauthenticated today: the helper checks the *name* on the
//! write, never *who is presenting it*. Anyone who can reach the vault can cast a real member's
//! vote, and `rename` is not bound to the seat that owns it.
//!
//! ADR-0011 authenticates them with a **per-device Ed25519 key derived from the share**, kept
//! separate from the FROST signing share - the hygiene `frost-client` follows, where a participant's
//! `CommunicationKey` authenticates coordination and the `key_package` signs threshold transactions
//! and nothing else.
//!
//! This module is the rule and only the rule: canonical bytes, signature check, replay check, seat
//! binding, and the migration gate. It lives here, beside `read_authorized`, because BOTH backends
//! must answer identically - the hosted helper and the local bridge - and a rule written twice gets
//! fixed in one place and forgotten in the other (ADR-0011 D6, #349, #215).
//!
//! It performs no I/O and knows nothing about HTTP. Callers supply the registered keys and a way to
//! ask whether a nonce has been seen.

// The action and the canonical bytes live in `konclave-seal`, the crate the DEVICE also uses to
// sign. One implementation of the format, shared, so the two sides cannot drift: a second copy
// here would fail in the field as "your vote was refused" with nothing pointing at the cause.
pub use konclave_seal::{write_message, WriteAction};

/// A device registered to write for a seat: ADR-0011 D4's extension of `device-keys.json`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct WriteKey {
    /// The 1-based FROST seat this device holds.
    pub seat: u16,
    /// Its Ed25519 write-verifying key, hex. Public material.
    pub pubkey: String,
}

/// The proof a device presents with its write.
#[derive(Debug, Clone)]
pub struct SignedWrite {
    pub seat: u16,
    /// Sender's clock, ms. Signed, so it cannot be moved.
    pub ts: i64,
    /// Single-use, per vault. Signed, and checked against what the caller has already seen.
    pub nonce: String,
    /// Ed25519 signature over [`write_message`], hex.
    pub sig: String,
}

/// The answer. `Open` is the migration state, not a success.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum WriteAuth {
    /// No device has registered a write key for this vault yet, so the vault still accepts
    /// unauthenticated writes (ADR-0011 D5). Existing vaults never break; once seats register, the
    /// same vault starts REQUIRING proof.
    Open,
    /// Proven: this write was signed by the device holding `seat`.
    Authorized { seat: u16 },
    /// Refused, with why. The reason is for the operator's log, never for the attacker.
    Refused(WriteRefusal),
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum WriteRefusal {
    /// The seat claimed has no registered key on this vault.
    UnknownSeat,
    /// The signature does not verify for that seat's key.
    BadSignature,
    /// Malformed hex, wrong length, or otherwise unparseable.
    Malformed,
    /// This nonce was already used on this vault.
    Replay,
}

/// Decide whether a governance write is authentic.
///
/// `seen_nonce` answers whether this vault has already accepted that nonce. It is a closure so this
/// stays I/O-free and both backends can back it with whatever they already have.
pub fn authorize_write(
    keys: &[WriteKey],
    vault_id: &str,
    action: WriteAction,
    target: &str,
    w: &SignedWrite,
    seen_nonce: impl Fn(&str) -> bool,
) -> WriteAuth {
    // The migration gate first (ADR-0011 D5): a vault where no device has registered a write key
    // still accepts unauthenticated writes, so the vaults that exist today keep working. This is
    // deliberately its OWN answer and not `Authorized` - a caller must be unable to confuse "nobody
    // has migrated yet" with "this write was proven".
    if keys.is_empty() {
        return WriteAuth::Open;
    }

    // Cheap, attacker-controlled checks before any crypto: a flood of forged writes should cost
    // parsing, not signature verification.
    let Some(key) = keys.iter().find(|k| k.seat == w.seat) else {
        return WriteAuth::Refused(WriteRefusal::UnknownSeat);
    };
    let (Some(sig_bytes), Some(pub_bytes)) = (unhex32x2(&w.sig), unhex32(&key.pubkey)) else {
        return WriteAuth::Refused(WriteRefusal::Malformed);
    };
    if seen_nonce(&w.nonce) {
        return WriteAuth::Refused(WriteRefusal::Replay);
    }

    let Ok(vk) = ed25519_dalek::VerifyingKey::from_bytes(&pub_bytes) else {
        return WriteAuth::Refused(WriteRefusal::Malformed);
    };
    let msg = write_message(vault_id, action, target, w.seat, w.ts, &w.nonce);
    match vk.verify_strict(&msg, &ed25519_dalek::Signature::from_bytes(&sig_bytes)) {
        Ok(()) => WriteAuth::Authorized { seat: w.seat },
        Err(_) => WriteAuth::Refused(WriteRefusal::BadSignature),
    }
}

/// The member who holds `seat`, or `None` when the roster cannot say.
///
/// Seats are positional. The DKG assigns them, the roster is written in seat order when the vault is
/// created, and a rename changes a name in place - so seat N is `roster[N-1]` for the life of the
/// vault. Seat 0 does not exist: FROST identifiers start at 1.
pub fn seat_holder(roster: &[String], seat: u16) -> Option<&str> {
    let i = usize::from(seat).checked_sub(1)?;
    roster.get(i).map(String::as_str)
}

/// Whether the device that PROVED `seat` may act under `name`.
///
/// [`authorize_write`] answers who asked. It cannot answer whose name they may use, because the name
/// is not in the signed bytes for a vote and is the signer's own choice for a proposal. Every write
/// that records a name has to ask this as well, and until #568 only the rename did: a member signed
/// correctly for their own seat and the vote was recorded under whichever roster name the request
/// carried.
///
/// An empty roster, or a seat past its end, answers `false`. A seat cannot be bound to a name that
/// was never recorded, and answering `true` there would be the defect again for exactly the vaults
/// least able to show it.
///
/// Whitespace at the edges is ignored on BOTH sides, and nothing else is. The device signs and
/// sends its name trimmed, while a roster keeps names as they arrived, so a roster entry stored as
/// `"bob "` would otherwise lock seat 2 out of every write, the rename that could repair it
/// included. Case, inner spaces and look-alike characters are different names.
///
/// What is RECORDED is never decided here. The caller records [`seat_holder`], the roster's own
/// spelling, so this tolerance cannot turn one member into two.
pub fn seat_acts_as(roster: &[String], seat: u16, name: &str) -> bool {
    member_name(name)
        .is_some_and(|name| seat_holder(roster, seat).and_then(member_name) == Some(name))
}

/// How many MEMBERS a list of recorded names amounts to (#575): each name counts at most as many
/// times as the roster has seats under it, and a name under no seat does not count.
///
/// An approval is recorded as a name, and the count used to be the length of the list. Nothing
/// checked that an entry belongs to a member, or that two entries belong to two members. So an
/// approval planted as `"alice "` while a vault still took unsigned writes went on counting beside
/// alice's own signed vote, recorded as `"alice"`, and a 2-of-2 proposal read as approved by both.
///
/// Names are compared the way [`seat_acts_as`] compares them, through the same function, because a
/// count that disagreed with the binding would hand back what the binding refuses.
///
/// Two seats under the same name can count as two only when their entries are two entries. A vote
/// replaces the earlier entry of the same member ([`same_member`]), so two seats both called
/// `"bob"` leave one entry and count as one; telling them apart needs the seat recorded with the
/// vote.
///
/// A vault with no roster has nothing to match against, so every entry counts, as it always did.
pub fn members_counted(entries: &[String], roster: &[String]) -> usize {
    if roster.is_empty() {
        return entries.len();
    }
    let mut seats: std::collections::HashMap<&str, usize> = std::collections::HashMap::new();
    for name in roster.iter().filter_map(|n| member_name(n)) {
        *seats.entry(name).or_default() += 1;
    }
    entries
        .iter()
        .filter_map(|e| member_name(e))
        .filter(|name| match seats.get_mut(name) {
            Some(free) if *free > 0 => {
                *free -= 1;
                true
            }
            _ => false,
        })
        .count()
}

/// Whether two recorded names are the same member's, compared as everywhere here.
///
/// A vote replaces what was recorded for its member before (#575). By exact string, an entry
/// planted as `"alice "` while a vault took unsigned writes survived alice's own vote: she refused,
/// and the planted approval went on counting as hers.
///
/// Two seats whose names differ only at the edges therefore replace each other's votes, as two seats
/// with the identical name already did. [`seat_acts_as`] treats them as one name too.
pub fn same_member(a: &str, b: &str) -> bool {
    member_key(a) == member_key(b)
}

/// The one comparison every name check here makes: whitespace at the edges is ignored and nothing
/// else is.
fn member_key(name: &str) -> &str {
    name.trim()
}

/// A name as a member, or `None` for one that is empty once trimmed: a blank name names nobody.
fn member_name(name: &str) -> Option<&str> {
    let name = member_key(name);
    (!name.is_empty()).then_some(name)
}

/// Exactly 32 bytes from hex, or `None`. Length is part of the check: a short key is malformed, not
/// something to pad.
fn unhex32(h: &str) -> Option<[u8; 32]> {
    let v = unhex(h)?;
    v.try_into().ok()
}

/// Exactly 64 bytes from hex (an Ed25519 signature), or `None`.
fn unhex32x2(h: &str) -> Option<[u8; 64]> {
    let v = unhex(h)?;
    v.try_into().ok()
}

fn unhex(h: &str) -> Option<Vec<u8>> {
    if !h.len().is_multiple_of(2) {
        return None;
    }
    (0..h.len())
        .step_by(2)
        .map(|i| u8::from_str_radix(&h[i..i + 2], 16).ok())
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    use ed25519_dalek::{Signer, SigningKey};

    fn hexs(b: &[u8]) -> String {
        b.iter().map(|x| format!("{x:02x}")).collect()
    }

    /// A device at `seat`, with its registered key and a way to sign a write for it.
    struct Device {
        seat: u16,
        sk: SigningKey,
    }
    impl Device {
        fn new(seat: u16, seed: u8) -> Self {
            Device {
                seat,
                sk: SigningKey::from_bytes(&[seed; 32]),
            }
        }
        fn registered(&self) -> WriteKey {
            WriteKey {
                seat: self.seat,
                pubkey: hexs(self.sk.verifying_key().as_bytes()),
            }
        }
        fn sign(&self, vault: &str, a: WriteAction, target: &str, nonce: &str) -> SignedWrite {
            let ts = 1_700_000_000_000;
            let msg = write_message(vault, a, target, self.seat, ts, nonce);
            SignedWrite {
                seat: self.seat,
                ts,
                nonce: nonce.into(),
                sig: hexs(&self.sk.sign(&msg).to_bytes()),
            }
        }
    }

    const V: &str = "vault-1";
    fn never_seen(_: &str) -> bool {
        false
    }

    fn roster(names: &[&str]) -> Vec<String> {
        names.iter().map(|n| n.to_string()).collect()
    }

    /// #568. The binding the vote and the proposal never had.
    #[test]
    fn a_seat_acts_only_under_the_name_the_roster_gives_it() {
        let r = roster(&["alice", "bob", "carol"]);
        assert_eq!(seat_holder(&r, 1), Some("alice"));
        assert_eq!(seat_holder(&r, 3), Some("carol"));
        assert!(seat_acts_as(&r, 2, "bob"));
        assert!(
            !seat_acts_as(&r, 1, "bob"),
            "seat 1 signs perfectly and is still not bob"
        );
    }

    /// The edges are where a positional rule goes wrong: an index that underflows, one that runs
    /// past the end, and a roster that was never written.
    #[test]
    fn a_seat_the_roster_cannot_name_acts_as_nobody() {
        let r = roster(&["alice", "bob"]);
        assert_eq!(
            seat_holder(&r, 0),
            None,
            "there is no seat 0, and it must not wrap to the last"
        );
        assert_eq!(seat_holder(&r, 3), None, "past the end of the roster");
        assert!(!seat_acts_as(&r, 3, "alice"));
        assert!(
            !seat_acts_as(&[], 1, "alice"),
            "no roster, no binding: fail closed"
        );
        assert!(
            !seat_acts_as(&[], 1, ""),
            "and an empty name does not match an empty roster"
        );
    }

    /// A near match is a different member, not a typo to forgive.
    #[test]
    fn a_name_that_almost_matches_is_a_different_member() {
        let r = roster(&["alice", "bob"]);
        assert!(!seat_acts_as(&r, 1, "Alice"));
        assert!(!seat_acts_as(&r, 1, "al ice"));
        assert!(
            !seat_acts_as(&r, 1, "alice\u{200b}"),
            "a zero-width space is not whitespace"
        );
        assert!(!seat_acts_as(&r, 1, ""));
        assert!(!seat_acts_as(&r, 1, "   "));
    }

    /// Found in review: the claim was trimmed and the roster entry was not, so a roster that
    /// stored `"bob "` refused seat 2 under both spellings, and refused the rename that could have
    /// repaired it. A roster keeps names as they arrived, so this is a state a vault can be in.
    #[test]
    fn whitespace_at_the_edges_is_ignored_on_both_sides() {
        let r = roster(&["alice", "bob ", " carol"]);
        assert!(seat_acts_as(&r, 2, "bob"));
        assert!(seat_acts_as(&r, 2, "bob "));
        assert!(seat_acts_as(&r, 3, "carol"));
        assert!(seat_acts_as(&r, 1, " alice\u{00a0}"));
        // And the roster's own spelling is what the caller is given to record.
        assert_eq!(seat_holder(&r, 2), Some("bob "));
        // Forgiving the edges does not let one seat act as another.
        assert!(!seat_acts_as(&r, 1, "bob"));
        assert!(!seat_acts_as(&r, 2, "carol"));
    }

    /// An empty roster entry names nobody, so nothing matches it, an empty claim included.
    #[test]
    fn a_seat_whose_roster_entry_is_blank_acts_as_nobody() {
        let r = roster(&["alice", "  "]);
        assert!(!seat_acts_as(&r, 2, ""));
        assert!(!seat_acts_as(&r, 2, "  "));
        assert!(!seat_acts_as(&r, 2, "alice"));
    }

    /// End to end across the crates: derive the key the way the DEVICE derives it, sign, verify.
    ///
    /// Worth being precise about what this does and does not prove. It CANNOT catch the two sides
    /// drifting on the message format or the HKDF label - because after moving both into
    /// `konclave-seal`, which the device signs from and this verifies with, there is only ONE
    /// implementation and drift is impossible rather than detectable. An earlier version of this
    /// test claimed to catch it and did not: it built the message with the same function it
    /// verified with, so it was self-consistent by construction and passed whatever I changed.
    ///
    /// What it proves is the COMPOSITION: seed -> signing key -> registered pubkey -> canonical
    /// bytes -> verification all line up, so a wrong seat, a mis-assembled message or a key taken
    /// from the wrong place fails here.
    #[test]
    fn a_signature_made_the_way_the_device_makes_it_verifies_here() {
        let share = b"a serialized key package, for the test";
        // Exactly what `konclave-seal::write_key_seed_from_share` does.
        let seed = konclave_seal::write_key_seed_from_share(share);
        let sk = SigningKey::from_bytes(&seed);

        let keys = [WriteKey {
            seat: 2,
            pubkey: hexs(sk.verifying_key().as_bytes()),
        }];
        let ts = 1_700_000_000_000;
        let msg = write_message(V, WriteAction::Refuse, "prop-9", 2, ts, "n-cross");
        let w = SignedWrite {
            seat: 2,
            ts,
            nonce: "n-cross".into(),
            sig: hexs(&sk.sign(&msg).to_bytes()),
        };

        assert_eq!(
            authorize_write(&keys, V, WriteAction::Refuse, "prop-9", &w, never_seen),
            WriteAuth::Authorized { seat: 2 }
        );
    }

    #[test]
    fn a_seated_device_signing_its_own_write_is_authorized() {
        let alice = Device::new(1, 1);
        let keys = [alice.registered()];
        let w = alice.sign(V, WriteAction::Approve, "prop-1", "n1");
        assert_eq!(
            authorize_write(&keys, V, WriteAction::Approve, "prop-1", &w, never_seen),
            WriteAuth::Authorized { seat: 1 }
        );
    }

    #[test]
    fn an_outsider_with_no_key_cannot_write_at_all() {
        // The critical attack in #288: reach the vault, POST a vote. Today it works.
        let alice = Device::new(1, 1);
        let outsider = Device::new(1, 9); // claims Alice's seat, holds a key nobody registered
        let keys = [alice.registered()];
        let w = outsider.sign(V, WriteAction::Approve, "prop-1", "n1");
        assert_eq!(
            authorize_write(&keys, V, WriteAction::Approve, "prop-1", &w, never_seen),
            WriteAuth::Refused(WriteRefusal::BadSignature)
        );
    }

    #[test]
    fn a_real_member_cannot_write_as_another_seat() {
        // Insider impersonation, which ADR-0011 says is the residual threat after #388.
        let alice = Device::new(1, 1);
        let bob = Device::new(2, 2);
        let keys = [alice.registered(), bob.registered()];
        // Alice signs, but claims seat 2.
        let mut w = alice.sign(V, WriteAction::Approve, "prop-1", "n1");
        w.seat = 2;
        assert_eq!(
            authorize_write(&keys, V, WriteAction::Approve, "prop-1", &w, never_seen),
            WriteAuth::Refused(WriteRefusal::BadSignature)
        );
    }

    #[test]
    fn a_signature_cannot_be_replayed_as_a_different_action() {
        // An approval captured off the wire must not become a refusal.
        let alice = Device::new(1, 1);
        let keys = [alice.registered()];
        let w = alice.sign(V, WriteAction::Approve, "prop-1", "n1");
        assert_eq!(
            authorize_write(&keys, V, WriteAction::Refuse, "prop-1", &w, never_seen),
            WriteAuth::Refused(WriteRefusal::BadSignature)
        );
    }

    #[test]
    fn a_signature_cannot_be_moved_to_another_proposal_or_vault() {
        let alice = Device::new(1, 1);
        let keys = [alice.registered()];
        let w = alice.sign(V, WriteAction::Approve, "prop-1", "n1");
        assert_eq!(
            authorize_write(&keys, V, WriteAction::Approve, "prop-2", &w, never_seen),
            WriteAuth::Refused(WriteRefusal::BadSignature),
            "another proposal"
        );
        assert_eq!(
            authorize_write(
                &keys,
                "vault-2",
                WriteAction::Approve,
                "prop-1",
                &w,
                never_seen
            ),
            WriteAuth::Refused(WriteRefusal::BadSignature),
            "another vault"
        );
    }

    #[test]
    fn a_used_nonce_is_refused_even_though_the_signature_is_perfect() {
        // Replay of a genuine write: same bytes, sent twice.
        let alice = Device::new(1, 1);
        let keys = [alice.registered()];
        let w = alice.sign(V, WriteAction::Approve, "prop-1", "n1");
        assert_eq!(
            authorize_write(&keys, V, WriteAction::Approve, "prop-1", &w, |n| n == "n1"),
            WriteAuth::Refused(WriteRefusal::Replay)
        );
    }

    #[test]
    fn a_seat_with_no_registered_key_is_refused_when_others_have_one() {
        let alice = Device::new(1, 1);
        let ghost = Device::new(3, 3);
        let keys = [alice.registered()];
        let w = ghost.sign(V, WriteAction::Approve, "prop-1", "n1");
        assert_eq!(
            authorize_write(&keys, V, WriteAction::Approve, "prop-1", &w, never_seen),
            WriteAuth::Refused(WriteRefusal::UnknownSeat)
        );
    }

    #[test]
    fn garbage_is_refused_as_malformed_and_never_panics() {
        // This runs on attacker-controlled input on an internet-facing endpoint.
        let alice = Device::new(1, 1);
        let keys = [alice.registered()];
        for bad in ["", "zz", "ff", &"ab".repeat(63), &"ab".repeat(65)] {
            let w = SignedWrite {
                seat: 1,
                ts: 1,
                nonce: "n".into(),
                sig: bad.into(),
            };
            assert_eq!(
                authorize_write(&keys, V, WriteAction::Approve, "p", &w, never_seen),
                WriteAuth::Refused(WriteRefusal::Malformed),
                "sig {bad:?}"
            );
        }
    }

    #[test]
    fn a_vault_with_no_registered_keys_stays_open_so_existing_vaults_do_not_break() {
        // ADR-0011 D5. The 8 live vaults have no write keys; requiring proof today would freeze
        // every one of them. `Open` is the migration state, and it is deliberately NOT `Authorized`
        // so a caller cannot confuse "nobody has migrated" with "this was proven".
        let alice = Device::new(1, 1);
        let w = alice.sign(V, WriteAction::Approve, "prop-1", "n1");
        assert_eq!(
            authorize_write(&[], V, WriteAction::Approve, "prop-1", &w, never_seen),
            WriteAuth::Open
        );
    }

    #[test]
    fn the_canonical_message_cannot_be_confused_by_a_target_containing_a_separator() {
        // A rename's target is `old\0new`, so a member could otherwise choose a name that makes two
        // different writes encode identically. Length prefixes make that impossible.
        let a = write_message(V, WriteAction::Rename, "ab\0c", 1, 1, "n");
        let b = write_message(V, WriteAction::Rename, "a\0bc", 1, 1, "n");
        assert_ne!(a, b);
    }

    /// #575, the case in the issue: an approval planted as another spelling of a member's name,
    /// beside that member's own, is one member.
    #[test]
    fn two_spellings_of_one_member_count_once() {
        let r = roster(&["alice", "bob"]);
        assert_eq!(members_counted(&roster(&["alice ", "alice"]), &r), 1);
        assert_eq!(members_counted(&roster(&["alice\u{00a0}", "alice"]), &r), 1);
        assert_eq!(members_counted(&roster(&["alice", "bob"]), &r), 2);
    }

    #[test]
    fn a_name_on_no_seat_does_not_count() {
        let r = roster(&["alice", "bob"]);
        assert_eq!(members_counted(&roster(&["mallory"]), &r), 0);
        assert_eq!(members_counted(&roster(&["mallory", "alice"]), &r), 1);
        // Case, inner spaces and look-alikes are different names, exactly as in the binding.
        assert_eq!(
            members_counted(&roster(&["Alice", "al ice", "alice\u{200b}"]), &r),
            0
        );
        // A blank entry names nobody, and a blank seat is nobody's.
        assert_eq!(members_counted(&roster(&["", "  "]), &r), 0);
        assert_eq!(
            members_counted(&roster(&["", " "]), &roster(&["", "bob"])),
            0
        );
    }

    /// Two seats under one name are two members, so two entries under it count as two and are not
    /// capped at one. This is the count alone: a vote replaces its member's earlier entry, so in a
    /// vault two such seats still leave one entry (Known limits).
    #[test]
    fn the_count_gives_each_seat_under_a_name_its_own_entry() {
        let r = roster(&["bob", "bob "]);
        assert_eq!(members_counted(&roster(&["bob", "bob "]), &r), 2);
        // But never more entries than seats.
        assert_eq!(members_counted(&roster(&["bob", "bob ", " bob"]), &r), 2);
    }

    /// A vault that never recorded a roster has nothing to match against, and keeps the count it
    /// always had rather than counting nobody.
    #[test]
    fn a_vault_with_no_roster_counts_every_entry() {
        assert_eq!(members_counted(&roster(&["alice ", "alice"]), &[]), 2);
        assert_eq!(members_counted(&[], &[]), 0);
    }
}
