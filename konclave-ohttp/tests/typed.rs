#![cfg(all(feature = "client", feature = "server"))]
//! A request that opened is refused WITH the means to answer it, and the gateway key is a file key,
//! not a boot one.

use konclave_ohttp::{
    encapsulate_response, key_config_from_text_for_tests as key_config_from_text, open_response,
    seal_request, ClientConfig, Gateway, InnerRequest, Refusal,
};

const NOW: i64 = 1_800_000_000;
/// Built from the one list of known test keys; never written out here.
fn key() -> String {
    konclave_ohttp::test_key_text(0, 7)
}

fn gateway(floor: i64) -> (Gateway, ClientConfig) {
    let g = Gateway::new(key_config_from_text(&key()).unwrap(), floor).unwrap();
    let c = ClientConfig::parse(&g.config_list().unwrap()).unwrap();
    (g, c)
}

fn inner(date: i64) -> InnerRequest {
    InnerRequest {
        method: "GET".into(),
        path: "/api/health".into(),
        content_type: String::new(),
        read_key: None,
        body: Vec::new(),
        date_unix: date,
    }
}

#[test]
fn the_key_is_the_files_every_time() {
    let a = gateway(NOW).0.config_list().unwrap();
    let b = gateway(NOW).0.config_list().unwrap();
    assert_eq!(a, b, "a restart with the same file is the same key");
    assert_eq!(gateway(NOW).0.key_id(), 7);
}

#[test]
fn a_bad_key_file_is_refused() {
    for bad in [
        "",
        "7",
        "7 00",
        "x 000102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f",
        "256 000102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f",
        "7 zz02030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f00",
        "7 000102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f 8",
        "7 0000000000000000000000000000000000000000000000000000000000000000",
    ] {
        assert!(key_config_from_text(bad).is_err(), "accepted {bad:?}");
    }
    // A trailing newline is a file's, not a mistake.
    assert!(key_config_from_text(&format!("{}\n", key())).is_ok());
}

#[test]
fn a_stale_request_is_refused_with_a_context_that_can_answer() {
    let (g, c) = gateway(NOW - 10_000);
    let (wire, cctx) = seal_request(&c, inner(NOW - 400)).unwrap();
    let rejected = g.open(&wire, NOW).unwrap_err();
    assert_eq!(rejected.refusal, Refusal::StaleDate);
    let ctx = rejected.ctx.expect("a request that opened can be answered");
    let sealed = encapsulate_response(ctx, 400, "application/problem+json", b"{}").unwrap();
    let (status, ct, _) = open_response(cctx, &sealed).unwrap();
    assert_eq!((status, ct.as_str()), (400, "application/problem+json"));
}

#[test]
fn future_replay_and_full_carry_a_context_and_garbage_does_not() {
    let (g, c) = gateway(NOW - 10_000);
    let (wire, _c) = seal_request(&c, inner(NOW + 400)).unwrap();
    let r = g.open(&wire, NOW).unwrap_err();
    assert_eq!((r.refusal, r.ctx.is_some()), (Refusal::FutureDate, true));

    let (wire, _c) = seal_request(&c, inner(NOW)).unwrap();
    g.open(&wire, NOW).unwrap();
    let r = g.open(&wire, NOW).unwrap_err();
    assert_eq!((r.refusal, r.ctx.is_some()), (Refusal::Replay, true));

    let r = g.open(&[1, 2, 3], NOW).unwrap_err();
    assert!(r.ctx.is_none(), "nothing opened, nothing to answer with");
    let mut tampered = seal_request(&c, inner(NOW)).unwrap().0;
    let n = tampered.len() - 1;
    tampered[n] ^= 1;
    let r = g.open(&tampered, NOW).unwrap_err();
    assert_eq!((r.refusal, r.ctx.is_none()), (Refusal::Undecryptable, true));
}

#[test]
fn an_unknown_key_id_is_distinct_and_has_no_context() {
    let (g, _c) = gateway(NOW);
    let other = Gateway::new(
        key_config_from_text(&key().replacen('7', "9", 1)).unwrap(),
        NOW,
    )
    .unwrap();
    let oc = ClientConfig::parse(&other.config_list().unwrap()).unwrap();
    let (wire, _) = seal_request(&oc, inner(NOW)).unwrap();
    let r = g.open(&wire, NOW).unwrap_err();
    assert_eq!(
        (r.refusal, r.ctx.is_none()),
        (Refusal::UnknownKeyId(9), true)
    );
}
