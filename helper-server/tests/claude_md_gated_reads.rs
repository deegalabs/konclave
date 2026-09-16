//! The project notes must name exactly the routes the #388 read gate covers.
//!
//! CLAUDE.md described the gate as "leaked id -> `401`, member -> `200`" for nine days. True of the
//! routes it named and silent about the one it did not: `/api/vault` is deliberately outside the
//! gate, so an id still opens the vault's quorum shape, its receive address and its change receiver.
//!
//! Anyone auditing the boundary from the notes alone would have got it wrong, and a forum post did.
//! The gate is a named list in the helper, so the notes can be held to the same list, by the suite
//! that already runs on every push. The sibling guard next to this one holds the write side.

use std::collections::BTreeSet;

/// The routes the helper's `GATED_READS` array actually names.
fn gated_in_code() -> BTreeSet<String> {
    let src = include_str!("../src/main.rs");
    let start = src
        .find("const GATED_READS")
        .expect("the helper no longer has a GATED_READS list - has the gate changed shape?");
    let body = &src[start..];
    let end = body.find("];").expect("GATED_READS is not terminated");
    routes_in(&body[..end])
}

/// The routes CLAUDE.md claims are gated, read out of the sentence that names the list.
fn gated_in_notes() -> BTreeSet<String> {
    let notes = include_str!("../../CLAUDE.md");
    let start = notes
        .find("`GATED_READS`")
        .expect("CLAUDE.md no longer names the gated read list");
    // The list runs to the end of that sentence. Stopping at the period keeps the routes named
    // elsewhere in the entry (the UFVK, /api/vault) from being counted as gated - naming them is
    // the whole point of the surrounding text, and counting them would invert this guard.
    let rest = &notes[start..];
    let end = rest.find(". The").unwrap_or(rest.len());
    routes_in(&rest[..end])
}

/// Every `/api/...` path in a chunk of text, however it is quoted.
fn routes_in(text: &str) -> BTreeSet<String> {
    let mut found = BTreeSet::new();
    for (i, _) in text.match_indices("/api/") {
        let path: String = text[i..]
            .chars()
            .take_while(|c| c.is_alphanumeric() || *c == '/' || *c == '_' || *c == '.')
            .collect();
        // Trim a trailing dot picked up from prose, but keep one inside a path (ledger.csv).
        let path = path.trim_end_matches('.').to_string();
        if path.len() > "/api/".len() {
            found.insert(path);
        }
    }
    found
}

#[test]
fn the_notes_name_exactly_the_reads_the_gate_covers() {
    let code = gated_in_code();
    let notes = gated_in_notes();
    assert!(
        !code.is_empty(),
        "no routes parsed out of GATED_READS - has the list moved?"
    );
    assert_eq!(
        notes, code,
        "CLAUDE.md and the helper disagree about which reads the #388 gate covers.\n\
         notes say: {notes:?}\n\
         code does: {code:?}\n\
         A route added to the gate and not to the notes makes the boundary look wider than it is;\n\
         one removed and not updated makes it look narrower. Both have already happened."
    );
}
