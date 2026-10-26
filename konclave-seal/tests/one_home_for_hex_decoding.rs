//! Source scan: the hosted side reads hex in ONE place, `konclave-seal/src/hex.rs`.
//!
//! Hex that arrives from outside used to be read by four copies of one loop. This fails the build if
//! a hand-written hex decoder comes back anywhere in the crates that read it, tests included: a test
//! that decodes by hand is one more place to copy from, and the shared decoder is just as easy to
//! call. A line that is only a comment is not code, so prose that explains the rule does not trip the
//! scan; a comment at the end of a code line does, which is the safe side.

use std::path::{Path, PathBuf};

/// The same crates the scan of the network-upgrade rules reads.
const ROOTS: &[&str] = &[
    "orchestrator/src",
    "helper-server/src",
    "konclave-wasm/src",
    "konclave-signer/src",
    "konclave-http/src",
    "relay-server/src",
    "src-tauri/src",
];

/// The ways of turning two hex digits into a byte by hand. Built in pieces so that this file's own
/// text does not trip the scan.
fn needles() -> [String; 3] {
    [
        ["from_str", "_radix"].concat(),
        ["to_digit", "(16)"].concat(),
        ["from_ascii", "_radix"].concat(),
    ]
}

/// Whether a line is only a comment (`//`, `///`, `//!`), so prose about the rule is not code.
fn comment_only(line: &str) -> bool {
    line.trim_start().starts_with("//")
}

fn repo() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR")).join("..")
}

fn rs_files(dir: &Path, out: &mut Vec<PathBuf>) {
    let Ok(rd) = std::fs::read_dir(dir) else {
        return;
    };
    for e in rd.flatten() {
        let p = e.path();
        if p.is_dir() {
            rs_files(&p, out);
        } else if p.extension().is_some_and(|x| x == "rs") {
            out.push(p);
        }
    }
}

fn sources() -> Vec<(String, String)> {
    let mut files = vec![];
    for r in ROOTS {
        rs_files(&repo().join(r), &mut files);
    }
    files
        .into_iter()
        .map(|p| {
            (
                p.display().to_string(),
                std::fs::read_to_string(&p).unwrap(),
            )
        })
        .collect()
}

#[test]
fn the_scan_reads_the_files_it_is_about() {
    let files = sources();
    for name in [
        "orchestrator/src/write_auth.rs",
        "orchestrator/src/envelope.rs",
        "orchestrator/src/net_send.rs",
        "orchestrator/src/signer.rs",
        "orchestrator/src/helper.rs",
        "helper-server/src/main.rs",
    ] {
        assert!(
            files.iter().any(|(p, _)| p.ends_with(name)),
            "{name} was not scanned"
        );
    }
}

#[test]
fn nothing_that_reads_hex_decodes_it_by_hand() {
    let needles = needles();
    let mut offenders = vec![];
    for (path, text) in sources() {
        // The shared decoder is the one place allowed to; it lives in konclave-seal, not scanned here.
        for (n, line) in text.lines().enumerate() {
            if comment_only(line) {
                continue;
            }
            if needles.iter().any(|needle| line.contains(needle.as_str())) {
                offenders.push(format!("{path}:{}", n + 1));
            }
        }
    }
    assert!(
        offenders.is_empty(),
        "read hex through konclave_seal::hex, not by hand: {offenders:?}"
    );
}

/// The scan is not satisfied by a comment, nor blinded by a URL before the call on the same line.
#[test]
fn the_scan_sees_a_call_after_a_url_on_the_same_line_and_skips_a_comment() {
    let [radix, digit, ascii] = needles();
    let call = format!("const U: &str = \"https://example.org\"; let b = u8::{radix}(\"ff\", 16);");
    assert!(!comment_only(&call) && call.contains(radix.as_str()));
    assert!(!comment_only(&format!("let d = c.{digit};")));
    assert!(!comment_only(&format!("let b = u8::{ascii}(&x, 16);")));
    assert!(comment_only(&format!(
        "    // u8::{radix} is what this replaced"
    )));
    assert!(comment_only(&format!("//! about {radix}")));
}

#[test]
fn the_shared_decoder_is_what_the_old_copies_call() {
    let files = sources();
    let count = |name: &str| {
        let text = &files
            .iter()
            .find(|(p, _)| p.ends_with(name))
            .unwrap_or_else(|| panic!("{name} was not scanned"))
            .1;
        text.lines()
            .filter(|l| !comment_only(l) && l.contains("konclave_seal::hex::"))
            .count()
    };
    // write_auth reads a 32-byte key and a 64-byte signature: two calls.
    assert!(count("orchestrator/src/write_auth.rs") >= 2);
    for name in [
        "orchestrator/src/envelope.rs",
        "orchestrator/src/net_send.rs",
        "orchestrator/src/signer.rs",
        "orchestrator/src/helper.rs",
    ] {
        assert!(
            count(name) >= 1,
            "{name} must read hex through the shared decoder"
        );
    }
}
