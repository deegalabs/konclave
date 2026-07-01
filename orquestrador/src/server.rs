//! The local HTTP bridge (ADR-0004): serves the Rosto bundle and a small JSON API,
//! bound to **`127.0.0.1` only**. This is not a network service — it is a local daemon
//! that a same-machine UI (browser today, a packaged webview tomorrow) talks to.
//!
//! Design for testability: [`handle`] is a pure dispatch — `(method, path, deps) →
//! Response` — with no socket. The socket loop in [`serve`] is a thin wrapper. Wallet
//! reads sit behind [`WalletReader`] so handlers can be tested (and failure-tested)
//! without spawning any external tool.
//!
//! The API never exposes secrets: only public vault material and local bookkeeping,
//! exactly as the [`crate::store`] discipline requires.

use std::path::{Path, PathBuf};

use serde::Serialize;

use crate::money::Zatoshis;
use crate::store::{ProposalKind, ProposalRecord, Store, VaultRecord};
use crate::wallet::{self, Balance, ChainInfo};

/// Read-only view of the on-chain wallet, abstracted so handlers are unit-testable
/// (and failure-testable) without spawning `zcash-devtool`.
pub trait WalletReader {
    fn info(&self) -> Result<ChainInfo, String>;
    fn balance(&self) -> Result<Balance, String>;
}

/// The live reader: drives `zcash-devtool` via the tested [`crate::wallet`] wrappers.
pub struct LiveWallet {
    pub devtool: PathBuf,
    pub wallet_dir: String,
    pub server: String,
}

impl WalletReader for LiveWallet {
    fn info(&self) -> Result<ChainInfo, String> {
        wallet::get_info(&self.devtool, &self.wallet_dir, &self.server).map_err(|e| e.to_string())
    }
    fn balance(&self) -> Result<Balance, String> {
        wallet::balance(&self.devtool, &self.wallet_dir).map_err(|e| e.to_string())
    }
}

/// Everything a request needs. Owns the wallet reader (optional: live balance is only
/// available when the tool paths are configured) and knows where the DB and web bundle
/// live.
pub struct Config {
    pub web_dir: PathBuf,
    pub db_path: String,
    pub wallet: Option<Box<dyn WalletReader>>,
}

/// A fully-formed HTTP response, independent of the transport.
pub struct Response {
    pub status: u16,
    pub content_type: String,
    pub body: Vec<u8>,
}

impl Response {
    fn json(status: u16, value: &serde_json::Value) -> Response {
        Response {
            status,
            content_type: "application/json; charset=utf-8".into(),
            body: serde_json::to_vec(value).unwrap_or_else(|_| b"{}".to_vec()),
        }
    }
    fn text(status: u16, ct: &str, body: Vec<u8>) -> Response {
        Response { status, content_type: ct.into(), body }
    }
}

// ---- DTOs (public material only; amounts carried as both zat and ZEC string) ----

#[derive(Serialize)]
struct VaultDto {
    id: String,
    name: String,
    threshold: u16,
    total: u16,
    members: u16,
    group_pubkey: String,
    orchard_address: String,
    ufvk: String,
    server_url: Option<String>,
}

impl From<VaultRecord> for VaultDto {
    fn from(v: VaultRecord) -> Self {
        VaultDto {
            id: v.id,
            name: v.name,
            threshold: v.quorum.threshold,
            total: v.quorum.total,
            members: v.quorum.total,
            group_pubkey: v.group_pubkey,
            orchard_address: v.orchard_address,
            ufvk: v.ufvk,
            server_url: v.server_url,
        }
    }
}

#[derive(Serialize)]
struct ProposalDto {
    id: String,
    vault_id: String,
    kind: &'static str,
    state: String,
    proposer: String,
    value_zat: u64,
    value_zec: String,
    memo: Option<String>,
    to_address: Option<String>,
    /// Whether the destination is transparent (public) — drives the UI warning.
    is_public: bool,
    expiry_unix: Option<i64>,
    txid: Option<String>,
    approvals: Vec<String>,
    refusals: Vec<String>,
    approvals_count: usize,
}

impl From<ProposalRecord> for ProposalDto {
    fn from(p: ProposalRecord) -> Self {
        let kind = match p.kind {
            ProposalKind::Payment => "payment",
            ProposalKind::Payroll => "payroll",
        };
        let is_public = p
            .to_address
            .as_deref()
            .map(|a| crate::validation::AddressKind::classify(a).is_public())
            .unwrap_or(false);
        ProposalDto {
            id: p.id,
            vault_id: p.vault_id,
            kind,
            state: format!("{:?}", p.state).to_lowercase(),
            proposer: p.proposer,
            value_zat: p.value_total.as_u64(),
            value_zec: p.value_total.to_zec_string(),
            memo: p.memo,
            to_address: p.to_address,
            is_public,
            expiry_unix: p.expiry_unix,
            txid: p.txid,
            approvals_count: p.approvals.len(),
            approvals: p.approvals,
            refusals: p.refusals,
        }
    }
}

#[derive(Serialize)]
struct BalanceDto {
    chain_tip_height: u64,
    total_zat: u64,
    total_zec: String,
    spendable_zat: u64,
    spendable_zec: String,
    pending_zat: u64,
    pending_zec: String,
    orchard_spendable_zat: u64,
    sapling_spendable_zat: u64,
    transparent_spendable_zat: u64,
}

impl From<Balance> for BalanceDto {
    fn from(b: Balance) -> Self {
        let spendable = b.orchard_spendable.as_u64()
            + b.sapling_spendable.as_u64()
            + b.transparent_spendable.as_u64();
        // total includes notes not yet spendable (awaiting confirmations).
        let pending = b.total.as_u64().saturating_sub(spendable);
        let zec = |z: u64| Zatoshis::from_u64(z).map(|v| v.to_zec_string()).unwrap_or_default();
        BalanceDto {
            chain_tip_height: b.chain_tip_height,
            total_zat: b.total.as_u64(),
            total_zec: b.total.to_zec_string(),
            spendable_zat: spendable,
            spendable_zec: zec(spendable),
            pending_zat: pending,
            pending_zec: zec(pending),
            orchard_spendable_zat: b.orchard_spendable.as_u64(),
            sapling_spendable_zat: b.sapling_spendable.as_u64(),
            transparent_spendable_zat: b.transparent_spendable.as_u64(),
        }
    }
}

// ---- dispatch (pure; no socket) ----

/// Route a request to a [`Response`]. Pure enough to unit-test every branch.
pub fn handle(cfg: &Config, method: &str, raw_path: &str, body: &[u8]) -> Response {
    // Drop any query string / fragment; keep just the path.
    let path = raw_path.split(['?', '#']).next().unwrap_or(raw_path);

    // Writes (state-changing) go through POST.
    if method == "POST" {
        return match path {
            "/api/proposals" => create_proposal(cfg, body),
            p if p.starts_with("/api/") => {
                Response::json(404, &serde_json::json!({"error": "unknown endpoint", "path": p}))
            }
            _ => Response::json(405, &serde_json::json!({"error": "method not allowed"})),
        };
    }
    if method != "GET" && method != "HEAD" {
        return Response::json(405, &serde_json::json!({"error": "method not allowed"}));
    }

    match path {
        "/api/health" => Response::json(
            200,
            &serde_json::json!({
                "status": "ok",
                "name": "konclave",
                "version": env!("CARGO_PKG_VERSION"),
            }),
        ),
        "/api/vault" => api_vault(cfg),
        "/api/proposals" => api_proposals(cfg),
        "/api/balance" => api_balance(cfg),
        p if p.starts_with("/api/") => {
            Response::json(404, &serde_json::json!({"error": "unknown endpoint", "path": p}))
        }
        _ => serve_static(&cfg.web_dir, path),
    }
}

fn open_store(cfg: &Config) -> Result<Store, Response> {
    Store::open(&cfg.db_path).map_err(|e| {
        Response::json(500, &serde_json::json!({"error": "store", "detail": e.to_string()}))
    })
}

/// The current vault (first known). `{ "vault": null }` when none exists yet.
fn api_vault(cfg: &Config) -> Response {
    let store = match open_store(cfg) {
        Ok(s) => s,
        Err(r) => return r,
    };
    match store.list_vaults() {
        Ok(mut vs) => {
            let vault = if vs.is_empty() { None } else { Some(VaultDto::from(vs.remove(0))) };
            Response::json(200, &serde_json::json!({ "vault": vault }))
        }
        Err(e) => Response::json(500, &serde_json::json!({"error": "store", "detail": e.to_string()})),
    }
}

/// Open proposals for the current vault (empty list when there is no vault).
fn api_proposals(cfg: &Config) -> Response {
    let store = match open_store(cfg) {
        Ok(s) => s,
        Err(r) => return r,
    };
    let vault_id = match store.list_vaults() {
        Ok(vs) => match vs.into_iter().next() {
            Some(v) => v.id,
            None => return Response::json(200, &serde_json::json!({ "proposals": [] })),
        },
        Err(e) => {
            return Response::json(500, &serde_json::json!({"error": "store", "detail": e.to_string()}))
        }
    };
    match store.list_open_proposals(&vault_id) {
        Ok(ps) => {
            let dtos: Vec<ProposalDto> = ps.into_iter().map(ProposalDto::from).collect();
            Response::json(200, &serde_json::json!({ "proposals": dtos }))
        }
        Err(e) => Response::json(500, &serde_json::json!({"error": "store", "detail": e.to_string()})),
    }
}

/// Live balance. `{ "configured": false }` when no wallet tool is wired; `502` when the
/// tool is wired but the call fails (offline node, etc.) — the UI degrades gracefully.
fn api_balance(cfg: &Config) -> Response {
    let Some(reader) = cfg.wallet.as_ref() else {
        return Response::json(200, &serde_json::json!({ "configured": false }));
    };
    match reader.balance() {
        Ok(b) => {
            let dto = BalanceDto::from(b);
            let mut v = serde_json::to_value(&dto).unwrap_or_else(|_| serde_json::json!({}));
            if let Some(obj) = v.as_object_mut() {
                obj.insert("configured".into(), serde_json::json!(true));
            }
            Response::json(200, &v)
        }
        Err(e) => Response::json(502, &serde_json::json!({"error": "wallet", "detail": e})),
    }
}

// ---- writes: create a proposal (single payment) ----

#[derive(serde::Deserialize)]
struct NewProposal {
    proposer: String,
    to_address: String,
    value_zec: String,
    #[serde(default)]
    memo: Option<String>,
}

fn bad(detail: impl Into<String>, what: &str) -> Response {
    Response::json(400, &serde_json::json!({"error": what, "detail": detail.into()}))
}

/// `POST /api/proposals` — validate at the boundary, then persist an Awaiting (or, for a
/// 1-of-n vault, Ready) proposal with the proposer as first approval. No funds move here;
/// spendability is authoritative at broadcast time (step 2c).
fn create_proposal(cfg: &Config, body: &[u8]) -> Response {
    use crate::proposal::Proposal;
    use crate::validation::{
        available_to_propose, estimate_fee_for_payment, validate_amount, validate_memo, AddressKind,
    };

    let input: NewProposal = match serde_json::from_slice(body) {
        Ok(v) => v,
        Err(e) => return bad(e.to_string(), "bad request"),
    };
    if input.proposer.trim().is_empty() {
        return bad("informe quem está propondo", "missing proposer");
    }

    // Destination: reject unrecognized encodings; transparent is allowed but flagged
    // downstream (is_public) so the UI warns.
    let addr_kind = AddressKind::classify(&input.to_address);
    if addr_kind == AddressKind::Unknown {
        return bad("endereço Zcash não reconhecido", "invalid address");
    }

    // Amount (no floating point) — must be > 0.
    let value = match Zatoshis::from_zec_str(&input.value_zec) {
        Ok(v) => v,
        Err(e) => return bad(e.to_string(), "invalid amount"),
    };
    if value.is_zero() {
        return bad("o valor deve ser maior que zero", "invalid amount");
    }

    // Memo rules (length; not on a transparent destination).
    let memo = input.memo.clone().unwrap_or_default();
    if let Err(e) = validate_memo(&memo, addr_kind) {
        return bad(e.to_string(), "invalid memo");
    }

    // Vault + quorum.
    let mut store = match open_store(cfg) {
        Ok(s) => s,
        Err(r) => return r,
    };
    let vault = match store.list_vaults() {
        Ok(mut vs) if !vs.is_empty() => vs.remove(0),
        Ok(_) => return bad("nenhum cofre neste dispositivo", "no vault"),
        Err(e) => return Response::json(500, &serde_json::json!({"error": "store", "detail": e.to_string()})),
    };

    // Overspend guard when a live wallet is wired. Uses total balance as the proposable
    // ceiling for the preview; spendable is re-checked authoritatively at broadcast.
    if let Some(reader) = cfg.wallet.as_ref() {
        if let Ok(bal) = reader.balance() {
            let fee = estimate_fee_for_payment(1, 1);
            let available = available_to_propose(bal.total, Zatoshis::ZERO, fee).unwrap_or(Zatoshis::ZERO);
            if let Err(e) = validate_amount(value, available) {
                return bad(e.to_string(), "insufficient funds");
            }
        }
    }

    // Build via the state machine (proposer = first approval), then persist.
    let proposal = Proposal::propose(input.proposer.clone(), vault.quorum);
    let rec = ProposalRecord {
        id: new_id(),
        vault_id: vault.id,
        kind: ProposalKind::Payment,
        state: proposal.state(),
        proposer: input.proposer.clone(),
        value_total: value,
        memo: if memo.is_empty() { None } else { Some(memo) },
        to_address: Some(input.to_address),
        expiry_unix: now_unix().map(|n| n + 72 * 3600), // 72h expiry (spec §10)
        txid: None,
        approvals: vec![input.proposer],
        refusals: vec![],
    };
    if let Err(e) = store.save_proposal(&rec) {
        return Response::json(500, &serde_json::json!({"error": "store", "detail": e.to_string()}));
    }
    let dto = ProposalDto::from(rec);
    Response::json(201, &serde_json::to_value(dto).unwrap_or_else(|_| serde_json::json!({})))
}

/// A short random hex id (public, non-secret) for a proposal.
fn new_id() -> String {
    let mut b = [0u8; 8];
    let _ = getrandom::getrandom(&mut b);
    b.iter().map(|x| format!("{x:02x}")).collect()
}

/// Wall-clock unix seconds (for expiry). `None` if the clock is before the epoch.
fn now_unix() -> Option<i64> {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .ok()
        .map(|d| d.as_secs() as i64)
}

// ---- static bundle (HashRouter → no SPA route fallback needed) ----

/// Serve a file from `web_dir`. `/` → `index.html`. Traversal (`..`) is rejected.
fn serve_static(web_dir: &Path, path: &str) -> Response {
    let rel = if path == "/" { "index.html" } else { path.trim_start_matches('/') };
    if rel.split(['/', '\\']).any(|seg| seg == "..") {
        return Response::text(403, "text/plain; charset=utf-8", b"forbidden".to_vec());
    }
    let full = web_dir.join(rel);
    match std::fs::read(&full) {
        Ok(bytes) => Response::text(200, content_type(&full), bytes),
        Err(_) => Response::text(
            404,
            "text/html; charset=utf-8",
            b"<!doctype html><meta charset=utf-8><title>404</title>\
              <body style=\"font-family:monospace;padding:2rem\">\
              404 - recurso nao encontrado. O bundle do Rosto foi buildado? \
              (<code>npm run build</code> em <code>rosto/</code>)</body>"
                .to_vec(),
        ),
    }
}

fn content_type(path: &Path) -> &'static str {
    match path.extension().and_then(|e| e.to_str()) {
        Some("html") => "text/html; charset=utf-8",
        Some("js") | Some("mjs") => "text/javascript; charset=utf-8",
        Some("css") => "text/css; charset=utf-8",
        Some("json") => "application/json; charset=utf-8",
        Some("svg") => "image/svg+xml",
        Some("png") => "image/png",
        Some("jpg") | Some("jpeg") => "image/jpeg",
        Some("webp") => "image/webp",
        Some("ico") => "image/x-icon",
        Some("woff2") => "font/woff2",
        Some("woff") => "font/woff",
        Some("ttf") => "font/ttf",
        Some("map") => "application/json; charset=utf-8",
        _ => "application/octet-stream",
    }
}

// ---- optional demo seed (no secrets; makes the UI alive for a walkthrough) ----

/// Seed one vault + two proposals so a fresh DB renders a populated Painel. Public
/// material only — never touches shares or sealed state. Idempotent-ish: skips if a
/// vault already exists.
pub fn seed_demo(store: &mut Store) -> Result<(), crate::store::StoreError> {
    use crate::proposal::{ProposalState, Quorum};
    if !store.list_vaults()?.is_empty() {
        return Ok(());
    }
    let vault = VaultRecord {
        id: "vault-demo".into(),
        name: "Tesouraria Comum".into(),
        quorum: Quorum::new(2, 3).unwrap(),
        group_pubkey: "0ab93649c3f1".into(),
        orchard_address: "u1vjgx7m0q9c8s4d2f6h0k3l5n7p9r1t3v5x7z9b1d3f5h7j9k1m3n5p7r9d406dr".into(),
        ufvk: "uview1m02wyjdemoonlyxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx".into(),
        server_url: Some("https://zec.rocks:443".into()),
    };
    store.save_vault(&vault)?;

    let p1 = ProposalRecord {
        id: "prop-demo-1".into(),
        vault_id: "vault-demo".into(),
        kind: ProposalKind::Payment,
        state: ProposalState::Awaiting,
        proposer: "Bruno".into(),
        value_total: Zatoshis::from_u64(50_000_000).unwrap(), // 0.5 ZEC
        memo: Some("adiantamento maio".into()),
        to_address: Some("u1recipientdemoxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx7ka2".into()),
        expiry_unix: Some(1_800_000_000),
        txid: None,
        approvals: vec!["Bruno".into()],
        refusals: vec![],
    };
    store.save_proposal(&p1)?;

    let p2 = ProposalRecord {
        id: "prop-demo-2".into(),
        vault_id: "vault-demo".into(),
        kind: ProposalKind::Payroll,
        state: ProposalState::Awaiting,
        proposer: "Ana".into(),
        value_total: Zatoshis::from_u64(420_000_000).unwrap(), // 4.2 ZEC
        memo: Some("folha de abril — 8 pagamentos".into()),
        to_address: None, // payroll: destinations live in its lines
        expiry_unix: Some(1_800_100_000),
        txid: None,
        approvals: vec!["Ana".into(), "Bruno".into()],
        refusals: vec![],
    };
    store.save_proposal(&p2)?;
    Ok(())
}

// ---- socket loop (thin) ----

/// Bind **127.0.0.1** only and serve requests serially (single local user).
pub fn serve(cfg: Config, port: u16) -> std::io::Result<()> {
    let addr = format!("127.0.0.1:{port}");
    let server = tiny_http::Server::http(&addr)
        .map_err(|e| std::io::Error::new(std::io::ErrorKind::Other, e.to_string()))?;
    eprintln!(
        "konclave serve → http://{addr}  (web: {}, db: {})",
        cfg.web_dir.display(),
        cfg.db_path
    );
    for mut req in server.incoming_requests() {
        let method = req.method().as_str().to_string();
        let url = req.url().to_string();
        let mut body = Vec::new();
        let _ = req.as_reader().read_to_end(&mut body);
        let resp = handle(&cfg, &method, &url, &body);
        let header = tiny_http::Header::from_bytes(&b"Content-Type"[..], resp.content_type.as_bytes())
            .expect("valid header");
        let response = tiny_http::Response::from_data(resp.body)
            .with_status_code(resp.status)
            .with_header(header);
        let _ = req.respond(response);
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    struct FakeWallet {
        result: Result<Balance, String>,
    }
    impl WalletReader for FakeWallet {
        fn info(&self) -> Result<ChainInfo, String> {
            Err("not used".into())
        }
        fn balance(&self) -> Result<Balance, String> {
            self.result.clone()
        }
    }

    fn tmp_db() -> String {
        // A unique temp path per test — a process-wide counter is collision-free even
        // under cargo's parallel test threads.
        use std::sync::atomic::{AtomicU64, Ordering};
        static N: AtomicU64 = AtomicU64::new(0);
        let id = N.fetch_add(1, Ordering::Relaxed);
        let p = std::env::temp_dir().join(format!("konclave-test-{}-{id}.db", std::process::id()));
        let _ = std::fs::remove_file(&p);
        p.to_string_lossy().into_owned()
    }

    fn cfg_with(db: String, wallet: Option<Box<dyn WalletReader>>) -> Config {
        Config { web_dir: std::env::temp_dir(), db_path: db, wallet }
    }

    fn body_json(r: &Response) -> serde_json::Value {
        serde_json::from_slice(&r.body).expect("json body")
    }

    #[test]
    fn health_is_ok() {
        let cfg = cfg_with(tmp_db(), None);
        let r = handle(&cfg, "GET", "/api/health", b"");
        assert_eq!(r.status, 200);
        assert_eq!(body_json(&r)["status"], "ok");
    }

    #[test]
    fn unsupported_method_is_405() {
        let cfg = cfg_with(tmp_db(), None);
        let r = handle(&cfg, "PUT", "/api/health", b"");
        assert_eq!(r.status, 405);
    }

    #[test]
    fn unknown_api_is_404_json() {
        let cfg = cfg_with(tmp_db(), None);
        let r = handle(&cfg, "GET", "/api/nope", b"");
        assert_eq!(r.status, 404);
        assert_eq!(body_json(&r)["error"], "unknown endpoint");
    }

    #[test]
    fn vault_empty_then_seeded() {
        let db = tmp_db();
        let cfg = cfg_with(db.clone(), None);

        // Empty DB → vault is null.
        let r = handle(&cfg, "GET", "/api/vault", b"");
        assert_eq!(r.status, 200);
        assert!(body_json(&r)["vault"].is_null());

        // Seed, then it appears with quorum + address, no secret fields.
        let mut store = Store::open(&db).unwrap();
        seed_demo(&mut store).unwrap();
        drop(store);

        let r = handle(&cfg, "GET", "/api/vault", b"");
        let v = &body_json(&r)["vault"];
        assert_eq!(v["name"], "Tesouraria Comum");
        assert_eq!(v["threshold"], 2);
        assert_eq!(v["total"], 3);
        assert!(v["orchard_address"].as_str().unwrap().starts_with("u1"));
        assert!(v.get("ufvk").is_some());
    }

    #[test]
    fn proposals_reflect_seed_with_zec_strings() {
        let db = tmp_db();
        let mut store = Store::open(&db).unwrap();
        seed_demo(&mut store).unwrap();
        drop(store);

        let cfg = cfg_with(db, None);
        let r = handle(&cfg, "GET", "/api/proposals", b"");
        assert_eq!(r.status, 200);
        let ps = body_json(&r)["proposals"].as_array().unwrap().clone();
        assert_eq!(ps.len(), 2);
        // 0.5 ZEC payment is present, formatted as a ZEC string.
        let payment = ps.iter().find(|p| p["kind"] == "payment").unwrap();
        assert_eq!(payment["value_zec"], "0.50000000");
        assert_eq!(payment["proposer"], "Bruno");
        assert_eq!(payment["approvals_count"], 1);
    }

    #[test]
    fn balance_unconfigured_is_explicit() {
        let cfg = cfg_with(tmp_db(), None);
        let r = handle(&cfg, "GET", "/api/balance", b"");
        assert_eq!(r.status, 200);
        assert_eq!(body_json(&r)["configured"], false);
    }

    #[test]
    fn balance_live_reports_spendable_and_pending() {
        let bal = Balance {
            chain_tip_height: 3_396_338,
            orchard_spendable: Zatoshis::from_u64(0).unwrap(),
            sapling_spendable: Zatoshis::ZERO,
            transparent_spendable: Zatoshis::ZERO,
            total: Zatoshis::from_u64(100_000).unwrap(),
        };
        let cfg = cfg_with(tmp_db(), Some(Box::new(FakeWallet { result: Ok(bal) })));
        let r = handle(&cfg, "GET", "/api/balance", b"");
        assert_eq!(r.status, 200);
        let j = body_json(&r);
        assert_eq!(j["configured"], true);
        assert_eq!(j["total_zec"], "0.00100000");
        // Nothing spendable yet → the whole balance is pending.
        assert_eq!(j["pending_zat"], 100_000);
        assert_eq!(j["spendable_zat"], 0);
    }

    #[test]
    fn balance_tool_failure_is_502() {
        let cfg = cfg_with(
            tmp_db(),
            Some(Box::new(FakeWallet { result: Err("node offline".into()) })),
        );
        let r = handle(&cfg, "GET", "/api/balance", b"");
        assert_eq!(r.status, 502);
        assert_eq!(body_json(&r)["error"], "wallet");
    }

    #[test]
    fn static_traversal_is_forbidden() {
        let cfg = cfg_with(tmp_db(), None);
        let r = handle(&cfg, "GET", "/../../etc/passwd", b"");
        assert_eq!(r.status, 403);
    }

    #[test]
    fn missing_static_is_404_html() {
        let cfg = cfg_with(tmp_db(), None);
        let r = handle(&cfg, "GET", "/definitely-not-here.js", b"");
        assert_eq!(r.status, 404);
        assert!(r.content_type.contains("text/html"));
    }

    // ---- create proposal (POST /api/proposals) ----

    fn seeded_cfg(wallet: Option<Box<dyn WalletReader>>) -> Config {
        let db = tmp_db();
        let mut store = Store::open(&db).unwrap();
        seed_demo(&mut store).unwrap();
        drop(store);
        cfg_with(db, wallet)
    }

    #[test]
    fn create_proposal_happy_path_awaiting() {
        let cfg = seeded_cfg(None);
        let body = br#"{"proposer":"Ana","to_address":"u1recipientxxxxxxxxxxxxxxxxxxxxxxxx","value_zec":"0.25","memo":"reembolso"}"#;
        let r = handle(&cfg, "POST", "/api/proposals", body);
        assert_eq!(r.status, 201);
        let j = body_json(&r);
        assert_eq!(j["state"], "awaiting"); // 2-of-3 vault → needs one more
        assert_eq!(j["value_zec"], "0.25000000");
        assert_eq!(j["proposer"], "Ana");
        assert_eq!(j["approvals_count"], 1);
        assert_eq!(j["is_public"], false);
        assert!(j["id"].as_str().unwrap().len() >= 8);

        // It is now listed as open.
        let list = handle(&cfg, "GET", "/api/proposals", b"");
        let n = body_json(&list)["proposals"].as_array().unwrap().len();
        assert_eq!(n, 3); // 2 seeded + 1 new
    }

    #[test]
    fn create_proposal_zero_value_is_400() {
        let cfg = seeded_cfg(None);
        let body = br#"{"proposer":"Ana","to_address":"u1abc","value_zec":"0"}"#;
        let r = handle(&cfg, "POST", "/api/proposals", body);
        assert_eq!(r.status, 400);
        assert_eq!(body_json(&r)["error"], "invalid amount");
    }

    #[test]
    fn create_proposal_unknown_address_is_400() {
        let cfg = seeded_cfg(None);
        let body = br#"{"proposer":"Ana","to_address":"not-an-address","value_zec":"0.1"}"#;
        let r = handle(&cfg, "POST", "/api/proposals", body);
        assert_eq!(r.status, 400);
        assert_eq!(body_json(&r)["error"], "invalid address");
    }

    #[test]
    fn create_proposal_memo_on_transparent_is_400() {
        let cfg = seeded_cfg(None);
        // t1… is transparent → a memo is meaningless and rejected.
        let body = br#"{"proposer":"Ana","to_address":"t1transparentxxxxxxxxxxxxxxxxxx","value_zec":"0.1","memo":"segredo"}"#;
        let r = handle(&cfg, "POST", "/api/proposals", body);
        assert_eq!(r.status, 400);
        assert_eq!(body_json(&r)["error"], "invalid memo");
    }

    #[test]
    fn create_proposal_transparent_is_flagged_public() {
        let cfg = seeded_cfg(None);
        let body = br#"{"proposer":"Ana","to_address":"t1transparentxxxxxxxxxxxxxxxxxx","value_zec":"0.1"}"#;
        let r = handle(&cfg, "POST", "/api/proposals", body);
        assert_eq!(r.status, 201);
        assert_eq!(body_json(&r)["is_public"], true);
    }

    #[test]
    fn create_proposal_overspend_is_400_when_wallet_live() {
        // Live wallet with only 100_000 zat total → proposing 1 ZEC must be refused.
        let bal = Balance {
            chain_tip_height: 1,
            orchard_spendable: Zatoshis::from_u64(100_000).unwrap(),
            sapling_spendable: Zatoshis::ZERO,
            transparent_spendable: Zatoshis::ZERO,
            total: Zatoshis::from_u64(100_000).unwrap(),
        };
        let cfg = seeded_cfg(Some(Box::new(FakeWallet { result: Ok(bal) })));
        let body = br#"{"proposer":"Ana","to_address":"u1abc","value_zec":"1.0"}"#;
        let r = handle(&cfg, "POST", "/api/proposals", body);
        assert_eq!(r.status, 400);
        assert_eq!(body_json(&r)["error"], "insufficient funds");
    }

    #[test]
    fn create_proposal_no_vault_is_400() {
        let cfg = cfg_with(tmp_db(), None); // empty DB, no vault
        let body = br#"{"proposer":"Ana","to_address":"u1abc","value_zec":"0.1"}"#;
        let r = handle(&cfg, "POST", "/api/proposals", body);
        assert_eq!(r.status, 400);
        assert_eq!(body_json(&r)["error"], "no vault");
    }

    #[test]
    fn create_proposal_malformed_json_is_400() {
        let cfg = seeded_cfg(None);
        let r = handle(&cfg, "POST", "/api/proposals", b"{not json");
        assert_eq!(r.status, 400);
        assert_eq!(body_json(&r)["error"], "bad request");
    }
}
