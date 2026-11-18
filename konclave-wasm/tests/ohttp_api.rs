#![cfg(feature = "ohttp")]
//! The browser-facing OHTTP API (`konclave_wasm::ohttp_api`), driven natively against the real
//! gateway half of `konclave-ohttp`. The wasm-bindgen wrappers are one-line calls into these.

use konclave_ohttp::{encapsulate_response, generate_key_config, Gateway};
use konclave_wasm::ohttp_api::{self, OhttpError};

const NOW: i64 = 1_800_000_000;

fn gateway() -> (Gateway, Vec<u8>) {
    let g = Gateway::new(generate_key_config(9).unwrap(), NOW - 1000).unwrap();
    let list = g.config_list().unwrap();
    (g, list)
}

#[test]
fn key_id_is_read_from_the_served_config() {
    let (_g, list) = gateway();
    assert_eq!(ohttp_api::key_id(&list).unwrap(), 9);
}

#[test]
fn a_bad_config_is_a_typed_error() {
    assert_eq!(
        ohttp_api::key_id(&[1, 2, 3]).unwrap_err(),
        OhttpError::BadConfig
    );
    assert_eq!(ohttp_api::key_id(&[]).unwrap_err(), OhttpError::BadConfig);
}

#[test]
fn seal_then_open_returns_status_and_body() {
    let (g, list) = gateway();
    let (wire, ctx) = ohttp_api::seal(
        &list,
        "GET",
        "/api/vault/balance?vault=abc",
        Some("rk".into()),
        "",
        &[],
        NOW,
    )
    .unwrap();
    let (inner, sctx) = g.decapsulate(&wire, NOW).unwrap();
    assert_eq!(inner.path, "/api/vault/balance?vault=abc");
    assert_eq!(inner.read_key.as_deref(), Some("rk"));
    let resp = encapsulate_response(sctx, 200, "application/json", b"{\"b\":0}").unwrap();
    let a = ctx.open(&resp).unwrap();
    assert_eq!(
        (a.status, a.content_type.as_str(), a.body.as_slice()),
        (200, "application/json", &b"{\"b\":0}"[..])
    );
}

#[test]
fn a_tampered_answer_is_refused_and_yields_nothing() {
    let (g, list) = gateway();
    let (wire, ctx) = ohttp_api::seal(&list, "GET", "/api/health", None, "", &[], NOW).unwrap();
    let (_i, sctx) = g.decapsulate(&wire, NOW).unwrap();
    let mut resp = encapsulate_response(sctx, 200, "application/json", b"{}").unwrap();
    let n = resp.len() - 1;
    resp[n] ^= 1;
    assert_eq!(ctx.open(&resp).unwrap_err(), OhttpError::NotAuthentic);
}

#[test]
fn the_context_is_single_use() {
    let (g, list) = gateway();
    let (wire, ctx) = ohttp_api::seal(&list, "GET", "/api/health", None, "", &[], NOW).unwrap();
    let (_i, sctx) = g.decapsulate(&wire, NOW).unwrap();
    let resp = encapsulate_response(sctx, 200, "application/json", b"{}").unwrap();
    assert!(ctx.open(&resp).is_ok());
    assert_eq!(ctx.open(&resp).unwrap_err(), OhttpError::ContextUsed);
}

/// This crate reaches Oblivious HTTP only through `konclave-ohttp`'s client half, so the BHTTP
/// mapping exists once. Checked on the resolved tree (what is really linked), not the manifest text.
#[test]
fn wasm_links_only_the_client_half() {
    let cargo = std::env::var("CARGO").unwrap_or_else(|_| "cargo".into());
    let out = std::process::Command::new(cargo)
        .args([
            "tree",
            "-p",
            "konclave-wasm",
            "--features",
            "ohttp",
            "-e",
            "normal",
            "--depth",
            "1",
            "-f",
            "{p} [{f}]",
        ])
        .current_dir(env!("CARGO_MANIFEST_DIR"))
        .output()
        .expect("cargo tree");
    let tree = String::from_utf8(out.stdout).unwrap();
    // The first word after the tree glyphs is the crate name; `konclave-ohttp` is not `ohttp`.
    let direct: Vec<&str> = tree
        .lines()
        .filter_map(|l| l.split("── ").nth(1)?.split_whitespace().next())
        .collect();
    for banned in ["ohttp", "bhttp", "hpke"] {
        assert!(
            !direct.contains(&banned),
            "{banned} is a direct dependency:\n{tree}"
        );
    }
    let line = tree
        .lines()
        .find(|l| l.contains("konclave-ohttp v"))
        .unwrap_or_else(|| panic!("konclave-ohttp is not linked:\n{tree}"));
    assert!(
        line.ends_with("[client]"),
        "features must be exactly client: {line}"
    );
}
