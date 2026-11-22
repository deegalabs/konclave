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

/// The longest nonce a signed write may carry. The app sends a 36-character UUID; the coordinator
/// remembers the nonces it has accepted, so their size is bounded here, before anything is signed
/// over or stored.
pub const MAX_NONCE_BYTES: usize = 64;
// The app's own nonce (a UUID, 36 bytes) must fit.
const _: () = assert!(MAX_NONCE_BYTES >= 36);

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
    if w.nonce.is_empty() || w.nonce.len() > MAX_NONCE_BYTES {
        return WriteAuth::Refused(WriteRefusal::Malformed);
    }
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

/// Whether two recorded names are the same member's, compared as everywhere here.
///
/// Names in the record are compared with it (#575); votes are counted by seat (see [`counted`]).
///
/// Two seats whose names differ only at the edges therefore replace each other's votes, as two seats
/// with the identical name already did. [`seat_acts_as`] treats them as one name too.
pub fn same_member(a: &str, b: &str) -> bool {
    konclave_seal::same_member(a, b)
}

/// The signed write that recorded a vote, kept with it (#575).
///
/// Only [`authorize_write`] answering `Authorized` may produce one: it is what makes a vote count on
/// a vault that requires signatures, so it is never built from what a request body says.
///
/// It is the write the device signed, not yet an approval of the proposal's CONTENT: a vote signs
/// the proposal id, and the proposer's own approval signs a `Propose` over the proposer's name.
/// Binding an approval to what it pays is #567, and it extends this record rather than replacing it.
#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
pub struct VoteProof {
    /// The signed action's tag ([`WriteAction::tag`]).
    pub action: String,
    /// The signed target: the proposal id for a vote, the proposer's name for a proposal.
    pub target: String,
    pub ts: i64,
    pub nonce: String,
    /// Ed25519 signature over [`write_message`], hex.
    pub sig: String,
}

/// One seat's stance on a proposal (#575).
///
/// The SEAT is the member. The name is the roster's spelling when the vote was recorded, for
/// display, and is read by the count in exactly one case: a vault with no roster, where no seat can
/// be known (`seat == 0`, see [`counted`]).
#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
pub struct Vote {
    /// The 1-based FROST seat, or `0` when it cannot be known (a vault with no roster).
    pub seat: u16,
    pub name: String,
    pub approve: bool,
    /// Present when the vote came through a proven signed write.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub proof: Option<VoteProof>,
    /// An unsigned REFUSAL inherited from a payment that had already reached `refused` before its vault
    /// required signatures, kept counting once another seat voted signed on it (ADR-0011 amendment
    /// 2026-11-13): history ends per seat, so each seat withdraws only its own refusal (#369).
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub carried: bool,
}

impl Vote {
    pub fn signed(&self) -> bool {
        self.proof.is_some()
    }
}

/// What the count needs to know about the vault, built in ONE place from its write gate.
#[derive(Debug, Clone, Copy)]
pub struct Basis<'a> {
    /// The vault's member list, in seat order. Empty when the vault never recorded one.
    pub roster: &'a [String],
    /// The vault refuses unsigned governance writes now (or cannot say: an unreadable registry
    /// counts as requiring them).
    pub requires_signatures: bool,
    /// The vault never accepted an unsigned write at all (a protocol-3 vault: its gate is never
    /// open). A vote recorded there before votes carried their proof was signed all the same.
    pub every_write_signed: bool,
}

/// How many seats approve and refuse (#575).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub struct Counted {
    pub approvals: usize,
    pub refusals: usize,
}

/// Whether one vote counts, under `basis`, for a vault of `total` seats.
///
/// A seat counts when it exists (`1..=total`, and on the roster when there is one) and its vote was
/// proven, or the vault still takes unsigned writes. So an approval recorded while the vault was
/// open stops counting the moment the vault requires signatures: before this, it went on counting
/// as its member's until that member voted (#575).
pub fn vote_counts(v: &Vote, basis: &Basis, total: u16) -> bool {
    // Approvals and refusals alike (#575, ADR-0011 amendment 2026-11-13): unsigned, they stop counting
    // once the vault requires signatures. A payment that had already reached `refused` is read as
    // history by its record's own basis (`HelperProposal::reading_basis`), so it is not reopened.
    let proven = v.signed() || v.carried || basis.every_write_signed || !basis.requires_signatures;
    if v.seat == 0 {
        // A seat that cannot be known: only on a vault with no roster, which is also the only
        // place a name is read (by `counted`).
        return proven && basis.roster.is_empty() && member_name(&v.name).is_some();
    }
    let on_roster = basis.roster.is_empty()
        || seat_holder(basis.roster, v.seat)
            .and_then(member_name)
            .is_some();
    proven && v.seat <= total && on_roster
}

/// The ONE count of a proposal's votes (#575): distinct seats, each counted by [`vote_counts`].
///
/// If a record holds two entries for one seat, the LAST is that seat's stance: a vote replaces the
/// seat's earlier one, and this does not trust that it did.
///
/// THE EXCEPTION, the one place a name is read: on a vault with no roster no seat can be known, so
/// its votes are recorded under seat 0 and counted by distinct trimmed name, at most `total`. That is
/// the count such a vault always had.
pub fn counted(votes: &[Vote], basis: &Basis, total: u16) -> Counted {
    // Newest first, so the first entry met for a seat (or, at seat 0, a name) is its stance.
    let mut seen_seats = std::collections::BTreeSet::new();
    let mut seen_names = std::collections::BTreeSet::new();
    let mut named = 0usize;
    let mut c = Counted::default();
    for v in votes.iter().rev() {
        let first = if v.seat == 0 {
            member_name(&v.name).is_some_and(|n| seen_names.insert(n))
        } else {
            seen_seats.insert(v.seat)
        };
        if !first || !vote_counts(v, basis, total) {
            continue;
        }
        if v.seat == 0 {
            if named >= usize::from(total) {
                continue;
            }
            named += 1;
        }
        if v.approve {
            c.approvals += 1;
        } else {
            c.refusals += 1;
        }
    }
    c
}

/// One seat's stance as an answer reports it (#575), so a reader never compares names to find it.
#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize)]
pub struct Stance {
    /// The seat, or `0` on a vault with no roster (then `name` is the member).
    pub seat: u16,
    pub name: String,
    /// `approved`, `refused` or `none`.
    pub stance: &'static str,
    /// Whether [`counted`] counts this stance. A stance recorded unsigned on a vault that now
    /// requires signatures is `false`: it is shown, apart, and never as part of the quorum.
    pub counted: bool,
}

/// Every seat's stance, the ONE reading an answer carries (#575): a row per roster seat, `none` where
/// the seat has not voted; on a vault with no roster, a row per distinct name that voted.
/// It reads the same last-entry-wins rule as [`counted`], and `counted` on each row is
/// [`vote_counts`], so the rows and the count cannot disagree.
pub fn stances(votes: &[Vote], basis: &Basis, total: u16) -> Vec<Stance> {
    let row = |v: &Vote| Stance {
        seat: v.seat,
        name: v.name.trim().to_string(),
        stance: if v.approve { "approved" } else { "refused" },
        counted: vote_counts(v, basis, total),
    };
    if basis.roster.is_empty() {
        let mut out: Vec<Stance> = Vec::new();
        for v in votes.iter().rev() {
            if member_name(&v.name).is_some() && !out.iter().any(|s| same_member(&s.name, &v.name))
            {
                out.push(row(v));
            }
        }
        out.reverse();
        return out;
    }
    basis
        .roster
        .iter()
        .enumerate()
        .filter_map(|(i, name)| Some((u16::try_from(i + 1).ok()?, name)))
        .map(
            |(seat, name)| match votes.iter().rev().find(|v| v.seat == seat) {
                Some(v) => Stance {
                    name: name.trim().to_string(),
                    ..row(v)
                },
                None => Stance {
                    seat,
                    name: name.trim().to_string(),
                    stance: "none",
                    counted: false,
                },
            },
        )
        .collect()
}

/// The seat an UNSIGNED vote under `name` is recorded for, or why there is none (#575).
///
/// A signed vote never asks this: its seat is the one the signature proved. An unsigned vote can
/// only come from a vault that still takes them, so this only has to be consistent, and it refuses
/// rather than guess: a name held by several seats needs the request to say which (`claimed`),
/// because picking "the next free one" would let a resent click count twice.
pub fn unsigned_seat(
    roster: &[String],
    name: &str,
    claimed: Option<u16>,
) -> Result<u16, SeatError> {
    if roster.is_empty() {
        return Ok(0);
    }
    if let Some(seat) = claimed {
        return if seat_acts_as(roster, seat, name) {
            Ok(seat)
        } else {
            Err(SeatError::NotThisSeat)
        };
    }
    let Some(name) = member_name(name) else {
        return Err(SeatError::NotAMember);
    };
    let mut seats = roster
        .iter()
        .enumerate()
        .filter(|(_, n)| member_name(n) == Some(name))
        .map(|(i, _)| i + 1);
    match (seats.next(), seats.next()) {
        (None, _) => Err(SeatError::NotAMember),
        (Some(s), None) => Ok(u16::try_from(s).map_err(|_| SeatError::NotAMember)?),
        (Some(_), Some(_)) => Err(SeatError::Ambiguous),
    }
}

/// Why an unsigned vote has no seat.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SeatError {
    /// The name is on no seat.
    NotAMember,
    /// The seat the request named does not hold that name.
    NotThisSeat,
    /// Several seats hold that name and the request did not say which.
    Ambiguous,
}

/// The votes of a record, reconciled with its name lists (#575).
///
/// The name lists (`approvals`, `refusals`) stay on disk with every recorded name, as before, so a
/// rollback to a binary that knows only them loses nothing. This reads the record both ways:
/// - a vote whose name is no longer in the list of its stance was replaced by a binary that writes
///   only names, and is dropped;
/// - a name with no vote (a record older than votes, or written by such a binary) becomes an
///   UNSIGNED vote, on the seat [`legacy_seat`] gives it, or none.
///
/// Nothing here can make a vote count that the names alone would not: an added vote is unsigned.
pub fn reconcile_votes(
    votes: &[Vote],
    approvals: &[String],
    refusals: &[String],
    roster: &[String],
) -> Vec<Vote> {
    let listed = |v: &Vote| {
        let list = if v.approve { approvals } else { refusals };
        list.iter().any(|n| same_member(n, &v.name))
    };
    let mut out: Vec<Vote> = votes.iter().filter(|v| listed(v)).cloned().collect();
    for (approve, list) in [(true, approvals), (false, refusals)] {
        for name in list {
            let already = out
                .iter()
                .filter(|v| v.approve == approve && same_member(&v.name, name))
                .count();
            let entries = list.iter().filter(|n| same_member(n, name)).count();
            if already >= entries {
                continue;
            }
            if let Some(seat) = legacy_seat(roster, name, &out) {
                out.push(Vote {
                    seat,
                    name: name.clone(),
                    approve,
                    proof: None,
                    carried: false,
                });
            }
        }
    }
    out
}

/// The seat a name recorded without one is read as: the first seat under that name that has no
/// vote yet; `0` on a vault with no roster; `None` for a name on no seat, or when every seat under it
/// already voted. Used only to read old records, never for a new vote ([`unsigned_seat`]).
fn legacy_seat(roster: &[String], name: &str, votes: &[Vote]) -> Option<u16> {
    if roster.is_empty() {
        return Some(0);
    }
    let name = member_name(name)?;
    roster
        .iter()
        .enumerate()
        .filter(|(_, n)| member_name(n) == Some(name))
        .filter_map(|(i, _)| u16::try_from(i + 1).ok())
        .find(|s| !votes.iter().any(|v| v.seat == *s))
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
/// something to pad. Read by the one decoder.
fn unhex32(h: &str) -> Option<[u8; 32]> {
    konclave_seal::hex::decode_exact(h)
}

/// Exactly 64 bytes from hex (an Ed25519 signature), or `None`.
fn unhex32x2(h: &str) -> Option<[u8; 64]> {
    konclave_seal::hex::decode_exact(h)
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

    /// The coordinator keeps every nonce it accepts, so the size of one is bounded: a valid signature
    /// over a nonce of any length is not enough.
    #[test]
    fn a_nonce_is_bounded_in_size_however_well_it_is_signed() {
        let alice = Device::new(1, 1);
        let keys = [alice.registered()];
        let at_the_limit = "n".repeat(MAX_NONCE_BYTES);
        let w = alice.sign(V, WriteAction::Approve, "prop-1", &at_the_limit);
        assert_eq!(
            authorize_write(&keys, V, WriteAction::Approve, "prop-1", &w, never_seen),
            WriteAuth::Authorized { seat: 1 }
        );
        for nonce in [
            "n".repeat(MAX_NONCE_BYTES + 1),
            "n".repeat(1_000_000),
            String::new(),
        ] {
            let w = alice.sign(V, WriteAction::Approve, "prop-1", &nonce);
            assert_eq!(
                authorize_write(&keys, V, WriteAction::Approve, "prop-1", &w, never_seen),
                WriteAuth::Refused(WriteRefusal::Malformed),
                "a nonce of {} bytes",
                nonce.len()
            );
        }
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
        // Text that is not ASCII is refused like any other garbage, and a sign is not a digit.
        for bad in [
            "",
            "zz",
            "ff",
            &"ab".repeat(63),
            &"ab".repeat(65),
            "€€",
            "ab€c",
            &"€".repeat(64),
            &format!("{}€", "ab".repeat(63)),
            &"+f".repeat(64),
            &" f".repeat(64),
        ] {
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

    /// The registered key is read from the volume with the same decoder as the signature: a key that
    /// is not hex is a refusal, whatever it holds.
    #[test]
    fn a_registered_key_that_is_not_hex_is_refused_as_malformed() {
        let alice = Device::new(1, 1);
        let w = alice.sign(V, WriteAction::Approve, "p", "n1");
        for bad in [
            "€".repeat(32),
            "ab€c".to_string(),
            "zz".repeat(32),
            "+f".repeat(32),
        ] {
            let keys = [WriteKey {
                seat: 1,
                pubkey: bad.clone(),
            }];
            assert_eq!(
                authorize_write(&keys, V, WriteAction::Approve, "p", &w, never_seen),
                WriteAuth::Refused(WriteRefusal::Malformed),
                "key {bad:?}"
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

    // ---- #575: votes counted by seat -------------------------------------------------------

    fn vote(seat: u16, name: &str, approve: bool, signed: bool) -> Vote {
        Vote {
            seat,
            name: name.into(),
            approve,
            proof: signed.then(|| VoteProof {
                action: if approve { "approve" } else { "refuse" }.into(),
                target: "p1".into(),
                ts: 1,
                nonce: format!("n{seat}"),
                sig: "00".into(),
            }),
            carried: false,
        }
    }

    fn basis(roster: &[String], requires_signatures: bool) -> Basis<'_> {
        Basis {
            roster,
            requires_signatures,
            every_write_signed: false,
        }
    }

    /// The case still open in #575: an approval recorded unsigned while the vault was open, under a
    /// member's exact name, beside a signed approval, once the vault requires signatures. A 2-of-2
    /// read as approved by both.
    #[test]
    fn an_unsigned_vote_stops_counting_once_the_vault_requires_signatures() {
        let r = roster(&["alice", "bob"]);
        let votes = vec![vote(2, "bob", true, false), vote(1, "alice", true, true)];
        assert_eq!(counted(&votes, &basis(&r, true), 2).approvals, 1);
        // While the vault is still open, both count, as every unsigned write does there.
        assert_eq!(counted(&votes, &basis(&r, false), 2).approvals, 2);
    }

    /// The issue's literal case, through the reading of an old record: two spellings of alice.
    #[test]
    fn the_issue_case_from_an_old_record_is_one_approval() {
        let r = roster(&["alice", "bob"]);
        let votes = reconcile_votes(&[], &roster(&["alice ", "alice"]), &[], &r);
        assert_eq!(counted(&votes, &basis(&r, false), 2).approvals, 1);
        assert_eq!(counted(&votes, &basis(&r, true), 2).approvals, 0);
    }

    /// Two seats under one name are two members (#575 acceptance). By name they counted as one.
    #[test]
    fn two_seats_sharing_a_name_count_as_two() {
        let r = roster(&["bob", "bob"]);
        let votes = vec![vote(1, "bob", true, true), vote(2, "bob", true, true)];
        assert_eq!(counted(&votes, &basis(&r, true), 2).approvals, 2);
    }

    #[test]
    fn a_seat_counts_once_and_its_last_entry_is_its_stance() {
        let r = roster(&["alice", "bob"]);
        let votes = vec![vote(1, "alice", true, true), vote(1, "alice", false, true)];
        let c = counted(&votes, &basis(&r, true), 2);
        assert_eq!((c.approvals, c.refusals), (0, 1));
    }

    #[test]
    fn a_seat_that_does_not_exist_does_not_count() {
        let r = roster(&["alice", "bob"]);
        let votes = vec![vote(3, "carol", true, true), vote(0, "alice", true, true)];
        assert_eq!(
            counted(&votes, &basis(&r, false), 3).approvals,
            0,
            "past the roster / seat 0"
        );
        let none: Vec<String> = vec![];
        assert_eq!(
            counted(&[vote(3, "x", true, true)], &basis(&none, false), 2).approvals,
            0
        );
        // A blank seat is nobody's.
        let blank = roster(&["alice", " "]);
        assert_eq!(
            counted(&[vote(2, " ", true, true)], &basis(&blank, false), 2).approvals,
            0
        );
    }

    /// L4: a vault that requires signatures and never recorded a roster no longer counts every
    /// name. The gate refuses its signed writes (#568), so nothing there can count.
    #[test]
    fn a_vault_requiring_signatures_with_no_roster_counts_no_name() {
        let none: Vec<String> = vec![];
        let votes = reconcile_votes(&[], &roster(&["alice", "bob"]), &[], &none);
        assert_eq!(counted(&votes, &basis(&none, true), 2).approvals, 0);
        // Open, it keeps the count it always had: distinct names, at most `total`.
        assert_eq!(counted(&votes, &basis(&none, false), 2).approvals, 2);
        let many = reconcile_votes(&[], &roster(&["a", "b", "c", "a "]), &[], &none);
        assert_eq!(counted(&many, &basis(&none, false), 2).approvals, 2);
    }

    /// A protocol-3 vault never took an unsigned write, so its votes recorded before votes carried
    /// their proof still count.
    #[test]
    fn a_vault_that_never_took_an_unsigned_write_keeps_its_old_votes() {
        let r = roster(&["alice", "bob"]);
        let votes = reconcile_votes(&[], &roster(&["alice", "bob"]), &[], &r);
        let b = Basis {
            roster: &r,
            requires_signatures: true,
            every_write_signed: true,
        };
        assert_eq!(counted(&votes, &b, 2).approvals, 2);
    }

    /// Reading a record both ways: a vote replaced by a binary that only writes names is dropped,
    /// and a name with no vote comes back unsigned. Nothing added this way can be signed.
    #[test]
    fn reconciling_drops_replaced_votes_and_adds_unsigned_names() {
        let r = roster(&["alice", "bob"]);
        // An older binary moved alice from approvals to refusals; the vote still says approve.
        let votes = reconcile_votes(
            &[vote(1, "alice", true, true)],
            &[],
            &roster(&["alice"]),
            &r,
        );
        assert_eq!(votes, vec![vote(1, "alice", false, false)]);
        // A record written by this binary reads back unchanged.
        let mine = vec![vote(1, "alice", true, true), vote(2, "bob", false, true)];
        assert_eq!(
            reconcile_votes(&mine, &roster(&["alice"]), &roster(&["bob"]), &r),
            mine
        );
        // Two seats under one name, two entries: two unsigned votes on the two seats.
        let rb = roster(&["bob", "bob"]);
        let two = reconcile_votes(&[], &roster(&["bob", "bob"]), &[], &rb);
        assert_eq!(two.iter().map(|v| v.seat).collect::<Vec<_>>(), vec![1, 2]);
        // A name on no seat gets no vote.
        assert!(reconcile_votes(&[], &roster(&["mallory"]), &[], &r).is_empty());
    }

    #[test]
    fn an_unsigned_vote_takes_the_one_seat_under_its_name_or_is_refused() {
        let r = roster(&["alice", "bob", "bob"]);
        assert_eq!(unsigned_seat(&r, "alice", None), Ok(1));
        assert_eq!(unsigned_seat(&r, " alice", None), Ok(1));
        assert_eq!(unsigned_seat(&r, "bob", None), Err(SeatError::Ambiguous));
        assert_eq!(unsigned_seat(&r, "bob", Some(3)), Ok(3));
        assert_eq!(
            unsigned_seat(&r, "bob", Some(1)),
            Err(SeatError::NotThisSeat)
        );
        assert_eq!(
            unsigned_seat(&r, "mallory", None),
            Err(SeatError::NotAMember)
        );
        assert_eq!(unsigned_seat(&r, "  ", None), Err(SeatError::NotAMember));
        assert_eq!(unsigned_seat(&[], "anyone", None), Ok(0));
    }

    /// The rows an answer carries agree with the count, and name every seat.
    #[test]
    fn stances_name_every_seat_and_agree_with_the_count() {
        let r = roster(&["alice", "bob", "carol "]);
        let votes = vec![vote(2, "bob", true, false), vote(1, "alice", true, true)];
        let b = basis(&r, true);
        let rows = stances(&votes, &b, 3);
        assert_eq!(rows.len(), 3);
        assert_eq!(
            (rows[0].seat, rows[0].stance, rows[0].counted),
            (1, "approved", true)
        );
        assert_eq!(
            (rows[1].seat, rows[1].stance, rows[1].counted),
            (2, "approved", false)
        );
        assert_eq!((rows[2].name.as_str(), rows[2].stance), ("carol", "none"));
        let shown = rows
            .iter()
            .filter(|s| s.counted && s.stance == "approved")
            .count();
        assert_eq!(shown, counted(&votes, &b, 3).approvals);
        // No roster: a row per distinct name, last stance wins.
        let none: Vec<String> = vec![];
        let v2 = vec![vote(0, "x", true, false), vote(0, "x ", false, false)];
        let rows = stances(&v2, &basis(&none, false), 2);
        assert_eq!(rows.len(), 1);
        assert_eq!(rows[0].stance, "refused");
    }

    /// Approvals and refusals alike: unsigned, neither counts once the vault requires signatures
    /// (ADR-0011 amendment 2026-11-13). A payment already refused is kept by its reading basis.
    #[test]
    fn an_unsigned_refusal_counts_no_more_than_an_unsigned_approval() {
        let r = roster(&["alice", "bob"]);
        let b = basis(&r, true);
        assert!(!vote_counts(&vote(2, "bob", false, false), &b, 2));
        assert!(!vote_counts(&vote(2, "bob", true, false), &b, 2));
        assert!(vote_counts(&vote(2, "bob", false, true), &b, 2));
    }
}
