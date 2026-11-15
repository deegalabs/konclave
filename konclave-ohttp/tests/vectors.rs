#![cfg(all(feature = "client", feature = "server"))]
//! Fixed bytes. Every other test in this crate seals and opens with the same code, so a mapping
//! that is wrong the same way on both sides would pass them all. These pin the bytes themselves:
//! a known key file, a known BHTTP message written out here by hand (RFC 9292 section 3, known
//! length), and a recorded encapsulated request, checked against the raw `ohttp` crate and not
//! against our own seal. A PWA installed with an old wasm talks to a new gateway: this is the
//! contract between them.

use konclave_ohttp::{
    encapsulate_response, key_config_from_text_for_tests as key_config_from_text, open_response,
    padding, seal_request, ClientConfig, Gateway, InnerRequest,
};

/// Built from the one list of known test keys; never written out here.
fn key() -> String {
    konclave_ohttp::test_key_text(0, 7)
}
/// The configuration list that key file serves: length 0x0029, key id 7, KEM 0x0020 (X25519), the
/// derived public key, then one suite (HKDF-SHA256 0x0001, AES-128-GCM 0x0001).
const CONFIG_HEX: &str =
    "0029070020b1f1b840de7a3241b02748cf9b05b74dc8c5e8451298738817bd76aa8ebe8c2b000400010001";
/// A request sealed to that key once, 4096 bytes on the wire (hex).
const REQUEST_HEX: &str = include_str!("vectors/request.hex");
const DATE: i64 = 1_800_000_000;

fn hex(s: &str) -> Vec<u8> {
    (0..s.len() / 2)
        .map(|i| u8::from_str_radix(&s[2 * i..2 * i + 2], 16).unwrap())
        .collect()
}

/// A length-prefixed string. The length is an RFC 9000 varint: one byte under 64, else two.
fn lv(b: &[u8]) -> Vec<u8> {
    let n = b.len();
    let mut v = if n < 64 {
        vec![u8::try_from(n).unwrap()]
    } else {
        assert!(n < 16384);
        vec![
            0x40 | u8::try_from(n >> 8).unwrap(),
            u8::try_from(n & 0xff).unwrap(),
        ]
    };
    v.extend_from_slice(b);
    v
}

/// The BHTTP the recorded request must contain, written out by hand: framing 0 (known-length
/// request), control data (method, scheme, authority, path), the header section, the content.
fn expected_request_plain() -> Vec<u8> {
    let mut m = vec![0u8];
    for part in [
        &b"GET"[..],
        b"https",
        b"konclave",
        b"/api/vault/balance?vault=ab12",
    ] {
        m.extend(lv(part));
    }
    let mut fields = Vec::new();
    for (n, v) in [
        (&b"content-type"[..], &b"application/json"[..]),
        (b"x-konclave-read", b"rk-0123"),
        (b"x-konclave-date", b"1800000000"),
    ] {
        fields.extend(lv(n));
        fields.extend(lv(v));
    }
    m.extend(lv(&fields));
    m.extend(lv(b"{}"));
    m
}

fn known_request() -> InnerRequest {
    InnerRequest {
        method: "GET".into(),
        path: "/api/vault/balance?vault=ab12".into(),
        content_type: "application/json".into(),
        read_key: Some("rk-0123".into()),
        body: b"{}".to_vec(),
        date_unix: DATE,
    }
}

#[test]
fn the_key_file_serves_these_exact_bytes() {
    let g = Gateway::new(key_config_from_text(&key()).unwrap(), 0).unwrap();
    assert_eq!(g.config_list().unwrap(), hex(CONFIG_HEX));
    let c = ClientConfig::parse(&hex(CONFIG_HEX)).unwrap();
    assert_eq!((c.key_id(), c.as_bytes()), (7, hex(CONFIG_HEX).as_slice()));
}

#[test]
fn a_recorded_request_decrypts_to_the_hand_written_message() {
    let wire = hex(REQUEST_HEX.trim());
    assert_eq!(wire.len(), 4096);
    // The raw crate, with the key derived from the file, not our gateway.
    let server = ohttp::Server::new(key_config_from_text(&key()).unwrap()).unwrap();
    let (plain, _ctx) = server.decapsulate(&wire).unwrap();
    let mut want = expected_request_plain();
    assert!(want.len() < plain.len());
    want.resize(plain.len(), 0); // BHTTP padding: zeros
    assert_eq!(plain.len(), 4096 - padding::REQUEST_OVERHEAD);
    assert_eq!(plain, want);
    // And our gateway reads the same thing out of it.
    let g = Gateway::new(key_config_from_text(&key()).unwrap(), DATE - 10).unwrap();
    let (got, _) = g.open(&wire, DATE).unwrap();
    assert_eq!(got, known_request());
}

/// Known response bytes, both ways, against the raw crate.
#[test]
fn responses_match_the_hand_written_message_both_ways() {
    let g = Gateway::new(key_config_from_text(&key()).unwrap(), DATE - 10).unwrap();
    let cfg = ClientConfig::parse(&g.config_list().unwrap()).unwrap();
    // Known-length response: framing 1, status 200 (a two-byte varint 0x40C8), headers, content.
    let mut want = vec![1u8, 0x40, 0xC8];
    want.extend(lv(&[lv(b"content-type"), lv(b"application/json")].concat()));
    want.extend(lv(br#"{"balance":0}"#));
    let plain_len = padding::response_bucket(want.len() + padding::RESPONSE_OVERHEAD).unwrap()
        - padding::RESPONSE_OVERHEAD;
    assert_eq!(plain_len + padding::RESPONSE_OVERHEAD, 1024);
    let mut padded = want.clone();
    padded.resize(plain_len, 0);

    // The gateway answers; the raw crate's CLIENT opens it: our encoding is these bytes.
    let raw_client =
        ohttp::ClientRequest::from_encoded_config_list(&g.config_list().unwrap()).unwrap();
    let mut req = expected_request_plain();
    req.resize(4096 - padding::REQUEST_OVERHEAD, 0);
    let (wire, raw_resp) = raw_client.encapsulate(&req).unwrap();
    let (_, sctx) = g.open(&wire, DATE).unwrap();
    let sealed = encapsulate_response(sctx, 200, "application/json", br#"{"balance":0}"#).unwrap();
    assert_eq!(raw_resp.decapsulate(&sealed).unwrap(), padded);

    // The raw crate's SERVER answers with the hand-written bytes; our client reads them.
    let (wire, ctx) = seal_request(&cfg, known_request()).unwrap();
    let raw_server = ohttp::Server::new(key_config_from_text(&key()).unwrap()).unwrap();
    let (_, raw_sctx) = raw_server.decapsulate(&wire).unwrap();
    let sealed = raw_sctx.encapsulate(&padded).unwrap();
    let (status, ct, body) = open_response(ctx, &sealed).unwrap();
    assert_eq!(
        (status, ct.as_str(), body.as_slice()),
        (200, "application/json", &br#"{"balance":0}"#[..])
    );
}
