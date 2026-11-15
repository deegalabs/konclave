#![cfg(all(feature = "client", feature = "server"))]

use konclave_ohttp::{
    encapsulate_response, generate_key_config, open_response, padding, seal_request, ClientConfig,
    ClientError, Gateway, InnerRequest, Refusal, ReplaySet, WINDOW_SECS,
};

const NOW: i64 = 1_800_000_000;

fn setup() -> (Gateway, ClientConfig) {
    let g = Gateway::new(generate_key_config(7).unwrap(), NOW - 1000).unwrap();
    let c = ClientConfig::parse(&g.config_list().unwrap()).unwrap();
    (g, c)
}

fn req(path: &str) -> InnerRequest {
    InnerRequest {
        method: "GET".into(),
        path: path.into(),
        content_type: String::new(),
        read_key: Some("readkey123".into()),
        body: Vec::new(),
        date_unix: NOW,
    }
}

#[test]
fn round_trip() {
    let (g, c) = setup();
    let mut r = req("/api/vault/balance?vault=abc");
    r.content_type = "application/json".into();
    r.body = b"{\"x\":1}".to_vec();
    let (wire, cctx) = seal_request(&c, r.clone()).unwrap();
    let (got, sctx) = g.decapsulate(&wire, NOW).unwrap();
    assert_eq!(got, r);
    let resp = encapsulate_response(sctx, 200, "application/json", b"{\"balance\":0}").unwrap();
    let (status, ct, body) = open_response(cctx, &resp).unwrap();
    assert_eq!(
        (status, ct.as_str(), body.as_slice()),
        (200, "application/json", &b"{\"balance\":0}"[..])
    );
}

#[test]
fn truncated_request_and_response_fail() {
    let (g, c) = setup();
    let (wire, cctx) = seal_request(&c, req("/api/health")).unwrap();
    for n in [0usize, 1, 7, 39, 55, 56, wire.len() - 1, wire.len() / 2] {
        assert!(g.decapsulate(&wire[..n], NOW).is_err(), "len {n}");
    }
    let (_, sctx) = g.decapsulate(&wire, NOW).unwrap();
    let resp = encapsulate_response(sctx, 200, "text/plain", b"ok").unwrap();
    for n in [0usize, 1, 16, 31, 32, 33, resp.len() - 1, resp.len() / 2] {
        let (w, c2) = seal_request(&c, req("/api/health")).unwrap();
        let _ = w;
        assert!(open_response(c2, &resp[..n]).is_err(), "len {n}");
    }
    assert!(open_response(cctx, &resp[..resp.len() - 1]).is_err());
}

#[test]
fn a_replay_is_refused_the_second_time() {
    let (g, c) = setup();
    let (wire, _) = seal_request(&c, req("/api/health")).unwrap();
    assert!(g.decapsulate(&wire, NOW).is_ok());
    assert!(matches!(g.decapsulate(&wire, NOW), Err(Refusal::Replay)));
    assert!(matches!(
        g.decapsulate(&wire, NOW + 5),
        Err(Refusal::Replay)
    ));
}

#[test]
fn stale_and_future_dates_are_refused() {
    let (g, c) = setup();
    for (date, ok) in [
        (NOW - WINDOW_SECS, true),
        (NOW - WINDOW_SECS - 1, false),
        (NOW + WINDOW_SECS, true),
        (NOW + WINDOW_SECS + 1, false),
    ] {
        let mut r = req("/api/health");
        r.date_unix = date;
        let (wire, _) = seal_request(&c, r).unwrap();
        let got = g.decapsulate(&wire, NOW);
        assert_eq!(got.is_ok(), ok, "date offset {}", date - NOW);
        if !ok {
            let want = if date < NOW {
                Refusal::StaleDate
            } else {
                Refusal::FutureDate
            };
            assert_eq!(got.err().unwrap(), want);
        }
    }
}

#[test]
fn a_date_before_the_boot_floor_is_refused() {
    let g = Gateway::new(generate_key_config(7).unwrap(), NOW - 10).unwrap();
    let c = ClientConfig::parse(&g.config_list().unwrap()).unwrap();
    let mut r = req("/api/health");
    r.date_unix = NOW - 11;
    let (wire, _) = seal_request(&c, r).unwrap();
    assert!(matches!(g.decapsulate(&wire, NOW), Err(Refusal::StaleDate)));
}

#[test]
fn an_unknown_key_id_is_refused_with_the_typed_error() {
    let (g, _) = setup();
    let other = Gateway::new(generate_key_config(8).unwrap(), NOW - 1000).unwrap();
    let c2 = ClientConfig::parse(&other.config_list().unwrap()).unwrap();
    assert_eq!(c2.key_id(), 8);
    let (wire, _) = seal_request(&c2, req("/api/health")).unwrap();
    assert!(matches!(
        g.decapsulate(&wire, NOW),
        Err(Refusal::UnknownKeyId(8))
    ));
}

/// The route rule is not this crate's: a request for a route that is not oblivious still opens,
/// and `konclave_http::route_is_oblivious` is what refuses it (the dispatch applies it).
#[test]
fn the_crate_does_not_judge_routes_the_http_crate_does() {
    let (g, c) = setup();
    for (m, p) in [("POST", "/api/vault/send"), ("GET", "/api/vault/ufvk")] {
        let mut r = req(p);
        r.method = m.into();
        let (wire, _) = seal_request(&c, r).unwrap();
        let (inner, _) = g.decapsulate(&wire, NOW).unwrap();
        assert!(!konclave_http::route_is_oblivious(
            &inner.method,
            &inner.path
        ));
    }
    for (m, p) in konclave_http::OBLIVIOUS_ROUTES {
        let mut r = req(&format!("{p}?vault=x"));
        r.method = (*m).into();
        let (wire, _) = seal_request(&c, r).unwrap();
        let (inner, _) = g.decapsulate(&wire, NOW).unwrap();
        assert!(konclave_http::route_is_oblivious(
            &inner.method,
            &inner.path
        ));
    }
}

#[test]
fn the_replay_set_refuses_when_full_and_does_not_evict() {
    let mut s = ReplaySet::new(3);
    for i in 0..3u8 {
        s.insert([i; 32], NOW, NOW + 300).unwrap();
    }
    assert_eq!(
        s.insert([9; 32], NOW, NOW + 300),
        Err(Refusal::ReplaySetFull)
    );
    assert_eq!(s.len(), 3);
    // the oldest entry is still there: it is a replay, not a fresh entry
    assert_eq!(s.insert([0; 32], NOW, NOW + 300), Err(Refusal::Replay));
    // entries expire, and only then is there room
    assert!(s.insert([9; 32], NOW + 301, NOW + 600).is_ok());
    assert_eq!(s.len(), 1);
}

#[test]
fn a_full_gateway_refuses_new_requests_and_keeps_old_ones_blocked() {
    let g = Gateway::with_capacity(generate_key_config(7).unwrap(), NOW - 1000, 2).unwrap();
    let c = ClientConfig::parse(&g.config_list().unwrap()).unwrap();
    let wires: Vec<_> = (0..3)
        .map(|_| seal_request(&c, req("/api/health")).unwrap().0)
        .collect();
    assert!(g.decapsulate(&wires[0], NOW).is_ok());
    assert!(g.decapsulate(&wires[1], NOW).is_ok());
    assert!(matches!(
        g.decapsulate(&wires[2], NOW),
        Err(Refusal::ReplaySetFull)
    ));
    assert!(matches!(
        g.decapsulate(&wires[0], NOW),
        Err(Refusal::Replay)
    ));
}

#[test]
fn garbage_does_not_fill_the_replay_set() {
    let g = Gateway::with_capacity(generate_key_config(7).unwrap(), NOW - 1000, 1).unwrap();
    let c = ClientConfig::parse(&g.config_list().unwrap()).unwrap();
    for i in 0..5 {
        let (mut wire, _) = seal_request(&c, req("/api/health")).unwrap();
        wire[100 + i] ^= 1;
        assert!(g.decapsulate(&wire, NOW).is_err());
        // A request for a route the dispatch will refuse DOES take a slot now: the route rule is
        // konclave-http's and is applied after this crate has opened the request. The dispatch
        // charges the oblivious budget for it, which is what bounds how many such slots exist.
    }
    let (wire, _) = seal_request(&c, req("/api/health")).unwrap();
    assert!(g.decapsulate(&wire, NOW).is_ok());
}

#[test]
fn padded_sizes_land_exactly_on_buckets() {
    let (g, c) = setup();
    let want = |len: usize| padding::request_bucket(len).unwrap();
    for body_len in [
        0usize, 1, 100, 3000, 4000, 4096, 10_000, 20_000, 70_000, 200_000, 1_500_000,
    ] {
        let mut r = req("/api/health");
        r.method = "GET".into();
        r.body = vec![7; body_len];
        let (wire, _) = seal_request(&c, r).unwrap();
        assert!(
            padding::REQUEST_BUCKETS.contains(&wire.len()),
            "{body_len}: {}",
            wire.len()
        );
        assert_eq!(wire.len(), want(body_len + 100), "{body_len}");
    }
    assert_eq!(padding::REQUEST_BUCKETS[0], 4096);
    assert_eq!(
        padding::REQUEST_BUCKETS,
        [4096, 16384, 32768, 65536, 131_072, 262_144, 524_288, 1_048_576, 2_097_152]
    );
    // a request over 2 MiB (what the helper reads) is not built
    let mut r = req("/api/health");
    r.body = vec![0; 2 * 1024 * 1024];
    assert!(matches!(
        seal_request(&c, r),
        Err(ClientError::BadRequest(_))
    ));
    // responses: powers of two from 1 KiB
    for (body_len, size) in [
        (0usize, 1024usize),
        (900, 1024),
        (1000, 2048),
        (4000, 4096),
        (5000, 8192),
        (100_000, 131_072),
    ] {
        let (wire, _) = seal_request(&c, req("/api/health")).unwrap();
        let (_, sctx) = g.decapsulate(&wire, NOW).unwrap();
        let resp = encapsulate_response(sctx, 200, "", &vec![1; body_len]).unwrap();
        assert_eq!(resp.len(), size, "body {body_len}");
    }
}

#[test]
fn the_response_status_is_returned_only_after_it_authenticates() {
    let (g, c) = setup();
    let (wire, cctx) = seal_request(&c, req("/api/health")).unwrap();
    let (_, sctx) = g.decapsulate(&wire, NOW).unwrap();
    let mut resp = encapsulate_response(sctx, 503, "text/plain", b"down").unwrap();
    resp[40] ^= 1;
    // the Result carries no field at all on failure: the type admits only Err(ClientError)
    let got = open_response(cctx, &resp);
    assert_eq!(got, Err(ClientError::NotAuthentic));
}

#[test]
fn a_response_that_is_not_a_padded_size_is_refused() {
    let (_, c) = setup();
    let (_, cctx) = seal_request(&c, req("/api/health")).unwrap();
    assert!(matches!(
        open_response(cctx, &[0u8; 1000]),
        Err(ClientError::BadResponse(_))
    ));
}

#[test]
fn a_request_that_is_not_a_padded_size_is_refused() {
    let (g, c) = setup();
    let (mut wire, _) = seal_request(&c, req("/api/health")).unwrap();
    wire.push(0);
    assert!(matches!(g.decapsulate(&wire, NOW), Err(Refusal::NotPadded)));
}

#[test]
fn the_client_refuses_a_config_list_of_several_keys() {
    let a = Gateway::new(generate_key_config(1).unwrap(), 0)
        .unwrap()
        .config_list()
        .unwrap();
    let b = Gateway::new(generate_key_config(2).unwrap(), 0)
        .unwrap()
        .config_list()
        .unwrap();
    let both = [a, b].concat();
    assert!(matches!(
        ClientConfig::parse(&both),
        Err(ClientError::BadConfig)
    ));
    assert!(matches!(
        ClientConfig::parse(&[]),
        Err(ClientError::BadConfig)
    ));
}
