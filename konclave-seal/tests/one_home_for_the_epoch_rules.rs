//! Source scan (#638): the network-upgrade rules have ONE home, `konclave-seal/src/epochs.rs`.
//!
//! The ten-block margin was written twice (the device's `still_counted`, the coordinator's `MARGIN`)
//! and each could have been changed without the other. This test fails the build if a margin, a
//! branch id, an activation height or the anchor reappears in production code outside that file.
//! Test code is skipped on purpose: the Rust tests keep their own oracle literals so they do not
//! check the rule against itself. A scan that skipped nothing would be red for ever, and one that
//! skipped everything after the first `#[cfg(test)]` would not look at the code that follows it
//! (konclave-wasm keeps a production module after its tests), so test items are cut out one by one.

use std::path::{Path, PathBuf};

const ROOTS: &[&str] = &[
    "orchestrator/src",
    "helper-server/src",
    "konclave-wasm/src",
    "konclave-signer/src",
    "konclave-http/src",
    "relay-server/src",
    "src-tauri/src",
];

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

/// Remove every item annotated `#[cfg(test)]` (a `mod` or `fn` with a body, or a one-line item).
/// A small lexer: braces inside strings, raw strings, char literals and comments do not count.
fn without_test_items(src: &str) -> String {
    let b = src.as_bytes();
    let mut out = String::new();
    let mut i = 0;
    while i < b.len() {
        if src[i..].starts_with("#[cfg(test)]") {
            // Skip to the end of the item.
            let mut j = i + "#[cfg(test)]".len();
            let (mut depth, mut seen_open) = (0i32, false);
            while j < b.len() {
                match b[j] {
                    b'/' if b.get(j + 1) == Some(&b'/') => {
                        while j < b.len() && b[j] != b'\n' {
                            j += 1;
                        }
                        continue;
                    }
                    b'/' if b.get(j + 1) == Some(&b'*') => {
                        j += 2;
                        while j + 1 < b.len() && !(b[j] == b'*' && b[j + 1] == b'/') {
                            j += 1;
                        }
                        j += 2;
                        continue;
                    }
                    b'"' => {
                        j += 1;
                        while j < b.len() && b[j] != b'"' {
                            if b[j] == b'\\' {
                                j += 1;
                            }
                            j += 1;
                        }
                    }
                    b'r' if matches!(b.get(j + 1), Some(b'"') | Some(b'#'))
                        && (j == 0 || !b[j - 1].is_ascii_alphanumeric()) =>
                    {
                        let mut k = j + 1;
                        let mut hashes = 0;
                        while b.get(k) == Some(&b'#') {
                            hashes += 1;
                            k += 1;
                        }
                        if b.get(k) == Some(&b'"') {
                            let end = format!("\"{}", "#".repeat(hashes));
                            j = src[k + 1..]
                                .find(&end)
                                .map_or(b.len(), |p| k + 1 + p + end.len() - 1);
                        }
                    }
                    b'\'' => {
                        // A char literal ('x', '\n', '{') or a lifetime ('a): a literal closes soon.
                        if b.get(j + 1) == Some(&b'\\') {
                            if let Some(p) = src[j + 2..].find('\'') {
                                j += 2 + p;
                            }
                        } else if b.get(j + 2) == Some(&b'\'') {
                            j += 2;
                        }
                    }
                    b'{' => {
                        depth += 1;
                        seen_open = true;
                    }
                    b'}' => {
                        depth -= 1;
                        if seen_open && depth == 0 {
                            j += 1;
                            break;
                        }
                    }
                    b';' if !seen_open => {
                        j += 1;
                        break;
                    }
                    _ => {}
                }
                j += 1;
            }
            i = j;
        } else {
            let ch = src[i..].chars().next().unwrap();
            out.push(ch);
            i += ch.len_utf8();
        }
    }
    out
}

fn production_sources() -> Vec<(String, String)> {
    let mut files = vec![];
    for r in ROOTS {
        rs_files(&repo().join(r), &mut files);
    }
    files
        .into_iter()
        .map(|p| {
            let text = std::fs::read_to_string(&p).unwrap();
            (p.display().to_string(), without_test_items(&text))
        })
        .collect()
}

/// A file with line comments removed, so prose that explains the rule is not mistaken for code.
fn code_only(s: &str) -> String {
    s.lines()
        .map(|l| l.split("//").next().unwrap_or(""))
        .collect::<Vec<_>>()
        .join("\n")
}

#[test]
fn the_scan_really_cuts_test_items_and_keeps_the_code_after_them() {
    let files = production_sources();
    let find = |name: &str| {
        files
            .iter()
            .find(|(p, _)| p.ends_with(name))
            .unwrap_or_else(|| panic!("{name} was not scanned"))
            .1
            .clone()
    };
    // Kept: production code on both sides of the test modules.
    let wasm = find("konclave-wasm/src/lib.rs");
    assert!(
        wasm.contains("pub fn pczt_sighash"),
        "the code after the tests is scanned"
    );
    assert!(wasm.contains("pub fn parse_signed"));
    // Cut: test bodies, with their oracle literals.
    assert!(!wasm.contains("PINNED_BOUNDS"));
    assert!(!wasm.contains("fn height_bounds_reproduce"));
    let rec = find("orchestrator/src/send_record.rs");
    assert!(rec.contains("pub fn settle_with"));
    assert!(!rec.contains("fn settle_is_what_it_was_with_no_later_row"));
}

#[test]
fn no_second_reorg_margin_exists() {
    for (path, text) in production_sources() {
        let code = code_only(&text);
        let squashed: String = code.split_whitespace().collect();
        for needle in [
            "constMARGIN:",
            "constMARGIN=",
            "REORG_MARGIN:u",
            "saturating_add(10)",
            "+MARGIN)",
            "+MARGIN;",
            "+MARGIN{",
            "+10>=",
            "+10<",
            ">expiry+",
            ">u64::from(a.expiry_height)+",
        ] {
            assert!(
                !squashed.contains(needle),
                "{path}: a margin is written here ({needle}); it lives in konclave-seal::epochs only"
            );
        }
    }
}

#[test]
fn the_table_and_the_margin_are_defined_in_epochs_and_nowhere_else() {
    let home = std::fs::read_to_string(repo().join("konclave-seal/src/epochs.rs")).unwrap();
    assert!(home.contains("pub const REORG_MARGIN: u32 = 10;"));
    for (path, text) in production_sources() {
        let code = code_only(&text).to_ascii_lowercase().replace('_', "");
        for literal in [
            "37a5165b",
            "3428143",
            "1785247643",
            "d884b698",
            "77190ad9",
            "3543405",
            "34560",
            "69120",
            "103680",
        ] {
            assert!(
                !code.contains(literal),
                "{path}: {literal} is a row of the epoch table; it lives in konclave-seal::epochs only"
            );
        }
    }
}

#[test]
fn a_testnet_table_is_not_in_production_code() {
    for (path, text) in production_sources() {
        let code = code_only(&text);
        assert!(
            !code.contains("TESTNET") || !code.contains("epochs"),
            "{path}: a TESTNET epoch table must live in tests only"
        );
    }
}
