#![cfg(feature = "server")]
//! Every key the repository publishes is a key every reader of the
//! repository knows. A gateway started on one would let anyone open its requests, so a key file
//! carrying one is refused, whatever the key id; and no key the server accepts is written out in
//! the repository's code.

use konclave_ohttp::{key_config_from_text, test_key_text, KeyFileError};

#[test]
fn every_known_test_key_is_refused_as_a_key() {
    for which in 0..3 {
        for id in [0u8, 7, 255] {
            let text = test_key_text(which, id);
            for spelling in [text.clone(), text.to_uppercase()] {
                let r = key_config_from_text(&spelling);
                assert!(
                    matches!(r, Err(KeyFileError::TestVector)),
                    "test key {which}, id {id}: accepted"
                );
            }
        }
        // The refusal names no key material.
        let e = key_config_from_text(&test_key_text(which, 7)).unwrap_err();
        let material = &test_key_text(which, 7)[2..10];
        assert!(!e.to_string().contains(material), "{e}");
    }
    // A key that is not on the list is still accepted: this one is built here, not written out.
    let real: String = (0..32u8)
        .map(|i| format!("{:02x}", i.wrapping_mul(7).wrapping_add(3)))
        .collect();
    assert!(key_config_from_text(&format!("7 {real}")).is_ok());
}

/// A key file's text written out in the repository's code (a key id, a space, 64 hex digits)
/// is a published key. The server must not accept any of them: so none may parse. The tests that
/// need a key get it from `test_key_text`.
#[test]
fn no_key_file_text_the_server_accepts_is_written_in_the_repository() {
    fn rust_files(dir: &std::path::Path, out: &mut Vec<std::path::PathBuf>) {
        for e in std::fs::read_dir(dir).into_iter().flatten().flatten() {
            let p = e.path();
            if p.is_dir() {
                rust_files(&p, out);
            } else if p.extension().is_some_and(|x| x == "rs") {
                out.push(p);
            }
        }
    }
    let root = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("..");
    let mut files = Vec::new();
    for d in [
        "konclave-ohttp",
        "konclave-ohttp-relay",
        "helper-server/src",
        "konclave-http",
    ] {
        rust_files(&root.join(d), &mut files);
    }
    assert!(files.len() > 10, "the scan found {} files", files.len());
    let mut found = 0;
    for f in files {
        let text = std::fs::read_to_string(&f).unwrap_or_default();
        let bytes = text.as_bytes();
        let mut i = 0;
        while i + 64 <= bytes.len() {
            let run = &bytes[i..i + 64];
            let is_run = run.iter().all(u8::is_ascii_hexdigit)
                && bytes.get(i + 64).is_none_or(|b| !b.is_ascii_hexdigit())
                && (i == 0 || !bytes[i - 1].is_ascii_hexdigit());
            if is_run && i >= 2 && bytes[i - 1] == b' ' && bytes[i - 2].is_ascii_digit() {
                found += 1;
                let mut s = i - 2;
                while s > 0 && bytes[s - 1].is_ascii_digit() {
                    s -= 1;
                }
                let candidate = String::from_utf8_lossy(&bytes[s..i + 64]).to_string();
                assert!(
                    key_config_from_text(&candidate).is_err(),
                    "{} writes out a key file the server accepts; use test_key_text and add the key to KNOWN_TEST_KEYS",
                    f.display()
                );
            }
            i += 1;
        }
    }
    // The scan is not vacuous: the bad-key rows of typed.rs are literals of this shape.
    assert!(found > 0, "the scan found no key-file literal at all");
}
