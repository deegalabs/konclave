//! Every server runs its request loop through the shared rule, so a worker that ends ends the
//! process with a failure code.
//!
//! The rule in `konclave_http::run_workers` / `run_in_place` can pass its own tests while a server
//! goes on spawning and joining its own threads, which is the shape that let a pool die to nothing
//! and exit 0. So this reads the sources: each server calls the shared rule, and none keeps a pool of
//! its own.

use std::fs;
use std::path::Path;

fn read(rel: &str) -> String {
    let path = Path::new(env!("CARGO_MANIFEST_DIR")).join(rel);
    fs::read_to_string(&path).unwrap_or_else(|e| panic!("cannot read {rel}: {e}"))
}

#[test]
fn every_server_runs_its_request_loop_through_the_shared_rule() {
    for (rel, call) in [
        (
            "../helper-server/src/main.rs",
            "konclave_http::run_workers(",
        ),
        ("../relay-server/src/main.rs", "konclave_http::run_workers("),
        (
            "../orchestrator/src/server.rs",
            "konclave_http::run_in_place(",
        ),
    ] {
        let src = read(rel);
        assert!(
            src.contains(call),
            "{rel} must run its request loop through {call}"
        );
        assert!(
            !src.contains("pool.push(") && !src.contains("for w in pool"),
            "{rel} keeps a worker pool of its own; a worker that dies there is not seen"
        );
    }
}
