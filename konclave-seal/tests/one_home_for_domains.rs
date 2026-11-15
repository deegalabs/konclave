//! The domain separators live in `konclave-seal/src/domains.rs` only (ADR-0012 D2). A literal of
//! the form `konclave-<name>-v<n>\0` (or `\x00`) in the non-test code of any Rust crate of the
//! repository is a second definition, and this scan refuses it. Test MODULES may write bytes out by
//! hand; every other line is read, however far down the file.

use std::path::{Path, PathBuf};

/// The text of `text` with every `#[cfg(test)]` module removed. A module ends at the first line
/// that is a closing brace at the module's own indentation, which rustfmt (checked in CI) guarantees.
/// Anything else after a `#[cfg(test)]` (a doc comment mentioning it, a `#[path]` module, a function)
/// is kept and scanned.
fn without_test_modules(text: &str) -> String {
    let lines: Vec<&str> = text.lines().collect();
    let mut out = String::new();
    let mut i = 0;
    while i < lines.len() {
        if lines[i].trim() == "#[cfg(test)]" {
            // Skip further attribute lines, then expect `mod name {`.
            let mut j = i + 1;
            while j < lines.len() && lines[j].trim_start().starts_with("#[") {
                j += 1;
            }
            let decl = lines.get(j).map(|l| l.trim_start()).unwrap_or("");
            let opens =
                (decl.starts_with("mod ") || decl.starts_with("pub mod ")) && decl.ends_with('{');
            if opens {
                let indent = &lines[j][..lines[j].len() - decl.len()];
                let close = format!("{indent}}}");
                let mut k = j + 1;
                while k < lines.len() && lines[k] != close {
                    // A line that closes at the module's indentation but is not exactly the brace
                    // (`} // mod tests`) would make the skip run on into production code: stop.
                    assert!(
                        !lines[k].starts_with(&close),
                        "ambiguous end of a test module at line {}: {:?}",
                        k + 1,
                        lines[k]
                    );
                    k += 1;
                }
                assert!(
                    k < lines.len(),
                    "a test module from line {} never closes",
                    j + 1
                );
                i = k + 1;
                continue;
            }
        }
        out.push_str(lines[i]);
        out.push('\n');
        i += 1;
    }
    out
}

fn domain_literals(text: &str) -> Vec<String> {
    let mut found = vec![];
    let mut rest = text;
    while let Some(at) = rest.find("konclave-") {
        let tail = &rest[at..];
        let end = tail.find('"').unwrap_or(tail.len());
        let lit = &tail[..end];
        let nul = ["\\0", "\\x00", "\\u{0}", "\\u{00}", "\\u{0000}"];
        if nul.iter().any(|z| lit.ends_with(z)) && lit.contains("-v") {
            found.push(lit.to_string());
        }
        rest = &tail["konclave-".len()..];
    }
    found
}

fn walk(dir: &Path, out: &mut Vec<PathBuf>) {
    for e in std::fs::read_dir(dir).unwrap_or_else(|_| panic!("{dir:?}")) {
        let p = e.unwrap().path();
        if p.is_dir() {
            walk(&p, out);
        } else if p.extension().is_some_and(|x| x == "rs") {
            out.push(p);
        }
    }
}

/// Every crate of the repository: a directory beside this one with a Cargo.toml and a src/.
fn crate_sources() -> Vec<PathBuf> {
    let mut dirs = vec![];
    for e in std::fs::read_dir("..").unwrap() {
        let p = e.unwrap().path();
        if p.join("Cargo.toml").is_file() && p.join("src").is_dir() {
            dirs.push(p.join("src"));
        }
    }
    dirs
}

#[test]
fn domain_literals_live_in_domains_rs_only() {
    let crates = crate_sources();
    for must in [
        "konclave-wasm",
        "orchestrator",
        "helper-server",
        "konclave-signer",
        "relay-server",
    ] {
        assert!(
            crates.iter().any(|c| c.to_string_lossy().contains(must)),
            "the scan reads {must}"
        );
    }
    let mut files = vec![];
    for c in &crates {
        walk(c, &mut files);
    }
    let mut offenders = vec![];
    for f in files {
        let name = f.to_string_lossy().to_string();
        if name.ends_with("konclave-seal/src/domains.rs") || name.ends_with("_tests.rs") {
            continue;
        }
        let text = std::fs::read_to_string(&f).unwrap();
        for lit in domain_literals(&without_test_modules(&text)) {
            offenders.push(format!("{name}: {lit}"));
        }
    }
    assert!(
        offenders.is_empty(),
        "domain literals outside domains.rs: {offenders:#?}"
    );
}

#[test]
fn the_scan_would_see_one() {
    let lit = |s: &str| domain_literals(&without_test_modules(s));
    assert_eq!(
        lit("out.extend_from_slice(b\"konclave-write-v1\\0\");"),
        vec!["konclave-write-v1\\0"]
    );
    assert_eq!(
        lit("let d = b\"konclave-vote-v2\\x00\";"),
        vec!["konclave-vote-v2\\x00"]
    );
    assert!(lit("hk.expand(b\"konclave-device-write-v1\", &mut okm)").is_empty());
    // A doc comment that mentions the attribute does not hide what follows it.
    assert_eq!(
        lit("//! use #[cfg(test)] here\nfn f() { b\"konclave-vote-v2\\0\"; }\n"),
        vec!["konclave-vote-v2\\0"]
    );
    // Production code after a nested test module is still read.
    let after = "fn a() {}\n#[cfg(test)]\nmod tests {\n    const X: &[u8] = b\"konclave-room-v1\\0\";\n}\nfn b() { b\"konclave-seat-v1\\0\"; }\n";
    assert_eq!(lit(after), vec!["konclave-seat-v1\\0"]);
    // So is code after an indented test module inside another module.
    let nested = "mod m {\n    #[cfg(test)]\n    mod tests {\n        fn t() {}\n    }\n    fn p() { b\"konclave-pkp-v1\\0\"; }\n}\n";
    assert_eq!(lit(nested), vec!["konclave-pkp-v1\\0"]);
    assert_eq!(
        lit("let d = \"konclave-vote-v2\\u{0}\";"),
        vec!["konclave-vote-v2\\u{0}"]
    );
    // A `#[path]` test module declaration has no body to skip.
    assert_eq!(
        lit("#[cfg(test)]\n#[path = \"x_tests.rs\"]\nmod tests;\nfn c() { b\"konclave-room-v1\\0\"; }\n"),
        vec!["konclave-room-v1\\0"]
    );
}

#[test]
#[should_panic(expected = "ambiguous end of a test module")]
fn a_test_module_closed_with_a_trailing_comment_stops_the_scan() {
    without_test_modules(
        "#[cfg(test)]\nmod tests {\n    fn t() {}\n} // mod tests\nfn p() {}\n}\n",
    );
}

#[test]
#[should_panic(expected = "never closes")]
fn a_test_module_that_never_closes_stops_the_scan() {
    without_test_modules("#[cfg(test)]\nmod tests {\n    fn t() {}\n");
}

#[test]
fn no_domain_is_a_prefix_of_another_and_none_repeats() {
    use konclave_seal::domains::ALL;
    for (i, a) in ALL.iter().enumerate() {
        assert!(a.ends_with(b"\0"), "{i} ends with NUL");
        for (j, b) in ALL.iter().enumerate() {
            assert!(i == j || !b.starts_with(a), "{i} is a prefix of {j}");
        }
    }
}
