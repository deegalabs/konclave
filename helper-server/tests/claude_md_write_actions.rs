//! The project notes must not misstate what the helper authenticates.
//!
//! CLAUDE.md carried "`authorize_write` has exactly two non-test call sites" from 2026-09-07 18:11
//! until 2026-09-16. It was true for 22 minutes: #507 corrected the line, and #508 landed at 18:33
//! and authenticated the proposal and the send, which made the line stale in the other direction.
//!
//! A note that COUNTS something goes stale the moment the thing is counted again, and nobody
//! notices, because prose has no compiler. A forum post quoting that line as fact is the cost. So
//! the count is checked here, against the code, by the suite that already runs on every push.

use std::collections::BTreeSet;

/// Every `WriteAction::X` the helper names outside its own test module.
fn authenticated_in_code() -> BTreeSet<String> {
    let src = include_str!("../src/main.rs");
    // Everything from `mod tests` on is the suite's own fixtures, which name actions they do not
    // authenticate. Counting those would let this guard pass on a helper that authenticates none.
    let prod = src.split("\nmod tests").next().unwrap_or(src);
    let mut found = BTreeSet::new();
    for (i, _) in prod.match_indices("WriteAction::") {
        let rest = &prod[i + "WriteAction::".len()..];
        let name: String = rest.chars().take_while(|c| c.is_alphanumeric()).collect();
        if !name.is_empty() {
            found.insert(name);
        }
    }
    found
}

/// Every action CLAUDE.md claims the helper authenticates, read out of its backticked list.
fn claimed_in_notes() -> BTreeSet<String> {
    let notes = include_str!("../../CLAUDE.md");
    let line = notes
        .lines()
        .find(|l| l.contains("the helper authenticates"))
        .expect("CLAUDE.md no longer states which writes the helper authenticates");
    let mut found = BTreeSet::new();
    let mut rest = line;
    while let Some(start) = rest.find('`') {
        let after = &rest[start + 1..];
        match after.find('`') {
            Some(end) => {
                let word = &after[..end];
                if !word.is_empty() && word.chars().all(|c| c.is_alphanumeric()) {
                    found.insert(word.to_string());
                }
                rest = &after[end + 1..];
            }
            None => break,
        }
    }
    found
}

#[test]
fn the_notes_name_exactly_the_writes_the_helper_authenticates() {
    let code = authenticated_in_code();
    let notes = claimed_in_notes();
    assert!(
        !code.is_empty(),
        "no WriteAction found in the helper at all - has the module moved?"
    );
    assert_eq!(
        notes, code,
        "CLAUDE.md and the helper disagree about which writes are authenticated.\n\
         notes say: {notes:?}\n\
         code does: {code:?}\n\
         Update the sentence in CLAUDE.md that begins \"the helper authenticates\"."
    );
}
