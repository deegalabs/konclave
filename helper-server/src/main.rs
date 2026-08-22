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
    append_ceremony, is_valid_group_key, ledger_csv, list_proposals, load_ceremonies, load_members,
    load_proposal, payment_plan, register_vault, rename_member, save_members, save_proposal,
    send_config_for, vault_transactions,
    vault_balance, CeremonyRecord, HelperConfig, HelperProposal, HelperState, PayrollLine,
    VaultRegistration,
};
use orchestrator::send::{net_orchestrate_send, PayrollDest, SpendPlan};
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
    // Quorum (threshold/total) is public and drives the UI; the UFVK + account stay omitted (M1).
    json!({ "vault_id": r.vault_id, "address": r.address, "threshold": r.threshold, "total": r.total })
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
                // The vault's approval quorum, which the browser knows from the DKG. Optional so an
                // older client still registers (0/0 = unknown, proposals then can't reach `ready`).
                #[serde(default)]
                threshold: u16,
                #[serde(default)]
                total: u16,
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
            match register_vault(cfg, &req.group_key, name, req.threshold, req.total) {
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
                            "ironwood_spendable_zat": b.ironwood_spendable_zat,
                            "shielded_spendable_zat": b.shielded_spendable_zat,
                            "chain_tip_height": b.chain_tip_height,
                            "total_zat": b.total_zat
                        })
                        .to_string(),
                    ),
                    Err(e) => resp(502, json!({ "error": e.to_string() }).to_string()),
                },
            }
        }
        (Method::Get, "/api/vault/transactions") => {
            match query_param(query, "vault").and_then(|v| state.get(v)) {
                None => resp(404, json!({ "error": "no such vault" }).to_string()),
                Some(reg) => match vault_transactions(cfg, &reg) {
                    Ok(txs) => resp(200, json!({ "transactions": txs }).to_string()),
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
        (Method::Get, "/api/vault/proposals") => {
            match query_param(query, "vault").and_then(|v| state.get(v)) {
                None => resp(404, json!({ "error": "no such vault" }).to_string()),
                Some(reg) => {
                    let ps = list_proposals(&cfg.vaults_dir, &reg.vault_id, now_unix());
                    resp(200, json!({ "proposals": ps }).to_string())
                }
            }
        }
        (Method::Get, "/api/vault/ledger") => {
            match query_param(query, "vault").and_then(|v| state.get(v)) {
                None => resp(404, json!({ "error": "no such vault" }).to_string()),
                Some(reg) => {
                    let entries = sent_proposals(cfg, &reg.vault_id);
                    resp(200, json!({ "entries": entries }).to_string())
                }
            }
        }
        (Method::Get, "/api/vault/ledger.csv") => {
            match query_param(query, "vault").and_then(|v| state.get(v)) {
                None => resp(404, json!({ "error": "no such vault" }).to_string()),
                // The body is CSV; it is served with the default JSON content-type, so the browser
                // client downloads it as a blob (it sets the filename/type). Keeps the router simple.
                Some(reg) => resp(200, ledger_csv(&sent_proposals(cfg, &reg.vault_id))),
            }
        }
        (Method::Get, "/api/vault/members") => {
            match query_param(query, "vault").and_then(|v| state.get(v)) {
                None => resp(404, json!({ "error": "no such vault" }).to_string()),
                Some(reg) => {
                    let members = load_members(&cfg.vaults_dir, &reg.vault_id);
                    resp(200, json!({ "members": members }).to_string())
                }
            }
        }
        (Method::Post, "/api/vault/members") => {
            #[derive(Deserialize)]
            struct Req {
                vault: String,
                names: Vec<String>,
            }
            let req: Req = match serde_json::from_slice(body) {
                Ok(r) => r,
                Err(_) => return resp(400, json!({ "error": "invalid json" }).to_string()),
            };
            let reg = match state.get(&req.vault) {
                Some(r) => r,
                None => return resp(404, json!({ "error": "no such vault" }).to_string()),
            };
            match save_members(&cfg.vaults_dir, &reg.vault_id, &req.names) {
                Ok(()) => resp(200, json!({ "members": req.names }).to_string()),
                Err(e) => resp(502, json!({ "error": e.to_string() }).to_string()),
            }
        }
        (Method::Post, "/api/vault/members/rename") => {
            // Rename ONE seat (the caller's own), migrating the name across every proposal's votes so
            // a rename never leaves a "ghost" approver under the old name. A 400 carries the reason
            // (unknown seat / name taken / empty) so the UI can show it.
            #[derive(Deserialize)]
            struct Req {
                vault: String,
                old: String,
                new: String,
            }
            let req: Req = match serde_json::from_slice(body) {
                Ok(r) => r,
                Err(_) => return resp(400, json!({ "error": "invalid json" }).to_string()),
            };
            let reg = match state.get(&req.vault) {
                Some(r) => r,
                None => return resp(404, json!({ "error": "no such vault" }).to_string()),
            };
            match rename_member(&cfg.vaults_dir, &reg.vault_id, &req.old, &req.new, now_unix()) {
                Ok(members) => resp(200, json!({ "members": members }).to_string()),
                Err(e) => resp(400, json!({ "error": e.to_string() }).to_string()),
            }
        }
        (Method::Post, "/api/vault/payroll") => handle_create_payroll(state, cfg, body),
        (Method::Post, "/api/vault/proposals") => handle_create_proposal(state, cfg, body),
        (Method::Post, vp) if vp.starts_with("/api/vault/proposals/") => {
            if vp.ends_with("/send") {
                handle_proposal_send(state, cfg, vp, body)
            } else {
                handle_vote(state, cfg, vp, body)
            }
        }
        (Method::Post, "/api/vault/send") => handle_send(state, cfg, body),
        _ => resp(404, json!({ "error": "not found" }).to_string()),
    }
}

/// Available memory in MiB parsed from a `/proc/meminfo` string (its `MemAvailable:` line), or None.
/// Pure, so it is unit-testable without touching the filesystem.
fn parse_mem_available_mb(meminfo: &str) -> Option<u64> {
    for line in meminfo.lines() {
        if let Some(rest) = line.strip_prefix("MemAvailable:") {
            let kb: u64 = rest.trim().split_whitespace().next()?.parse().ok()?;
            return Some(kb / 1024);
        }
    }
    None
}

fn available_mem_mb() -> Option<u64> {
    std::fs::read_to_string("/proc/meminfo")
        .ok()
        .and_then(|s| parse_mem_available_mb(&s))
}

/// Opt-in pre-prove capacity guard (#135). Proving a PCZT (Halo2) is RAM-heavy; on a small instance
/// a prove can OOM mid-send, killing the container and returning an ambiguous platform 502. When
/// `MIN_PROVE_MB` is set and MemAvailable is below it, refuse the prove up front with a clean 503
/// (before ANY tx work), so the money path fails fast and unambiguously instead of crashing. Disabled
/// by default (unset/0) so behavior is unchanged until the instance is sized and the threshold tuned.
fn over_capacity() -> bool {
    let min: u64 = std::env::var("MIN_PROVE_MB")
        .ok()
        .and_then(|v| v.parse().ok())
        .unwrap_or(0);
    if min == 0 {
        return false;
    }
    // Can't read memory (non-Linux/dev): don't block.
    available_mem_mb().map(|avail| avail < min).unwrap_or(false)
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
    // Capacity guard (#135): refuse a memory-heavy prove up front when the instance is low, rather
    // than OOM-crashing mid-send. Before any tx work, so no ambiguous state.
    if over_capacity() {
        return resp(503, json!({ "error": "coordinator over capacity, retry in a moment" }).to_string());
    }
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
            // signature(s) + txid, all public + independently verifiable. Best-effort - a
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

/// Execute a READY proposal over Architecture B: build the PCZT for the proposal's payment, run the
/// browser ceremony over the relay, and (unless `dry_run`) broadcast. On a real broadcast the
/// proposal is marked `sent` with its txid.
///
/// SECURITY (audit): `ready` is advisory (the approval votes are social, unauthenticated). The
/// money gate is the ceremony itself, which needs the real quorum of browser shares to produce a
/// valid signature, so a forged "ready" cannot move funds on its own. Non-ready proposals are
/// refused (409); `dry_run` defaults true so a broadcast is always explicit.
fn handle_proposal_send(state: &HelperState, cfg: &HelperConfig, path: &str, body: &[u8]) -> Resp {
    let id = path
        .trim_start_matches("/api/vault/proposals/")
        .trim_end_matches("/send");
    #[derive(Deserialize)]
    struct Req {
        vault: String,
        relay_base: String,
        room: String,
        #[serde(default = "psend_dry_run")]
        dry_run: bool,
        #[serde(default = "psend_max_polls")]
        max_polls: u32,
    }
    fn psend_dry_run() -> bool {
        true
    }
    fn psend_max_polls() -> u32 {
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
    let now = now_unix();
    let mut p = match load_proposal(&cfg.vaults_dir, &req.vault, id, now) {
        Some(p) => p,
        None => return resp(404, json!({ "error": "no such proposal" }).to_string()),
    };
    if p.state != "ready" {
        return resp(
            409,
            json!({ "error": "proposal is not ready to send", "state": p.state }).to_string(),
        );
    }
    // A payroll spends to N beneficiaries in one tx; a payment spends to one. Re-validate each
    // destination + amount at execution time (defence in depth) before building the plan.
    let plan = if p.kind == "payroll" {
        let mut dests = Vec::with_capacity(p.lines.len());
        for l in &p.lines {
            if let Err(e) = payment_plan(&l.to, l.amount_zat, l.memo.clone(), cfg.network_type()) {
                return resp(400, json!({ "error": e.to_string() }).to_string());
            }
            dests.push(PayrollDest {
                address: l.to.clone(),
                value_zat: l.amount_zat,
                memo: l.memo.clone(),
            });
        }
        SpendPlan::Payroll { lines: dests }
    } else {
        match payment_plan(&p.to, p.amount_zat, p.memo.clone(), cfg.network_type()) {
            Ok(pl) => pl,
            Err(e) => return resp(400, json!({ "error": e.to_string() }).to_string()),
        }
    };
    // Capacity guard (#135): same pre-prove check as handle_send.
    if over_capacity() {
        return resp(503, json!({ "error": "coordinator over capacity, retry in a moment" }).to_string());
    }
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
            let rec = CeremonyRecord {
                vault_id: reg.vault_id.clone(),
                sighash: out.sighash.clone(),
                signatures: out.signatures.clone(),
                txid: out.txid.clone(),
                dry_run: req.dry_run,
                created_at_unix: now_unix(),
            };
            let _ = append_ceremony(&cfg.vaults_dir, &rec);
            // A real broadcast moves the proposal to the terminal `sent` with its txid; a dry-run
            // leaves it `ready` (it only proved the quorum can sign).
            if !req.dry_run {
                if let Some(txid) = &out.txid {
                    p.state = "sent".into();
                    p.txid = Some(txid.clone());
                    let _ = save_proposal(&cfg.vaults_dir, &p);
                }
            }
            resp(
                200,
                json!({ "txid": out.txid, "dry_run": req.dry_run, "sighash": out.sighash,
                        "state": p.state })
                .to_string(),
            )
        }
        Err(e) => resp(502, json!({ "error": e.to_string() }).to_string()),
    }
}

/// The vault's confirmed, governed payments: proposals that reached the terminal `sent` state (each
/// carries its on-chain txid). This is the accounting ledger. Direct (non-proposal) sends are not
/// here; they live in the ceremony trail.
fn sent_proposals(cfg: &HelperConfig, vault: &str) -> Vec<HelperProposal> {
    list_proposals(&cfg.vaults_dir, vault, now_unix())
        .into_iter()
        .filter(|p| p.state == "sent")
        .collect()
}

/// Unix seconds now (0 if the clock is before the epoch, which never happens on a real host).
fn now_unix() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0)
}

/// A unique proposal id from the wall clock (nanosecond precision). Not attacker-controlled.
fn gen_proposal_id() -> String {
    let nanos = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_nanos())
        .unwrap_or(0);
    format!("p{nanos:x}")
}

/// Create a payment proposal on a browser-native vault. The destination + amount are validated
/// AUTHORITATIVELY (zcash_address decode + Orchard-pool + network, plus amount > 0) before anything
/// is stored, so a bad proposal is a 400. The proposer auto-approves (proposing implies approval).
/// The quorum comes from the VAULT (not the request), so it cannot be spoofed per-proposal.
fn handle_create_proposal(state: &HelperState, cfg: &HelperConfig, body: &[u8]) -> Resp {
    #[derive(Deserialize)]
    struct Req {
        vault: String,
        proposer: String,
        to: String,
        amount_zat: u64,
        memo: Option<String>,
        #[serde(default)]
        expiry_unix: u64,
    }
    let req: Req = match serde_json::from_slice(body) {
        Ok(r) => r,
        Err(_) => return resp(400, json!({ "error": "invalid json" }).to_string()),
    };
    if req.proposer.trim().is_empty() {
        return resp(400, json!({ "error": "proposer is required" }).to_string());
    }
    let reg = match state.get(&req.vault) {
        Some(r) => r,
        None => return resp(404, json!({ "error": "no such vault" }).to_string()),
    };
    // Reuse the send-path validation (authoritative address + amount) so a proposal can only name a
    // destination the vault could actually pay.
    if let Err(e) = payment_plan(
        &req.to,
        req.amount_zat,
        req.memo.clone(),
        cfg.network_type(),
    ) {
        return resp(400, json!({ "error": e.to_string() }).to_string());
    }
    let now = now_unix();
    let mut p = HelperProposal {
        id: gen_proposal_id(),
        vault_id: reg.vault_id.clone(),
        kind: "payment".into(),
        to: req.to,
        amount_zat: req.amount_zat,
        memo: req.memo,
        lines: vec![],
        proposer: req.proposer.clone(),
        state: "pending".into(),
        approvals: vec![req.proposer],
        refusals: vec![],
        threshold: reg.threshold,
        total: reg.total,
        created_at_unix: now,
        expiry_unix: req.expiry_unix,
        txid: None,
    };
    p.recompute(now);
    match save_proposal(&cfg.vaults_dir, &p) {
        Ok(()) => resp(200, serde_json::to_string(&p).unwrap_or_default()),
        Err(e) => resp(502, json!({ "error": e.to_string() }).to_string()),
    }
}

/// Create a PAYROLL proposal: N beneficiaries paid in one private Orchard tx, approved once. Every
/// line's destination + amount is validated authoritatively before anything is stored, so a bad
/// line is a 400. The proposer auto-approves; the quorum comes from the vault. `amount_zat` records
/// the total. Execution (like a payment) is one FROST ceremony per real spend, in /net.
fn handle_create_payroll(state: &HelperState, cfg: &HelperConfig, body: &[u8]) -> Resp {
    #[derive(Deserialize)]
    struct Line {
        #[serde(default)]
        label: String,
        to: String,
        amount_zat: u64,
        memo: Option<String>,
    }
    #[derive(Deserialize)]
    struct Req {
        vault: String,
        proposer: String,
        lines: Vec<Line>,
        #[serde(default)]
        expiry_unix: u64,
    }
    let req: Req = match serde_json::from_slice(body) {
        Ok(r) => r,
        Err(_) => return resp(400, json!({ "error": "invalid json" }).to_string()),
    };
    if req.proposer.trim().is_empty() {
        return resp(400, json!({ "error": "proposer is required" }).to_string());
    }
    if req.lines.is_empty() {
        return resp(400, json!({ "error": "payroll has no lines" }).to_string());
    }
    let reg = match state.get(&req.vault) {
        Some(r) => r,
        None => return resp(404, json!({ "error": "no such vault" }).to_string()),
    };
    // Validate every line (authoritative address + amount) and sum the total, with overflow guard.
    let mut total: u64 = 0;
    let mut lines = Vec::with_capacity(req.lines.len());
    for l in req.lines {
        if let Err(e) = payment_plan(&l.to, l.amount_zat, l.memo.clone(), cfg.network_type()) {
            return resp(400, json!({ "error": e.to_string() }).to_string());
        }
        total = match total.checked_add(l.amount_zat) {
            Some(t) => t,
            None => {
                return resp(
                    400,
                    json!({ "error": "payroll total overflows" }).to_string(),
                )
            }
        };
        lines.push(PayrollLine {
            label: l.label,
            to: l.to,
            amount_zat: l.amount_zat,
            memo: l.memo,
        });
    }
    let now = now_unix();
    let mut p = HelperProposal {
        id: gen_proposal_id(),
        vault_id: reg.vault_id.clone(),
        kind: "payroll".into(),
        to: String::new(),
        amount_zat: total,
        memo: None,
        lines,
        proposer: req.proposer.clone(),
        state: "pending".into(),
        approvals: vec![req.proposer],
        refusals: vec![],
        threshold: reg.threshold,
        total: reg.total,
        created_at_unix: now,
        expiry_unix: req.expiry_unix,
        txid: None,
    };
    p.recompute(now);
    match save_proposal(&cfg.vaults_dir, &p) {
        Ok(()) => resp(200, serde_json::to_string(&p).unwrap_or_default()),
        Err(e) => resp(502, json!({ "error": e.to_string() }).to_string()),
    }
}

/// Record an approve/refuse vote on a proposal. Path: `/api/vault/proposals/{id}/(approve|refuse)`.
/// SECURITY: unauthenticated in this iteration (see `HelperProposal` note) - the money gate is the
/// FROST ceremony, not this vote. A vote on a terminal proposal is a 409.
fn handle_vote(state: &HelperState, cfg: &HelperConfig, path: &str, body: &[u8]) -> Resp {
    let rest = path.trim_start_matches("/api/vault/proposals/");
    let (id, action) = match rest.rsplit_once('/') {
        Some(v) => v,
        None => return resp(404, json!({ "error": "not found" }).to_string()),
    };
    let approve = match action {
        "approve" => true,
        "refuse" => false,
        _ => return resp(404, json!({ "error": "not found" }).to_string()),
    };
    #[derive(Deserialize)]
    struct Req {
        vault: String,
        member: String,
    }
    let req: Req = match serde_json::from_slice(body) {
        Ok(r) => r,
        Err(_) => return resp(400, json!({ "error": "invalid json" }).to_string()),
    };
    if state.get(&req.vault).is_none() {
        return resp(404, json!({ "error": "no such vault" }).to_string());
    }
    let now = now_unix();
    let mut p = match load_proposal(&cfg.vaults_dir, &req.vault, id, now) {
        Some(p) => p,
        None => return resp(404, json!({ "error": "no such proposal" }).to_string()),
    };
    if !p.vote(&req.member, approve, now) {
        return resp(
            409,
            json!({ "error": "proposal is no longer open", "state": p.state }).to_string(),
        );
    }
    match save_proposal(&cfg.vaults_dir, &p) {
        Ok(()) => resp(200, serde_json::to_string(&p).unwrap_or_default()),
        Err(e) => resp(502, json!({ "error": e.to_string() }).to_string()),
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
        // Default to MAINNET: this is a mainnet product, and a testnet default silently mints
        // `utest1…` vault addresses that would lose real funds. A testnet dev deploy sets these.
        lightwalletd: env("KONCLAVE_LIGHTWALLETD", "zec.rocks:443"),
        network: env("KONCLAVE_NETWORK", "main"),
        konclave_signer: PathBuf::from(env("KONCLAVE_SIGNER", "konclave-signer")),
        vaults_dir: PathBuf::from(env("KONCLAVE_VAULTS_DIR", "./helper-vaults")),
    }
}

fn main() {
    let addr = std::env::var("KONCLAVE_HELPER_ADDR").unwrap_or_else(|_| "0.0.0.0:4780".to_string());
    let cfg = Arc::new(config_from_env());
    let state = Arc::new(HelperState::new());
    // Reseed the registry from disk (a restart / redeploy keeps every vault when vaults_dir is on a
    // persistent volume). Only public / view-only material is loaded - never a share.
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

    #[test]
    fn parse_mem_available_reads_the_meminfo_line() {
        let meminfo = "MemTotal:        2048000 kB\nMemFree:          123456 kB\nMemAvailable:     524288 kB\nBuffers:            1000 kB\n";
        assert_eq!(parse_mem_available_mb(meminfo), Some(512)); // 524288 kB / 1024 = 512 MiB
    }

    #[test]
    fn parse_mem_available_none_when_absent_or_garbage() {
        assert_eq!(parse_mem_available_mb("MemFree: 1000 kB\n"), None);
        assert_eq!(parse_mem_available_mb("MemAvailable: not-a-number kB\n"), None);
        assert_eq!(parse_mem_available_mb(""), None);
    }

    #[test]
    fn over_capacity_disabled_by_default() {
        // With MIN_PROVE_MB unset, the guard never blocks (default behavior unchanged).
        std::env::remove_var("MIN_PROVE_MB");
        assert!(!over_capacity());
    }

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
            threshold: 2,
            total: 3,
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

    // A real testnet Orchard-capable unified address (payment_plan accepts it on "test").
    const TESTNET_ORCHARD_UA: &str = "utest1snsykvxrx7csenfxks3g7w865hhkmhxpdkfu3t4wrmes697vac86vw3a3nu3eylqdmp3l9svg65s86tu0djwcdfxa65fkvgz4qpnlqkr";

    fn cfg_at(dir: &std::path::Path) -> HelperConfig {
        let mut c = cfg();
        c.vaults_dir = dir.to_path_buf();
        c
    }

    #[test]
    fn create_proposal_rejects_before_persisting() {
        let st = HelperState::new();
        // bad json
        assert_eq!(
            handle(&st, &cfg(), &Method::Post, "/api/vault/proposals", b"x").status,
            400
        );
        // unknown vault
        let body = format!(
            r#"{{"vault":"zzzz","proposer":"a","to":"{TESTNET_ORCHARD_UA}","amount_zat":1000}}"#
        );
        assert_eq!(
            handle(
                &st,
                &cfg(),
                &Method::Post,
                "/api/vault/proposals",
                body.as_bytes()
            )
            .status,
            404
        );
        // known vault but empty proposer, then bad address (both 400, nothing written)
        seed(&st, "aaaa");
        let no_proposer = br#"{"vault":"aaaa","proposer":"","to":"utest1x","amount_zat":1000}"#;
        assert_eq!(
            handle(
                &st,
                &cfg(),
                &Method::Post,
                "/api/vault/proposals",
                no_proposer
            )
            .status,
            400
        );
        let bad_addr = br#"{"vault":"aaaa","proposer":"alice","to":"garbage","amount_zat":1000}"#;
        assert_eq!(
            handle(&st, &cfg(), &Method::Post, "/api/vault/proposals", bad_addr).status,
            400
        );
    }

    #[test]
    fn proposals_create_list_vote_flow() {
        let dir = std::env::temp_dir().join(format!("konclave-hs-prop-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        let cfg = cfg_at(&dir);
        let st = HelperState::new();
        seed(&st, "aaaa"); // threshold 2 of 3

        // create (proposer alice auto-approves -> 1 of 2 -> pending)
        let body = format!(
            r#"{{"vault":"aaaa","proposer":"alice","to":"{TESTNET_ORCHARD_UA}","amount_zat":1000000}}"#
        );
        let created = handle(
            &st,
            &cfg,
            &Method::Post,
            "/api/vault/proposals",
            body.as_bytes(),
        );
        assert_eq!(created.status, 200);
        assert!(created.body.contains("\"state\":\"pending\""));
        let id = created
            .body
            .split("\"id\":\"")
            .nth(1)
            .unwrap()
            .split('"')
            .next()
            .unwrap()
            .to_string();

        // list shows it
        let listed = handle(
            &st,
            &cfg,
            &Method::Get,
            "/api/vault/proposals?vault=aaaa",
            b"",
        );
        assert_eq!(listed.status, 200);
        assert!(listed.body.contains(&id));

        // bob approves -> 2 of 2 -> ready
        let vote = br#"{"vault":"aaaa","member":"bob"}"#;
        let path = format!("/api/vault/proposals/{id}/approve");
        let voted = handle(&st, &cfg, &Method::Post, &path, vote);
        assert_eq!(voted.status, 200);
        assert!(voted.body.contains("\"state\":\"ready\""));

        // voting on a nonexistent proposal is 404
        let miss = handle(
            &st,
            &cfg,
            &Method::Post,
            "/api/vault/proposals/nope/approve",
            vote,
        );
        assert_eq!(miss.status, 404);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn create_payroll_validates_and_sums() {
        let dir = std::env::temp_dir().join(format!("konclave-hs-payroll-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        let cfg = cfg_at(&dir);
        let st = HelperState::new();
        seed(&st, "aaaa"); // 2 of 3

        // bad json / unknown vault / empty lines / bad line -> all rejected before persisting
        assert_eq!(
            handle(&st, &cfg, &Method::Post, "/api/vault/payroll", b"x").status,
            400
        );
        let unknown = format!(
            r#"{{"vault":"zzz","proposer":"a","lines":[{{"to":"{TESTNET_ORCHARD_UA}","amount_zat":1000}}]}}"#
        );
        assert_eq!(
            handle(
                &st,
                &cfg,
                &Method::Post,
                "/api/vault/payroll",
                unknown.as_bytes()
            )
            .status,
            404
        );
        assert_eq!(
            handle(
                &st,
                &cfg,
                &Method::Post,
                "/api/vault/payroll",
                br#"{"vault":"aaaa","proposer":"a","lines":[]}"#
            )
            .status,
            400
        );
        let bad_line =
            br#"{"vault":"aaaa","proposer":"a","lines":[{"to":"garbage","amount_zat":1000}]}"#;
        assert_eq!(
            handle(&st, &cfg, &Method::Post, "/api/vault/payroll", bad_line).status,
            400
        );

        // valid 2-line payroll: kind=payroll, amount_zat = the sum
        let ok = format!(
            r#"{{"vault":"aaaa","proposer":"alice","lines":[{{"label":"Rent","to":"{TESTNET_ORCHARD_UA}","amount_zat":1000000}},{{"to":"{TESTNET_ORCHARD_UA}","amount_zat":2000000}}]}}"#
        );
        let r = handle(
            &st,
            &cfg,
            &Method::Post,
            "/api/vault/payroll",
            ok.as_bytes(),
        );
        assert_eq!(r.status, 200);
        assert!(r.body.contains("\"kind\":\"payroll\""));
        assert!(r.body.contains("\"amount_zat\":3000000"));
        assert!(r.body.contains("Rent"));
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn proposal_send_rejects_before_engine() {
        let dir = std::env::temp_dir().join(format!("konclave-hs-psend-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        let cfg = cfg_at(&dir);
        let st = HelperState::new();
        seed(&st, "aaaa"); // 2 of 3

        // unknown vault -> 404
        let body = br#"{"vault":"zzzz","relay_base":"http://x","room":"r"}"#;
        assert_eq!(
            handle(
                &st,
                &cfg,
                &Method::Post,
                "/api/vault/proposals/x/send",
                body
            )
            .status,
            404
        );
        // unknown proposal -> 404
        let body2 = br#"{"vault":"aaaa","relay_base":"http://x","room":"r"}"#;
        assert_eq!(
            handle(
                &st,
                &cfg,
                &Method::Post,
                "/api/vault/proposals/nope/send",
                body2
            )
            .status,
            404
        );
        // a pending (not-ready) proposal -> 409, never reaching the engine
        let create = format!(
            r#"{{"vault":"aaaa","proposer":"alice","to":"{TESTNET_ORCHARD_UA}","amount_zat":1000000}}"#
        );
        let created = handle(
            &st,
            &cfg,
            &Method::Post,
            "/api/vault/proposals",
            create.as_bytes(),
        );
        let id = created
            .body
            .split("\"id\":\"")
            .nth(1)
            .unwrap()
            .split('"')
            .next()
            .unwrap();
        let send_path = format!("/api/vault/proposals/{id}/send");
        let r = handle(&st, &cfg, &Method::Post, &send_path, body2);
        assert_eq!(r.status, 409);
        assert!(r.body.contains("not ready"));
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn members_set_and_get() {
        let dir = std::env::temp_dir().join(format!("konclave-hs-members-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        let cfg = cfg_at(&dir);
        let st = HelperState::new();
        seed(&st, "aaaa");
        // unknown vault -> 404 on both
        assert_eq!(
            handle(&st, &cfg, &Method::Get, "/api/vault/members?vault=zzz", b"").status,
            404
        );
        let bad = br#"{"vault":"zzz","names":["Alice"]}"#;
        assert_eq!(
            handle(&st, &cfg, &Method::Post, "/api/vault/members", bad).status,
            404
        );
        // empty by default
        let empty = handle(
            &st,
            &cfg,
            &Method::Get,
            "/api/vault/members?vault=aaaa",
            b"",
        );
        assert!(empty.body.contains("\"members\":[]"));
        // set then get
        let set = br#"{"vault":"aaaa","names":["Alice","Bob","Carol"]}"#;
        assert_eq!(
            handle(&st, &cfg, &Method::Post, "/api/vault/members", set).status,
            200
        );
        let got = handle(
            &st,
            &cfg,
            &Method::Get,
            "/api/vault/members?vault=aaaa",
            b"",
        );
        assert!(got.body.contains("Alice") && got.body.contains("Carol"));
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn ledger_lists_only_sent_and_csv() {
        let dir = std::env::temp_dir().join(format!("konclave-hs-ledger-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        let cfg = cfg_at(&dir);
        let st = HelperState::new();
        seed(&st, "aaaa");
        // unknown vault -> 404 on both
        assert_eq!(
            handle(&st, &cfg, &Method::Get, "/api/vault/ledger?vault=zzz", b"").status,
            404
        );
        assert_eq!(
            handle(
                &st,
                &cfg,
                &Method::Get,
                "/api/vault/ledger.csv?vault=zzz",
                b""
            )
            .status,
            404
        );
        // a sent proposal (governed payment) + a non-sent one that must NOT appear
        let sent = HelperProposal {
            id: "s1".into(),
            vault_id: "aaaa".into(),
            kind: "payment".into(),
            to: "utest1x".into(),
            amount_zat: 5000,
            memo: Some("hi".into()),
            lines: vec![],
            proposer: "alice".into(),
            state: "sent".into(),
            approvals: vec!["alice".into(), "bob".into()],
            refusals: vec![],
            threshold: 2,
            total: 3,
            created_at_unix: 100,
            expiry_unix: 0,
            txid: Some("abc123txid".into()),
        };
        save_proposal(&cfg.vaults_dir, &sent).unwrap();
        let mut pending = sent.clone();
        pending.id = "pend".into();
        pending.state = "pending".into();
        pending.approvals = vec!["alice".into()];
        pending.txid = None;
        save_proposal(&cfg.vaults_dir, &pending).unwrap();

        let led = handle(&st, &cfg, &Method::Get, "/api/vault/ledger?vault=aaaa", b"");
        assert_eq!(led.status, 200);
        assert!(led.body.contains("abc123txid"));
        assert!(!led.body.contains("\"id\":\"pend\""));
        let csv = handle(
            &st,
            &cfg,
            &Method::Get,
            "/api/vault/ledger.csv?vault=aaaa",
            b"",
        );
        assert_eq!(csv.status, 200);
        assert!(csv.body.starts_with("created_at_unix,amount_zat"));
        assert!(csv.body.contains("abc123txid"));
        let _ = std::fs::remove_dir_all(&dir);
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
