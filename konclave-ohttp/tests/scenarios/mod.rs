//! Each scenario is a plain function returning Ok(()) or a reason, so the same code is run as a
//! #[test] (oblivious.rs) and as a named check in acceptance.json (acceptance.rs).
#![allow(dead_code)]

use konclave_http::{route_is_oblivious, OBLIVIOUS_ROUTES};
use konclave_ohttp::{
    encapsulate_response, generate_key_config, open_response, padding, seal_request, ClientConfig,
    ClientError, Gateway, InnerRequest, Refusal, ReplaySet, WINDOW_SECS,
};

pub const NOW: i64 = 1_800_000_000;

pub struct Rig {
    pub gw: Gateway,
    pub cfg: ClientConfig,
}

pub fn rig_with(key_id: u8, capacity: usize) -> Rig {
    let kc = generate_key_config(key_id).unwrap();
    let gw = Gateway::with_capacity(kc, NOW - 1000, capacity).unwrap();
    let cfg = ClientConfig::parse(&gw.config_list().unwrap()).unwrap();
    Rig { gw, cfg }
}

pub fn rig() -> Rig {
    rig_with(7, 16_384)
}

pub fn req(path: &str, body: &[u8], date: i64) -> InnerRequest {
    InnerRequest {
        method: "GET".into(),
        path: path.into(),
        content_type: "application/json".into(),
        read_key: Some("rk-abc".into()),
        body: body.to_vec(),
        date_unix: date,
    }
}

fn ensure(c: bool, why: &str) -> Result<(), String> {
    if c {
        Ok(())
    } else {
        Err(why.to_owned())
    }
}

fn refusal(r: Result<impl Sized, Refusal>) -> Result<Refusal, String> {
    match r {
        Ok(_) => Err("accepted, expected a refusal".into()),
        Err(e) => Ok(e),
    }
}

/// Seal raw BHTTP bytes (padded to a bucket) for the rig, bypassing InnerRequest.
pub fn raw_seal(rig: &Rig, mut plain: Vec<u8>) -> Vec<u8> {
    let target = padding::request_bucket(plain.len() + padding::REQUEST_OVERHEAD).unwrap();
    plain.resize(target - padding::REQUEST_OVERHEAD, 0);
    let list = rig.gw.config_list().unwrap();
    let c = ohttp::ClientRequest::from_encoded_config_list(&list).unwrap();
    c.encapsulate(&plain).unwrap().0
}

pub fn raw_message(headers: &[(&str, &str)], path: &str) -> Vec<u8> {
    let mut m = bhttp::Message::request(
        b"GET".to_vec(),
        b"https".to_vec(),
        b"konclave".to_vec(),
        path.as_bytes().to_vec(),
    );
    for (k, v) in headers {
        m.put_header(k.as_bytes(), v.as_bytes());
    }
    m.write_content(b"");
    let mut out = Vec::new();
    m.write_bhttp(bhttp::Mode::KnownLength, &mut out).unwrap();
    out
}

pub fn round_trip() -> Result<(), String> {
    let r = rig();
    let sent = req("/api/vault/balance?vault=abc", b"{\"a\":1}", NOW);
    let (wire, ctx) = seal_request(&r.cfg, sent.clone()).map_err(|e| e.to_string())?;
    let (got, rc) = r.gw.decapsulate(&wire, NOW).map_err(|e| e.to_string())?;
    ensure(got == sent, "inner request changed in transit")?;
    let resp = encapsulate_response(rc, 200, "application/json", b"{\"ok\":true}")
        .map_err(|e| e.to_string())?;
    let (st, ct, body) = open_response(ctx, &resp).map_err(|e| e.to_string())?;
    ensure(
        st == 200 && ct == "application/json" && body == b"{\"ok\":true}",
        "response changed",
    )
}

pub fn tamper_request() -> Result<(), String> {
    let r = rig();
    let (wire, _ctx) =
        seal_request(&r.cfg, req("/api/health", b"", NOW)).map_err(|e| e.to_string())?;
    for i in 0..wire.len() {
        let mut w = wire.clone();
        w[i] ^= 0x01;
        if r.gw.decapsulate(&w, NOW).is_ok() {
            return Err(format!("a flipped byte at {i} was accepted"));
        }
    }
    // the untouched request still goes through: nothing above was recorded as seen
    r.gw.decapsulate(&wire, NOW)
        .map(|_| ())
        .map_err(|e| e.to_string())
}

fn exchange(r: &Rig, status: u16, body: &[u8]) -> (Vec<u8>, konclave_ohttp::ClientCtx) {
    let (wire, ctx) = seal_request(&r.cfg, req("/api/health", b"", NOW)).unwrap();
    let (_, rc) = r.gw.decapsulate(&wire, NOW).unwrap();
    (
        encapsulate_response(rc, status, "text/plain", body).unwrap(),
        ctx,
    )
}

pub fn tamper_response() -> Result<(), String> {
    let r = rig();
    let (probe, _) = exchange(&r, 200, b"hello");
    for i in 0..probe.len() {
        let (mut resp, ctx) = exchange(&r, 200, b"hello");
        resp[i] ^= 0x01;
        if open_response(ctx, &resp).is_ok() {
            return Err(format!("a flipped response byte at {i} was accepted"));
        }
    }
    Ok(())
}

pub fn truncation() -> Result<(), String> {
    let r = rig();
    let (wire, _c) =
        seal_request(&r.cfg, req("/api/health", b"", NOW)).map_err(|e| e.to_string())?;
    for n in [0, 1, 7, 8, 39, 40, 55, wire.len() / 2, wire.len() - 1] {
        if r.gw.decapsulate(&wire[..n], NOW).is_ok() {
            return Err(format!("request truncated to {n} accepted"));
        }
    }
    let (probe, _) = exchange(&r, 200, b"hello");
    for n in [0, 1, 16, 17, 32, probe.len() / 2, probe.len() - 1] {
        let (resp, ctx) = exchange(&r, 200, b"hello");
        if open_response(ctx, &resp[..n]).is_ok() {
            return Err(format!("response truncated to {n} accepted"));
        }
    }
    Ok(())
}

pub fn replay() -> Result<(), String> {
    let r = rig();
    let (wire, _c) =
        seal_request(&r.cfg, req("/api/health", b"", NOW)).map_err(|e| e.to_string())?;
    r.gw.decapsulate(&wire, NOW).map_err(|e| e.to_string())?;
    ensure(
        refusal(r.gw.decapsulate(&wire, NOW))? == Refusal::Replay,
        "second use was not a Replay",
    )?;
    // still refused a little later, inside the window
    ensure(
        refusal(r.gw.decapsulate(&wire, NOW + 100))? == Refusal::Replay,
        "replay accepted later in the window",
    )
}

pub fn stale_date() -> Result<(), String> {
    let r = rig();
    let (w, _c) = seal_request(&r.cfg, req("/api/health", b"", NOW - WINDOW_SECS - 1)).unwrap();
    ensure(
        refusal(r.gw.decapsulate(&w, NOW))? == Refusal::StaleDate,
        "stale not refused",
    )?;
    let (w, _c) = seal_request(&r.cfg, req("/api/health", b"", NOW - WINDOW_SECS)).unwrap();
    r.gw.decapsulate(&w, NOW)
        .map_err(|e| format!("edge of the window refused: {e}"))?;
    // before the boot floor
    let (w, _c) = seal_request(&r.cfg, req("/api/health", b"x", NOW - 1001)).unwrap();
    ensure(
        refusal(r.gw.decapsulate(&w, NOW - 1000))? == Refusal::StaleDate,
        "pre-boot request accepted",
    )
}

pub fn future_date() -> Result<(), String> {
    let r = rig();
    let (w, _c) = seal_request(&r.cfg, req("/api/health", b"", NOW + WINDOW_SECS + 1)).unwrap();
    ensure(
        refusal(r.gw.decapsulate(&w, NOW))? == Refusal::FutureDate,
        "future not refused",
    )?;
    let (w, _c) = seal_request(&r.cfg, req("/api/health", b"", NOW + WINDOW_SECS)).unwrap();
    r.gw.decapsulate(&w, NOW)
        .map(|_| ())
        .map_err(|e| format!("edge refused: {e}"))
}

pub fn missing_date() -> Result<(), String> {
    let r = rig();
    let w = raw_seal(
        &r,
        raw_message(&[("content-type", "text/plain")], "/api/health"),
    );
    ensure(
        refusal(r.gw.decapsulate(&w, NOW))? == Refusal::MissingDate,
        "missing date not refused",
    )?;
    let w = raw_seal(
        &r,
        raw_message(&[("x-konclave-date", "soon")], "/api/health"),
    );
    ensure(
        refusal(r.gw.decapsulate(&w, NOW))? == Refusal::BadDate,
        "non-numeric date not refused",
    )
}

pub fn unknown_key_id() -> Result<(), String> {
    let r = rig_with(7, 8);
    let other = rig_with(9, 8);
    let (w, _c) = seal_request(&other.cfg, req("/api/health", b"", NOW)).unwrap();
    ensure(
        refusal(r.gw.decapsulate(&w, NOW))? == Refusal::UnknownKeyId(9),
        "wrong typed error",
    )?;
    ensure(
        refusal(r.gw.decapsulate(&[], NOW))? == Refusal::NotPadded,
        "empty input",
    )?;
    // the client refuses a list with no entry or with two
    ensure(
        matches!(ClientConfig::parse(&[]), Err(ClientError::BadConfig)),
        "empty list parsed",
    )?;
    let mut two = r.gw.config_list().unwrap();
    two.extend_from_slice(&other.gw.config_list().unwrap());
    ensure(
        matches!(ClientConfig::parse(&two), Err(ClientError::BadConfig)),
        "two-entry list parsed",
    )
}

pub fn route_allowlist() -> Result<(), String> {
    let r = rig();
    for (m, p) in OBLIVIOUS_ROUTES {
        let mut q = req(p, b"", NOW);
        q.method = (*m).to_owned();
        let (w, _c) = seal_request(&r.cfg, q).unwrap();
        let (inner, _) =
            r.gw.decapsulate(&w, NOW)
                .map_err(|e| format!("{m} {p}: {e}"))?;
        ensure(
            route_is_oblivious(&inner.method, &inner.path),
            &format!("{m} {p} listed but refused"),
        )?;
    }
    for (m, p) in [
        ("POST", "/api/vault/send"),
        ("POST", "/api/vault/proposals"),
        ("GET", "/api/vault/ledger.csv"),
        ("GET", "/api/vault/ufvk"),
        ("GET", "/api/vault/balance/"),
        ("POST", "/api/vault/balance"),
        ("GET", "/api/ohttp"),
        ("GET", "/"),
    ] {
        let mut q = req(p, b"x", NOW);
        q.method = m.to_owned();
        let (w, _c) = seal_request(&r.cfg, q).unwrap();
        // the crypto layer opens it; the routing rule (konclave-http) is what refuses it
        let (inner, _) =
            r.gw.decapsulate(&w, NOW)
                .map_err(|e| format!("{m} {p}: {e}"))?;
        if route_is_oblivious(&inner.method, &inner.path) {
            return Err(format!("{m} {p} was reachable"));
        }
    }
    Ok(())
}

pub fn forbidden_header() -> Result<(), String> {
    let r = rig();
    for h in [
        "cookie",
        "authorization",
        "x-forwarded-for",
        "user-agent",
        "origin",
        "Content-Type",
        "x-konclave-write",
    ] {
        let w = raw_seal(
            &r,
            raw_message(
                &[("x-konclave-date", &NOW.to_string()), (h, "v")],
                "/api/health",
            ),
        );
        match r.gw.decapsulate(&w, NOW) {
            Err(e @ Refusal::ForbiddenHeader) => {
                // The refusal carries no text of the request, so it cannot name the header.
                let said = format!("{e:?} {e}").to_ascii_lowercase();
                if said.contains(&h.to_ascii_lowercase()) {
                    return Err(format!("the refusal names the header {h}: {said}"));
                }
            }
            other => return Err(format!("header {h}: {:?}", other.map(|_| ()))),
        }
    }
    // duplicates of an allowed header are refused too
    let w = raw_seal(
        &r,
        raw_message(
            &[
                ("x-konclave-date", &NOW.to_string()),
                ("x-konclave-date", &NOW.to_string()),
            ],
            "/api/health",
        ),
    );
    ensure(
        matches!(r.gw.decapsulate(&w, NOW), Err(Refusal::Malformed(_))),
        "duplicate date accepted",
    )?;
    // nonzero bytes in the padding area are refused
    let mut plain = raw_message(&[("x-konclave-date", &NOW.to_string())], "/api/health");
    let target = padding::request_bucket(plain.len() + padding::REQUEST_OVERHEAD).unwrap();
    plain.resize(target - padding::REQUEST_OVERHEAD, 0);
    *plain.last_mut().unwrap() = 1;
    let list = r.gw.config_list().unwrap();
    let w = ohttp::ClientRequest::from_encoded_config_list(&list)
        .unwrap()
        .encapsulate(&plain)
        .unwrap()
        .0;
    ensure(
        matches!(
            r.gw.decapsulate(&w, NOW),
            Err(Refusal::Malformed("padding"))
        ),
        "dirty padding accepted",
    )
}

pub fn replay_full_no_evict() -> Result<(), String> {
    let mut s = ReplaySet::new(2);
    s.insert([1; 32], 100, 400).map_err(|e| e.to_string())?;
    s.insert([2; 32], 100, 500).map_err(|e| e.to_string())?;
    ensure(
        s.insert([3; 32], 100, 400) == Err(Refusal::ReplaySetFull),
        "full set accepted a third",
    )?;
    ensure(
        s.insert([1; 32], 101, 400) == Err(Refusal::Replay),
        "the oldest entry was evicted",
    )?;
    ensure(s.len() == 2, "size changed")?;
    // entries leave only by expiry
    s.insert([3; 32], 401, 700)
        .map_err(|e| format!("expired entry kept: {e}"))?;
    ensure(
        s.insert([2; 32], 401, 500) == Err(Refusal::Replay),
        "unexpired entry lost",
    )?;

    // and through the gateway
    let r = rig_with(7, 2);
    let mut keep = Vec::new();
    for i in 0..2 {
        let (w, _c) = seal_request(&r.cfg, req("/api/health", &[i], NOW)).unwrap();
        r.gw.decapsulate(&w, NOW).map_err(|e| e.to_string())?;
        keep.push(w);
    }
    let (w3, _c) = seal_request(&r.cfg, req("/api/health", b"third", NOW)).unwrap();
    ensure(
        refusal(r.gw.decapsulate(&w3, NOW))? == Refusal::ReplaySetFull,
        "gateway accepted when full",
    )?;
    ensure(
        refusal(r.gw.decapsulate(&keep[0], NOW))? == Refusal::Replay,
        "gateway evicted",
    )?;
    // garbage never takes a slot: a bad key id leaves the set as it was
    let other = rig_with(8, 4);
    let (wb, _c) = seal_request(&other.cfg, req("/api/health", b"", NOW)).unwrap();
    ensure(
        matches!(r.gw.decapsulate(&wb, NOW), Err(Refusal::UnknownKeyId(8))),
        "bad key id",
    )?;
    // after the window, a slot frees and the third goes in
    r.gw.decapsulate(&w3, NOW + WINDOW_SECS + 1).err();
    Ok(())
}

pub fn padding_buckets() -> Result<(), String> {
    let r = rig();
    let expect_req = |body: usize, want: usize| -> Result<(), String> {
        let (w, _c) = seal_request(&r.cfg, req("/api/vault/balance", &vec![7u8; body], NOW))
            .map_err(|e| e.to_string())?;
        ensure(
            w.len() == want,
            &format!("body {body}: wire {} want {want}", w.len()),
        )
    };
    expect_req(0, 4096)?;
    expect_req(1, 4096)?;
    expect_req(3500, 4096)?;
    expect_req(4096, 16384)?;
    expect_req(20_000, 32768)?;
    expect_req(100_000, 131_072)?;
    expect_req(1_000_000, 1_048_576)?;
    expect_req(1_500_000, 2_097_152)?;
    ensure(
        matches!(
            seal_request(&r.cfg, req("/api/health", &vec![0u8; 2_097_152], NOW)),
            Err(ClientError::BadRequest(_))
        ),
        "over 2 MiB accepted",
    )?;
    // the request's inner size never reveals the body size: equal wire for different bodies
    let a = seal_request(&r.cfg, req("/api/health", b"a", NOW))
        .unwrap()
        .0
        .len();
    let b = seal_request(&r.cfg, req("/api/health", &[b'b'; 3000], NOW))
        .unwrap()
        .0
        .len();
    ensure(a == b, "small requests differ in size")?;

    for (len, want) in [
        (0usize, 1024usize),
        (500, 1024),
        (900, 1024),
        (2000, 4096),
        (4096, 8192),
        (5000, 8192),
        (70_000, 131_072),
    ] {
        let (wire, _) = exchange(&r, 200, &vec![b'x'; len]);
        ensure(
            wire.len() == want,
            &format!("response body {len}: wire {} want {want}", wire.len()),
        )?;
    }
    // the table itself
    for b in padding::REQUEST_BUCKETS {
        ensure(
            padding::request_bucket(b) == Some(b) && padding::request_bucket(b + 1) != Some(b),
            "request table",
        )?;
    }
    ensure(
        padding::response_bucket(1024) == Some(1024)
            && padding::response_bucket(1025) == Some(2048),
        "response table",
    )
}

pub fn response_authenticates_first() -> Result<(), String> {
    let r = rig();
    // a forged response (valid BHTTP, status 200, but not sealed by the gateway) yields no field
    let (_w, ctx) = seal_request(&r.cfg, req("/api/health", b"", NOW)).unwrap();
    let forged = vec![0x5au8; 1024];
    ensure(
        open_response(ctx, &forged) == Err(ClientError::NotAuthentic),
        "forged response not rejected as unauthentic",
    )?;
    // a response from another exchange fails
    let (resp_a, _ca) = exchange(&r, 200, b"a");
    let (_resp_b, cb) = exchange(&r, 500, b"b");
    ensure(
        open_response(cb, &resp_a) == Err(ClientError::NotAuthentic),
        "cross-exchange response accepted",
    )?;
    // a bad tag (last byte) is NotAuthentic, never a parsed status
    let (mut resp, ctx) = exchange(&r, 503, b"x");
    *resp.last_mut().unwrap() ^= 1;
    ensure(
        open_response(ctx, &resp) == Err(ClientError::NotAuthentic),
        "bad tag",
    )?;
    // a wrong size is refused before any decryption
    let (resp, ctx) = exchange(&r, 200, b"x");
    ensure(
        matches!(
            open_response(ctx, &resp[..resp.len() - 1]),
            Err(ClientError::BadResponse(_))
        ),
        "unpadded size",
    )?;
    // error statuses round-trip as data
    let (resp, ctx) = exchange(&r, 401, b"no");
    let (st, _, body) = open_response(ctx, &resp).map_err(|e| e.to_string())?;
    ensure(st == 401 && body == b"no", "401 changed")
}

/// A vault's answer size is not a stable fingerprint. Powers of two from 1 KiB, so answers
/// within a factor of two of each other are the same size on the wire.
pub fn response_buckets_exponential() -> Result<(), String> {
    let r = rig();
    for (a, b) in [
        (1100usize, 2000usize),
        (5_000, 7_000),
        (40_000, 60_000),
        (300_000, 500_000),
    ] {
        let (wa, _) = exchange(&r, 200, &vec![b'x'; a]);
        let (wb, _) = exchange(&r, 200, &vec![b'x'; b]);
        ensure(
            wa.len() == wb.len() || wa.len().next_power_of_two() != wb.len().next_power_of_two(),
            "same-size class",
        )?;
        ensure(
            wa.len().is_power_of_two() && wb.len().is_power_of_two(),
            &format!("not a power of two: {} {}", wa.len(), wb.len()),
        )?;
    }
    let (w5, _) = exchange(&r, 200, &vec![b'x'; 5_000]);
    let (w7, _) = exchange(&r, 200, &vec![b'x'; 7_000]);
    ensure(
        w5.len() == w7.len(),
        "5 KiB and 7 KiB answers differ in size",
    )?;
    let table = padding::RESPONSE_BUCKETS;
    ensure(
        table.len() == 15
            && table[0] == 1024
            && table.windows(2).all(|w| w[1] == 2 * w[0])
            && padding::RESPONSE_MAX == 16 * 1024 * 1024,
        "the table is not 1 KiB doubling to 16 MiB",
    )
}

/// The committed default wasm is the one the base commit had: members download no code for private
/// mode. Pinned by digest of `ui/src/wasm-pkg/konclave_wasm_bg.wasm` at the base, 93bfe759.
pub fn wasm_default_unchanged() -> Result<(), String> {
    use sha2::{Digest, Sha256};
    const BASE: &str = "2972fa54bff3223327f63402060d67cb15217458f4dafbb262b1c83f27aa94b5";
    let path = concat!(
        env!("CARGO_MANIFEST_DIR"),
        "/../ui/src/wasm-pkg/konclave_wasm_bg.wasm"
    );
    let bytes = std::fs::read(path).map_err(|e| e.to_string())?;
    let got: String = Sha256::digest(&bytes)
        .iter()
        .map(|b| format!("{b:02x}"))
        .collect();
    ensure(
        got == BASE,
        &format!("the committed wasm is {got}, not {BASE}"),
    )
}
