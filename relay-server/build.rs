//! Stamp a digest of the sources this relay was built from into the binary.
//!
//! The helper answers "which build is running?" with a git commit (#522/#531). The relay cannot:
//! it is built by Railway from an uploaded directory, so there is no GitHub connection and no
//! `RAILWAY_GIT_COMMIT_SHA`, and the Dockerfile copies `Cargo.toml` and `src` without `.git`. A
//! commit stamp here would report `unknown` every time, which is worse than nothing because it
//! looks like an answer.
//!
//! A digest of the sources answers the question that actually matters, and answers it better: not
//! "which commit was this" but "is the running relay built from THIS source". It needs no git, no
//! platform metadata and no step anyone has to remember at deploy time, which is the failure mode
//! every other fix in this area has been about.
//!
//! IT IS NOT AN ATTESTATION, and nothing here should be read as one. Anyone who can replace the
//! binary can also make it report whatever digest they like. It detects a stale deploy, not an
//! adversary, which is why the hash below is a plain FNV-1a rather than something that would invite
//! being mistaken for a security control.

use std::fs;

/// Every file under `dir`, recursively, as paths relative to the crate root.
///
/// An unreadable directory contributes nothing rather than failing the build, for the same reason a
/// missing file does: the digest's job is to DIFFER when the sources differ, not to refuse to
/// compile. A build that cannot read its own sources will fail a line later anyway.
fn walk(dir: &str, out: &mut Vec<String>) {
    let Ok(entries) = fs::read_dir(dir) else {
        return;
    };
    for e in entries.flatten() {
        let path = e.path();
        let Some(p) = path.to_str() else { continue };
        if path.is_dir() {
            walk(p, out);
        } else {
            out.push(p.to_string());
        }
    }
}

/// FNV-1a, 64-bit. Chosen because this is a drift check and the code should not pretend otherwise.
fn fnv1a(bytes: &[u8]) -> u64 {
    let mut h: u64 = 0xcbf2_9ce4_8422_2325;
    for b in bytes {
        h ^= *b as u64;
        h = h.wrapping_mul(0x1000_0000_01b3);
    }
    h
}

fn main() {
    // `src/` is WALKED, not listed. A hardcoded list digests the files someone remembered, and this
    // repo's recurring defect is precisely the thing someone did not remember. A new module happens
    // to change the digest anyway, because Rust makes you declare it in `main.rs` - but EDITING that
    // module afterwards would not, and a fingerprint that misses edits to half the crate is worse
    // than none, because it reports a match that means nothing.
    //
    // Sorted, so the digest does not depend on the order the filesystem hands them back.
    let mut parts: Vec<String> = vec!["Cargo.toml".into()];
    walk("src", &mut parts);
    parts.sort();

    let mut blob = Vec::new();
    for p in &parts {
        println!("cargo:rerun-if-changed={p}");
        // The NAME is digested too. Otherwise renaming a file, or moving its contents into another,
        // leaves the fingerprint unchanged while the crate is no longer the same crate.
        blob.extend_from_slice(&(p.len() as u64).to_le_bytes());
        blob.extend_from_slice(p.as_bytes());
        match fs::read(p) {
            Ok(mut b) => {
                // Length-prefixed, so moving a byte from one file to the next changes the digest.
                blob.extend_from_slice(&(b.len() as u64).to_le_bytes());
                blob.append(&mut b);
            }
            // A missing file is a real answer, not a reason to fail the build: it means the image
            // was assembled from something other than this crate, and the digest should say so by
            // differing rather than by matching.
            Err(_) => blob.extend_from_slice(b"<missing>"),
        }
    }

    println!(
        "cargo:rustc-env=KONCLAVE_SOURCE_DIGEST={:016x}",
        fnv1a(&blob)
    );
}
