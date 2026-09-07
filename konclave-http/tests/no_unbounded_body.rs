//! Neither public server may read a request body without a ceiling.
//!
//! A unit test cannot catch this: the rule is not "does `body_read_cap` work" - it did, and its own
//! tests passed the whole time - but "does every server CALL it". #269 was open for fifteen days
//! while the relay called it and the helper did not, and the release notes said both did.
//!
//! So this reads the sources and refuses a bare `read_to_end` on a request body. It is the same
//! shape as the repo's `prf-reachable` and `wasm-ready` source scans, and it exists for the same
//! reason: a capability that is offered must be shown to be USED, because the gap between having a
//! rule and applying it is where this codebase keeps losing.

use std::fs;
use std::path::Path;

/// Servers that face the open internet. Both must cap.
const PUBLIC_SERVERS: [&str; 2] = [
    "../helper-server/src/main.rs",
    "../relay-server/src/main.rs",
];

fn read(rel: &str) -> String {
    let path = Path::new(env!("CARGO_MANIFEST_DIR")).join(rel);
    fs::read_to_string(&path).unwrap_or_else(|e| panic!("cannot read {rel}: {e}"))
}

#[test]
fn no_public_server_reads_a_request_body_unbounded() {
    for rel in PUBLIC_SERVERS {
        for (i, line) in read(rel).lines().enumerate() {
            let l = line.trim();
            if l.starts_with("//") || !l.contains("read_to_end") {
                continue;
            }
            // `.take(limit)` is what bounds it. Reject anything else, including a future
            // `read_to_end` that looks innocent - the point is that the ceiling is visible here.
            assert!(
                l.contains(".take("),
                "{rel}:{} reads a request body with no ceiling:\n    {l}\n\
                 Use konclave_http::body_read_cap and .take(limit). An unbounded read on a public \
                 POST is memory exhaustion by one request (#269).",
                i + 1,
            );
        }
    }
}

#[test]
fn both_public_servers_take_the_shared_rule() {
    // The complement: capping by hand, with a local constant, is how the two copies diverged in the
    // first place. Both must reach for the same crate.
    for rel in PUBLIC_SERVERS {
        assert!(
            read(rel).contains("body_read_cap("),
            "{rel} does not call body_read_cap; it must not invent its own ceiling",
        );
    }
}
