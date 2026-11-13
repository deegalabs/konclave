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

/// Added 2026-11-06 (#847, PR A). The coordinator's builder still pays the crate's 5,000 until it
/// reads the fee table (#847, PR B):
/// these two files keep their own fee rule until then, and nothing else may. Each entry is removed
/// when PR B moves that file onto `konclave_seal::epochs`; an entry that no longer matches anything
/// fails the test, so the list cannot outlive what it excuses.
const FEE_RULE_UNTIL_PR_B: &[(&str, &str)] = &[
    ("orchestrator/src/validation.rs", "constMARGINAL_FEE:"),
    ("orchestrator/src/validation.rs", "constGRACE_ACTIONS:"),
];

/// Added 2026-11-12 (#847, B3b). The ONE place a builder's fee rule is constructed: the signer's
/// `build_payroll`, from the marginal `konclave_seal::epochs::fee_rule_for` gives it. Permanent, not
/// an excuse: nothing else may construct a rule, and the entry must still match (a rule moved
/// elsewhere, or a builder that stopped building one, fails here).
const FEE_RULE_BUILDERS: &[(&str, &str)] =
    &[("konclave-signer/src/main.rs", "FeeRule::non_standard(")];

/// What a second fee rule looks like once whitespace is removed: a declaration, the crate's
/// constants or fee rules used directly, a marginal fee multiplied, or the ZIP 2009 height.
const FEE_NEEDLES: &[&str] = &[
    "constMARGINAL_FEE:",
    "constGRACE_ACTIONS:",
    "zip317::MARGINAL_FEE",
    "zip317::GRACE_ACTIONS",
    "StandardFeeRule::Zip317",
    "FeeRule::standard()",
    "FeeRule::non_standard(",
    "5_000*",
    "*5_000",
    "5000*",
    "*5000",
    "3_590_000",
    "3590000",
];

fn fee_needles_in(code: &str) -> Vec<&'static str> {
    let squashed: String = code.split_whitespace().collect();
    FEE_NEEDLES
        .iter()
        .copied()
        .filter(|n| squashed.contains(n))
        .collect()
}

#[test]
fn the_fee_scan_would_find_a_planted_rule() {
    for planted in [
        "const MARGINAL_FEE: u64 = 5_000;",
        "let fee = 5_000 * n;",
        "let fee = zip317::MARGINAL_FEE * actions;",
        "let rule = FeeRule::non_standard(m, 2, a, b);",
        "if tip >= 3_590_000 { 1_000 } else { 5_000 }",
    ] {
        assert!(!fee_needles_in(planted).is_empty(), "{planted}");
    }
    assert!(fee_needles_in("let ms = 1_000 * secs;").is_empty());
}

#[test]
fn no_second_fee_rule_exists() {
    let mut excused_seen = vec![false; FEE_RULE_UNTIL_PR_B.len()];
    let mut builder_seen = vec![false; FEE_RULE_BUILDERS.len()];
    for (path, text) in production_sources() {
        let code = code_only(&text);
        for needle in fee_needles_in(&code) {
            if let Some(i) = FEE_RULE_BUILDERS
                .iter()
                .position(|(p, n)| path.ends_with(p) && *n == needle)
            {
                builder_seen[i] = true;
                continue;
            }
            let excused = FEE_RULE_UNTIL_PR_B
                .iter()
                .position(|(p, n)| path.ends_with(p) && *n == needle);
            match excused {
                Some(i) => excused_seen[i] = true,
                None => panic!(
                    "{path}: a fee rule is written here ({needle}); it lives in konclave-seal::epochs only"
                ),
            }
        }
    }
    assert!(
        builder_seen.iter().all(|s| *s),
        "the builder's fee rule is no longer constructed where FEE_RULE_BUILDERS says"
    );
    for (i, seen) in excused_seen.iter().enumerate() {
        assert!(
            seen,
            "{:?} is excused but no longer there: remove it from FEE_RULE_UNTIL_PR_B",
            FEE_RULE_UNTIL_PR_B[i]
        );
    }
}
