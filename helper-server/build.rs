//! Stamp the commit this binary was built from into the binary.
//!
//! The question "is what production runs the same as what `main` says?" had no answer that did not
//! rest on someone remembering the procedure (#522). On 2026-09-16 the deployed helper was nine days
//! behind `main` and nothing said so; on 2026-09-17 a fix was deployed and the only evidence it
//! arrived was the sequence of steps taken. #466 is the same gap with money on it: the repo was
//! correct for a week while the container ran something else, and there was no way to see it.
//!
//! DIRTY IS PART OF THE ANSWER. A commit alone says "built from something like this". A build made
//! from a modified tree is not reproducible from that commit, and saying so is the difference
//! between an identifier and a guess.
//!
//! Failing softly is deliberate: a build from a tarball, or without git on PATH, must still produce
//! a working helper. It reports `unknown` rather than refusing to compile, because a binary that
//! cannot say what it is remains more useful than no binary.

use std::process::Command;

fn git(args: &[&str]) -> Option<String> {
    let out = Command::new("git").args(args).output().ok()?;
    if !out.status.success() {
        return None;
    }
    let s = String::from_utf8(out.stdout).ok()?.trim().to_string();
    if s.is_empty() {
        None
    } else {
        Some(s)
    }
}

fn main() {
    // Rebuild the stamp when HEAD moves. Without this, cargo caches the crate and the binary keeps
    // reporting the commit it was FIRST built at, which is a worse lie than reporting nothing.
    println!("cargo:rerun-if-changed=../.git/HEAD");
    println!("cargo:rerun-if-changed=../.git/index");

    let commit = git(&["rev-parse", "--short", "HEAD"]).unwrap_or_else(|| "unknown".into());
    let dirty = git(&["status", "--porcelain"]).is_some();
    let commit = if dirty {
        format!("{commit}-dirty")
    } else {
        commit
    };
    println!("cargo:rustc-env=KONCLAVE_BUILD_COMMIT={commit}");

    // Seconds since the epoch, formatted by the caller. No local paths, no user, no hostname: this
    // is served publicly, and the only thing anyone needs from it is WHICH build is answering.
    let built = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0);
    println!("cargo:rustc-env=KONCLAVE_BUILD_EPOCH={built}");
}
