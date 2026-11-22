//! Every server runs its request loop through the shared rule, so a worker that ends ends the
//! process with a failure code.
//!
//! The rule in `konclave_http::run_workers` / `run_in_place` can pass its own tests while a server
//! goes on spawning and joining its own threads, which is the shape that let a pool die to nothing
//! and exit 0. So this reads the sources: every crate that serves HTTP with tiny_http is listed
//! here, each calls the shared rule in code (not in a comment), and none starts or joins threads of
//! its own outside its tests.

use std::fs;
use std::path::Path;

/// Each crate that depends on tiny_http, and the file that runs its request loop.
const SERVERS: [(&str, &str, &str); 3] = [
    (
        "helper-server",
        "src/main.rs",
        "konclave_http::run_workers(",
    ),
    ("relay-server", "src/main.rs", "konclave_http::run_workers("),
    (
        "orchestrator",
        "src/server.rs",
        "konclave_http::run_in_place(",
    ),
];

fn repo() -> &'static Path {
    Path::new(env!("CARGO_MANIFEST_DIR"))
        .parent()
        .expect("repo root")
}

fn read(rel: &Path) -> String {
    fs::read_to_string(repo().join(rel)).unwrap_or_else(|e| panic!("cannot read {rel:?}: {e}"))
}

/// The production code of a server file: line comments removed and its test module cut off.
fn production(src: &str) -> String {
    let body = src.split("\nmod tests {").next().unwrap_or(src);
    body.lines().map(code_part).collect::<Vec<_>>().join("\n")
}

/// A line up to its `//` comment, where a `//` inside a string literal does not start one.
fn code_part(line: &str) -> &str {
    let (mut in_str, mut escaped) = (false, false);
    let bytes = line.as_bytes();
    for i in 0..bytes.len() {
        let c = bytes[i];
        if in_str {
            match (escaped, c) {
                (true, _) => escaped = false,
                (false, b'\\') => escaped = true,
                (false, b'"') => in_str = false,
                _ => {}
            }
        } else if c == b'"' {
            in_str = true;
        } else if c == b'/' && bytes.get(i + 1) == Some(&b'/') {
            return &line[..i];
        }
    }
    line
}

#[test]
fn every_tiny_http_server_is_on_the_list() {
    let mut found: Vec<String> = fs::read_dir(repo())
        .expect("repo root")
        .filter_map(|e| e.ok())
        .filter(|e| {
            fs::read_to_string(e.path().join("Cargo.toml"))
                .map(|t| t.lines().any(|l| l.trim_start().starts_with("tiny_http")))
                .unwrap_or(false)
        })
        .map(|e| e.file_name().to_string_lossy().into_owned())
        .collect();
    found.sort();
    let mut listed: Vec<String> = SERVERS.iter().map(|(c, _, _)| c.to_string()).collect();
    listed.sort();
    assert_eq!(
        found, listed,
        "a crate serves HTTP with tiny_http and is not checked for the worker rule"
    );
}

#[test]
fn every_server_runs_its_request_loop_through_the_shared_rule() {
    for (krate, file, call) in SERVERS {
        let rel = Path::new(krate).join(file);
        let code = production(&read(&rel));
        assert!(
            code.contains(call),
            "{rel:?} must run its request loop through {call} in code"
        );
        for own in ["spawn(", "thread::Builder", "thread::scope", ".join()"] {
            assert!(
                !code.contains(own),
                "{rel:?} uses `{own}` outside its tests; a worker of its own that dies is not seen"
            );
        }
    }
}

#[test]
fn the_pooled_servers_catch_a_handler_panic_through_the_shared_guard() {
    for (krate, file, _) in SERVERS.iter().filter(|(_, _, c)| c.contains("run_workers")) {
        let rel = Path::new(krate).join(file);
        let code = production(&read(&rel));
        assert!(
            code.contains("konclave_http::guard(|| state.handle(")
                || code.contains("konclave_http::guard(work)"),
            "{rel:?} must run each request's handler through konclave_http::guard"
        );
        assert!(
            !code.contains("catch_unwind"),
            "{rel:?} catches panics with a copy of its own"
        );
    }
}

#[test]
fn a_comment_is_cut_at_its_slashes_but_a_string_holding_slashes_is_kept() {
    assert_eq!(code_part("let a = 1; // thread::spawn"), "let a = 1; ");
    assert_eq!(
        code_part(r#"let u = "http://x"; std::thread::spawn(f);"#),
        r#"let u = "http://x"; std::thread::spawn(f);"#
    );
    assert_eq!(
        code_part(r#"let q = "a\"//b"; // c"#),
        r#"let q = "a\"//b"; "#
    );
}
