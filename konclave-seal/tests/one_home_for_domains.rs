//! The domain separators live in `konclave-seal/src/domains.rs` only (ADR-0012 D2). A literal of
//! the form `konclave-<name>-v<n>\0` in the non-test code of any Rust crate that signs or verifies
//! is a second definition, and this scan refuses it. Test modules may write bytes out by hand.

use std::path::Path;

const CRATES: [&str; 5] = [
    "../konclave-seal/src",
    "../konclave-wasm/src",
    "../orchestrator/src",
    "../helper-server/src",
    "../konclave-signer/src",
];

fn non_test_part(text: &str) -> &str {
    match text.find("#[cfg(test)]") {
        Some(at) => &text[..at],
        None => text,
    }
}

fn domain_literals(text: &str) -> Vec<String> {
    let mut found = vec![];
    let mut rest = text;
    while let Some(at) = rest.find("konclave-") {
        let tail = &rest[at..];
        let end = tail.find('"').unwrap_or(tail.len());
        let lit = &tail[..end];
        if lit.ends_with("\\0") && lit.contains("-v") {
            found.push(lit.to_string());
        }
        rest = &tail["konclave-".len()..];
    }
    found
}

fn walk(dir: &Path, out: &mut Vec<std::path::PathBuf>) {
    for e in std::fs::read_dir(dir).unwrap_or_else(|_| panic!("{dir:?}")) {
        let p = e.unwrap().path();
        if p.is_dir() {
            walk(&p, out);
        } else if p.extension().is_some_and(|x| x == "rs") {
            out.push(p);
        }
    }
}

#[test]
fn domain_literals_live_in_domains_rs_only() {
    let mut files = vec![];
    for c in CRATES {
        walk(Path::new(c), &mut files);
    }
    assert!(files.len() > 10, "the scan reads the crates");
    let mut offenders = vec![];
    for f in files {
        let name = f.to_string_lossy();
        if name.ends_with("konclave-seal/src/domains.rs") || name.ends_with("_tests.rs") {
            continue;
        }
        let text = std::fs::read_to_string(&f).unwrap();
        for lit in domain_literals(non_test_part(&text)) {
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
    assert_eq!(
        domain_literals("out.extend_from_slice(b\"konclave-write-v1\\0\");"),
        vec!["konclave-write-v1\\0".to_string()]
    );
    assert!(domain_literals("hk.expand(b\"konclave-device-write-v1\", &mut okm)").is_empty());
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
