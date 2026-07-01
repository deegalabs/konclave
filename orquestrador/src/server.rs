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
    /// The FROST ceremony config, present only when the send path is wired (`--ceremony`).
    pub ceremony: Option<crate::send::SendConfig>,
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
        if path == "/api/proposals" {
            return create_proposal(cfg, body);
        }
        if path == "/api/payroll/preview" {
            return payroll_preview(body);
        }
        if path == "/api/payroll" {
            return payroll_create(cfg, body);
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
            return Response::json(404, &serde_json::json!({"error": "unknown endpoint", "path": path}));
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
        "/api/vault" => api_vault(cfg),
        "/api/proposals" => api_proposals(cfg),
        "/api/ledger" => api_ledger(cfg),
        "/api/ledger.csv" => api_ledger_csv(cfg),
        "/api/balance" => api_balance(cfg),
        p if p.starts_with("/api/proposals/") => {
            api_proposal_one(cfg, p.strip_prefix("/api/proposals/").unwrap())
        }
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

/// The full ledger (all proposals, terminal states included) for the current vault.
fn api_ledger(cfg: &Config) -> Response {
    match load_ledger(cfg) {
        Ok(ps) => {
            let dtos: Vec<ProposalDto> = ps.into_iter().map(ProposalDto::from).collect();
            Response::json(200, &serde_json::json!({ "ledger": dtos }))
        }
        Err(r) => r,
    }
}

/// `GET /api/ledger.csv` — the accountant's export, ITEMIZED: **one row per payment**.
/// A single payment is one row; a payroll of N is **N rows** (one per beneficiary),
/// sharing the document id/state/txid. This is the accounting "lançamentos" view
/// (docs/REDESENHO_FOLHA.md), not one aggregate line per proposal.
fn api_ledger_csv(cfg: &Config) -> Response {
    const HEADER: &str =
        "documento,tipo,estado,proposto_por,aprovadores,beneficiario,valor_zec,memo,destino,txid\n";

    let store = match open_store(cfg) {
        Ok(s) => s,
        Err(r) => return r,
    };
    let vault_id = match store.list_vaults() {
        Ok(vs) => match vs.into_iter().next() {
            Some(v) => v.id,
            None => return csv_response(HEADER.to_string()),
        },
        Err(e) => return Response::json(500, &serde_json::json!({"error": "store", "detail": e.to_string()})),
    };
    let proposals = match store.list_all_proposals(&vault_id) {
        Ok(p) => p,
        Err(e) => return Response::json(500, &serde_json::json!({"error": "store", "detail": e.to_string()})),
    };

    let mut csv = String::from(HEADER);
    for p in proposals {
        let state = format!("{:?}", p.state).to_lowercase();
        let approvers = p.approvals.join(" ");
        let txid = p.txid.clone().unwrap_or_default();
        match p.kind {
            ProposalKind::Payment => {
                push_csv_row(&mut csv, &[
                    &p.id, "pagamento", &state, &p.proposer, &approvers, "",
                    &p.value_total.to_zec_string(), p.memo.as_deref().unwrap_or(""),
                    p.to_address.as_deref().unwrap_or(""), &txid,
                ]);
            }
            ProposalKind::Payroll => {
                let lines = store.get_payroll_lines(&p.id).unwrap_or_default();
                if lines.is_empty() {
                    push_csv_row(&mut csv, &[
                        &p.id, "folha", &state, &p.proposer, &approvers, "",
                        &p.value_total.to_zec_string(), p.memo.as_deref().unwrap_or(""), "", &txid,
                    ]);
                } else {
                    for l in &lines {
                        push_csv_row(&mut csv, &[
                            &p.id, "folha", &state, &p.proposer, &approvers,
                            l.label.as_deref().unwrap_or(""), &l.value.to_zec_string(),
                            &l.memo, &l.address, &txid,
                        ]);
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

fn csv_response(csv: String) -> Response {
    Response {
        status: 200,
        content_type: "text/csv; charset=utf-8".into(),
        body: csv.into_bytes(),
    }
}

/// Load all proposals for the current vault, or a ready-to-return error Response.
fn load_ledger(cfg: &Config) -> Result<Vec<ProposalRecord>, Response> {
    let store = open_store(cfg)?;
    let vault_id = match store.list_vaults() {
        Ok(vs) => match vs.into_iter().next() {
            Some(v) => v.id,
            None => return Ok(Vec::new()),
        },
        Err(e) => {
            return Err(Response::json(500, &serde_json::json!({"error": "store", "detail": e.to_string()})))
        }
    };
    store
        .list_all_proposals(&vault_id)
        .map_err(|e| Response::json(500, &serde_json::json!({"error": "store", "detail": e.to_string()})))
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
    lines: Vec<PayrollLineIn>,
}

/// Convert one input line to a validated domain line (address/value/memo checked).
fn line_in_to_payroll(l: &PayrollLineIn) -> Result<crate::payroll::PayrollLine, String> {
    use crate::validation::{validate_memo, AddressKind};
    let kind = AddressKind::classify(&l.address);
    if kind == AddressKind::Unknown {
        return Err(format!("endereço não reconhecido: {}", l.address));
    }
    let value = Zatoshis::from_zec_str(&l.value_zec).map_err(|e| e.to_string())?;
    if value.is_zero() {
        return Err("o valor deve ser maior que zero".into());
    }
    let memo = l.memo.clone().unwrap_or_default();
    validate_memo(&memo, kind).map_err(|e| e.to_string())?;
    Ok(crate::payroll::PayrollLine { label: l.label.clone(), address: l.address.clone(), value, memo })
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
    let z = |v: u64| Zatoshis::from_u64(v).map(|x| x.to_zec_string()).unwrap_or_default();
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
        let errs = report.errors.iter().map(|e| serde_json::json!({"row": e.row, "reason": e.reason})).collect();
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
        return bad("informe 'csv' ou 'lines'", "bad request");
    };
    let plan = PayrollPlan::new(lines);
    let lines_json: Vec<_> = plan.lines.iter().map(payroll_line_json).collect();
    Response::json(200, &serde_json::json!({
        "lines": lines_json, "errors": errors, "summary": payroll_summary_json(&plan),
    }))
}

/// `POST /api/payroll` — create a Payroll proposal (N outputs, one envelope). Every line
/// is validated; the aggregate is checked against the balance when a wallet is wired.
fn payroll_create(cfg: &Config, body: &[u8]) -> Response {
    use crate::money::MAX_MONEY;
    use crate::payroll::PayrollPlan;
    use crate::proposal::Proposal;

    let req: PayrollCreateReq = match serde_json::from_slice(body) {
        Ok(v) => v,
        Err(e) => return bad(e.to_string(), "bad request"),
    };
    if req.proposer.trim().is_empty() {
        return bad("informe quem está propondo", "missing proposer");
    }
    let mut lines = Vec::new();
    for (i, l) in req.lines.iter().enumerate() {
        match line_in_to_payroll(l) {
            Ok(pl) => lines.push(pl),
            Err(r) => return bad(format!("linha {}: {}", i + 1, r), "invalid line"),
        }
    }
    let plan = PayrollPlan::new(lines);

    let mut store = match open_store(cfg) {
        Ok(s) => s,
        Err(r) => return r,
    };
    let vault = match store.list_vaults() {
        Ok(mut vs) if !vs.is_empty() => vs.remove(0),
        Ok(_) => return bad("nenhum cofre neste dispositivo", "no vault"),
        Err(e) => return Response::json(500, &serde_json::json!({"error": "store", "detail": e.to_string()})),
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

    let proposal = Proposal::propose(req.proposer.clone(), vault.quorum);
    let rec = ProposalRecord {
        id: new_id(),
        vault_id: vault.id,
        kind: ProposalKind::Payroll,
        state: proposal.state(),
        proposer: req.proposer.clone(),
        value_total: summary.total,
        memo: Some(format!("Folha — {} pagamentos", summary.count)),
        to_address: None, // destinations live in the lines
        expiry_unix: now_unix().map(|n| n + 72 * 3600),
        txid: None,
        approvals: vec![req.proposer],
        refusals: vec![],
    };
    if let Err(e) = store.save_proposal(&rec) {
        return Response::json(500, &serde_json::json!({"error": "store", "detail": e.to_string()}));
    }
    if let Err(e) = store.save_payroll_lines(&rec.id, &plan.lines) {
        return Response::json(500, &serde_json::json!({"error": "store", "detail": e.to_string()}));
    }
    let lines_json: Vec<_> = plan.lines.iter().map(payroll_line_json).collect();
    Response::json(201, &serde_json::json!({
        "proposal": ProposalDto::from(rec),
        "lines": lines_json,
        "summary": payroll_summary_json(&plan),
    }))
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
            Response::json(200, &serde_json::json!({
                "proposal": ProposalDto::from(r),
                "lines": lines_json,
            }))
        }
        Ok(None) => Response::json(404, &serde_json::json!({"error": "not found", "detail": "proposta não encontrada"})),
        Err(e) => Response::json(500, &serde_json::json!({"error": "store", "detail": e.to_string()})),
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
        return bad("informe quem está votando", "missing member");
    }

    let mut store = match open_store(cfg) {
        Ok(s) => s,
        Err(r) => return r,
    };
    let rec = match store.get_proposal(id) {
        Ok(Some(r)) => r,
        Ok(None) => return Response::json(404, &serde_json::json!({"error": "not found", "detail": "proposta não encontrada"})),
        Err(e) => return Response::json(500, &serde_json::json!({"error": "store", "detail": e.to_string()})),
    };
    let vault = match store.get_vault(&rec.vault_id) {
        Ok(Some(v)) => v,
        Ok(None) => return Response::json(500, &serde_json::json!({"error": "store", "detail": "cofre da proposta ausente"})),
        Err(e) => return Response::json(500, &serde_json::json!({"error": "store", "detail": e.to_string()})),
    };

    let approvals: BTreeSet<String> = rec.approvals.iter().cloned().collect();
    let refusals: BTreeSet<String> = rec.refusals.iter().cloned().collect();
    let mut p = Proposal::from_parts(rec.proposer.clone(), vault.quorum, approvals, refusals, rec.state);

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
        return Response::json(status, &serde_json::json!({"error": "vote rejected", "detail": e.to_string()}));
    }

    let mut updated = rec;
    updated.state = p.state();
    updated.approvals = p.approved_by();
    updated.refusals = p.refused_by();
    if let Err(e) = store.save_proposal(&updated) {
        return Response::json(500, &serde_json::json!({"error": "store", "detail": e.to_string()}));
    }
    Response::json(200, &serde_json::json!({ "proposal": ProposalDto::from(updated) }))
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
        return Response::json(501, &serde_json::json!({
            "error": "ceremony not configured",
            "detail": "suba a ponte com --ceremony <config.json> para habilitar o envio"
        }));
    };

    let mut store = match open_store(cfg) {
        Ok(s) => s,
        Err(r) => return r,
    };
    let rec = match store.get_proposal(id) {
        Ok(Some(r)) => r,
        Ok(None) => return Response::json(404, &serde_json::json!({"error": "not found"})),
        Err(e) => return Response::json(500, &serde_json::json!({"error": "store", "detail": e.to_string()})),
    };
    if rec.state != crate::proposal::ProposalState::Ready {
        return Response::json(409, &serde_json::json!({
            "error": "not ready",
            "detail": format!("a proposta está {:?}; só uma proposta com quórum (Ready) pode ser enviada", rec.state)
        }));
    }
    // Payroll (N outputs) needs a multi-output PCZT, which the CLI can't build. Honest
    // limitation: the multi-output send engine (zcash_client_backend) is roadmap (5-B.2).
    if rec.kind == ProposalKind::Payroll {
        return Response::json(501, &serde_json::json!({
            "error": "payroll send not implemented",
            "detail": "o envio de folha (N saídas numa transação) ainda não está disponível — precisa do motor multi-saída (roadmap 5-B.2)"
        }));
    }
    let Some(to) = rec.to_address.clone() else {
        return Response::json(400, &serde_json::json!({"error": "no destination", "detail": "proposta sem endereço de destino"}));
    };

    let outcome = orchestrate_send(sc, &to, rec.value_total.as_u64(), rec.memo.as_deref(), req.dry_run);
    let outcome = match outcome {
        Ok(o) => o,
        Err(e) => return Response::json(502, &serde_json::json!({"error": "send failed", "detail": e.to_string()})),
    };

    if req.dry_run {
        return Response::json(200, &serde_json::json!({
            "dry_run": true, "sighash": outcome.sighash, "signed_pczt": outcome.signed_pczt
        }));
    }

    // Real broadcast succeeded → transition Ready→Sent via the state machine, record txid.
    let vault = match store.get_vault(&rec.vault_id) {
        Ok(Some(v)) => v,
        _ => return Response::json(500, &serde_json::json!({"error": "store", "detail": "cofre ausente"})),
    };
    let approvals: BTreeSet<String> = rec.approvals.iter().cloned().collect();
    let refusals: BTreeSet<String> = rec.refusals.iter().cloned().collect();
    let mut p = Proposal::from_parts(rec.proposer.clone(), vault.quorum, approvals, refusals, rec.state);
    let _ = p.broadcast(); // Ready→Sent (state already verified above)

    let mut updated = rec;
    updated.state = p.state();
    updated.txid = outcome.txid.clone();
    if let Err(e) = store.save_proposal(&updated) {
        return Response::json(500, &serde_json::json!({"error": "store", "detail": e.to_string()}));
    }
    Response::json(200, &serde_json::json!({
        "proposal": ProposalDto::from(updated),
        "txid": outcome.txid
    }))
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

    // One example pending proposal, with a value that FITS the real vault balance
    // (~0.0009 ZEC) — so nothing on screen contradicts the on-chain reality.
    let example = ProposalRecord {
        id: "prop-exemplo-1".into(),
        vault_id: "vault-slice".into(),
        kind: ProposalKind::Payment,
        state: ProposalState::Awaiting,
        proposer: "Bruno".into(),
        value_total: Zatoshis::from_u64(30_000).unwrap(), // 0.0003 ZEC
        memo: Some("adiantamento maio".into()),
        to_address: Some(SLICE_ADDRESS.into()),
        expiry_unix: Some(1_800_000_000),
        txid: None,
        approvals: vec!["Bruno".into()],
        refusals: vec![],
    };
    store.save_proposal(&example)?;
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
        Config { web_dir: std::env::temp_dir(), db_path: db, wallet, ceremony: None }
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
        assert_eq!(ps.len(), 1);
        // The example payment fits the real balance, formatted as a ZEC string.
        let payment = ps.iter().find(|p| p["kind"] == "payment").unwrap();
        assert_eq!(payment["value_zec"], "0.00030000");
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
        let r = handle(&cfg, "POST", &format!("/api/proposals/{id}/approve"), br#"{"member":"Bruno"}"#);
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
        let r = handle(&cfg, "POST", &format!("/api/proposals/{id}/refuse"), br#"{"member":"Ana"}"#);
        assert_eq!(r.status, 409);
        assert_eq!(body_json(&r)["error"], "vote rejected");
    }

    #[test]
    fn refusals_making_quorum_unreachable_reject() {
        let cfg = seeded_cfg(None);
        let id = create_one(&cfg); // 2-of-3, Ana approved
        let r1 = handle(&cfg, "POST", &format!("/api/proposals/{id}/refuse"), br#"{"member":"Bruno"}"#);
        assert_eq!(body_json(&r1)["proposal"]["state"], "awaiting"); // still reachable
        let r2 = handle(&cfg, "POST", &format!("/api/proposals/{id}/refuse"), br#"{"member":"Carla"}"#);
        assert_eq!(body_json(&r2)["proposal"]["state"], "rejected"); // now unreachable
    }

    #[test]
    fn vote_on_missing_proposal_is_404() {
        let cfg = seeded_cfg(None);
        let r = handle(&cfg, "POST", "/api/proposals/deadbeef/approve", br#"{"member":"Bruno"}"#);
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
        assert!(text.starts_with("documento,tipo,estado,proposto_por,aprovadores,beneficiario,valor_zec,memo,destino,txid"));
        assert!(text.contains("pagamento"));
        assert!(text.lines().count() >= 2); // header + >=1 seeded row
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
        assert_eq!(text.matches(",folha,").count(), 2); // each beneficiary is its own lançamento
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
        let body = br#"{"csv":"Alice,u1alice,0.0003,maio\nBob,u1bob,0.0002,\nCarol,u1carol,oops,x"}"#;
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
        let r = handle(&cfg, "POST", "/api/payroll", br#"{"proposer":"Ana","lines":[]}"#);
        assert_eq!(r.status, 400);
    }

    #[test]
    fn payroll_bad_line_is_400() {
        let cfg = seeded_cfg(None);
        let r = handle(&cfg, "POST", "/api/payroll", br#"{"proposer":"Ana","lines":[{"address":"nao-e-endereco","value_zec":"0.1"}]}"#);
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
        let body = br#"{"proposer":"Ana","lines":[{"address":"u1a","value_zec":"1.0"},{"address":"u1b","value_zec":"1.0"}]}"#;
        let r = handle(&cfg, "POST", "/api/payroll", body);
        assert_eq!(r.status, 400);
        assert_eq!(body_json(&r)["error"], "payroll invalid");
    }

    #[test]
    fn payroll_send_is_501_not_implemented() {
        let db = tmp_db();
        let mut store = Store::open(&db).unwrap();
        seed_demo(&mut store).unwrap();
        drop(store);
        let mut cfg = cfg_with(db, None);
        cfg.ceremony = Some(dummy_ceremony());

        let r = handle(&cfg, "POST", "/api/payroll", br#"{"proposer":"Ana","lines":[{"address":"u1a","value_zec":"0.0002"}]}"#);
        assert_eq!(r.status, 201);
        let id = body_json(&r)["proposal"]["id"].as_str().unwrap().to_string();
        // Reach the quorum (Ana proposed; Bruno approves) → Ready.
        let a = handle(&cfg, "POST", &format!("/api/proposals/{id}/approve"), br#"{"member":"Bruno"}"#);
        assert_eq!(body_json(&a)["proposal"]["state"], "ready");
        // Sending a payroll is an honest 501 (multi-output engine is roadmap).
        let s = handle(&cfg, "POST", &format!("/api/proposals/{id}/send"), br#"{"dry_run":false}"#);
        assert_eq!(s.status, 501);
        assert_eq!(body_json(&s)["error"], "payroll send not implemented");
    }

    // ---- send guards (the ceremony itself is validated live, not in unit tests) ----

    fn dummy_ceremony() -> crate::send::SendConfig {
        serde_json::from_str(
            r#"{"devtool":"/x","wallet_dir":"/w","lightwalletd":"z:443","account":"a",
                "konclave_signer":"/ks","frostd":"/fd","frost_client":"/fc",
                "coordinator_config":"a.toml","participant_configs":["a.toml","b.toml"],
                "group":"gg","signers":["aa","bb"],"frostd_cert":"c.pem","frostd_key":"k.pem",
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
        let r = handle(&cfg, "POST", &format!("/api/proposals/{id}/send"), br#"{"dry_run":false}"#);
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
