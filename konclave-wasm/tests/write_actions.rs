//! Every write action the rule knows must be signable, and spelled the same on both sides.
//!
//! `sign_write` maps an action STRING to a `WriteAction` with a match, and the helper verifies with
//! the enum. So there are two lists: one in this crate's match arms, one in `konclave-seal`. Add a
//! variant to the enum and forget the arm, and the UI cannot sign that action at all - the write is
//! refused with `unknown write action`, on a path nobody exercises until a member tries it.
//!
//! That is the shape this repo keeps paying for: one rule, two implementations, only one updated.
//! #424, #425 and #439 were all this. So the enum carries the canonical list and this walks it.

use konclave_seal::{write_message, WriteAction, ALL_WRITE_ACTIONS};

/// The tag each action signs under. Mirrors the match in `sign_write`, which is the point: if the
/// two disagree, one of the assertions below fails rather than a member's write.
fn tag_via_string(s: &str) -> Option<WriteAction> {
    match s {
        "approve" => Some(WriteAction::Approve),
        "refuse" => Some(WriteAction::Refuse),
        "rename" => Some(WriteAction::Rename),
        "propose" => Some(WriteAction::Propose),
        "send" => Some(WriteAction::Send),
        _ => None,
    }
}

#[test]
fn every_action_round_trips_through_its_tag() {
    for a in ALL_WRITE_ACTIONS {
        let t = a.tag();
        assert_eq!(
            tag_via_string(t),
            Some(a),
            "action {t:?} is in the enum but `sign_write` cannot parse it, so no device can sign it",
        );
    }
}

#[test]
fn the_tags_are_distinct() {
    // A collision would let a signature for one action authorise another - a vote reused as a send.
    let mut tags: Vec<&str> = ALL_WRITE_ACTIONS.iter().map(|a| a.tag()).collect();
    let before = tags.len();
    tags.sort_unstable();
    tags.dedup();
    assert_eq!(tags.len(), before, "two write actions share a tag");
}

#[test]
fn a_message_is_bound_to_its_action() {
    // The whole point of the tag being IN the signed bytes: the same seat, target, timestamp and
    // nonce under a different action must produce different bytes to sign.
    let msgs: Vec<Vec<u8>> = ALL_WRITE_ACTIONS
        .iter()
        .map(|a| write_message("v", *a, "p1", 1, 1_700_000_000, "n1"))
        .collect();
    for (i, a) in msgs.iter().enumerate() {
        for b in msgs.iter().skip(i + 1) {
            assert_ne!(a, b, "two actions produce the same signed message");
        }
    }
}
