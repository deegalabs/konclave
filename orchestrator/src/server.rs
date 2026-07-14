//! The local HTTP bridge (ADR-0004): serves the UI bundle and a small JSON API,
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
    /// The FROST ceremony config, present only when the send path is wired (`--ceremony`).
    pub ceremony: Option<crate::send::SendConfig>,
    /// In-memory per-vault unlock throttle (audit L1): `vault_id -> (recent fails, window
    /// start unix)`. Loopback-only defense-in-depth so a wrong passphrase cannot be retried
    /// without bound, on top of the session token (C1) and the memory-hard KDF cost.
    pub unlock_throttle: std::sync::Mutex<std::collections::HashMap<String, (u32, i64)>>,
    /// L2: when set, the DB is opened with SQLCipher under this key (from the OS keychain),
    /// so vault metadata + the UFVK are encrypted at rest. `None` = plaintext (legacy/default).
    pub db_key: Option<zeroize::Zeroizing<[u8; 32]>>,
}

impl Config {
    /// Build a Config with an empty unlock throttle. Prefer this over the struct literal so
    /// callers do not have to know about the throttle field.
    pub fn new(
        web_dir: PathBuf,
        db_path: String,
        wallet: Option<Box<dyn WalletReader>>,
        ceremony: Option<crate::send::SendConfig>,
    ) -> Config {
        Config {
            web_dir,
            db_path,
            wallet,
            ceremony,
            unlock_throttle: std::sync::Mutex::new(std::collections::HashMap::new()),
            db_key: None,
        }
    }

    /// Encrypt the local DB at rest (audit L2): subsequent opens use SQLCipher under `key`.
    pub fn with_db_key(mut self, key: [u8; 32]) -> Config {
        self.db_key = Some(zeroize::Zeroizing::new(key));
        self
    }
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
        Response {
            status,
            content_type: ct.into(),
            body,
        }
    }
}

// ---- DTOs (public material only; amounts carried as both zat and ZEC string) ----

#[derive(Serialize)]
struct MemberDto {
    name: String,
    pubkey: String,
}

#[derive(Serialize)]
struct VaultDto {
    id: String,
    name: String,
    threshold: u16,
    total: u16,
    /// Member count (kept for compatibility); the real member entities are in `member_list`.
    members: u16,
    member_list: Vec<MemberDto>,
    group_pubkey: String,
    orchard_address: String,
    /// The Unified Full Viewing Key decrypts the vault's entire transaction graph and every
    /// incoming memo (the payslips). The UI never needs the raw key, so it is NEVER served
    /// over the bridge (SECURITY_AUDIT M1) — kept in the struct only for internal use.
    #[serde(skip)]
    #[allow(dead_code)]
    ufvk: String,
    server_url: Option<String>,
    /// Whether the vault is passphrase-protected (the UI prompts for the word on entry).
    locked: bool,
}

impl From<VaultRecord> for VaultDto {
    fn from(v: VaultRecord) -> Self {
        VaultDto {
            id: v.id,
            name: v.name,
            threshold: v.quorum.threshold,
            total: v.quorum.total,
            members: v.quorum.total,
            member_list: Vec::new(),
            group_pubkey: v.group_pubkey,
            orchard_address: v.orchard_address,
            ufvk: v.ufvk,
            server_url: v.server_url,
            locked: false,
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
    /// Unix seconds when the proposal was created — the real date the UI renders.
    created_at: Option<i64>,
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
            created_at: p.created_at,
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
        let zec = |z: u64| {
            Zatoshis::from_u64(z)
                .map(|v| v.to_zec_string())
                .unwrap_or_default()
        };
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
    // Which vault the request targets (?vault=<id>); no selector = the default (first) vault,
    // an explicit unknown id = 404 (see resolve_vault_id, L3).
    let vsel = query_param(raw_path, "vault");
    let vsel = vsel.as_deref();

    // Writes (state-changing) go through POST.
    if method == "POST" {
        if path == "/api/proposals" {
            return create_proposal(cfg, body, vsel);
        }
        if path == "/api/payroll/preview" {
            return payroll_preview(body);
        }
        if path == "/api/payroll" {
            return payroll_create(cfg, body, vsel);
        }
        if path == "/api/vault/dkg" {
            return create_vault_dkg_handler(cfg, body);
        }
        if path == "/api/vault/unlock" {
            return vault_unlock(cfg, body, vsel);
        }
        if path == "/api/vault/delete" {
            return vault_delete(cfg, body, vsel);
        }
        if path == "/api/beneficiaries" {
            return beneficiary_add(cfg, body, vsel);
        }
        if let Some(rest) = path.strip_prefix("/api/beneficiaries/") {
            if let Some(id) = rest.strip_suffix("/delete") {
                return beneficiary_delete(cfg, id);
            }
        }
        if let Some(rest) = path.strip_prefix("/api/proposals/") {
            if let Some(id) = rest.strip_suffix("/approve") {
                return vote_proposal(cfg, id, body, true);
            }
            if let Some(id) = rest.strip_suffix("/refuse") {
                return vote_proposal(cfg, id, body, false);
            }
            if let Some(id) = rest.strip_suffix("/send") {
                return send_proposal(cfg, id, body);
            }
        }
        if path.starts_with("/api/") {
            return Response::json(
                404,
                &serde_json::json!({"error": "unknown endpoint", "path": path}),
            );
        }
        return Response::json(405, &serde_json::json!({"error": "method not allowed"}));
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
        "/api/vault" => api_vault(cfg, vsel),
        "/api/vaults" => api_vaults(cfg),
        "/api/proposals" => api_proposals(cfg, vsel),
        "/api/ledger" => api_ledger(cfg, vsel),
        "/api/ledger.csv" => api_ledger_csv(cfg, vsel),
        "/api/beneficiaries" => api_beneficiaries(cfg, vsel),
        "/api/balance" => api_balance(cfg),
        p if p.starts_with("/api/proposals/") => {
            api_proposal_one(cfg, p.strip_prefix("/api/proposals/").unwrap())
        }
        p if p.starts_with("/api/") => Response::json(
            404,
            &serde_json::json!({"error": "unknown endpoint", "path": p}),
        ),
        _ => serve_static(&cfg.web_dir, path),
    }
}

fn open_store(cfg: &Config) -> Result<Store, Response> {
    let opened = match &cfg.db_key {
        Some(key) => Store::open_keyed(&cfg.db_path, key), // L2: encrypted at rest (SQLCipher)
        None => Store::open(&cfg.db_path),
    };
    let store = opened.map_err(|e| {
        Response::json(
            500,
            &serde_json::json!({"error": "store", "detail": e.to_string()}),
        )
    })?;
    // Enforce time-based proposal expiry on every read (no background job needed).
    let _ = store.expire_due(now_unix().unwrap_or(0));
    Ok(store)
}

/// Read a query-string parameter (`?key=value`) from a raw request path.
fn query_param(raw_path: &str, key: &str) -> Option<String> {
    let q = raw_path.split('?').nth(1)?;
    let q = q.split('#').next().unwrap_or(q);
    q.split('&').find_map(|pair| {
        let mut it = pair.splitn(2, '=');
        (it.next() == Some(key)).then(|| it.next().unwrap_or("").to_string())
    })
}

/// Which vault a request operates on: the requested `want` if it exists on this device,
/// else the first known vault. `Ok(None)` when there are no vaults at all. This is what
/// isolates each vault's data (proposals, ledger, people) instead of always the first.
fn resolve_vault_id(store: &Store, want: Option<&str>) -> Result<Option<String>, Response> {
    let vaults = store.list_vaults().map_err(|e| {
        Response::json(
            500,
            &serde_json::json!({"error": "store", "detail": e.to_string()}),
        )
    })?;
    if let Some(w) = want {
        return match vaults.iter().find(|v| v.id == w) {
            Some(v) => Ok(Some(v.id.clone())),
            // An explicit ?vault=<id> that doesn't exist is a 404 — never silently fall back
            // to the first vault (SECURITY_AUDIT L3), which could land a write on the wrong one.
            None => Err(Response::json(
                404,
                &serde_json::json!({"error": "unknown vault", "detail": "no vault with that id on this device"}),
            )),
        };
    }
    // No selector → the device's default (first) vault.
    Ok(vaults.into_iter().next().map(|v| v.id))
}

/// The selected vault (`?vault=<id>`, else the first). `{ "vault": null }` when none.
fn api_vault(cfg: &Config, want: Option<&str>) -> Response {
    let store = match open_store(cfg) {
        Ok(s) => s,
        Err(r) => return r,
    };
    let vault_id = match resolve_vault_id(&store, want) {
        Ok(Some(id)) => id,
        Ok(None) => return Response::json(200, &serde_json::json!({ "vault": null })),
        Err(r) => return r,
    };
    let record = match store.get_vault(&vault_id) {
        Ok(Some(r)) => r,
        Ok(None) => return Response::json(200, &serde_json::json!({ "vault": null })),
        Err(e) => {
            return Response::json(
                500,
                &serde_json::json!({"error": "store", "detail": e.to_string()}),
            )
        }
    };
    let member_list = store
        .get_vault_members(&record.id)
        .unwrap_or_default()
        .into_iter()
        .map(|m| MemberDto {
            name: m.name,
            pubkey: m.pubkey,
        })
        .collect();
    let locked = store.vault_has_lock(&record.id).unwrap_or(false);
    let mut dto = VaultDto::from(record);
    dto.member_list = member_list;
    dto.locked = locked;
    Response::json(200, &serde_json::json!({ "vault": dto }))
}

/// Every vault known to this device (for the "Meus cofres" home).
fn api_vaults(cfg: &Config) -> Response {
    let store = match open_store(cfg) {
        Ok(s) => s,
        Err(r) => return r,
    };
    match store.list_vaults() {
        Ok(vs) => {
            let vaults: Vec<_> = vs
                .into_iter()
                .map(|record| {
                    let member_list: Vec<MemberDto> = store
                        .get_vault_members(&record.id)
                        .unwrap_or_default()
                        .into_iter()
                        .map(|m| MemberDto {
                            name: m.name,
                            pubkey: m.pubkey,
                        })
                        .collect();
                    let locked = store.vault_has_lock(&record.id).unwrap_or(false);
                    let mut dto = VaultDto::from(record);
                    dto.member_list = member_list;
                    dto.locked = locked;
                    dto
                })
                .collect();
            Response::json(200, &serde_json::json!({ "vaults": vaults }))
        }
        Err(e) => Response::json(
            500,
            &serde_json::json!({"error": "store", "detail": e.to_string()}),
        ),
    }
}

/// Open proposals for the selected vault (empty list when there is no vault).
fn api_proposals(cfg: &Config, want: Option<&str>) -> Response {
    let store = match open_store(cfg) {
        Ok(s) => s,
        Err(r) => return r,
    };
    let vault_id = match resolve_vault_id(&store, want) {
        Ok(Some(id)) => id,
        Ok(None) => return Response::json(200, &serde_json::json!({ "proposals": [] })),
        Err(r) => return r,
    };
    match store.list_open_proposals(&vault_id) {
        Ok(ps) => {
            let dtos: Vec<ProposalDto> = ps.into_iter().map(ProposalDto::from).collect();
            Response::json(200, &serde_json::json!({ "proposals": dtos }))
        }
        Err(e) => Response::json(
            500,
            &serde_json::json!({"error": "store", "detail": e.to_string()}),
        ),
    }
}

/// The full ledger (all proposals, terminal states included) for the selected vault.
fn api_ledger(cfg: &Config, want: Option<&str>) -> Response {
    match load_ledger(cfg, want) {
        Ok(ps) => {
            let dtos: Vec<ProposalDto> = ps.into_iter().map(ProposalDto::from).collect();
            Response::json(200, &serde_json::json!({ "ledger": dtos }))
        }
        Err(r) => r,
    }
}

/// `GET /api/ledger.csv` — the accountant's export, ITEMIZED: **one row per payment**.
/// A single payment is one row; a payroll of N is **N rows** (one per beneficiary),
/// sharing the document id/state/txid. This is the accounting "entries" (lançamentos) view
/// (docs/REDESENHO_FOLHA.md), not one aggregate line per proposal.
fn api_ledger_csv(cfg: &Config, want: Option<&str>) -> Response {
    const HEADER: &str =
        "documento,data,tipo,estado,proposto_por,aprovadores,beneficiario,valor_zec,memo,destino,txid\n";

    let store = match open_store(cfg) {
        Ok(s) => s,
        Err(r) => return r,
    };
    let vault_id = match resolve_vault_id(&store, want) {
        Ok(Some(id)) => id,
        Ok(None) => return csv_response(HEADER.to_string()),
        Err(r) => return r,
    };
    let proposals = match store.list_all_proposals(&vault_id) {
        Ok(p) => p,
        Err(e) => {
            return Response::json(
                500,
                &serde_json::json!({"error": "store", "detail": e.to_string()}),
            )
        }
    };

    let mut csv = String::from(HEADER);
    for p in proposals {
        let state = format!("{:?}", p.state).to_lowercase();
        let approvers = p.approvals.join(" ");
        let txid = p.txid.clone().unwrap_or_default();
        let date = p.created_at.map(iso_date).unwrap_or_default();
        match p.kind {
            ProposalKind::Payment => {
                push_csv_row(
                    &mut csv,
                    &[
                        &p.id,
                        &date,
                        "pagamento",
                        &state,
                        &p.proposer,
                        &approvers,
                        "",
                        &p.value_total.to_zec_string(),
                        p.memo.as_deref().unwrap_or(""),
                        p.to_address.as_deref().unwrap_or(""),
                        &txid,
                    ],
                );
            }
            ProposalKind::Payroll => {
                let lines = store.get_payroll_lines(&p.id).unwrap_or_default();
                if lines.is_empty() {
                    push_csv_row(
                        &mut csv,
                        &[
                            &p.id,
                            &date,
                            "folha",
                            &state,
                            &p.proposer,
                            &approvers,
                            "",
                            &p.value_total.to_zec_string(),
                            p.memo.as_deref().unwrap_or(""),
                            "",
                            &txid,
                        ],
                    );
                } else {
                    for l in &lines {
                        push_csv_row(
                            &mut csv,
                            &[
                                &p.id,
                                &date,
                                "folha",
                                &state,
                                &p.proposer,
                                &approvers,
                                l.label.as_deref().unwrap_or(""),
                                &l.value.to_zec_string(),
                                &l.memo,
                                &l.address,
                                &txid,
                            ],
                        );
                    }
                }
            }
        }
    }
    csv_response(csv)
}

fn push_csv_row(csv: &mut String, fields: &[&str]) {
    let escaped: Vec<String> = fields.iter().map(|f| csv_field(f)).collect();
    csv.push_str(&escaped.join(","));
    csv.push('\n');
}

/// Unix seconds → ISO `YYYY-MM-DD` (UTC) for the accounting export — an auditable ledger
/// must be year-qualified. Civil-from-days (Howard Hinnant's algorithm), no chrono dep.
fn iso_date(unix: i64) -> String {
    let days = unix.div_euclid(86_400);
    let z = days + 719_468;
    let era = (if z >= 0 { z } else { z - 146_096 }) / 146_097;
    let doe = z - era * 146_097;
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let y = yoe + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = doy - (153 * mp + 2) / 5 + 1;
    let m = if mp < 10 { mp + 3 } else { mp - 9 };
    let y = if m <= 2 { y + 1 } else { y };
    format!("{y:04}-{m:02}-{d:02}")
}

fn csv_response(csv: String) -> Response {
    Response {
        status: 200,
        content_type: "text/csv; charset=utf-8".into(),
        body: csv.into_bytes(),
    }
}

/// Load all proposals for the selected vault, or a ready-to-return error Response.
fn load_ledger(cfg: &Config, want: Option<&str>) -> Result<Vec<ProposalRecord>, Response> {
    let store = open_store(cfg)?;
    let vault_id = match resolve_vault_id(&store, want)? {
        Some(id) => id,
        None => return Ok(Vec::new()),
    };
    store.list_all_proposals(&vault_id).map_err(|e| {
        Response::json(
            500,
            &serde_json::json!({"error": "store", "detail": e.to_string()}),
        )
    })
}

// ---- create vault by DKG (5-F) ----

#[derive(serde::Deserialize)]
struct NewVaultDkg {
    name: String,
    threshold: u16,
    #[serde(default)]
    members: Vec<String>,
}

/// `POST /api/vault/dkg` — create a vault by Distributed Key Generation. Runs the full
/// DKG (key never reconstituted), derives the Orchard address, creates the view-only
/// wallet, seals the shares, and saves the vault + members. Takes several seconds.
fn create_vault_dkg_handler(cfg: &Config, body: &[u8]) -> Response {
    use crate::proposal::Quorum;

    let Some(sc) = cfg.ceremony.as_ref() else {
        return Response::json(
            501,
            &serde_json::json!({
                "error": "ceremony not configured",
                "detail": "start with --ceremony <config> (with zcash_sign, vaults_dir and sealing_key_file)"
            }),
        );
    };
    let req: NewVaultDkg = match serde_json::from_slice(body) {
        Ok(v) => v,
        Err(e) => return bad(e.to_string(), "bad request"),
    };
    if req.name.trim().is_empty() {
        return bad("enter a name for the vault", "missing name");
    }
    if req.members.len() < 2 {
        return bad("a vault needs at least 2 members", "too few members");
    }
    if req.threshold < 1 || req.threshold as usize > req.members.len() {
        return bad(
            format!("invalid quorum {}-of-{}", req.threshold, req.members.len()),
            "invalid quorum",
        );
    }
    let quorum = match Quorum::new(req.threshold, req.members.len() as u16) {
        Ok(q) => q,
        Err(e) => return bad(e.to_string(), "invalid quorum"),
    };

    let v = match crate::dkg::create_vault_dkg(sc, req.name.trim(), req.threshold, &req.members) {
        Ok(v) => v,
        Err(e) => {
            return Response::json(
                502,
                &serde_json::json!({"error": "dkg failed", "detail": e.to_string()}),
            )
        }
    };

    let mut store = match open_store(cfg) {
        Ok(s) => s,
        Err(r) => return r,
    };
    let id = format!(
        "vault-dkg-{}",
        &v.group_pubkey[..v.group_pubkey.len().min(12)]
    );
    let record = VaultRecord {
        id: id.clone(),
        name: req.name.trim().to_string(),
        quorum,
        group_pubkey: v.group_pubkey.clone(),
        orchard_address: v.orchard_address.clone(),
        ufvk: v.ufvk.clone(),
        server_url: Some(sc.server_url.clone()),
    };
    if let Err(e) = store.save_vault(&record) {
        return Response::json(
            500,
            &serde_json::json!({"error": "store", "detail": e.to_string()}),
        );
    }
    let members: Vec<crate::store::Member> = v
        .members
        .iter()
        .map(|(nm, pk, _)| crate::store::Member {
            name: nm.clone(),
            pubkey: pk.clone(),
        })
        .collect();
    if let Err(e) = store.save_vault_members(&id, &members) {
        return Response::json(
            500,
            &serde_json::json!({"error": "store", "detail": e.to_string()}),
        );
    }
    // Persist the passphrase lock (salt + verifier). The passphrase itself is NOT stored
    // — it is returned once below for the user to write down.
    if let Err(e) = store.set_vault_lock(&id, &v.salt, &v.verifier) {
        return Response::json(
            500,
            &serde_json::json!({"error": "store", "detail": e.to_string()}),
        );
    }

    let member_list: Vec<MemberDto> = members
        .into_iter()
        .map(|m| MemberDto {
            name: m.name,
            pubkey: m.pubkey,
        })
        .collect();
    let mut dto = VaultDto::from(record);
    dto.member_list = member_list;
    dto.locked = true;
    // `passphrase` is shown ONCE and never persisted; losing it makes the sealed shares
    // on this device unrecoverable (that is the point of the lock).
    Response::json(
        201,
        &serde_json::json!({ "vault": dto, "dkg": true, "passphrase": v.passphrase }),
    )
}

// ---- vault passphrase unlock ("palavra do cofre") ----

#[derive(serde::Deserialize)]
struct UnlockReq {
    passphrase: String,
}

/// Unlock throttle (audit L1): after this many wrong words within the window, the vault is
/// locked out for the rest of it. Small numbers: this is defense-in-depth behind the session
/// token and the memory-hard KDF, not the primary control.
const UNLOCK_MAX_FAILS: u32 = 5;
const UNLOCK_LOCKOUT_SECS: i64 = 60;

/// If the vault is currently locked out (too many recent wrong passphrases), return the 429
/// to send. Called BEFORE the expensive KDF so a locked-out attempt is refused cheaply.
fn unlock_locked_out(cfg: &Config, vault_id: &str) -> Option<Response> {
    let now = now_unix().unwrap_or(0);
    let mut map = cfg
        .unlock_throttle
        .lock()
        .unwrap_or_else(|e| e.into_inner());
    if let Some(&(fails, start)) = map.get(vault_id) {
        let elapsed = now.saturating_sub(start);
        if elapsed >= UNLOCK_LOCKOUT_SECS {
            map.remove(vault_id); // window expired → forget
        } else if fails >= UNLOCK_MAX_FAILS {
            let retry = UNLOCK_LOCKOUT_SECS - elapsed;
            return Some(Response::json(
                429,
                &serde_json::json!({
                    "error": "too many attempts",
                    "detail": format!("wait {retry}s before trying the vault word again"),
                }),
            ));
        }
    }
    None
}

/// Record an unlock attempt: clear the record on success, increment (restarting a stale
/// window) on failure.
fn record_unlock(cfg: &Config, vault_id: &str, success: bool) {
    let now = now_unix().unwrap_or(0);
    let mut map = cfg
        .unlock_throttle
        .lock()
        .unwrap_or_else(|e| e.into_inner());
    if success {
        map.remove(vault_id);
    } else {
        let entry = map.entry(vault_id.to_string()).or_insert((0, now));
        if now.saturating_sub(entry.1) >= UNLOCK_LOCKOUT_SECS {
            *entry = (0, now); // stale window → restart the count
        }
        entry.0 += 1;
    }
}

/// `POST /api/vault/unlock` — verify a vault's passphrase against its stored verifier.
/// 200 `{ok:true, locked:true}` on the right word; 401 on the wrong one; `{ok:true,
/// locked:false}` when the vault has no passphrase (legacy/slice). Never returns the key.
/// Repeated wrong words are throttled per vault (L1). Never returns the key.
fn vault_unlock(cfg: &Config, body: &[u8], want: Option<&str>) -> Response {
    let req: UnlockReq = match serde_json::from_slice(body) {
        Ok(v) => v,
        Err(e) => return bad(e.to_string(), "bad request"),
    };
    let store = match open_store(cfg) {
        Ok(s) => s,
        Err(r) => return r,
    };
    let vault_id = match resolve_vault_id(&store, want) {
        Ok(Some(id)) => id,
        Ok(None) => return bad("no vault on this device", "no vault"),
        Err(r) => return r,
    };
    let (salt, verifier) = match store.get_vault_lock(&vault_id) {
        Ok(Some(l)) => l,
        Ok(None) => {
            return Response::json(200, &serde_json::json!({ "ok": true, "locked": false }))
        }
        Err(e) => {
            return Response::json(
                500,
                &serde_json::json!({"error": "store", "detail": e.to_string()}),
            )
        }
    };
    // L1: refuse (429) while locked out — before spending the KDF on another guess.
    if let Some(resp) = unlock_locked_out(cfg, &vault_id) {
        return resp;
    }
    let key = match crate::secrets::derive_key(&req.passphrase, &salt) {
        Ok(k) => zeroize::Zeroizing::new(k), // wipe the derived key on drop (M4)
        Err(e) => {
            return Response::json(
                500,
                &serde_json::json!({"error": "kdf", "detail": e.to_string()}),
            )
        }
    };
    let ok = crate::secrets::verify(&key, &verifier);
    record_unlock(cfg, &vault_id, ok);
    if ok {
        Response::json(200, &serde_json::json!({ "ok": true, "locked": true }))
    } else {
        Response::json(
            401,
            &serde_json::json!({ "error": "wrong passphrase", "detail": "incorrect vault word" }),
        )
    }
}

// ---- delete a vault (local only) ----

#[derive(serde::Deserialize)]
struct DeleteReq {
    #[serde(default)]
    passphrase: Option<String>,
    /// For an unlocked/legacy vault (no passphrase), the exact vault name typed back as a
    /// destructive-action confirmation — verified server-side, not just in the UI.
    #[serde(default)]
    confirm_name: Option<String>,
}

/// `POST /api/vault/delete` — remove a vault from THIS device (records, proposals,
/// people, members, lock). Passphrase-protected vaults require the correct word. This
/// is local only: it cannot touch the chain or other members' devices, and if the vault
/// still holds funds they become unreachable from here (the UI warns before calling this).
fn vault_delete(cfg: &Config, body: &[u8], want: Option<&str>) -> Response {
    let req: DeleteReq = serde_json::from_slice(body).unwrap_or(DeleteReq {
        passphrase: None,
        confirm_name: None,
    });
    let mut store = match open_store(cfg) {
        Ok(s) => s,
        Err(r) => return r,
    };
    let vault_id = match resolve_vault_id(&store, want) {
        Ok(Some(id)) => id,
        Ok(None) => return bad("no vault on this device", "no vault"),
        Err(r) => return r,
    };
    // A locked vault can only be deleted with the right passphrase.
    match store.get_vault_lock(&vault_id) {
        Ok(Some((salt, verifier))) => {
            let key =
                match crate::secrets::derive_key(req.passphrase.as_deref().unwrap_or(""), &salt) {
                    Ok(k) => zeroize::Zeroizing::new(k), // wipe the derived key on drop (M4)
                    Err(e) => {
                        return Response::json(
                            500,
                            &serde_json::json!({"error": "kdf", "detail": e.to_string()}),
                        )
                    }
                };
            if !crate::secrets::verify(&key, &verifier) {
                return Response::json(
                    401,
                    &serde_json::json!({"error": "wrong passphrase", "detail": "incorrect vault word"}),
                );
            }
        }
        Ok(None) => {
            // Unlocked/legacy vault: require the exact vault name typed back as a destructive
            // confirmation, enforced here (not only in the UI) so a request can't silently wipe it.
            let name = match store.get_vault(&vault_id) {
                Ok(Some(v)) => v.name,
                _ => String::new(),
            };
            match req.confirm_name.as_deref() {
                Some(n) if n == name => {}
                _ => {
                    return Response::json(
                        401,
                        &serde_json::json!({"error": "confirm_required", "detail": "type the vault name to confirm deletion"}),
                    )
                }
            }
        }
        Err(e) => {
            return Response::json(
                500,
                &serde_json::json!({"error": "store", "detail": e.to_string()}),
            )
        }
    }
    if let Err(e) = store.delete_vault(&vault_id) {
        return Response::json(
            500,
            &serde_json::json!({"error": "store", "detail": e.to_string()}),
        );
    }
    Response::json(200, &serde_json::json!({ "ok": true, "deleted": vault_id }))
}

// ---- beneficiaries (address book: pick a name, not an address) ----

fn beneficiary_json(b: &crate::store::Beneficiary) -> serde_json::Value {
    serde_json::json!({
        "id": b.id, "name": b.name, "address": b.address, "memo": b.memo,
        "is_public": crate::validation::AddressKind::classify(&b.address).is_public(),
    })
}

fn api_beneficiaries(cfg: &Config, want: Option<&str>) -> Response {
    let store = match open_store(cfg) {
        Ok(s) => s,
        Err(r) => return r,
    };
    let vault_id = match resolve_vault_id(&store, want) {
        Ok(Some(id)) => id,
        Ok(None) => return Response::json(200, &serde_json::json!({ "beneficiaries": [] })),
        Err(r) => return r,
    };
    match store.list_beneficiaries(&vault_id) {
        Ok(bs) => {
            let list: Vec<_> = bs.iter().map(beneficiary_json).collect();
            Response::json(200, &serde_json::json!({ "beneficiaries": list }))
        }
        Err(e) => Response::json(
            500,
            &serde_json::json!({"error": "store", "detail": e.to_string()}),
        ),
    }
}

#[derive(serde::Deserialize)]
struct NewBeneficiary {
    name: String,
    address: String,
    #[serde(default)]
    memo: Option<String>,
}

fn beneficiary_add(cfg: &Config, body: &[u8], want: Option<&str>) -> Response {
    use crate::validation::AddressKind;
    let input: NewBeneficiary = match serde_json::from_slice(body) {
        Ok(v) => v,
        Err(e) => return bad(e.to_string(), "bad request"),
    };
    if input.name.trim().is_empty() {
        return bad("enter a name for the beneficiary", "missing name");
    }
    if AddressKind::classify(&input.address) == AddressKind::Unknown {
        return bad("unrecognized Zcash address", "invalid address");
    }
    let store = match open_store(cfg) {
        Ok(s) => s,
        Err(r) => return r,
    };
    let vault_id = match resolve_vault_id(&store, want) {
        Ok(Some(id)) => id,
        Ok(None) => return bad("no vault on this device", "no vault"),
        Err(r) => return r,
    };
    let b = crate::store::Beneficiary {
        id: new_id(),
        vault_id,
        name: input.name.trim().to_string(),
        address: input.address.trim().to_string(),
        memo: input.memo.unwrap_or_default(),
    };
    if let Err(e) = store.save_beneficiary(&b) {
        return Response::json(
            500,
            &serde_json::json!({"error": "store", "detail": e.to_string()}),
        );
    }
    Response::json(
        201,
        &serde_json::json!({ "beneficiary": beneficiary_json(&b) }),
    )
}

fn beneficiary_delete(cfg: &Config, id: &str) -> Response {
    let store = match open_store(cfg) {
        Ok(s) => s,
        Err(r) => return r,
    };
    match store.delete_beneficiary(id) {
        Ok(true) => Response::json(200, &serde_json::json!({ "deleted": true })),
        Ok(false) => Response::json(404, &serde_json::json!({"error": "not found"})),
        Err(e) => Response::json(
            500,
            &serde_json::json!({"error": "store", "detail": e.to_string()}),
        ),
    }
}

/// Minimal RFC-4180 CSV field escaping.
fn csv_field(s: &str) -> String {
    if s.contains([',', '"', '\n', '\r']) {
        format!("\"{}\"", s.replace('"', "\"\""))
    } else {
        s.to_string()
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
    Response::json(
        400,
        &serde_json::json!({"error": what, "detail": detail.into()}),
    )
}

/// `POST /api/proposals` — validate at the boundary, then persist an Awaiting (or, for a
/// 1-of-n vault, Ready) proposal with the proposer as first approval. No funds move here;
/// spendability is authoritative at broadcast time (step 2c).
fn create_proposal(cfg: &Config, body: &[u8], want: Option<&str>) -> Response {
    use crate::proposal::Proposal;
    use crate::validation::{
        available_to_propose, estimate_fee_for_payment, validate_amount, validate_memo, AddressKind,
    };

    let input: NewProposal = match serde_json::from_slice(body) {
        Ok(v) => v,
        Err(e) => return bad(e.to_string(), "bad request"),
    };
    if input.proposer.trim().is_empty() {
        return bad("enter who is proposing", "missing proposer");
    }

    // Destination: reject unrecognized encodings; transparent is allowed but flagged
    // downstream (is_public) so the UI warns.
    let addr_kind = AddressKind::classify(&input.to_address);
    if addr_kind == AddressKind::Unknown {
        return bad("unrecognized Zcash address", "invalid address");
    }

    // Authoritative decode when real funds are at stake (a live wallet is configured).
    // The prefix heuristic above lets malformed / wrong-network / Sapling-only strings
    // through; the builder would then try to pay them and lock the funds (§8). Demo mode
    // (no wallet) keeps the lenient check so placeholder addresses work.
    if cfg.wallet.is_some() {
        match crate::address::validate_recipient(&input.to_address) {
            Ok(rep) if rep.is_payable() => {}
            Ok(_) => {
                return bad(
                    "this address can't receive from an Orchard vault — the funds would be locked",
                    "unpayable address",
                )
            }
            Err(e) => return bad(e.human(), "invalid address"),
        }
    }

    // Amount (no floating point) — must be > 0.
    let value = match Zatoshis::from_zec_str(&input.value_zec) {
        Ok(v) => v,
        Err(e) => return bad(e.to_string(), "invalid amount"),
    };
    if value.is_zero() {
        return bad("the value must be greater than zero", "invalid amount");
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
    let vault_id = match resolve_vault_id(&store, want) {
        Ok(Some(id)) => id,
        Ok(None) => return bad("no vault on this device", "no vault"),
        Err(r) => return r,
    };
    let vault = match store.get_vault(&vault_id) {
        Ok(Some(v)) => v,
        Ok(None) => return bad("no vault on this device", "no vault"),
        Err(e) => {
            return Response::json(
                500,
                &serde_json::json!({"error": "store", "detail": e.to_string()}),
            )
        }
    };

    // Overspend guard when a live wallet is wired. Uses total balance as the proposable
    // ceiling for the preview; spendable is re-checked authoritatively at broadcast.
    if let Some(reader) = cfg.wallet.as_ref() {
        if let Ok(bal) = reader.balance() {
            let fee = estimate_fee_for_payment(1, 1);
            let available =
                available_to_propose(bal.total, Zatoshis::ZERO, fee).unwrap_or(Zatoshis::ZERO);
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
        created_at: now_unix(),
        approvals: vec![input.proposer],
        refusals: vec![],
    };
    if let Err(e) = store.save_proposal(&rec) {
        return Response::json(
            500,
            &serde_json::json!({"error": "store", "detail": e.to_string()}),
        );
    }
    let dto = ProposalDto::from(rec);
    Response::json(
        201,
        &serde_json::to_value(dto).unwrap_or_else(|_| serde_json::json!({})),
    )
}

// ---- payroll (N outputs, one approval) ----

#[derive(serde::Deserialize)]
struct PayrollLineIn {
    #[serde(default)]
    label: Option<String>,
    address: String,
    value_zec: String,
    #[serde(default)]
    memo: Option<String>,
}

#[derive(serde::Deserialize)]
struct PreviewReq {
    #[serde(default)]
    csv: Option<String>,
    #[serde(default)]
    lines: Option<Vec<PayrollLineIn>>,
}

#[derive(serde::Deserialize)]
struct PayrollCreateReq {
    proposer: String,
    /// Document description / accounting period (e.g. "Folha · abril/2026"). Optional.
    #[serde(default)]
    description: Option<String>,
    lines: Vec<PayrollLineIn>,
}

/// Convert one input line to a validated domain line (address/value/memo checked).
fn line_in_to_payroll(l: &PayrollLineIn) -> Result<crate::payroll::PayrollLine, String> {
    use crate::validation::{validate_memo, AddressKind};
    let kind = AddressKind::classify(&l.address);
    if kind == AddressKind::Unknown {
        return Err(format!("unrecognized address: {}", l.address));
    }
    let value = Zatoshis::from_zec_str(&l.value_zec).map_err(|e| e.to_string())?;
    if value.is_zero() {
        return Err("the value must be greater than zero".into());
    }
    let memo = l.memo.clone().unwrap_or_default();
    validate_memo(&memo, kind).map_err(|e| e.to_string())?;
    Ok(crate::payroll::PayrollLine {
        label: l.label.clone(),
        address: l.address.clone(),
        value,
        memo,
    })
}

fn payroll_line_json(l: &crate::payroll::PayrollLine) -> serde_json::Value {
    serde_json::json!({
        "label": l.label,
        "address": l.address,
        "value_zat": l.value.as_u64(),
        "value_zec": l.value.to_zec_string(),
        "memo": l.memo,
        "is_public": crate::validation::AddressKind::classify(&l.address).is_public(),
    })
}

fn payroll_summary_json(plan: &crate::payroll::PayrollPlan) -> serde_json::Value {
    use crate::validation::estimate_fee_for_payment;
    let count = plan.lines.len();
    let total: u64 = plan.lines.iter().map(|l| l.value.as_u64()).sum();
    let fee = estimate_fee_for_payment(count as u64, 1).as_u64();
    let z = |v: u64| {
        Zatoshis::from_u64(v)
            .map(|x| x.to_zec_string())
            .unwrap_or_default()
    };
    serde_json::json!({
        "count": count,
        "total_zat": total, "total_zec": z(total),
        "fee_zat": fee, "fee_zec": z(fee),
        "total_with_fee_zec": z(total.saturating_add(fee)),
    })
}

/// `POST /api/payroll/preview` — parse CSV or structured lines and report accepted lines,
/// per-row errors, and the aggregate summary. No state change (local parse, spec §4.3).
fn payroll_preview(body: &[u8]) -> Response {
    use crate::payroll::{import_csv, PayrollPlan};
    let req: PreviewReq = match serde_json::from_slice(body) {
        Ok(v) => v,
        Err(e) => return bad(e.to_string(), "bad request"),
    };
    let (lines, errors): (Vec<_>, Vec<serde_json::Value>) = if let Some(csv) = req.csv {
        let report = import_csv(&csv);
        let errs = report
            .errors
            .iter()
            .map(|e| serde_json::json!({"row": e.row, "reason": e.reason}))
            .collect();
        (report.plan.lines, errs)
    } else if let Some(ins) = req.lines {
        let mut ls = Vec::new();
        let mut errs = Vec::new();
        for (i, l) in ins.iter().enumerate() {
            match line_in_to_payroll(l) {
                Ok(pl) => ls.push(pl),
                Err(r) => errs.push(serde_json::json!({"row": i + 1, "reason": r})),
            }
        }
        (ls, errs)
    } else {
        return bad("provide 'csv' or 'lines'", "bad request");
    };
    let plan = PayrollPlan::new(lines);
    let lines_json: Vec<_> = plan.lines.iter().map(payroll_line_json).collect();
    Response::json(
        200,
        &serde_json::json!({
            "lines": lines_json, "errors": errors, "summary": payroll_summary_json(&plan),
        }),
    )
}

/// `POST /api/payroll` — create a Payroll proposal (N outputs, one envelope). Every line
/// is validated; the aggregate is checked against the balance when a wallet is wired.
fn payroll_create(cfg: &Config, body: &[u8], want: Option<&str>) -> Response {
    use crate::money::MAX_MONEY;
    use crate::payroll::PayrollPlan;
    use crate::proposal::Proposal;

    let req: PayrollCreateReq = match serde_json::from_slice(body) {
        Ok(v) => v,
        Err(e) => return bad(e.to_string(), "bad request"),
    };
    if req.proposer.trim().is_empty() {
        return bad("enter who is proposing", "missing proposer");
    }
    let mut lines = Vec::new();
    for (i, l) in req.lines.iter().enumerate() {
        match line_in_to_payroll(l) {
            Ok(pl) => lines.push(pl),
            Err(r) => return bad(format!("line {}: {}", i + 1, r), "invalid line"),
        }
    }
    let plan = PayrollPlan::new(lines);

    // Authoritative per-line decode when a live wallet is configured (real funds). A
    // single Sapling-only / malformed / wrong-network beneficiary would lock the whole
    // multi-output envelope (§8). Demo mode keeps the lenient prefix check.
    if cfg.wallet.is_some() {
        for (i, l) in plan.lines.iter().enumerate() {
            match crate::address::validate_recipient(&l.address) {
                Ok(rep) if rep.is_payable() => {}
                Ok(_) => {
                    return bad(
                        format!(
                            "line {}: this address can't receive from an Orchard vault (funds would lock)",
                            i + 1
                        ),
                        "invalid line",
                    )
                }
                Err(e) => return bad(format!("line {}: {}", i + 1, e.human()), "invalid line"),
            }
        }
    }

    let mut store = match open_store(cfg) {
        Ok(s) => s,
        Err(r) => return r,
    };
    let vault_id = match resolve_vault_id(&store, want) {
        Ok(Some(id)) => id,
        Ok(None) => return bad("no vault on this device", "no vault"),
        Err(r) => return r,
    };
    let vault = match store.get_vault(&vault_id) {
        Ok(Some(v)) => v,
        Ok(None) => return bad("no vault on this device", "no vault"),
        Err(e) => {
            return Response::json(
                500,
                &serde_json::json!({"error": "store", "detail": e.to_string()}),
            )
        }
    };

    // Aggregate validation (empty, per-line, Σ+fee ≤ available). Uses the live balance as
    // the ceiling when wired; otherwise a sentinel so only structure is enforced.
    let available = cfg
        .wallet
        .as_ref()
        .and_then(|w| w.balance().ok())
        .map(|b| b.total)
        .unwrap_or_else(|| Zatoshis::from_u64(MAX_MONEY).unwrap());
    let summary = match plan.validate(available, Zatoshis::ZERO) {
        Ok(s) => s,
        Err(e) => return bad(e.to_string(), "payroll invalid"),
    };

    let description = req
        .description
        .as_deref()
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(str::to_string)
        .unwrap_or_else(|| format!("Folha — {} pagamentos", summary.count));

    let proposal = Proposal::propose(req.proposer.clone(), vault.quorum);
    let rec = ProposalRecord {
        id: new_id(),
        vault_id: vault.id,
        kind: ProposalKind::Payroll,
        state: proposal.state(),
        proposer: req.proposer.clone(),
        value_total: summary.total,
        memo: Some(description),
        to_address: None, // destinations live in the lines
        expiry_unix: now_unix().map(|n| n + 72 * 3600),
        txid: None,
        created_at: now_unix(),
        approvals: vec![req.proposer],
        refusals: vec![],
    };
    if let Err(e) = store.save_proposal(&rec) {
        return Response::json(
            500,
            &serde_json::json!({"error": "store", "detail": e.to_string()}),
        );
    }
    if let Err(e) = store.save_payroll_lines(&rec.id, &plan.lines) {
        return Response::json(
            500,
            &serde_json::json!({"error": "store", "detail": e.to_string()}),
        );
    }
    let lines_json: Vec<_> = plan.lines.iter().map(payroll_line_json).collect();
    Response::json(
        201,
        &serde_json::json!({
            "proposal": ProposalDto::from(rec),
            "lines": lines_json,
            "summary": payroll_summary_json(&plan),
        }),
    )
}

/// `GET /api/proposals/{id}` — a single proposal (for the proposal detail screen). Payroll
/// proposals also carry their output lines.
fn api_proposal_one(cfg: &Config, id: &str) -> Response {
    let store = match open_store(cfg) {
        Ok(s) => s,
        Err(r) => return r,
    };
    match store.get_proposal(id) {
        Ok(Some(r)) => {
            let lines = if r.kind == ProposalKind::Payroll {
                store.get_payroll_lines(&r.id).unwrap_or_default()
            } else {
                Vec::new()
            };
            let lines_json: Vec<_> = lines.iter().map(payroll_line_json).collect();
            Response::json(
                200,
                &serde_json::json!({
                    "proposal": ProposalDto::from(r),
                    "lines": lines_json,
                }),
            )
        }
        Ok(None) => Response::json(
            404,
            &serde_json::json!({"error": "not found", "detail": "proposal not found"}),
        ),
        Err(e) => Response::json(
            500,
            &serde_json::json!({"error": "store", "detail": e.to_string()}),
        ),
    }
}

#[derive(serde::Deserialize)]
struct Vote {
    member: String,
}

/// `POST /api/proposals/{id}/approve|refuse` — record a vote through the state machine.
/// The domain is authoritative: reaching the quorum flips to Ready; refusals that make
/// the quorum unreachable auto-Reject. Conflicting/late votes are 409, never silent.
fn vote_proposal(cfg: &Config, id: &str, body: &[u8], approve: bool) -> Response {
    use crate::proposal::{Proposal, ProposalError};
    use std::collections::BTreeSet;

    let vote: Vote = match serde_json::from_slice(body) {
        Ok(v) => v,
        Err(e) => return bad(e.to_string(), "bad request"),
    };
    if vote.member.trim().is_empty() {
        return bad("enter who is voting", "missing member");
    }

    let mut store = match open_store(cfg) {
        Ok(s) => s,
        Err(r) => return r,
    };
    let rec = match store.get_proposal(id) {
        Ok(Some(r)) => r,
        Ok(None) => {
            return Response::json(
                404,
                &serde_json::json!({"error": "not found", "detail": "proposal not found"}),
            )
        }
        Err(e) => {
            return Response::json(
                500,
                &serde_json::json!({"error": "store", "detail": e.to_string()}),
            )
        }
    };
    let vault = match store.get_vault(&rec.vault_id) {
        Ok(Some(v)) => v,
        Ok(None) => {
            return Response::json(
                500,
                &serde_json::json!({"error": "store", "detail": "proposal's vault is missing"}),
            )
        }
        Err(e) => {
            return Response::json(
                500,
                &serde_json::json!({"error": "store", "detail": e.to_string()}),
            )
        }
    };

    let approvals: BTreeSet<String> = rec.approvals.iter().cloned().collect();
    let refusals: BTreeSet<String> = rec.refusals.iter().cloned().collect();
    let mut p = Proposal::from_parts(
        rec.proposer.clone(),
        vault.quorum,
        approvals,
        refusals,
        rec.state,
    );

    let outcome = if approve {
        p.approve(vote.member.clone())
    } else {
        p.refuse(vote.member.clone())
    };
    if let Err(e) = outcome {
        let status = match e {
            ProposalError::ConflictingVote { .. } | ProposalError::WrongState { .. } => 409,
            _ => 400,
        };
        return Response::json(
            status,
            &serde_json::json!({"error": "vote rejected", "detail": e.to_string()}),
        );
    }

    let mut updated = rec;
    updated.state = p.state();
    updated.approvals = p.approved_by();
    updated.refusals = p.refused_by();
    if let Err(e) = store.save_proposal(&updated) {
        return Response::json(
            500,
            &serde_json::json!({"error": "store", "detail": e.to_string()}),
        );
    }
    Response::json(
        200,
        &serde_json::json!({ "proposal": ProposalDto::from(updated) }),
    )
}

#[derive(serde::Deserialize, Default)]
struct SendReq {
    #[serde(default)]
    dry_run: bool,
}

/// `POST /api/proposals/{id}/send` — run the FROST ceremony for a Ready proposal and,
/// unless `dry_run`, broadcast. On a real send the proposal transitions Ready→Sent with
/// the txid recorded. This moves real funds; the caller (UI) confirms explicitly first.
fn send_proposal(cfg: &Config, id: &str, body: &[u8]) -> Response {
    use crate::proposal::Proposal;
    use crate::send::orchestrate_send;
    use std::collections::BTreeSet;

    let req: SendReq = if body.is_empty() {
        SendReq::default()
    } else {
        serde_json::from_slice(body).unwrap_or_default()
    };

    let Some(sc) = cfg.ceremony.as_ref() else {
        return Response::json(
            501,
            &serde_json::json!({
                "error": "ceremony not configured",
                "detail": "start the bridge with --ceremony <config.json> to enable sending"
            }),
        );
    };

    let mut store = match open_store(cfg) {
        Ok(s) => s,
        Err(r) => return r,
    };
    let rec = match store.get_proposal(id) {
        Ok(Some(r)) => r,
        Ok(None) => return Response::json(404, &serde_json::json!({"error": "not found"})),
        Err(e) => {
            return Response::json(
                500,
                &serde_json::json!({"error": "store", "detail": e.to_string()}),
            )
        }
    };
    if rec.state != crate::proposal::ProposalState::Ready {
        return Response::json(
            409,
            &serde_json::json!({
                "error": "not ready",
                "detail": format!("the proposal is {:?}; only a proposal that reached quorum (Ready) can be sent", rec.state)
            }),
        );
    }
    // Build the spend plan: a single payment (CLI) or a payroll (multi-output builder).
    let plan = match rec.kind {
        ProposalKind::Payment => {
            let Some(to) = rec.to_address.clone() else {
                return Response::json(
                    400,
                    &serde_json::json!({"error": "no destination", "detail": "proposal has no destination address"}),
                );
            };
            crate::send::SpendPlan::Payment {
                to,
                value_zat: rec.value_total.as_u64(),
                memo: rec.memo.clone(),
            }
        }
        ProposalKind::Payroll => {
            let lines = store.get_payroll_lines(&rec.id).unwrap_or_default();
            if lines.is_empty() {
                return Response::json(
                    400,
                    &serde_json::json!({"error": "empty payroll", "detail": "payroll has no lines"}),
                );
            }
            let dests = lines
                .into_iter()
                .map(|l| crate::send::PayrollDest {
                    address: l.address,
                    value_zat: l.value.as_u64(),
                    memo: if l.memo.is_empty() {
                        None
                    } else {
                        Some(l.memo)
                    },
                })
                .collect();
            crate::send::SpendPlan::Payroll { lines: dests }
        }
    };

    // 5-D.3: the ceremony signs with the shares of WHO APPROVED (rec.approvals).
    let outcome = orchestrate_send(sc, &plan, &rec.approvals, req.dry_run);
    let outcome = match outcome {
        Ok(o) => o,
        Err(e) => {
            return Response::json(
                502,
                &serde_json::json!({"error": "send failed", "detail": e.to_string()}),
            )
        }
    };

    if req.dry_run {
        return Response::json(
            200,
            &serde_json::json!({
                "dry_run": true, "sighash": outcome.sighash, "signed_pczt": outcome.signed_pczt
            }),
        );
    }

    // Real broadcast succeeded → transition Ready→Sent via the state machine, record txid.
    let vault = match store.get_vault(&rec.vault_id) {
        Ok(Some(v)) => v,
        _ => {
            return Response::json(
                500,
                &serde_json::json!({"error": "store", "detail": "vault is missing"}),
            )
        }
    };
    let approvals: BTreeSet<String> = rec.approvals.iter().cloned().collect();
    let refusals: BTreeSet<String> = rec.refusals.iter().cloned().collect();
    let mut p = Proposal::from_parts(
        rec.proposer.clone(),
        vault.quorum,
        approvals,
        refusals,
        rec.state,
    );
    let _ = p.broadcast(); // Ready→Sent (state already verified above)

    let mut updated = rec;
    updated.state = p.state();
    updated.txid = outcome.txid.clone();
    if let Err(e) = store.save_proposal(&updated) {
        return Response::json(
            500,
            &serde_json::json!({"error": "store", "detail": e.to_string()}),
        );
    }
    Response::json(
        200,
        &serde_json::json!({
            "proposal": ProposalDto::from(updated),
            "txid": outcome.txid
        }),
    )
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
    let rel = if path == "/" {
        "index.html"
    } else {
        path.trim_start_matches('/')
    };
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
              404 - not found. Was the UI bundle built? \
              (<code>npm run build</code> in <code>ui/</code>)</body>"
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

// ---- demo seed (public material only; coherent with the real slice vault) ----

/// Group public key of the real slice vault (2-of-3 trusted-dealer, RedPallas).
pub const SLICE_GROUP: &str = "1539b0ec3bc70a98d5c0e436da0b103552544d77d6b199efc444cdbab9b6ac24";
/// The real vault's Orchard receive address — public material (you hand it out to be paid).
pub const SLICE_ADDRESS: &str = "u1vjgxlvz4ewnt43rkq6fzexpl639745spx369tc4j9n9l0qnt9rufxdt2pxe3jtku7lqv4gtzfqafxtf7gal5y9gmz84nkza6z5d406dr";

/// Seed the **real** slice vault so a fresh DB renders a Painel coherent with the live
/// balance and the ceremony (same address/group). Only PUBLIC material is committed here:
/// the Orchard address and the group pubkey are public; the UFVK (view key) is not put in
/// git — it is loaded from the wallet at runtime. Skips if a vault already exists.
pub fn seed_demo(store: &mut Store) -> Result<(), crate::store::StoreError> {
    use crate::proposal::{ProposalState, Quorum};
    if !store.list_vaults()?.is_empty() {
        return Ok(());
    }
    let vault = VaultRecord {
        id: "vault-slice".into(),
        name: "Tesouraria Comum".into(),
        quorum: Quorum::new(2, 3).unwrap(),
        group_pubkey: SLICE_GROUP.into(),
        orchard_address: SLICE_ADDRESS.into(),
        // View key is loaded from the wallet at runtime; never committed.
        ufvk: "(carregada da carteira em tempo de execução)".into(),
        server_url: Some("127.0.0.1:2744".into()),
    };
    store.save_vault(&vault)?;

    // The real vault members = the FROST group's 3 participants (public comm pubkeys).
    store.save_vault_members(
        "vault-slice",
        &[
            crate::store::Member {
                name: "Alice".into(),
                pubkey: "317db5938d246aa64c3a08b5e74051cae6261838f482e8335450bb606f4b7214".into(),
            },
            crate::store::Member {
                name: "Bob".into(),
                pubkey: "2ca6d7365a44205e38bd2135446b454b1e2762708ea554493f0dbc7a1294b73a".into(),
            },
            crate::store::Member {
                name: "Carol".into(),
                pubkey: "2fd84a5cdb55a0a93ddaea092362190db2ce61d2fd5eefee2d661b44422d5d5a".into(),
            },
        ],
    )?;

    // One example pending proposal, with a value that FITS the real vault balance
    // (~0.0009 ZEC) — so nothing on screen contradicts the on-chain reality.
    let example = ProposalRecord {
        id: "prop-exemplo-1".into(),
        vault_id: "vault-slice".into(),
        kind: ProposalKind::Payment,
        state: ProposalState::Awaiting,
        proposer: "Alice".into(),
        value_total: Zatoshis::from_u64(30_000).unwrap(), // 0.0003 ZEC
        memo: Some("adiantamento maio".into()),
        to_address: Some(SLICE_ADDRESS.into()),
        expiry_unix: Some(i64::MAX), // example: never expires
        txid: None,
        created_at: now_unix(),
        approvals: vec!["Alice".into()],
        refusals: vec![],
    };
    store.save_proposal(&example)?;

    // A couple of example saved beneficiaries (address book).
    for (id, name, addr, memo) in [
        ("benef-1", "Prestador Infra", SLICE_ADDRESS, "infra mensal"),
        ("benef-2", "Design Estúdio", SLICE_ADDRESS, ""),
    ] {
        store.save_beneficiary(&crate::store::Beneficiary {
            id: id.into(),
            vault_id: "vault-slice".into(),
            name: name.into(),
            address: addr.into(),
            memo: memo.into(),
        })?;
    }
    Ok(())
}

// ---- local-bridge security (anti CSRF / DNS-rebinding) ----

/// A fresh, unguessable per-run token. Injected into the served HTML and required back on
/// state-changing API requests (a header a cross-site page cannot forge).
fn new_session_token() -> String {
    let mut b = [0u8; 24];
    let _ = getrandom::getrandom(&mut b);
    b.iter().map(|x| format!("{x:02x}")).collect()
}

/// Does the `Host` (or an `Origin`'s host) point at our loopback? Accepts `localhost` /
/// `127.0.0.1`, with or without a port. A foreign/absent host is rejected — this is what
/// defeats DNS-rebinding (an attacker domain resolving to 127.0.0.1 still sends its own Host).
fn host_is_local(host: Option<&str>) -> bool {
    match host {
        Some(h) => {
            let name = h.rsplit_once(':').map(|(n, _)| n).unwrap_or(h);
            name.eq_ignore_ascii_case("localhost") || name == "127.0.0.1"
        }
        None => false,
    }
}

/// The host[:port] part of an `Origin` header (drops the scheme). `null`/malformed stays as-is
/// (and will fail `host_is_local`).
fn origin_host(origin: &str) -> Option<&str> {
    Some(
        origin
            .split_once("://")
            .map(|(_, rest)| rest)
            .unwrap_or(origin),
    )
}

fn constant_time_eq(a: &str, b: &str) -> bool {
    let (a, b) = (a.as_bytes(), b.as_bytes());
    if a.len() != b.len() {
        return false;
    }
    let mut diff = 0u8;
    for i in 0..a.len() {
        diff |= a[i] ^ b[i];
    }
    diff == 0
}

/// Hand the session token to the SPA via the HTML it bootstraps from (window.__KONCLAVE_SESSION__).
fn inject_session(html: Vec<u8>, token: &str) -> Vec<u8> {
    match String::from_utf8(html) {
        Ok(s) => {
            let tag = format!("<script>window.__KONCLAVE_SESSION__={token:?}</script>");
            match s.find("</head>") {
                Some(pos) => format!("{}{}{}", &s[..pos], tag, &s[pos..]).into_bytes(),
                None => format!("{tag}{s}").into_bytes(),
            }
        }
        Err(e) => e.into_bytes(),
    }
}

/// Security wrapper around [`handle`]. Enforces the loopback `Host` (anti DNS-rebinding) on every
/// request and a per-session token on state-changing API calls (anti CSRF), then injects the token
/// into the served index.html. `handle` itself stays a pure router (kept directly testable).
///
/// Reads are protected by the Host gate + the browser same-origin policy (no CORS headers are ever
/// emitted), so only writes (POST) need the token — which also keeps the `<a download>` CSV export,
/// a plain GET, working.
#[allow(clippy::too_many_arguments)]
pub fn handle_secured(
    cfg: &Config,
    session_token: &str,
    method: &str,
    raw_path: &str,
    body: &[u8],
    host: Option<&str>,
    origin: Option<&str>,
    csrf_token: Option<&str>,
) -> Response {
    if !host_is_local(host) {
        return Response::json(403, &serde_json::json!({ "error": "bad_host" }));
    }
    let path = raw_path.split(['?', '#']).next().unwrap_or(raw_path);
    if method == "POST" && path.starts_with("/api/") {
        if let Some(o) = origin {
            if !host_is_local(origin_host(o)) {
                return Response::json(403, &serde_json::json!({ "error": "bad_origin" }));
            }
        }
        match csrf_token {
            Some(t) if constant_time_eq(t, session_token) => {}
            _ => {
                return Response::json(403, &serde_json::json!({ "error": "missing_or_bad_token" }))
            }
        }
    }
    let resp = handle(cfg, method, raw_path, body);
    if (path == "/" || path == "/index.html")
        && resp.status == 200
        && resp.content_type.starts_with("text/html")
    {
        let ct = resp.content_type.clone();
        return Response::text(200, &ct, inject_session(resp.body, session_token));
    }
    resp
}

// ---- socket loop (thin) ----

/// Bind **127.0.0.1** only and serve requests serially (single local user).
pub fn serve(cfg: Config, port: u16) -> std::io::Result<()> {
    let addr = format!("127.0.0.1:{port}");
    let server =
        tiny_http::Server::http(&addr).map_err(|e| std::io::Error::other(e.to_string()))?;
    let session_token = new_session_token();
    eprintln!(
        "konclave serve → http://{addr}  (web: {}, db: {})",
        cfg.web_dir.display(),
        cfg.db_path
    );
    for mut req in server.incoming_requests() {
        let method = req.method().as_str().to_string();
        let url = req.url().to_string();
        let (mut host, mut origin, mut token) = (None, None, None);
        for h in req.headers() {
            let f = h.field.as_str().as_str();
            if f.eq_ignore_ascii_case("host") {
                host = Some(h.value.as_str().to_string());
            } else if f.eq_ignore_ascii_case("origin") {
                origin = Some(h.value.as_str().to_string());
            } else if f.eq_ignore_ascii_case("x-konclave-session") {
                token = Some(h.value.as_str().to_string());
            }
        }
        // Bounded body (L4): reject an over-large payload up front by Content-Length — a local
        // daemon must not buffer an unbounded Vec. 2 MiB is generous for a payroll. Over → 413.
        const MAX_BODY: usize = 2 * 1024 * 1024;
        let too_large = req.body_length().map(|n| n > MAX_BODY).unwrap_or(false);
        let mut body = Vec::new();
        if !too_large {
            let _ = req.as_reader().read_to_end(&mut body);
        }
        let resp = if too_large {
            Response::json(413, &serde_json::json!({ "error": "payload too large" }))
        } else {
            handle_secured(
                &cfg,
                &session_token,
                &method,
                &url,
                &body,
                host.as_deref(),
                origin.as_deref(),
                token.as_deref(),
            )
        };
        let header =
            tiny_http::Header::from_bytes(&b"Content-Type"[..], resp.content_type.as_bytes())
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
        Config::new(std::env::temp_dir(), db, wallet, None)
    }

    fn body_json(r: &Response) -> serde_json::Value {
        serde_json::from_slice(&r.body).expect("json body")
    }

    // ---- local-bridge security gate (anti CSRF / DNS-rebinding) ----

    #[test]
    fn security_rejects_foreign_host() {
        let cfg = cfg_with(tmp_db(), None);
        let r = handle_secured(
            &cfg,
            "tok",
            "GET",
            "/api/health",
            b"",
            Some("evil.com"),
            None,
            None,
        );
        assert_eq!(r.status, 403);
        assert_eq!(body_json(&r)["error"], "bad_host");
    }

    #[test]
    fn security_rejects_absent_host() {
        let cfg = cfg_with(tmp_db(), None);
        let r = handle_secured(&cfg, "tok", "GET", "/api/health", b"", None, None, None);
        assert_eq!(r.status, 403);
    }

    #[test]
    fn security_allows_reads_on_local_host_without_token() {
        // Reads are safe under the Host gate + same-origin policy, so no token is required
        // (this keeps the `<a download>` CSV export, a plain GET, working).
        let cfg = cfg_with(tmp_db(), None);
        let r = handle_secured(
            &cfg,
            "tok",
            "GET",
            "/api/health",
            b"",
            Some("127.0.0.1:4762"),
            None,
            None,
        );
        assert_eq!(r.status, 200);
        assert_eq!(body_json(&r)["status"], "ok");
    }

    #[test]
    fn security_post_requires_the_session_token() {
        let cfg = cfg_with(tmp_db(), None);
        let none = handle_secured(
            &cfg,
            "tok",
            "POST",
            "/api/payroll/preview",
            b"{}",
            Some("localhost"),
            None,
            None,
        );
        assert_eq!(none.status, 403);
        assert_eq!(body_json(&none)["error"], "missing_or_bad_token");
        let bad = handle_secured(
            &cfg,
            "tok",
            "POST",
            "/api/payroll/preview",
            b"{}",
            Some("localhost"),
            None,
            Some("nope"),
        );
        assert_eq!(bad.status, 403);
    }

    #[test]
    fn security_post_with_token_passes_the_gate() {
        let cfg = cfg_with(tmp_db(), None);
        let ok = handle_secured(
            &cfg,
            "tok",
            "POST",
            "/api/payroll/preview",
            b"",
            Some("localhost"),
            Some("http://localhost:4762"),
            Some("tok"),
        );
        // Gate passed → the real handler ran; its status is never our 403 gate response.
        assert_ne!(ok.status, 403);
    }

    #[test]
    fn security_post_rejects_foreign_origin() {
        let cfg = cfg_with(tmp_db(), None);
        let r = handle_secured(
            &cfg,
            "tok",
            "POST",
            "/api/payroll/preview",
            b"{}",
            Some("localhost"),
            Some("http://evil.com"),
            Some("tok"),
        );
        assert_eq!(r.status, 403);
        assert_eq!(body_json(&r)["error"], "bad_origin");
    }

    #[test]
    fn host_and_token_matchers() {
        assert!(host_is_local(Some("localhost")));
        assert!(host_is_local(Some("localhost:4762")));
        assert!(host_is_local(Some("127.0.0.1:4762")));
        assert!(!host_is_local(Some("evil.com")));
        assert!(!host_is_local(Some("evil.com:4762")));
        assert!(!host_is_local(None));
        assert!(constant_time_eq("abc", "abc"));
        assert!(!constant_time_eq("abc", "abd"));
        assert!(!constant_time_eq("a", "ab"));
    }

    #[test]
    fn session_token_is_injected_into_html() {
        let html = b"<html><head><title>x</title></head><body></body></html>".to_vec();
        let out = String::from_utf8(inject_session(html, "deadbeef")).unwrap();
        assert!(out.contains("window.__KONCLAVE_SESSION__=\"deadbeef\""));
        assert!(out.find("__KONCLAVE_SESSION__").unwrap() < out.find("</head>").unwrap());
    }

    #[test]
    fn delete_unlocked_vault_requires_the_typed_name() {
        // The seeded demo vault has no passphrase; deletion must still be confirmed by typing
        // its exact name, enforced server-side (M3) — not only in the UI.
        let cfg = seeded_cfg(None);
        let none = handle(&cfg, "POST", "/api/vault/delete", b"{}");
        assert_eq!(none.status, 401);
        assert_eq!(body_json(&none)["error"], "confirm_required");

        let wrong = handle(
            &cfg,
            "POST",
            "/api/vault/delete",
            br#"{"confirm_name":"Errado"}"#,
        );
        assert_eq!(wrong.status, 401);

        let ok = handle(
            &cfg,
            "POST",
            "/api/vault/delete",
            br#"{"confirm_name":"Tesouraria Comum"}"#,
        );
        assert_eq!(ok.status, 200);
        assert_eq!(body_json(&ok)["ok"], true);
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
    fn vaults_are_isolated_by_query_param() {
        use crate::proposal::Quorum;
        let db = tmp_db();
        {
            let store = Store::open(&db).unwrap();
            for (vid, nm, benef) in [
                ("vault-a", "Cofre A", "Ana"),
                ("vault-b", "Cofre B", "Bruno"),
            ] {
                store
                    .save_vault(&VaultRecord {
                        id: vid.into(),
                        name: nm.into(),
                        quorum: Quorum::new(2, 3).unwrap(),
                        group_pubkey: format!("{vid}-gp"),
                        orchard_address: "u1demo".into(),
                        ufvk: String::new(),
                        server_url: None,
                    })
                    .unwrap();
                store
                    .save_beneficiary(&crate::store::Beneficiary {
                        id: format!("{vid}-b"),
                        vault_id: vid.into(),
                        name: benef.into(),
                        address: SLICE_ADDRESS.into(),
                        memo: String::new(),
                    })
                    .unwrap();
            }
        }
        let cfg = cfg_with(db, None);

        // Each vault sees only its own people — no cross-vault leakage.
        let b = handle(&cfg, "GET", "/api/beneficiaries?vault=vault-b", b"");
        let list = body_json(&b)["beneficiaries"].as_array().unwrap().clone();
        assert_eq!(list.len(), 1);
        assert_eq!(list[0]["name"], "Bruno");
        let a = handle(&cfg, "GET", "/api/beneficiaries?vault=vault-a", b"");
        assert_eq!(body_json(&a)["beneficiaries"][0]["name"], "Ana");

        // The vault endpoint honours the selection.
        let v = handle(&cfg, "GET", "/api/vault?vault=vault-b", b"");
        assert_eq!(body_json(&v)["vault"]["name"], "Cofre B");

        // An explicit unknown ?vault=<id> is a 404 — it must NOT fall back to the first
        // vault (L3), so a stale/guessed id can't land a request on the wrong vault.
        let f = handle(&cfg, "GET", "/api/vault?vault=nope", b"");
        assert_eq!(f.status, 404);
        assert_eq!(body_json(&f)["error"], "unknown vault");
    }

    #[test]
    fn vault_unlock_checks_the_passphrase() {
        use crate::proposal::Quorum;
        let db = tmp_db();
        {
            let store = Store::open(&db).unwrap();
            store
                .save_vault(&VaultRecord {
                    id: "v-lock".into(),
                    name: "Cofre".into(),
                    quorum: Quorum::new(2, 3).unwrap(),
                    group_pubkey: "gp".into(),
                    orchard_address: "u1".into(),
                    ufvk: String::new(),
                    server_url: None,
                })
                .unwrap();
            let salt = crate::secrets::generate_salt().unwrap();
            let key = crate::secrets::derive_key("cedro-barco-pedra-chave", &salt).unwrap();
            let verifier = crate::secrets::make_verifier(&key).unwrap();
            store.set_vault_lock("v-lock", &salt, &verifier).unwrap();
        }
        let cfg = cfg_with(db, None);

        // The vault reports itself locked.
        let v = handle(&cfg, "GET", "/api/vault?vault=v-lock", b"");
        assert_eq!(body_json(&v)["vault"]["locked"], true);

        // The right word unlocks; the wrong word is rejected (401), never leaking a key.
        let ok = handle(
            &cfg,
            "POST",
            "/api/vault/unlock?vault=v-lock",
            br#"{"passphrase":"cedro-barco-pedra-chave"}"#,
        );
        assert_eq!(ok.status, 200);
        assert_eq!(body_json(&ok)["ok"], true);
        let no = handle(
            &cfg,
            "POST",
            "/api/vault/unlock?vault=v-lock",
            br#"{"passphrase":"cedro-barco-pedra-monte"}"#,
        );
        assert_eq!(no.status, 401);
    }

    #[test]
    fn unlock_is_rate_limited_after_repeated_wrong_words() {
        use crate::proposal::Quorum;
        let db = tmp_db();
        {
            let store = Store::open(&db).unwrap();
            store
                .save_vault(&VaultRecord {
                    id: "v-lock".into(),
                    name: "Cofre".into(),
                    quorum: Quorum::new(2, 3).unwrap(),
                    group_pubkey: "gp".into(),
                    orchard_address: "u1".into(),
                    ufvk: String::new(),
                    server_url: None,
                })
                .unwrap();
            let salt = crate::secrets::generate_salt().unwrap();
            let key = crate::secrets::derive_key("cedro-barco-pedra-chave", &salt).unwrap();
            let verifier = crate::secrets::make_verifier(&key).unwrap();
            store.set_vault_lock("v-lock", &salt, &verifier).unwrap();
        }
        let cfg = cfg_with(db, None);

        // Exhaust the allowance with wrong words (401 each).
        for _ in 0..UNLOCK_MAX_FAILS {
            let r = handle(
                &cfg,
                "POST",
                "/api/vault/unlock?vault=v-lock",
                br#"{"passphrase":"cedro-barco-pedra-monte"}"#,
            );
            assert_eq!(r.status, 401);
        }
        // Now locked out: even the RIGHT word is refused (429) — no key check happens.
        let r = handle(
            &cfg,
            "POST",
            "/api/vault/unlock?vault=v-lock",
            br#"{"passphrase":"cedro-barco-pedra-chave"}"#,
        );
        assert_eq!(r.status, 429);
        assert_eq!(body_json(&r)["error"], "too many attempts");
    }

    #[test]
    fn vault_delete_requires_passphrase_then_removes() {
        use crate::proposal::Quorum;
        let db = tmp_db();
        {
            let store = Store::open(&db).unwrap();
            for id in ["v-locked", "v-plain"] {
                store
                    .save_vault(&VaultRecord {
                        id: id.into(),
                        name: id.into(),
                        quorum: Quorum::new(2, 3).unwrap(),
                        group_pubkey: "gp".into(),
                        orchard_address: "u1".into(),
                        ufvk: String::new(),
                        server_url: None,
                    })
                    .unwrap();
            }
            let salt = crate::secrets::generate_salt().unwrap();
            let key = crate::secrets::derive_key("cedro-barco-pedra-chave", &salt).unwrap();
            store
                .set_vault_lock(
                    "v-locked",
                    &salt,
                    &crate::secrets::make_verifier(&key).unwrap(),
                )
                .unwrap();
        }
        let cfg = cfg_with(db, None);

        // Wrong word cannot delete a locked vault.
        let no = handle(
            &cfg,
            "POST",
            "/api/vault/delete?vault=v-locked",
            br#"{"passphrase":"cedro-barco-pedra-monte"}"#,
        );
        assert_eq!(no.status, 401);
        assert_eq!(
            handle(&cfg, "GET", "/api/vault?vault=v-locked", b"").status,
            200
        );
        assert_eq!(
            body_json(&handle(&cfg, "GET", "/api/vault?vault=v-locked", b""))["vault"]["id"],
            "v-locked"
        );

        // Right word deletes it.
        let ok = handle(
            &cfg,
            "POST",
            "/api/vault/delete?vault=v-locked",
            br#"{"passphrase":"cedro-barco-pedra-chave"}"#,
        );
        assert_eq!(ok.status, 200);
        // An unlocked vault deletes only when its name is typed back (M3): a bare request
        // is refused server-side, not just in the UI.
        let refused = handle(&cfg, "POST", "/api/vault/delete?vault=v-plain", b"{}");
        assert_eq!(refused.status, 401);
        let ok2 = handle(
            &cfg,
            "POST",
            "/api/vault/delete?vault=v-plain",
            br#"{"confirm_name":"v-plain"}"#,
        );
        assert_eq!(ok2.status, 200);
        // Nothing left.
        assert!(
            body_json(&handle(&cfg, "GET", "/api/vaults", b""))["vaults"]
                .as_array()
                .unwrap()
                .is_empty()
        );
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
        // The UFVK is NEVER served over the bridge (M1) — it decrypts the whole tx graph + memos.
        assert!(v.get("ufvk").is_none());
    }

    #[test]
    fn beneficiaries_list_add_delete() {
        let cfg = seeded_cfg(None);
        // Seeded with two examples.
        let r = handle(&cfg, "GET", "/api/beneficiaries", b"");
        assert_eq!(r.status, 200);
        assert_eq!(body_json(&r)["beneficiaries"].as_array().unwrap().len(), 2);

        // Add one.
        let a = handle(
            &cfg,
            "POST",
            "/api/beneficiaries",
            br#"{"name":"Nova","address":"u1nova","memo":"x"}"#,
        );
        assert_eq!(a.status, 201);
        let id = body_json(&a)["beneficiary"]["id"]
            .as_str()
            .unwrap()
            .to_string();
        assert_eq!(
            body_json(&handle(&cfg, "GET", "/api/beneficiaries", b""))["beneficiaries"]
                .as_array()
                .unwrap()
                .len(),
            3
        );

        // Bad address rejected.
        let bad = handle(
            &cfg,
            "POST",
            "/api/beneficiaries",
            br#"{"name":"X","address":"nope"}"#,
        );
        assert_eq!(bad.status, 400);

        // Delete.
        let d = handle(
            &cfg,
            "POST",
            &format!("/api/beneficiaries/{id}/delete"),
            b"",
        );
        assert_eq!(d.status, 200);
        assert_eq!(
            body_json(&handle(&cfg, "GET", "/api/beneficiaries", b""))["beneficiaries"]
                .as_array()
                .unwrap()
                .len(),
            2
        );
    }

    #[test]
    fn vault_includes_member_list() {
        let db = tmp_db();
        let mut store = Store::open(&db).unwrap();
        seed_demo(&mut store).unwrap();
        drop(store);
        let cfg = cfg_with(db, None);
        let r = handle(&cfg, "GET", "/api/vault", b"");
        let v = &body_json(&r)["vault"];
        let members = v["member_list"].as_array().unwrap();
        assert_eq!(members.len(), 3);
        assert_eq!(members[0]["name"], "Alice");
        assert!(members[0]["pubkey"].as_str().unwrap().len() >= 8);
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
        assert_eq!(ps.len(), 1);
        // The example payment fits the real balance, formatted as a ZEC string.
        let payment = ps.iter().find(|p| p["kind"] == "payment").unwrap();
        assert_eq!(payment["value_zec"], "0.00030000");
        assert_eq!(payment["proposer"], "Alice");
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
            Some(Box::new(FakeWallet {
                result: Err("node offline".into()),
            })),
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
        assert_eq!(n, 2); // 1 seeded + 1 new
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
        // Real Orchard address so the authoritative check passes and the OVERSPEND guard
        // is what fires (a fake `u1abc` would now be rejected as malformed first).
        let body =
            format!(r#"{{"proposer":"Ana","to_address":"{SLICE_ADDRESS}","value_zec":"1.0"}}"#);
        let r = handle(&cfg, "POST", "/api/proposals", body.as_bytes());
        assert_eq!(r.status, 400);
        assert_eq!(body_json(&r)["error"], "insufficient funds");
    }

    // Real mainnet vectors for the authoritative address guard (audit M2 / §8).
    const SAPLING_ADDR: &str =
        "zs1qqqqqqqqqqqqqqqqqqcguyvaw2vjk4sdyeg0lc970u659lvhqq7t0np6hlup5lusxle75c8v35z";
    const TESTNET_UA: &str = "utest10c5kutapazdnf8ztl3pu43nkfsjx89fy3uuff8tsmxm6s86j37pe7uz94z5jhkl49pqe8yz75rlsaygexk6jpaxwx0esjr8wm5ut7d5s";

    fn live_cfg() -> Config {
        let bal = Balance {
            chain_tip_height: 1,
            orchard_spendable: Zatoshis::from_u64(100_000_000).unwrap(),
            sapling_spendable: Zatoshis::ZERO,
            transparent_spendable: Zatoshis::ZERO,
            total: Zatoshis::from_u64(100_000_000).unwrap(),
        };
        seeded_cfg(Some(Box::new(FakeWallet { result: Ok(bal) })))
    }

    #[test]
    fn create_proposal_rejects_sapling_dest_with_live_wallet() {
        // §8: a Sapling address handed to an Orchard vault would lock the funds.
        let cfg = live_cfg();
        let body =
            format!(r#"{{"proposer":"Ana","to_address":"{SAPLING_ADDR}","value_zec":"0.001"}}"#);
        let r = handle(&cfg, "POST", "/api/proposals", body.as_bytes());
        assert_eq!(r.status, 400);
        assert_eq!(body_json(&r)["error"], "unpayable address");
    }

    #[test]
    fn create_proposal_rejects_malformed_unified_with_live_wallet() {
        // `u1recipient…` passes the prefix heuristic but is not a real address — the exact
        // gap the authoritative decode closes on the fund-moving path.
        let cfg = live_cfg();
        let body =
            br#"{"proposer":"Ana","to_address":"u1recipientxxxxxxxxxxxxxxxxxxxxxxxx","value_zec":"0.001"}"#;
        let r = handle(&cfg, "POST", "/api/proposals", body);
        assert_eq!(r.status, 400);
        assert_eq!(body_json(&r)["error"], "invalid address");
    }

    #[test]
    fn create_proposal_rejects_testnet_dest_with_live_wallet() {
        let cfg = live_cfg();
        let body =
            format!(r#"{{"proposer":"Ana","to_address":"{TESTNET_UA}","value_zec":"0.001"}}"#);
        let r = handle(&cfg, "POST", "/api/proposals", body.as_bytes());
        assert_eq!(r.status, 400);
        assert_eq!(body_json(&r)["error"], "invalid address");
    }

    #[test]
    fn create_proposal_accepts_real_orchard_dest_with_live_wallet() {
        // The positive control: a real Orchard UA passes the authoritative gate.
        let cfg = live_cfg();
        let body =
            format!(r#"{{"proposer":"Ana","to_address":"{SLICE_ADDRESS}","value_zec":"0.001"}}"#);
        let r = handle(&cfg, "POST", "/api/proposals", body.as_bytes());
        assert_eq!(r.status, 201);
    }

    #[test]
    fn payroll_rejects_sapling_line_with_live_wallet() {
        let cfg = live_cfg();
        let body = format!(
            r#"{{"proposer":"Ana","lines":[{{"address":"{SLICE_ADDRESS}","value_zec":"0.001"}},{{"address":"{SAPLING_ADDR}","value_zec":"0.001"}}]}}"#
        );
        let r = handle(&cfg, "POST", "/api/payroll", body.as_bytes());
        assert_eq!(r.status, 400);
        assert_eq!(body_json(&r)["error"], "invalid line");
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

    // ---- vote on a proposal (POST /api/proposals/{id}/approve|refuse) ----

    fn create_one(cfg: &Config) -> String {
        let body = br#"{"proposer":"Ana","to_address":"u1recipient","value_zec":"0.001"}"#;
        let r = handle(cfg, "POST", "/api/proposals", body);
        assert_eq!(r.status, 201);
        body_json(&r)["id"].as_str().unwrap().to_string()
    }

    #[test]
    fn approve_reaches_quorum_ready() {
        let cfg = seeded_cfg(None);
        let id = create_one(&cfg); // Ana proposed → 1 approval, 2-of-3 → awaiting
        let r = handle(
            &cfg,
            "POST",
            &format!("/api/proposals/{id}/approve"),
            br#"{"member":"Bruno"}"#,
        );
        assert_eq!(r.status, 200);
        let j = body_json(&r);
        assert_eq!(j["proposal"]["state"], "ready");
        assert_eq!(j["proposal"]["approvals_count"], 2);
    }

    #[test]
    fn conflicting_vote_is_409() {
        let cfg = seeded_cfg(None);
        let id = create_one(&cfg);
        // Ana already approved (as proposer); Ana refusing is a conflict.
        let r = handle(
            &cfg,
            "POST",
            &format!("/api/proposals/{id}/refuse"),
            br#"{"member":"Ana"}"#,
        );
        assert_eq!(r.status, 409);
        assert_eq!(body_json(&r)["error"], "vote rejected");
    }

    #[test]
    fn refusals_making_quorum_unreachable_reject() {
        let cfg = seeded_cfg(None);
        let id = create_one(&cfg); // 2-of-3, Ana approved
        let r1 = handle(
            &cfg,
            "POST",
            &format!("/api/proposals/{id}/refuse"),
            br#"{"member":"Bruno"}"#,
        );
        assert_eq!(body_json(&r1)["proposal"]["state"], "awaiting"); // still reachable
        let r2 = handle(
            &cfg,
            "POST",
            &format!("/api/proposals/{id}/refuse"),
            br#"{"member":"Carla"}"#,
        );
        assert_eq!(body_json(&r2)["proposal"]["state"], "rejected"); // now unreachable
    }

    #[test]
    fn vote_on_missing_proposal_is_404() {
        let cfg = seeded_cfg(None);
        let r = handle(
            &cfg,
            "POST",
            "/api/proposals/deadbeef/approve",
            br#"{"member":"Bruno"}"#,
        );
        assert_eq!(r.status, 404);
    }

    #[test]
    fn get_single_proposal_and_404() {
        let cfg = seeded_cfg(None);
        let id = create_one(&cfg);
        let r = handle(&cfg, "GET", &format!("/api/proposals/{id}"), b"");
        assert_eq!(r.status, 200);
        assert_eq!(body_json(&r)["proposal"]["id"], id);
        let miss = handle(&cfg, "GET", "/api/proposals/nope", b"");
        assert_eq!(miss.status, 404);
    }

    // ---- ledger + CSV export (accounting track) ----

    #[test]
    fn ledger_json_lists_all_proposals() {
        let cfg = seeded_cfg(None);
        let r = handle(&cfg, "GET", "/api/ledger", b"");
        assert_eq!(r.status, 200);
        assert_eq!(body_json(&r)["ledger"].as_array().unwrap().len(), 1);
    }

    #[test]
    fn ledger_csv_has_header_and_rows() {
        let cfg = seeded_cfg(None);
        let r = handle(&cfg, "GET", "/api/ledger.csv", b"");
        assert_eq!(r.status, 200);
        assert!(r.content_type.contains("text/csv"));
        let text = String::from_utf8(r.body).unwrap();
        assert!(text.starts_with("documento,data,tipo,estado,proposto_por,aprovadores,beneficiario,valor_zec,memo,destino,txid"));
        assert!(text.contains("pagamento"));
        assert!(text.lines().count() >= 2); // header + >=1 seeded row
    }

    #[test]
    fn iso_date_is_correct() {
        assert_eq!(super::iso_date(0), "1970-01-01");
        assert_eq!(super::iso_date(1_767_225_600), "2026-01-01");
        assert_eq!(super::iso_date(1_735_689_600), "2025-01-01");
    }

    #[test]
    fn ledger_csv_itemizes_payroll_into_n_rows() {
        let cfg = seeded_cfg(None); // seeded: 1 payment
        let body = br#"{"proposer":"Ana","lines":[{"label":"Alice","address":"u1alice","value_zec":"0.0003","memo":"maio"},{"label":"Bob","address":"u1bob","value_zec":"0.0002"}]}"#;
        assert_eq!(handle(&cfg, "POST", "/api/payroll", body).status, 201);

        let r = handle(&cfg, "GET", "/api/ledger.csv", b"");
        let text = String::from_utf8(r.body).unwrap();
        // header + 1 payment + 2 payroll beneficiary rows.
        assert_eq!(text.lines().count(), 4);
        assert!(text.contains("Alice") && text.contains("Bob"));
        assert_eq!(text.matches(",folha,").count(), 2); // each beneficiary is its own entry
    }

    #[test]
    fn csv_field_escapes_commas_and_quotes() {
        assert_eq!(csv_field("plain"), "plain");
        assert_eq!(csv_field("a,b"), "\"a,b\"");
        assert_eq!(csv_field("she said \"hi\""), "\"she said \"\"hi\"\"\"");
    }

    // ---- payroll (N outputs, one approval) ----

    #[test]
    fn payroll_preview_from_csv_reports_lines_errors_summary() {
        let cfg = seeded_cfg(None);
        let body =
            br#"{"csv":"Alice,u1alice,0.0003,maio\nBob,u1bob,0.0002,\nCarol,u1carol,oops,x"}"#;
        let r = handle(&cfg, "POST", "/api/payroll/preview", body);
        assert_eq!(r.status, 200);
        let j = body_json(&r);
        assert_eq!(j["lines"].as_array().unwrap().len(), 2); // Alice + Bob
        assert_eq!(j["errors"].as_array().unwrap().len(), 1); // Carol: bad amount
        assert_eq!(j["summary"]["count"], 2);
        assert_eq!(j["summary"]["total_zec"], "0.00050000");
    }

    #[test]
    fn payroll_create_stores_lines_and_single_get_returns_them() {
        let cfg = seeded_cfg(None);
        let body = br#"{"proposer":"Ana","lines":[{"label":"Alice","address":"u1alice","value_zec":"0.0003","memo":"maio"},{"address":"u1bob","value_zec":"0.0002"}]}"#;
        let r = handle(&cfg, "POST", "/api/payroll", body);
        assert_eq!(r.status, 201);
        let j = body_json(&r);
        assert_eq!(j["proposal"]["kind"], "payroll");
        assert_eq!(j["proposal"]["value_zec"], "0.00050000");
        assert_eq!(j["lines"].as_array().unwrap().len(), 2);

        let id = j["proposal"]["id"].as_str().unwrap().to_string();
        let g = handle(&cfg, "GET", &format!("/api/proposals/{id}"), b"");
        assert_eq!(g.status, 200);
        assert_eq!(body_json(&g)["lines"].as_array().unwrap().len(), 2);
    }

    #[test]
    fn payroll_empty_is_400() {
        let cfg = seeded_cfg(None);
        let r = handle(
            &cfg,
            "POST",
            "/api/payroll",
            br#"{"proposer":"Ana","lines":[]}"#,
        );
        assert_eq!(r.status, 400);
    }

    #[test]
    fn payroll_bad_line_is_400() {
        let cfg = seeded_cfg(None);
        let r = handle(
            &cfg,
            "POST",
            "/api/payroll",
            br#"{"proposer":"Ana","lines":[{"address":"nao-e-endereco","value_zec":"0.1"}]}"#,
        );
        assert_eq!(r.status, 400);
        assert_eq!(body_json(&r)["error"], "invalid line");
    }

    #[test]
    fn payroll_overspend_is_400_with_live_wallet() {
        let bal = Balance {
            chain_tip_height: 1,
            orchard_spendable: Zatoshis::from_u64(100_000).unwrap(),
            sapling_spendable: Zatoshis::ZERO,
            transparent_spendable: Zatoshis::ZERO,
            total: Zatoshis::from_u64(100_000).unwrap(),
        };
        let cfg = seeded_cfg(Some(Box::new(FakeWallet { result: Ok(bal) })));
        // Real Orchard addresses so the OVERSPEND aggregate is what fires (fakes would be
        // rejected as malformed first).
        let body = format!(
            r#"{{"proposer":"Ana","lines":[{{"address":"{SLICE_ADDRESS}","value_zec":"1.0"}},{{"address":"{SLICE_ADDRESS}","value_zec":"1.0"}}]}}"#
        );
        let r = handle(&cfg, "POST", "/api/payroll", body.as_bytes());
        assert_eq!(r.status, 400);
        assert_eq!(body_json(&r)["error"], "payroll invalid");
    }

    #[test]
    fn payroll_send_attempts_ceremony_and_502_on_missing_tools() {
        let db = tmp_db();
        let mut store = Store::open(&db).unwrap();
        seed_demo(&mut store).unwrap();
        drop(store);
        let mut cfg = cfg_with(db, None);
        cfg.ceremony = Some(dummy_ceremony()); // fake tool paths

        let r = handle(
            &cfg,
            "POST",
            "/api/payroll",
            br#"{"proposer":"Alice","lines":[{"address":"u1a","value_zec":"0.0002"}]}"#,
        );
        assert_eq!(r.status, 201);
        let id = body_json(&r)["proposal"]["id"]
            .as_str()
            .unwrap()
            .to_string();
        let a = handle(
            &cfg,
            "POST",
            &format!("/api/proposals/{id}/approve"),
            br#"{"member":"Bob"}"#,
        );
        assert_eq!(body_json(&a)["proposal"]["state"], "ready");
        // Payroll now goes through the multi-output engine; with dummy tool paths the
        // build step fails and surfaces a clean 502 (not a silent success, not a 501).
        let s = handle(
            &cfg,
            "POST",
            &format!("/api/proposals/{id}/send"),
            br#"{"dry_run":false}"#,
        );
        assert_eq!(s.status, 502);
        assert_eq!(body_json(&s)["error"], "send failed");
    }

    // ---- send guards (the ceremony itself is validated live, not in unit tests) ----

    fn dummy_ceremony() -> crate::send::SendConfig {
        serde_json::from_str(
            r#"{"devtool":"/x","wallet_dir":"/w","lightwalletd":"z:443","account":"a",
                "konclave_signer":"/ks","frostd":"/fd","frost_client":"/fc",
                "members":[{"name":"Alice","pubkey":"aa","config":"a.toml"},
                           {"name":"Bob","pubkey":"bb","config":"b.toml"},
                           {"name":"Carol","pubkey":"cc","config":"c.toml"}],
                "threshold":2,"group":"gg","frostd_cert":"c.pem","frostd_key":"k.pem",
                "server_url":"127.0.0.1:2744","work_dir":"/tmp/w"}"#,
        )
        .unwrap()
    }

    #[test]
    fn send_without_ceremony_config_is_501() {
        let cfg = seeded_cfg(None); // ceremony: None
        let r = handle(&cfg, "POST", "/api/proposals/anything/send", b"");
        assert_eq!(r.status, 501);
        assert_eq!(body_json(&r)["error"], "ceremony not configured");
    }

    #[test]
    fn send_on_non_ready_proposal_is_409() {
        let db = tmp_db();
        let mut store = Store::open(&db).unwrap();
        seed_demo(&mut store).unwrap();
        drop(store);
        let mut cfg = cfg_with(db, None);
        cfg.ceremony = Some(dummy_ceremony());
        let id = create_one(&cfg); // awaiting (2-of-3, only proposer approved)
        let r = handle(
            &cfg,
            "POST",
            &format!("/api/proposals/{id}/send"),
            br#"{"dry_run":false}"#,
        );
        assert_eq!(r.status, 409);
        assert_eq!(body_json(&r)["error"], "not ready");
    }

    #[test]
    fn send_on_missing_proposal_is_404() {
        let mut cfg = seeded_cfg(None);
        cfg.ceremony = Some(dummy_ceremony());
        let r = handle(&cfg, "POST", "/api/proposals/deadbeef/send", b"");
        assert_eq!(r.status, 404);
    }
}
