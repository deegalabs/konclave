//! Neither public server may decide for itself which value of `X-Forwarded-For` is the client.
//!
//! The rule lives in this crate: `boot_forwarding_rule` reads the setting once and records it, and
//! `request_client_address` is the only way a server can turn a request into an address (the
//! function that takes a rule is private to the crate). So the drift left to catch is a server that
//! never boots the rule, boots it after it has touched the volume or a socket, or keeps a reader of
//! its own. This reads the sources of both servers, in the same spirit as `no_unbounded_body.rs`.

use std::fs;
use std::path::Path;

const PUBLIC_SERVERS: [&str; 2] = [
    "../helper-server/src/main.rs",
    "../relay-server/src/main.rs",
];

/// The source of a server without its test module, and without comment lines.
fn production_code(rel: &str) -> String {
    let path = Path::new(env!("CARGO_MANIFEST_DIR")).join(rel);
    let text = fs::read_to_string(&path).unwrap_or_else(|e| panic!("cannot read {rel}: {e}"));
    let before_tests = text
        .split("#[cfg(test)]\nmod tests")
        .next()
        .unwrap_or(&text);
    before_tests
        .lines()
        .filter(|l| !l.trim_start().starts_with("//"))
        .collect::<Vec<_>>()
        .join("\n")
}

/// `main`'s body, up to the first line that is a closing brace at column zero.
fn main_body(code: &str, rel: &str) -> String {
    let at = code
        .find("fn main() {")
        .unwrap_or_else(|| panic!("{rel} has no `fn main() {{`"));
    let rest = &code[at..];
    rest[..rest.find("\n}\n").unwrap_or(rest.len())].to_string()
}

#[test]
fn both_public_servers_boot_the_rule_first_and_apply_it_through_the_crate() {
    for rel in PUBLIC_SERVERS {
        let code = production_code(rel);
        let main = main_body(&code, rel);
        let boot = main
            .find("konclave_http::boot_forwarding_rule(")
            .unwrap_or_else(|| {
                panic!("{rel}: main never calls konclave_http::boot_forwarding_rule")
            });
        for later in ["Server::http(", "boot_registry(", "config_from_env("] {
            if let Some(at) = main.find(later) {
                assert!(
                    boot < at,
                    "{rel}: the rule is booted after `{later}`; it must come first, so a setting \
                     that is not understood stops the server before it touches a socket or a volume",
                );
            }
        }
        assert!(
            code.contains("konclave_http::request_client_address("),
            "{rel} never calls konclave_http::request_client_address",
        );
        for forbidden in [
            "ForwardingRule::",
            "from_setting(",
            "TRUSTED_PROXY_HOPS_VAR",
            "with_forwarding_rule(",
            "init_forwarding_rule(",
            "OnceLock<konclave_http::ForwardingRule>",
        ] {
            assert!(
                !code.contains(forbidden),
                "{rel} production code contains `{forbidden}`: the rule is read and applied in \
                 konclave-http only, one implementation (#400)",
            );
        }
    }
}
