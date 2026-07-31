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

use std::time::Duration;

use orchestrator::helper::{
    append_ceremony, is_valid_group_key, load_ceremonies, payment_plan, register_vault,
    send_config_for, vault_balance, CeremonyRecord, HelperConfig, HelperState, VaultRegistration,
};
use orchestrator::send::net_orchestrate_send;
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
        (Method::Get, "/api/vault/balance") => {
            match query_param(query, "vault").and_then(|v| state.get(v)) {
                None => resp(404, json!({ "error": "no such vault" }).to_string()),
                Some(reg) => match vault_balance(cfg, &reg) {
                    Ok(b) => resp(
                        200,
                        json!({
                            "orchard_spendable_zat": b.orchard_spendable_zat,
                            "total_zat": b.total_zat
                        })
                        .to_string(),
                    ),
                    Err(e) => resp(502, json!({ "error": e.to_string() }).to_string()),
                },
            }
        }
        (Method::Get, "/api/vault/ceremonies") => {
            match query_param(query, "vault").and_then(|v| state.get(v)) {
                None => resp(404, json!({ "error": "no such vault" }).to_string()),
                Some(reg) => {
                    let recs = load_ceremonies(&cfg.vaults_dir, &reg.vault_id);
                    resp(200, json!({ "ceremonies": recs }).to_string())
                }
            }
        }
        (Method::Post, "/api/vault/send") => handle_send(state, cfg, body),
        _ => resp(404, json!({ "error": "not found" }).to_string()),
    }
}

/// Architecture-B send: the helper builds/proves the PCZT for the vault's own spend, publishes a
/// signing request into the vault's relay room, waits for the **browsers'** aggregate FROST
/// signature, injects it, and (unless `dry_run`) broadcasts. It never sees a share. Every
/// caller-fixable rejection (bad json, unknown vault, bad destination/amount) is decided BEFORE
/// the engine runs, so those branches are unit-testable; only the happy path touches the tooling
/// and the relay. `dry_run` defaults to **true** (safe): the caller must pass `"dry_run": false`
/// to actually broadcast, so a single call never fires funds by accident.
fn handle_send(state: &HelperState, cfg: &HelperConfig, body: &[u8]) -> Resp {
    #[derive(Deserialize)]
    struct Req {
        vault: String,
        to: String,
        amount_zat: u64,
        memo: Option<String>,
        #[serde(default = "default_dry_run")]
        dry_run: bool,
        relay_base: String,
        room: String,
        #[serde(default = "default_max_polls")]
        max_polls: u32,
    }
    fn default_dry_run() -> bool {
        true
    }
    fn default_max_polls() -> u32 {
        // The browser FROST ceremony over the blind relay (short-poll, several round-trips per
        // spend) can exceed 2 minutes, so give the helper a generous window to collect the
        // devices' aggregate signature before giving up. Each poll is `poll_delay` (1s).
        300
    }
    let req: Req = match serde_json::from_slice(body) {
        Ok(r) => r,
        Err(_) => return resp(400, json!({ "error": "invalid json" }).to_string()),
    };
    let reg = match state.get(&req.vault) {
        Some(r) => r,
        None => return resp(404, json!({ "error": "no such vault" }).to_string()),
    };
    let plan = match payment_plan(&req.to, req.amount_zat, req.memo, cfg.network_type()) {
        Ok(p) => p,
        Err(e) => return resp(400, json!({ "error": e.to_string() }).to_string()),
    };
    // Per-send scratch dir under the vault's own tree (intermediate PCZTs, never a share).
    let work_dir = format!("{}/{}/send-work", cfg.vaults_dir.display(), reg.vault_id);
    let sc = send_config_for(cfg, &reg, work_dir);
    match net_orchestrate_send(
        &sc,
        &plan,
        &req.relay_base,
        &req.room,
        req.dry_run,
        req.max_polls,
        Duration::from_secs(1),
    ) {
        Ok(out) => {
            // Record the ceremony (ZecSafe-inspired reproducible evidence): sighash + aggregate
            // signature(s) + txid, all public + independently verifiable. Best-effort — a
            // persistence failure must not undo a completed send.
            let rec = CeremonyRecord {
                vault_id: reg.vault_id.clone(),
                sighash: out.sighash.clone(),
                signatures: out.signatures.clone(),
                txid: out.txid.clone(),
                dry_run: req.dry_run,
                created_at_unix: now_unix(),
            };
            let _ = append_ceremony(&cfg.vaults_dir, &rec);
            resp(
                200,
                json!({ "txid": out.txid, "dry_run": req.dry_run, "sighash": out.sighash,
                        "signatures": out.signatures })
                .to_string(),
            )
        }
        Err(e) => resp(502, json!({ "error": e.to_string() }).to_string()),
    }
}

/// Unix seconds now (0 if the clock is before the epoch, which never happens on a real host).
fn now_unix() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0)
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
        konclave_signer: PathBuf::from(env("KONCLAVE_SIGNER", "konclave-signer")),
        vaults_dir: PathBuf::from(env("KONCLAVE_VAULTS_DIR", "./helper-vaults")),
    }
}

fn main() {
    let addr = std::env::var("KONCLAVE_HELPER_ADDR").unwrap_or_else(|_| "0.0.0.0:4780".to_string());
    let cfg = Arc::new(config_from_env());
    let state = Arc::new(HelperState::new());
    // Reseed the registry from disk (a restart / redeploy keeps every vault when vaults_dir is on a
    // persistent volume). Only public / view-only material is loaded — never a share.
    let restored = orchestrator::helper::load_registrations(&cfg.vaults_dir);
    let restored_n = restored.len();
    for reg in restored {
        state.insert(reg);
    }
    let server = Server::http(&addr).expect("bind");
    eprintln!(
        "konclave-helper listening on {addr} (network={}, {restored_n} vault(s) restored)",
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
            konclave_signer: PathBuf::from("/nonexistent/konclave-signer"),
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

    // All send rejections below fire BEFORE the engine/relay run, so no tooling is touched.

    #[test]
    fn send_rejects_bad_json_before_anything() {
        let st = HelperState::new();
        let r = handle(&st, &cfg(), &Method::Post, "/api/vault/send", b"not json");
        assert_eq!(r.status, 400);
    }

    #[test]
    fn send_unknown_vault_is_404() {
        let st = HelperState::new();
        // Well-formed request, but the vault is not registered: rejected before the engine.
        let body = br#"{"vault":"zzzz","to":"utest1xyz","amount_zat":1000,"relay_base":"http://x","room":"r"}"#;
        let r = handle(&st, &cfg(), &Method::Post, "/api/vault/send", body);
        assert_eq!(r.status, 404);
    }

    #[test]
    fn send_rejects_zero_amount_for_known_vault() {
        let st = HelperState::new();
        seed(&st, "aaaa");
        // Zero amount is caught by payment_plan before any PCZT is built.
        let body = br#"{"vault":"aaaa","to":"utest1xyz","amount_zat":0,"relay_base":"http://x","room":"r"}"#;
        let r = handle(&st, &cfg(), &Method::Post, "/api/vault/send", body);
        assert_eq!(r.status, 400);
        assert!(r.body.contains("greater than zero"));
    }

    #[test]
    fn ceremonies_unknown_vault_is_404() {
        let st = HelperState::new();
        let r = handle(
            &st,
            &cfg(),
            &Method::Get,
            "/api/vault/ceremonies?vault=zzzz",
            b"",
        );
        assert_eq!(r.status, 404);
    }

    #[test]
    fn ceremonies_known_vault_returns_a_list() {
        // A registered vault with no trail yet returns an empty list (no engine needed).
        let st = HelperState::new();
        seed(&st, "aaaa");
        let r = handle(
            &st,
            &cfg(),
            &Method::Get,
            "/api/vault/ceremonies?vault=aaaa",
            b"",
        );
        assert_eq!(r.status, 200);
        assert!(r.body.contains("\"ceremonies\":[]"));
    }

    #[test]
    fn balance_unknown_vault_is_404() {
        // The unknown-vault branch is decided before any sync/engine runs, so it is testable.
        let st = HelperState::new();
        let r = handle(
            &st,
            &cfg(),
            &Method::Get,
            "/api/vault/balance?vault=zzzz",
            b"",
        );
        assert_eq!(r.status, 404);
    }

    #[test]
    fn send_rejects_bad_destination_for_known_vault() {
        let st = HelperState::new();
        seed(&st, "aaaa");
        // A malformed destination is rejected by authoritative decode before the engine runs.
        let body = br#"{"vault":"aaaa","to":"not-an-address","amount_zat":1000,"relay_base":"http://x","room":"r"}"#;
        let r = handle(&st, &cfg(), &Method::Post, "/api/vault/send", body);
        assert_eq!(r.status, 400);
    }
}
