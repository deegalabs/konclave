//! Konclave hosted BLIND helper (ADR-0006, Rung A).
//!
//! Turns `/net` into a self-service web vault: it registers a browser-DKG vault by its FROST group
//! key, derives the vault's Orchard address + UFVK (public material), keeps a VIEW-ONLY wallet per
//! vault, and (as the send path lands) builds/proves/broadcasts over Architecture B while the
//! browsers sign. It is **blind to shares** by construction: it never receives, derives, or stores a
//! share or seed, and it cannot move funds without the quorum's browser signatures.
//!
//! Bind on `0.0.0.0` with permissive CORS so browsers on any origin can reach it (like the relay).
//! Config comes from the environment (see `HelperConfig::from_env`).

use std::path::PathBuf;
use std::sync::Arc;

use orchestrator::helper::{
    is_valid_group_key, register_vault, HelperConfig, HelperState, VaultRegistration,
};
use serde::Deserialize;
use serde_json::json;
use tiny_http::{Header, Method, Response, Server};

/// A minimal response: an HTTP status and a JSON body. Kept separate from tiny_http's `Response`
/// so `handle` is pure and unit-testable without a live socket or the engine binaries.
struct Resp {
    status: u16,
    body: String,
}

fn resp(status: u16, body: impl Into<String>) -> Resp {
    Resp {
        status,
        body: body.into(),
    }
}

/// The vault's PUBLIC view for a response. Deliberately omits the UFVK and the account uuid: the
/// UFVK decrypts the whole tx graph and the browser does not need it (the helper holds it). The
/// browser only needs the address (to receive) and the id.
fn vault_value(r: &VaultRegistration) -> serde_json::Value {
    json!({ "vault_id": r.vault_id, "address": r.address })
}

/// One value from a `k=v&k2=v2` query string (no percent-decoding needed for our ids/hex).
fn query_param<'a>(query: &'a str, key: &str) -> Option<&'a str> {
    query.split('&').find_map(|kv| {
        let (k, v) = kv.split_once('=')?;
        (k == key).then_some(v)
    })
}

/// The pure router. `state` is the live registry; `cfg` is the helper's tooling config. Returns the
/// status + JSON body. Only `POST /api/vault` reaches the engine (via register_vault); every read
/// path and every input rejection is decided here, so they are unit-testable.
fn handle(
    state: &HelperState,
    cfg: &HelperConfig,
    method: &Method,
    path: &str,
    body: &[u8],
) -> Resp {
    let (p, query) = path.split_once('?').unwrap_or((path, ""));
    match (method, p) {
        (Method::Get, "/api/health") => resp(
            200,
            json!({ "status": "ok", "name": "konclave-helper", "vaults": state.len() }).to_string(),
        ),
        (Method::Get, "/api/vaults") => resp(200, json!({ "vaults": state.ids() }).to_string()),
        (Method::Get, "/api/vault") => match query_param(query, "vault").and_then(|v| state.get(v))
        {
            Some(r) => resp(200, json!({ "vault": vault_value(&r) }).to_string()),
            None => resp(404, json!({ "error": "no such vault" }).to_string()),
        },
        (Method::Post, "/api/vault") => {
            #[derive(Deserialize)]
            struct Req {
                group_key: String,
                name: Option<String>,
            }
            let req: Req = match serde_json::from_slice(body) {
                Ok(r) => r,
                Err(_) => return resp(400, json!({ "error": "invalid json" }).to_string()),
            };
            if !is_valid_group_key(&req.group_key) {
                return resp(
                    400,
                    json!({ "error": "group_key must be 64 hex chars" }).to_string(),
                );
            }
            // Idempotent: if already registered, return it without re-running the tooling.
            if let Some(r) = state.get(&req.group_key) {
                return resp(200, vault_value(&r).to_string());
            }
            let name = req.name.as_deref().unwrap_or("vault");
            match register_vault(cfg, &req.group_key, name) {
                Ok(r) => {
                    let out = vault_value(&r).to_string();
                    state.insert(r);
                    resp(200, out)
                }
                Err(e) => resp(502, json!({ "error": e.to_string() }).to_string()),
            }
        }
        _ => resp(404, json!({ "error": "not found" }).to_string()),
    }
}

fn header(name: &str, value: &str) -> Header {
    Header::from_bytes(name.as_bytes(), value.as_bytes()).expect("valid header")
}

fn with_cors(mut r: Response<std::io::Cursor<Vec<u8>>>) -> Response<std::io::Cursor<Vec<u8>>> {
    r.add_header(header("Access-Control-Allow-Origin", "*"));
    r.add_header(header("Access-Control-Allow-Methods", "GET, POST, OPTIONS"));
    r.add_header(header(
        "Access-Control-Allow-Headers",
        "Content-Type, X-Konclave-Session",
    ));
    r.add_header(header("Content-Type", "application/json"));
    r
}

/// Build a HelperConfig from env vars. All paths are public tooling; nothing secret.
fn config_from_env() -> HelperConfig {
    let env = |k: &str, d: &str| std::env::var(k).unwrap_or_else(|_| d.to_string());
    HelperConfig {
        zcash_sign: PathBuf::from(env("KONCLAVE_ZCASH_SIGN", "zcash-sign")),
        devtool: PathBuf::from(env("KONCLAVE_DEVTOOL", "zcash-devtool")),
        lightwalletd: env("KONCLAVE_LIGHTWALLETD", "testnet.zec.rocks:443"),
        network: env("KONCLAVE_NETWORK", "test"),
        vaults_dir: PathBuf::from(env("KONCLAVE_VAULTS_DIR", "./helper-vaults")),
    }
}

fn main() {
    let addr = std::env::var("KONCLAVE_HELPER_ADDR").unwrap_or_else(|_| "0.0.0.0:4780".to_string());
    let cfg = Arc::new(config_from_env());
    let state = Arc::new(HelperState::new());
    let server = Server::http(&addr).expect("bind");
    eprintln!(
        "konclave-helper listening on {addr} (network={})",
        cfg.network
    );

    for mut req in server.incoming_requests() {
        if req.method() == &Method::Options {
            let _ = req.respond(with_cors(Response::from_data(Vec::new())).with_status_code(204));
            continue;
        }
        let method = req.method().clone();
        let path = req.url().to_string();
        let mut body = Vec::new();
        let _ = req.as_reader().read_to_end(&mut body);
        let r = handle(&state, &cfg, &method, &path, &body);
        let out = Response::from_data(r.body.into_bytes()).with_status_code(r.status);
        let _ = req.respond(with_cors(out));
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn cfg() -> HelperConfig {
        HelperConfig {
            zcash_sign: PathBuf::from("/nonexistent/zcash-sign"),
            devtool: PathBuf::from("/nonexistent/zcash-devtool"),
            lightwalletd: "testnet.zec.rocks:443".into(),
            network: "test".into(),
            vaults_dir: PathBuf::from("/tmp/helper-vaults"),
        }
    }

    fn seed(state: &HelperState, id: &str) {
        state.insert(VaultRegistration {
            vault_id: id.into(),
            address: format!("utest1{id}"),
            ufvk: format!("uviewtest1{id}"),
            wallet_dir: format!("/tmp/{id}/wallet"),
            account: format!("acct-{id}"),
        });
    }

    #[test]
    fn health_reports_vault_count() {
        let st = HelperState::new();
        seed(&st, "aaaa");
        let r = handle(&st, &cfg(), &Method::Get, "/api/health", b"");
        assert_eq!(r.status, 200);
        assert!(r.body.contains("\"vaults\":1"));
        assert!(r.body.contains("konclave-helper"));
    }

    #[test]
    fn get_vault_found_and_not_found() {
        let st = HelperState::new();
        seed(&st, "aaaa");
        let ok = handle(&st, &cfg(), &Method::Get, "/api/vault?vault=aaaa", b"");
        assert_eq!(ok.status, 200);
        assert!(ok.body.contains("utest1aaaa"));
        // Never leaks the UFVK or the account.
        assert!(!ok.body.contains("uviewtest1"));
        assert!(!ok.body.contains("acct-"));
        let miss = handle(&st, &cfg(), &Method::Get, "/api/vault?vault=zzzz", b"");
        assert_eq!(miss.status, 404);
    }

    #[test]
    fn list_vaults_sorted() {
        let st = HelperState::new();
        seed(&st, "bbbb");
        seed(&st, "aaaa");
        let r = handle(&st, &cfg(), &Method::Get, "/api/vaults", b"");
        assert_eq!(r.status, 200);
        assert_eq!(r.body, "{\"vaults\":[\"aaaa\",\"bbbb\"]}");
    }

    #[test]
    fn register_rejects_bad_json_and_bad_key_before_exec() {
        let st = HelperState::new();
        let bad_json = handle(&st, &cfg(), &Method::Post, "/api/vault", b"not json");
        assert_eq!(bad_json.status, 400);
        let bad_key = handle(
            &st,
            &cfg(),
            &Method::Post,
            "/api/vault",
            br#"{"group_key":"short"}"#,
        );
        assert_eq!(bad_key.status, 400);
        assert!(st.is_empty());
    }

    #[test]
    fn register_is_idempotent_for_a_known_vault() {
        let st = HelperState::new();
        seed(
            &st,
            "6ed62d0ba95e25668f80104425723a57d2be9ae525b28535f04850e4456edd1b",
        );
        // A valid, already-registered group key returns without touching the (bogus) tooling.
        let r = handle(
            &st,
            &cfg(),
            &Method::Post,
            "/api/vault",
            br#"{"group_key":"6ed62d0ba95e25668f80104425723a57d2be9ae525b28535f04850e4456edd1b"}"#,
        );
        assert_eq!(r.status, 200);
        assert_eq!(st.len(), 1);
    }

    #[test]
    fn unknown_route_is_404() {
        let st = HelperState::new();
        let r = handle(&st, &cfg(), &Method::Get, "/api/nope", b"");
        assert_eq!(r.status, 404);
    }
}
