//! In-process console simulation of Konclave's core use cases.
//!
//! Drives the **real** request handlers (`server::handle`) against a throwaway SQLite DB
//! and prints a readable trace of each use case — no HTTP server, no network, no FROST
//! engine binaries. It runs anywhere `cargo` does and doubles as living documentation of
//! the propose → approve → account flow.
//!
//!   cargo run -p orchestrator --example simulate
//!
//! Covered: list the vault · authoritative address safety (M2) · propose a payment ·
//! approve to quorum (Awaiting → Ready) · refuse path · accounting ledger + itemized CSV.
//! The signing/broadcast step needs the FROST engine (`--ceremony`) and is out of scope
//! here — it is printed as an honest note, not faked.

use orchestrator::address::validate_recipient;
use orchestrator::proposal::Quorum;
use orchestrator::server::{self, Config, SLICE_ADDRESS};
use orchestrator::store::{Member, Store, VaultRecord};

/// A real mainnet Sapling address — an Orchard vault cannot pay it (funds would lock, §8).
const SAPLING_ADDR: &str =
    "zs1qqqqqqqqqqqqqqqqqqcguyvaw2vjk4sdyeg0lc970u659lvhqq7t0np6hlup5lusxle75c8v35z";

fn main() {
    println!("\n╔══════════════════════════════════════════════════════════════╗");
    println!("║  Konclave — in-process simulation of the core use cases        ║");
    println!("║  (real handlers, throwaway DB, no server / no engine)          ║");
    println!("╚══════════════════════════════════════════════════════════════╝");

    let db = std::env::temp_dir().join(format!("konclave-sim-{}.db", std::process::id()));
    let db_path = db.to_string_lossy().into_owned();
    let _ = std::fs::remove_file(&db);
    seed_clean_vault(&db_path);

    // Demo mode: no live wallet, no ceremony (the flow that needs neither).
    let cfg = Config::new(std::env::temp_dir(), db_path.clone(), None, None);

    list_vault(&cfg);
    address_safety();
    let ready_id = propose_and_approve(&cfg);
    refuse_path(&cfg);
    payroll_path(&cfg);
    accounting(&cfg);
    signing_note(ready_id);

    let _ = std::fs::remove_file(&db);
    println!("\n✓ simulation complete — every step above ran through the real core.\n");
}

/// Seed a clean 2-of-3 vault (no example proposals) so the trace shows only what we do.
fn seed_clean_vault(db_path: &str) {
    let mut store = Store::open(db_path).expect("open db");
    store
        .save_vault(&VaultRecord {
            id: "vault-sim".into(),
            name: "Tesouraria Comum".into(),
            quorum: Quorum::new(2, 3).unwrap(),
            group_pubkey: "sim-group".into(),
            orchard_address: SLICE_ADDRESS.into(),
            ufvk: String::new(),
            server_url: None,
        })
        .expect("save vault");
    store
        .save_vault_members(
            "vault-sim",
            &[
                Member {
                    name: "Alice".into(),
                    pubkey: "alice-pk".into(),
                },
                Member {
                    name: "Bob".into(),
                    pubkey: "bob-pk".into(),
                },
                Member {
                    name: "Carol".into(),
                    pubkey: "carol-pk".into(),
                },
            ],
        )
        .expect("save members");
}

fn section(title: &str) {
    println!("\n── {title} ──────────────────────────────────────────");
}

/// Call a real handler and print a one-line trace; return the parsed JSON body.
fn call(cfg: &Config, method: &str, path: &str, body: &str) -> serde_json::Value {
    let resp = server::handle(cfg, method, path, body.as_bytes());
    println!("   {method:5} {path}  →  {}", resp.status);
    serde_json::from_slice(&resp.body).unwrap_or(serde_json::json!({}))
}

fn list_vault(cfg: &Config) {
    section("The vault");
    let vaults = call(cfg, "GET", "/api/vaults", "");
    if let Some(v) = vaults["vaults"].as_array().and_then(|a| a.first()) {
        println!(
            "   → “{}”  ·  quorum {}-of-{}  ·  members: {}",
            v["name"].as_str().unwrap_or("?"),
            v["threshold"],
            v["total"],
            v["member_list"]
                .as_array()
                .map(|ms| ms
                    .iter()
                    .filter_map(|m| m["name"].as_str())
                    .collect::<Vec<_>>()
                    .join(", "))
                .unwrap_or_default()
        );
    }
}

/// Use case: authoritative address validation (M2) — the fund-lock guard, in console.
fn address_safety() {
    section("Address safety (M2 — the fund-lock guard)");
    for (label, addr) in [
        ("real Orchard UA", SLICE_ADDRESS),
        ("mainnet Sapling", SAPLING_ADDR),
        ("looks-valid junk", "u1recipientxxxxxxxxxxxxxxxxxxxxxxxx"),
    ] {
        match validate_recipient(addr) {
            Ok(r) if r.is_payable() => {
                println!(
                    "   {label:18} → payable{}",
                    if r.is_public() {
                        " (PUBLIC)"
                    } else {
                        " (shielded)"
                    }
                )
            }
            Ok(_) => {
                println!("   {label:18} → REFUSED: not payable from an Orchard vault (would lock)")
            }
            Err(e) => println!("   {label:18} → REFUSED: {e}"),
        }
    }
}

/// Use case: propose a payment, then approve until the quorum is met (Awaiting → Ready).
fn propose_and_approve(cfg: &Config) -> String {
    section("Use case 1 — propose a payment, approve to quorum");
    let body = format!(
        r#"{{"proposer":"Alice","to_address":"{SLICE_ADDRESS}","value_zec":"0.0005","memo":"reembolso maio"}}"#
    );
    let created = call(cfg, "POST", "/api/proposals", &body);
    let id = created["id"].as_str().unwrap_or_default().to_string();
    println!(
        "   → proposed by Alice: {} ZEC  ·  state = {}  ·  approvals = {} (quorum is 2-of-3)",
        created["value_zec"].as_str().unwrap_or("?"),
        created["state"].as_str().unwrap_or("?"),
        created["approvals_count"],
    );

    let approved = call(
        cfg,
        "POST",
        &format!("/api/proposals/{id}/approve"),
        r#"{"member":"Bob"}"#,
    );
    let p = &approved["proposal"];
    println!(
        "   → Bob approves  ·  state = {}  ·  approvals {}",
        p["state"].as_str().unwrap_or("?"),
        p["approvals_count"],
    );
    println!("   ✓ quorum reached: the payment is READY to sign.");
    id
}

/// Use case: a refusal on a fresh proposal, showing the state machine reacts.
fn refuse_path(cfg: &Config) {
    section("Use case 2 — a member refuses");
    let body = format!(
        r#"{{"proposer":"Alice","to_address":"{SLICE_ADDRESS}","value_zec":"0.0003","memo":"material"}}"#
    );
    let created = call(cfg, "POST", "/api/proposals", &body);
    let id = created["id"].as_str().unwrap_or_default().to_string();
    let refused = call(
        cfg,
        "POST",
        &format!("/api/proposals/{id}/refuse"),
        r#"{"member":"Bob"}"#,
    );
    println!(
        "   → Bob refuses  ·  state = {}",
        refused["proposal"]["state"].as_str().unwrap_or("?"),
    );
}

/// Use case: private payroll — one Orchard transaction paying N beneficiaries, approved once.
fn payroll_path(cfg: &Config) {
    section("Use case 3 — private payroll (N beneficiaries, one envelope)");
    let body = format!(
        r#"{{"proposer":"Alice","description":"Folha · maio/2026","lines":[
            {{"label":"Infra","address":"{SLICE_ADDRESS}","value_zec":"0.0002","memo":"servidores"}},
            {{"label":"Design","address":"{SLICE_ADDRESS}","value_zec":"0.0001","memo":""}}
        ]}}"#
    );
    let created = call(cfg, "POST", "/api/payroll", &body);
    let id = created["proposal"]["id"]
        .as_str()
        .unwrap_or_default()
        .to_string();
    println!(
        "   → payroll proposed by Alice: 2 beneficiaries  ·  state = {}",
        created["proposal"]["state"].as_str().unwrap_or("?"),
    );
    let approved = call(
        cfg,
        "POST",
        &format!("/api/proposals/{id}/approve"),
        r#"{"member":"Carol"}"#,
    );
    println!(
        "   → Carol approves  ·  state = {}",
        approved["proposal"]["state"].as_str().unwrap_or("?"),
    );
    println!("   ✓ one shielded transaction, N outputs — itemized as N ledger rows below.");
}

/// Use case: the accounting trail — JSON ledger + itemized CSV export.
fn accounting(cfg: &Config) {
    section("Accounting — ledger + itemized CSV");
    let ledger = call(cfg, "GET", "/api/ledger", "");
    let n = ledger["ledger"].as_array().map(|a| a.len()).unwrap_or(0);
    println!(
        "   → ledger holds {n} entr{}",
        if n == 1 { "y" } else { "ies" }
    );

    let resp = server::handle(cfg, "GET", "/api/ledger.csv", b"");
    println!("   GET   /api/ledger.csv  →  {}", resp.status);
    let csv = String::from_utf8_lossy(&resp.body);
    for line in csv.lines().take(4) {
        println!("     | {line}");
    }
}

fn signing_note(ready_id: String) {
    section("Signing & broadcast (engine-gated)");
    println!("   Proposal {ready_id} is READY. Signing runs a live FROST ceremony via the");
    println!("   official binaries (frostd · konclave-signer · zcash-devtool) and needs the");
    println!("   engine built + `konclave serve --ceremony`. It is intentionally NOT faked here.");
}
