//! The relay against a fake gateway that records everything it is sent.

use std::io::{Read, Write};
use std::net::{SocketAddr, TcpListener, TcpStream};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use konclave_ohttp::{
    encapsulate_response, generate_key_config, open_response, seal_request, ClientConfig,
    Gateway as OhttpGateway, InnerRequest,
};
use konclave_ohttp_relay::{
    upstream::{Gateway, GatewayOptions, Timeouts},
    Config, Inbound, Limits, Relay, MAX_ANSWER, MAX_REQUEST_BODY, RELAY_PATH,
};

// ---------- the fake gateway ----------

#[derive(Clone)]
enum Mode {
    /// Answer 200 with this type and body.
    Fixed(u16, &'static str, Vec<u8>),
    /// Declare 100 bytes, send 10, close.
    CutMidAnswer,
    /// Read the request, then say nothing until the client gives up.
    Silent,
    /// Open the ohttp request, answer through the real server half.
    Ohttp(Arc<OhttpGateway>),
}

struct Seen {
    peer: SocketAddr,
    raw: Vec<u8>,
}

struct FakeGateway {
    addr: SocketAddr,
    seen: Arc<Mutex<Vec<Seen>>>,
}

fn read_request(s: &mut TcpStream) -> Vec<u8> {
    let mut raw = Vec::new();
    let mut buf = [0u8; 8192];
    loop {
        let n = s.read(&mut buf).unwrap_or(0);
        if n == 0 {
            return raw;
        }
        raw.extend_from_slice(&buf[..n]);
        if let Some(end) = raw.windows(4).position(|w| w == b"\r\n\r\n") {
            let head = String::from_utf8_lossy(&raw[..end]).to_ascii_lowercase();
            let len: usize = head
                .lines()
                .find_map(|l| l.strip_prefix("content-length:"))
                .and_then(|v| v.trim().parse().ok())
                .unwrap_or(0);
            if raw.len() >= end + 4 + len {
                return raw;
            }
        }
    }
}

fn body_of(raw: &[u8]) -> &[u8] {
    let end = raw.windows(4).position(|w| w == b"\r\n\r\n").unwrap();
    &raw[end + 4..]
}

fn fake_gateway(mode: Mode) -> FakeGateway {
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    let addr = listener.local_addr().unwrap();
    let seen = Arc::new(Mutex::new(Vec::new()));
    let log = seen.clone();
    std::thread::spawn(move || {
        for conn in listener.incoming() {
            let Ok(mut s) = conn else { continue };
            let peer = s.peer_addr().unwrap();
            let raw = read_request(&mut s);
            log.lock().unwrap().push(Seen {
                peer,
                raw: raw.clone(),
            });
            match mode.clone() {
                Mode::Fixed(status, ct, body) => reply(&mut s, status, ct, &body),
                Mode::CutMidAnswer => {
                    let _ = s.write_all(
                        b"HTTP/1.1 200 OK\r\nContent-Type: message/ohttp-res\r\nContent-Length: 100\r\n\r\n0123456789",
                    );
                }
                Mode::Silent => std::thread::sleep(Duration::from_secs(3)),
                Mode::Ohttp(gw) => {
                    let now = now();
                    let (_inner, ctx) = gw
                        .decapsulate(body_of(&raw), now)
                        .expect("gateway opens it");
                    let sealed =
                        encapsulate_response(ctx, 200, "application/json", br#"{"ok":true}"#)
                            .unwrap();
                    reply(&mut s, 200, "message/ohttp-res", &sealed);
                }
            }
        }
    });
    FakeGateway { addr, seen }
}

fn reply(s: &mut TcpStream, status: u16, ct: &str, body: &[u8]) {
    let head = format!(
        "HTTP/1.1 {status} X\r\nContent-Type: {ct}\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
        body.len()
    );
    let _ = s.write_all(head.as_bytes());
    let _ = s.write_all(body);
}

fn now() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap()
        .as_secs() as i64
}

// ---------- the relay under test ----------

const ORIGIN: &str = "https://www.konclave.xyz";
const SECRET: &str = "relay-secret-for-the-tests-0123";

fn start_relay(gw: &FakeGateway, flood_max: u32, io: Duration) -> u16 {
    start_relay_with(
        gw,
        flood_max,
        io,
        Limits::default(),
        Duration::from_secs(5),
        Duration::from_secs(10),
    )
}

/// A relay with these limits, this head deadline and this body deadline.
fn start_relay_with(
    gw: &FakeGateway,
    flood_max: u32,
    io: Duration,
    limits: Limits,
    head: Duration,
    body_deadline: Duration,
) -> u16 {
    start_relay_inbound(
        gw,
        flood_max,
        io,
        limits,
        Inbound {
            head_deadline: head,
            body_deadline,
            ..Inbound::default()
        },
    )
}

fn start_relay_inbound(
    gw: &FakeGateway,
    flood_max: u32,
    io: Duration,
    limits: Limits,
    inbound: Inbound,
) -> u16 {
    let config = Config {
        gateway: Gateway::parse(
            &format!("http://{}/api/ohttp", gw.addr),
            &GatewayOptions::plain(),
        )
        .unwrap()
        .with_secret(SECRET)
        .unwrap(),
        allowed_origins: vec![ORIGIN.to_string()],
        flood_max,
        timeouts: Timeouts {
            connect: Duration::from_secs(2),
            total: io,
        },
        limits,
        inbound,
    };
    let listener = TcpListener::bind("0.0.0.0:0").unwrap();
    let port = listener.local_addr().unwrap().port();
    let relay = Arc::new(Relay::new(config));
    std::thread::spawn(move || konclave_ohttp_relay::serve(listener, relay, 4));
    port
}

struct Reply {
    status: u16,
    headers: Vec<(String, String)>,
    body: Vec<u8>,
}

impl Reply {
    fn header(&self, name: &str) -> Option<&str> {
        self.headers
            .iter()
            .find(|(n, _)| n.eq_ignore_ascii_case(name))
            .map(|(_, v)| v.as_str())
    }
}

/// A raw request from `from` (a loopback address the test picks) to the relay.
fn request(
    host: &str,
    port: u16,
    method: &str,
    path: &str,
    headers: &[(&str, &str)],
    body: &[u8],
) -> Reply {
    let mut s = TcpStream::connect((host, port)).unwrap();
    s.set_read_timeout(Some(Duration::from_secs(10))).unwrap();
    let mut head = format!("{method} {path} HTTP/1.1\r\nHost: relay.test\r\nConnection: close\r\n");
    for (n, v) in headers {
        head.push_str(&format!("{n}: {v}\r\n"));
    }
    if !headers
        .iter()
        .any(|(n, _)| n.eq_ignore_ascii_case("content-length"))
    {
        head.push_str(&format!("Content-Length: {}\r\n", body.len()));
    }
    head.push_str("\r\n");
    s.write_all(head.as_bytes()).unwrap();
    let _ = s.write_all(body);
    let mut raw = Vec::new();
    let _ = s.read_to_end(&mut raw);
    let end = raw
        .windows(4)
        .position(|w| w == b"\r\n\r\n")
        .expect("a response head");
    let head = String::from_utf8_lossy(&raw[..end]).to_string();
    let mut lines = head.split("\r\n");
    let status = lines
        .next()
        .unwrap()
        .split(' ')
        .nth(1)
        .unwrap()
        .parse()
        .unwrap();
    let headers = lines
        .filter_map(|l| l.split_once(':'))
        .map(|(n, v)| (n.trim().to_string(), v.trim().to_string()))
        .collect();
    Reply {
        status,
        headers,
        body: raw[end + 4..].to_vec(),
    }
}

fn post(port: u16, body: &[u8]) -> Reply {
    request(
        "127.0.0.1",
        port,
        "POST",
        RELAY_PATH,
        &[("Content-Type", "message/ohttp-req")],
        body,
    )
}

fn text(r: &Reply) -> String {
    String::from_utf8_lossy(&r.body).to_string()
}

// ---------- forwarding ----------

#[test]
fn the_gateways_answer_comes_back_unchanged() {
    let gw = fake_gateway(Mode::Fixed(200, "message/ohttp-res", vec![7u8; 1024]));
    let port = start_relay(&gw, 60, Duration::from_secs(5));
    let r = post(port, &[1u8; 4096]);
    assert_eq!(r.status, 200);
    assert_eq!(r.header("content-type"), Some("message/ohttp-res"));
    assert_eq!(r.body, vec![7u8; 1024]);
    let seen = gw.seen.lock().unwrap();
    assert_eq!(seen.len(), 1);
    assert_eq!(
        body_of(&seen[0].raw),
        &[1u8; 4096][..],
        "the body is forwarded unchanged"
    );
    assert!(seen[0].raw.starts_with(b"POST /api/ohttp HTTP/1.1\r\n"));
}

#[test]
fn a_gateway_refusal_passes_through_with_its_status() {
    let gw = fake_gateway(Mode::Fixed(400, "application/json", b"{}".to_vec()));
    let port = start_relay(&gw, 60, Duration::from_secs(5));
    let r = post(port, &[1u8; 64]);
    assert_eq!(r.status, 400);
    assert_eq!(r.body, b"{}");
}

#[test]
fn no_retries_on_a_5xx() {
    let gw = fake_gateway(Mode::Fixed(503, "application/json", b"{}".to_vec()));
    let port = start_relay(&gw, 60, Duration::from_secs(5));
    let r = post(port, &[1u8; 64]);
    assert_eq!(r.status, 503, "the gateway's status, unchanged");
    std::thread::sleep(Duration::from_millis(300));
    assert_eq!(
        gw.seen.lock().unwrap().len(),
        1,
        "exactly one upstream attempt"
    );
}

// ---------- what the gateway sees ----------

const CANARIES: [&str; 6] = [
    "canary-cookie-9f1",
    "canary-agent-9f2",
    "https://canary-origin-9f3.example",
    "198.51.100.77",
    "canary-custom-9f5",
    "https://canary-referer-9f6.example",
];

fn client_headers() -> Vec<(&'static str, &'static str)> {
    vec![
        ("Content-Type", "message/ohttp-req"),
        ("Cookie", "session=canary-cookie-9f1"),
        ("User-Agent", "canary-agent-9f2"),
        ("Origin", "https://canary-origin-9f3.example"),
        ("X-Forwarded-For", "198.51.100.77"),
        ("X-Custom", "canary-custom-9f5"),
        ("Referer", "https://canary-referer-9f6.example"),
        ("Forwarded", "for=198.51.100.77"),
        ("X-Real-IP", "198.51.100.77"),
        ("Via", "1.1 canary-via"),
        ("Authorization", "Bearer canary-auth"),
        // A client cannot pass the relay's secret off as its own, or learn it: only the relay's
        // configured value goes out.
        ("X-Konclave-Relay-Secret", "canary-secret-9f7-0123456789"),
    ]
}

fn header_names(raw: &[u8]) -> Vec<String> {
    let end = raw.windows(4).position(|w| w == b"\r\n\r\n").unwrap();
    String::from_utf8_lossy(&raw[..end])
        .split("\r\n")
        .skip(1)
        .map(|l| l.split(':').next().unwrap().to_ascii_lowercase())
        .collect()
}

#[test]
fn header_strip_canary() {
    let gw = fake_gateway(Mode::Fixed(200, "message/ohttp-res", vec![0u8; 1024]));
    let port = start_relay(&gw, 60, Duration::from_secs(5));
    let r = request(
        "127.0.0.1",
        port,
        "POST",
        RELAY_PATH,
        &client_headers(),
        &[3u8; 4096],
    );
    assert_eq!(r.status, 200);
    let seen = gw.seen.lock().unwrap();
    let head = String::from_utf8_lossy(&seen[0].raw[..seen[0].raw.len() - 4096]).to_string();
    for c in CANARIES
        .iter()
        .chain(["canary-via", "canary-auth", "canary-secret-9f7"].iter())
    {
        assert!(!head.contains(c), "{c} reached the gateway:\n{head}");
    }
    let mut names = header_names(&seen[0].raw);
    names.sort();
    assert_eq!(
        names,
        [
            "content-length",
            "content-type",
            "host",
            "x-konclave-relay-secret"
        ],
        "exactly the framing headers and the relay's own secret: no User-Agent, no Accept"
    );
    // hyper writes header names in lower case; they are case-insensitive.
    let lower = head.to_ascii_lowercase();
    assert!(
        lower.contains(&format!("x-konclave-relay-secret: {SECRET}\r\n")),
        "the gateway got the relay's secret:\n{head}"
    );
    // The framing headers carry nothing of the client's.
    assert!(lower.contains("content-type: message/ohttp-req\r\n"));
    assert!(lower.contains(&format!("host: 127.0.0.1:{}\r\n", gw.addr.port())));
    // hyper's client adds nothing of its own, and the client's User-Agent is not forwarded.
    assert!(!head.to_ascii_lowercase().contains("user-agent"));
}

#[test]
fn gateway_never_sees_client_ip() {
    let gw = fake_gateway(Mode::Fixed(200, "message/ohttp-res", vec![0u8; 1024]));
    let port = start_relay(&gw, 60, Duration::from_secs(5));
    // 127.0.0.2 is a loopback address of its own on Linux: connecting to it makes the client's
    // source address 127.0.0.2, while the relay's call to the gateway leaves from 127.0.0.1.
    let client_host = "127.0.0.2";
    if TcpStream::connect((client_host, port)).is_err() {
        eprintln!("skipped: {client_host} is not a loopback address here");
        return;
    }
    let r = request(
        client_host,
        port,
        "POST",
        RELAY_PATH,
        &client_headers(),
        &[3u8; 4096],
    );
    assert_eq!(r.status, 200);
    let seen = gw.seen.lock().unwrap();
    assert_eq!(seen.len(), 1);
    assert_ne!(
        seen[0].peer.ip().to_string(),
        client_host,
        "the gateway's peer is the relay, never the client"
    );
    let all = String::from_utf8_lossy(&seen[0].raw).to_string();
    for addr in [client_host, "198.51.100.77"] {
        assert!(
            !all.contains(addr),
            "{addr} appears in what the gateway received"
        );
    }
    for name in ["x-forwarded-for", "forwarded", "x-real-ip", "via"] {
        assert!(
            !header_names(&seen[0].raw).contains(&name.to_string()),
            "{name}"
        );
    }
}

// ---------- fail closed ----------

#[test]
fn relay_cut_mid_request() {
    for mode in [Mode::CutMidAnswer, Mode::Silent] {
        let gw = fake_gateway(mode.clone());
        let port = start_relay(&gw, 60, Duration::from_millis(400));
        let r = post(port, &[1u8; 4096]);
        assert_eq!(r.status, 502);
        let body = text(&r);
        assert!(
            body.contains("gateway_cut") || body.contains("gateway_timeout"),
            "typed error expected: {body}"
        );
        assert_eq!(r.header("content-type"), Some("application/json"));
        std::thread::sleep(Duration::from_millis(500));
        assert_eq!(
            gw.seen.lock().unwrap().len(),
            1,
            "exactly one upstream attempt, no retry"
        );
    }
}

#[test]
fn an_unreachable_gateway_is_a_typed_502_with_no_fallback() {
    let dead = {
        let l = TcpListener::bind("127.0.0.1:0").unwrap();
        l.local_addr().unwrap()
    };
    let gw = FakeGateway {
        addr: dead,
        seen: Default::default(),
    };
    let port = start_relay(&gw, 60, Duration::from_secs(2));
    let r = post(port, &[1u8; 64]);
    assert_eq!(r.status, 502);
    assert!(text(&r).contains("gateway_unreachable"));
}

// ---------- the front door ----------

#[test]
fn oversize_refused() {
    let gw = fake_gateway(Mode::Fixed(200, "message/ohttp-res", vec![0u8; 1024]));
    let port = start_relay(&gw, 60, Duration::from_secs(5));
    // Declared too large: refused from the header, without the body being read or forwarded.
    let r = request(
        "127.0.0.1",
        port,
        "POST",
        RELAY_PATH,
        &[
            ("Content-Type", "message/ohttp-req"),
            ("Content-Length", &(MAX_REQUEST_BODY + 1).to_string()),
        ],
        b"",
    );
    assert_eq!(r.status, 413);
    // Exactly at the cap is accepted.
    let ok = post(port, &vec![1u8; MAX_REQUEST_BODY]);
    assert_eq!(ok.status, 200);
    assert_eq!(
        gw.seen.lock().unwrap().len(),
        1,
        "only the one at the cap went upstream"
    );
}

#[test]
fn wrong_content_type_refused() {
    let gw = fake_gateway(Mode::Fixed(200, "message/ohttp-res", vec![0u8; 1024]));
    let port = start_relay(&gw, 60, Duration::from_secs(5));
    for ct in [
        "application/json",
        "message/ohttp-chunked-req",
        "message/ohttp-res",
    ] {
        let r = request(
            "127.0.0.1",
            port,
            "POST",
            RELAY_PATH,
            &[("Content-Type", ct)],
            &[1u8; 64],
        );
        assert_eq!(r.status, 415, "{ct}");
    }
    let none = request("127.0.0.1", port, "POST", RELAY_PATH, &[], &[1u8; 64]);
    assert_eq!(none.status, 415);
    assert!(gw.seen.lock().unwrap().is_empty());
}

#[test]
fn other_paths_and_methods_are_refused() {
    let gw = fake_gateway(Mode::Fixed(200, "message/ohttp-res", vec![0u8; 1024]));
    let port = start_relay(&gw, 60, Duration::from_secs(5));
    let h = [("Content-Type", "message/ohttp-req")];
    assert_eq!(
        request("127.0.0.1", port, "POST", "/api/ohttp", &h, b"x").status,
        404
    );
    assert_eq!(
        request("127.0.0.1", port, "GET", RELAY_PATH, &[], b"").status,
        405
    );
    assert!(gw.seen.lock().unwrap().is_empty());
}

#[test]
fn the_flood_limit() {
    let gw = fake_gateway(Mode::Fixed(200, "message/ohttp-res", vec![0u8; 1024]));
    let port = start_relay(&gw, 3, Duration::from_secs(5));
    let from = |ip: &str| {
        request(
            "127.0.0.1",
            port,
            "POST",
            RELAY_PATH,
            &[
                ("Content-Type", "message/ohttp-req"),
                ("X-Forwarded-For", ip),
            ],
            &[1u8; 64],
        )
        .status
    };
    // Window boundaries are wall-clock; three requests can straddle one, so allow one stray pass.
    let a: Vec<u16> = (0..6).map(|_| from("203.0.113.1")).collect();
    assert!(a.iter().filter(|s| **s == 429).count() >= 2, "{a:?}");
    assert!(a.iter().filter(|s| **s == 200).count() <= 4, "{a:?}");
    assert_eq!(
        from("203.0.113.2"),
        200,
        "another address has its own allowance"
    );
    assert!(
        gw.seen.lock().unwrap().len() < 6 + 1,
        "refused requests never reached the gateway"
    );
}

// ---------- CORS ----------

#[test]
fn cors_is_an_allow_list_with_max_age() {
    let gw = fake_gateway(Mode::Fixed(200, "message/ohttp-res", vec![0u8; 1024]));
    let port = start_relay(&gw, 60, Duration::from_secs(5));
    let pre = request(
        "127.0.0.1",
        port,
        "OPTIONS",
        RELAY_PATH,
        &[
            ("Origin", ORIGIN),
            ("Access-Control-Request-Method", "POST"),
        ],
        b"",
    );
    assert_eq!(pre.status, 204);
    assert_eq!(pre.header("access-control-allow-origin"), Some(ORIGIN));
    assert_eq!(pre.header("access-control-max-age"), Some("86400"));
    assert_eq!(
        pre.header("access-control-allow-headers"),
        Some("Content-Type")
    );
    let other = request(
        "127.0.0.1",
        port,
        "OPTIONS",
        RELAY_PATH,
        &[("Origin", "https://evil.example")],
        b"",
    );
    assert!(other.header("access-control-allow-origin").is_none());
    let answer = request(
        "127.0.0.1",
        port,
        "POST",
        RELAY_PATH,
        &[("Content-Type", "message/ohttp-req"), ("Origin", ORIGIN)],
        &[1u8; 64],
    );
    assert_eq!(answer.header("access-control-allow-origin"), Some(ORIGIN));
}

// ---------- pins and the end to end ----------

#[test]
fn the_size_cap_is_the_largest_request_bucket() {
    use konclave_ohttp::padding;
    assert_eq!(MAX_REQUEST_BODY, *padding::REQUEST_BUCKETS.last().unwrap());
    assert_eq!(MAX_ANSWER, padding::RESPONSE_MAX);
    // One number: what the relay carries is what the coordinator reads.
    assert_eq!(MAX_REQUEST_BODY as u64, konclave_http::MAX_BODY);
}

#[test]
fn a_sealed_request_goes_through_the_relay_and_the_answer_opens() {
    // The gateway here is konclave-ohttp's server half behind a fake HTTP listener, NOT the
    // helper's dispatch: the helper is a binary, and the real dispatch is covered by its own tests.
    let config = generate_key_config(1).unwrap();
    let gateway = Arc::new(OhttpGateway::new(config, now() - 5).unwrap());
    let client_cfg = ClientConfig::parse(&gateway.config_list().unwrap()).unwrap();
    let gw = fake_gateway(Mode::Ohttp(gateway));
    let port = start_relay(&gw, 60, Duration::from_secs(5));

    let (wire, ctx) = seal_request(
        &client_cfg,
        InnerRequest {
            method: "GET".into(),
            path: "/api/health".into(),
            content_type: String::new(),
            read_key: None,
            body: Vec::new(),
            date_unix: now(),
        },
    )
    .unwrap();
    let r = post(port, &wire);
    assert_eq!(r.status, 200);
    assert_eq!(r.header("content-type"), Some("message/ohttp-res"));
    let (status, ct, body) = open_response(ctx, &r.body).unwrap();
    assert_eq!(status, 200);
    assert_eq!(ct, "application/json");
    assert_eq!(body, br#"{"ok":true}"#);
}

#[test]
fn a_bad_gateway_url_and_a_bad_origin_list_are_refused_at_boot() {
    let plain = GatewayOptions::plain();
    assert!(Gateway::parse("ftp://gw.example/", &plain).is_err());
    assert!(Gateway::parse("http://user@gw.example/", &plain).is_err());
    assert!(Gateway::parse("http://127.0.0.1:8080/api/ohttp", &plain).is_ok());
    assert!(
        konclave_ohttp_relay::parse_origins("https://a.example, http://localhost:5173").is_ok()
    );
    for bad in [
        "*",
        "https://a.example/",
        "a.example",
        "https://*.a.example",
    ] {
        assert!(konclave_ohttp_relay::parse_origins(bad).is_err(), "{bad}");
    }
}

/// The relay opens nothing. TLS (rustls, ring) is the only cryptography it links; none of it can
/// open a sealed request.
#[test]
fn the_relay_links_no_hpke_in_its_normal_dependencies() {
    let manifest =
        std::fs::read_to_string(concat!(env!("CARGO_MANIFEST_DIR"), "/Cargo.toml")).unwrap();
    let normal_section = manifest
        .split("[dev-dependencies]")
        .next()
        .unwrap()
        .split("[dependencies]")
        .nth(1)
        .unwrap();
    // The code of the section, not its comments (which say what is NOT used).
    let normal: String = normal_section
        .lines()
        .filter(|l| !l.trim_start().starts_with('#'))
        .collect::<Vec<_>>()
        .join("\n");
    for banned in [
        "ohttp\"",
        "bhttp",
        "hpke",
        "sha2",
        "aes",
        "konclave-ohttp",
        "reqwest",
        "ureq",
        "aws-lc",
        "openssl",
        "native-tls",
        "macros",
        "http2",
        "tls12",
        "logging",
    ] {
        assert!(!normal.contains(banned), "{banned} in [dependencies]");
    }
    // Every dependency version is exact, so a build never takes a newer crate on its own, and no
    // dependency keeps its default features.
    for line in normal
        .lines()
        .filter(|l| l.contains("version =") || l.contains("= \""))
    {
        if line.contains("path =") {
            continue;
        }
        assert!(line.contains("\"="), "version not exact: {line}");
        if line.contains("version =") {
            assert!(
                line.contains("default-features = false"),
                "default features on: {line}"
            );
        }
    }
}

/// The tree the relay builds, read from `cargo tree` on the committed lock: no proc-macro crate (so
/// no `syn`), no second TLS stack, no C toolchain, no HTTP/2, and a small number of crates.
#[test]
fn the_relay_tree_is_small_and_has_no_proc_macros() {
    let cargo = std::env::var("CARGO").unwrap_or_else(|_| "cargo".to_string());
    let out = std::process::Command::new(cargo)
        .current_dir(env!("CARGO_MANIFEST_DIR"))
        .args([
            "tree",
            "--locked",
            "-p",
            "konclave-ohttp-relay",
            "-e",
            "normal",
            "--prefix",
            "none",
        ])
        .output()
        .unwrap();
    assert!(
        out.status.success(),
        "{}",
        String::from_utf8_lossy(&out.stderr)
    );
    let text = String::from_utf8_lossy(&out.stdout).to_string();
    assert!(
        !text.contains("(proc-macro)"),
        "a proc-macro crate:\n{text}"
    );
    let mut names: Vec<&str> = text.lines().map(|l| l.split(' ').next().unwrap()).collect();
    names.sort_unstable();
    names.dedup();
    for banned in [
        "ureq",
        "syn",
        "proc-macro2",
        "quote",
        "tokio-macros",
        "aws-lc-rs",
        "aws-lc-sys",
        "openssl",
        "openssl-sys",
        "native-tls",
        "h2",
        "log",
        "url",
        "idna",
        "serde",
        "hpke",
        "ohttp",
        "bhttp",
    ] {
        assert!(!names.contains(&banned), "{banned} is in the relay's tree");
    }
    assert!(names.contains(&"hyper") && names.contains(&"tokio-rustls"));
    assert!(
        names.len() <= 36,
        "{} crates (this includes the relay and konclave-http): {names:?}",
        names.len()
    );
}

/// The same path against the REAL helper, if one is built and named in `KONCLAVE_TEST_HELPER_BIN`:
/// `KONCLAVE_OHTTP=1`, the real `dispatch`, the real `/api/ohttp`. Skipped (passes) when unset, so
/// the suite needs no other crate's binary; run it with
/// `cargo build -p helper-server && KONCLAVE_TEST_HELPER_BIN=<target>/debug/helper-server cargo test ...`.
#[test]
fn through_the_relay_to_the_real_helper_gateway() {
    let Ok(bin) = std::env::var("KONCLAVE_TEST_HELPER_BIN") else {
        eprintln!("skipped: KONCLAVE_TEST_HELPER_BIN is not set");
        return;
    };
    let dir = std::env::temp_dir().join(format!("konclave-ohttp-relay-{}", std::process::id()));
    let _ = std::fs::create_dir_all(&dir);
    let probe = TcpListener::bind("127.0.0.1:0").unwrap();
    let hport = probe.local_addr().unwrap().port();
    drop(probe);
    struct Kill(std::process::Child);
    impl Drop for Kill {
        fn drop(&mut self) {
            let _ = self.0.kill();
        }
    }
    // The gateway's key is a file (one line: key id, 32 bytes in hex) and the relay holds its secret.
    let key_file = dir.join("ohttp-key");
    // Made here and never written out: the helper refuses every key the repository publishes.
    std::fs::write(&key_file, format!("11 {}\n", fresh_key_hex())).unwrap();
    // The helper refuses a key file that group or others can read.
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(&key_file, std::fs::Permissions::from_mode(0o600)).unwrap();
    }
    let _helper = Kill(
        std::process::Command::new(bin)
            .env("KONCLAVE_OHTTP", "1")
            .env("KONCLAVE_OHTTP_KEY_FILE", &key_file)
            .env("KONCLAVE_OHTTP_RELAY_SECRET", SECRET)
            .env("KONCLAVE_HELPER_ADDR", format!("127.0.0.1:{hport}"))
            .current_dir(&dir)
            .stdout(std::process::Stdio::null())
            .stderr(std::process::Stdio::null())
            .spawn()
            .unwrap(),
    );
    let mut keys = None;
    for _ in 0..100 {
        std::thread::sleep(Duration::from_millis(100));
        if TcpStream::connect(("127.0.0.1", hport)).is_ok() {
            let r = request("127.0.0.1", hport, "GET", "/api/ohttp-keys", &[], b"");
            if r.status == 200 {
                keys = Some(r.body);
                break;
            }
        }
    }
    let client_cfg = ClientConfig::parse(&keys.expect("the helper's key configuration")).unwrap();
    let config = Config {
        gateway: Gateway::parse(
            &format!("http://127.0.0.1:{hport}/api/ohttp"),
            &GatewayOptions::plain(),
        )
        .unwrap()
        .with_secret(SECRET)
        .unwrap(),
        allowed_origins: vec![],
        flood_max: 60,
        timeouts: Timeouts::default(),
        limits: Limits::default(),
        inbound: Inbound::default(),
    };
    let listener = TcpListener::bind("0.0.0.0:0").unwrap();
    let port = listener.local_addr().unwrap().port();
    let relay = Arc::new(Relay::new(config));
    std::thread::spawn(move || konclave_ohttp_relay::serve(listener, relay, 2));

    let (wire, ctx) = seal_request(
        &client_cfg,
        InnerRequest {
            method: "GET".into(),
            path: "/api/health".into(),
            content_type: String::new(),
            read_key: None,
            body: Vec::new(),
            date_unix: now(),
        },
    )
    .unwrap();
    let r = post(port, &wire);
    assert_eq!(r.status, 200, "{}", text(&r));
    let (status, _ct, body) = open_response(ctx, &r.body).unwrap();
    assert_eq!(status, 200);
    // Straight to the gateway, without the relay's secret: refused before anything is read.
    let no_secret = request(
        "127.0.0.1",
        hport,
        "POST",
        "/api/ohttp",
        &[("Content-Type", "message/ohttp-req")],
        &[7u8; 64],
    );
    assert_eq!(no_secret.status, 403);
    assert_eq!(no_secret.header("access-control-allow-origin"), None);
    let direct = request("127.0.0.1", hport, "GET", "/api/health", &[], b"");
    assert_eq!(
        body, direct.body,
        "the oblivious answer is the direct answer"
    );
    // A route off the list is refused by the dispatch, through the same relay.
    let (wire, ctx) = seal_request(
        &client_cfg,
        InnerRequest {
            method: "POST".into(),
            path: "/api/vault".into(),
            content_type: "application/json".into(),
            read_key: None,
            body: b"{}".to_vec(),
            date_unix: now(),
        },
    )
    .unwrap();
    let r = post(port, &wire);
    let (status, _, _) = open_response(ctx, &r.body).unwrap();
    assert!(status >= 400, "creation must not be reachable obliviously");
    let _ = std::fs::remove_dir_all(&dir);
}

// ---------- the secret, slow connections, the proxy setting ----------

#[test]
fn the_relay_secret_is_checked_when_it_is_set() {
    let g = || Gateway::parse("http://127.0.0.1:1/api/ohttp", &GatewayOptions::plain()).unwrap();
    assert!(g().with_secret("short").is_err());
    assert!(g().with_secret("has a space in it, long enough").is_err());
    assert!(g().with_secret("line\r\nbreak-long-enough-secret").is_err());
    assert!(g().with_secret("héllo-not-ascii-but-long-enough").is_err());
    assert!(g().with_secret(SECRET).is_ok());
}

/// A body that stops arriving is cut, and while it dribbles it holds neither the relay nor
/// more than its address's share of it.
#[test]
fn a_slow_body_is_cut_and_does_not_hold_the_relay() {
    let gw = fake_gateway(Mode::Fixed(200, "message/ohttp-res", vec![0u8; 1024]));
    // One address may have one request in flight.
    let port = start_relay_with(
        &gw,
        600,
        Duration::from_secs(5),
        Limits {
            per_address: 1,
            ..Limits::default()
        },
        Duration::from_secs(1),
        Duration::from_secs(2),
    );
    let slow_from = |ip: &str| {
        let mut s = TcpStream::connect(("127.0.0.1", port)).unwrap();
        s.set_read_timeout(Some(Duration::from_secs(12))).unwrap();
        s.write_all(
            format!(
                "POST /relay HTTP/1.1\r\nHost: relay.test\r\nContent-Type: message/ohttp-req\r\nX-Forwarded-For: {ip}\r\nContent-Length: 4096\r\n\r\n0123456789"
            )
            .as_bytes(),
        )
        .unwrap();
        s
    };
    let started = std::time::Instant::now();
    let mut slow = slow_from("198.51.100.1");
    std::thread::sleep(Duration::from_millis(300));
    // The same address cannot take a second share.
    let again = request(
        "127.0.0.1",
        port,
        "POST",
        RELAY_PATH,
        &[
            ("Content-Type", "message/ohttp-req"),
            ("X-Forwarded-For", "198.51.100.1"),
        ],
        &[1u8; 64],
    );
    assert_eq!(again.status, 429, "a second request from the slow address");
    // Another address is served while the slow one is still holding its worker.
    let other = request(
        "127.0.0.1",
        port,
        "POST",
        RELAY_PATH,
        &[
            ("Content-Type", "message/ohttp-req"),
            ("X-Forwarded-For", "198.51.100.2"),
        ],
        &[1u8; 64],
    );
    assert_eq!(other.status, 200);
    // The slow connection is answered 408 or closed, well inside what the client would wait.
    let mut raw = Vec::new();
    let _ = slow.read_to_end(&mut raw);
    let took = started.elapsed();
    assert!(took < Duration::from_secs(8), "cut after {took:?}");
    let head = String::from_utf8_lossy(&raw).to_string();
    assert!(raw.is_empty() || head.starts_with("HTTP/1.1 408"), "{head}");
    // Its slot is free again afterwards.
    let after = request(
        "127.0.0.1",
        port,
        "POST",
        RELAY_PATH,
        &[
            ("Content-Type", "message/ohttp-req"),
            ("X-Forwarded-For", "198.51.100.1"),
        ],
        &[1u8; 64],
    );
    assert_eq!(after.status, 200);
    assert_eq!(
        gw.seen.lock().unwrap().len(),
        2,
        "only the two complete requests reached the gateway"
    );
}

/// A connection that never finishes its headers is let go too.
#[test]
fn a_connection_that_never_finishes_its_headers_is_let_go() {
    let gw = fake_gateway(Mode::Fixed(200, "message/ohttp-res", vec![0u8; 1024]));
    let port = start_relay_with(
        &gw,
        600,
        Duration::from_secs(5),
        Limits::default(),
        Duration::from_secs(1),
        Duration::from_secs(2),
    );
    let mut s = TcpStream::connect(("127.0.0.1", port)).unwrap();
    s.set_read_timeout(Some(Duration::from_secs(10))).unwrap();
    s.write_all(b"POST /relay HTTP/1.1\r\nHost: relay.test\r\nX-Slow: ")
        .unwrap();
    let started = std::time::Instant::now();
    let mut raw = Vec::new();
    let _ = s.read_to_end(&mut raw);
    assert!(
        started.elapsed() < Duration::from_secs(6),
        "held for {:?}",
        started.elapsed()
    );
    // The relay is still there.
    assert_eq!(post(port, &[1u8; 64]).status, 200);
}

/// The proxy setting has no default.
#[test]
fn relay_requires_proxy_hops() {
    use std::ffi::OsStr;
    assert!(konclave_ohttp_relay::require_hops_choice(None).is_err());
    assert!(konclave_ohttp_relay::require_hops_choice(Some(OsStr::new(""))).is_err());
    // A blank value is "not chosen" too, and a value the shared parser refuses is refused here.
    for bad in [" ", "\t", "abc", "-1", "9", "1 2"] {
        assert!(
            konclave_ohttp_relay::require_hops_choice(Some(OsStr::new(bad))).is_err(),
            "{bad:?}"
        );
    }
    for ok in ["0", "1", "2"] {
        assert!(konclave_ohttp_relay::require_hops_choice(Some(OsStr::new(ok))).is_ok());
    }
    let run = |hops: Option<&str>, secret: bool| {
        let mut c = std::process::Command::new(env!("CARGO_BIN_EXE_konclave-ohttp-relay"));
        c.env_clear()
            .env("KONCLAVE_OHTTP_GATEWAY", "http://127.0.0.1:1/api/ohttp")
            .env("PORT", "0");
        if let Some(h) = hops {
            c.env("KONCLAVE_TRUSTED_PROXY_HOPS", h);
        }
        if secret {
            c.env("KONCLAVE_OHTTP_RELAY_SECRET", SECRET);
        }
        let out = c.output().unwrap();
        (
            out.status.code(),
            String::from_utf8_lossy(&out.stderr).to_string(),
        )
    };
    // Everything else set, the hops not: the relay does not start, and says which variable.
    let (code, err) = run(None, true);
    assert_eq!(code, Some(2), "{err}");
    assert!(err.contains("KONCLAVE_TRUSTED_PROXY_HOPS"), "{err}");
    for blank in ["", " "] {
        let (code, err) = run(Some(blank), true);
        assert_eq!(code, Some(2), "{blank:?}: {err}");
        assert!(err.contains("KONCLAVE_TRUSTED_PROXY_HOPS"), "{err}");
        assert!(
            !err.contains("counts a client by"),
            "{blank:?} booted: {err}"
        );
    }
    // With 0 it gets past that check (and stops on the next thing missing).
    let (code, err) = run(Some("0"), false);
    assert_eq!(code, Some(2), "{err}");
    assert!(err.contains("KONCLAVE_OHTTP_RELAY_SECRET"), "{err}");
    assert!(!err.contains("must be set explicitly"), "{err}");
}

// ---------- idle connections and a flood on any path ----------

/// Connections that send nothing, all from one address, must not stall a
/// client at another address. With one thread per connection, four idle sockets held all four
/// workers for the whole head deadline.
#[test]
fn idle_connections_from_one_address_do_not_stall_another_client() {
    let client_host = "127.0.0.2";
    let gw = fake_gateway(Mode::Fixed(200, "message/ohttp-res", vec![0u8; 1024]));
    let port = start_relay_with(
        &gw,
        600,
        Duration::from_secs(5),
        Limits::default(),
        Duration::from_secs(5),
        Duration::from_secs(10),
    );
    if TcpStream::connect((client_host, port)).is_err() {
        eprintln!("skipped: {client_host} is not a loopback address here");
        return;
    }
    // Eight connections that open and say nothing (twice the workers of the old reader).
    let idle: Vec<TcpStream> = (0..8)
        .map(|_| TcpStream::connect(("127.0.0.1", port)).unwrap())
        .collect();
    std::thread::sleep(Duration::from_millis(200));
    let started = std::time::Instant::now();
    let mut s = TcpStream::connect((client_host, port)).unwrap();
    s.set_read_timeout(Some(Duration::from_secs(1))).unwrap();
    let body = [1u8; 64];
    let head = format!(
        "POST {RELAY_PATH} HTTP/1.1\r\nHost: relay.test\r\nContent-Type: message/ohttp-req\r\nContent-Length: {}\r\n\r\n",
        body.len()
    );
    s.write_all(head.as_bytes()).unwrap();
    s.write_all(&body).unwrap();
    let mut raw = Vec::new();
    let _ = s.read_to_end(&mut raw);
    let took = started.elapsed();
    assert!(
        raw.starts_with(b"HTTP/1.1 200"),
        "another client got no answer in {took:?} behind {} idle connections: {:?}",
        idle.len(),
        String::from_utf8_lossy(&raw)
    );
    assert!(took < Duration::from_secs(1), "answered after {took:?}");
}

/// The flood limit applies to every request, not only `POST /relay`.
/// 100 `GET /nope` from one address: the 61st and every one after it is a 429.
#[test]
fn a_flood_of_unknown_paths_from_one_address_gets_429() {
    let gw = fake_gateway(Mode::Fixed(200, "message/ohttp-res", vec![0u8; 1024]));
    let port = start_relay(&gw, 60, Duration::from_secs(5));
    let statuses: Vec<u16> = (0..100)
        .map(|_| request("127.0.0.1", port, "GET", "/nope", &[], b"").status)
        .collect();
    assert!(
        statuses[..60].iter().all(|s| *s == 404),
        "the first 60 are answered: {statuses:?}"
    );
    assert!(
        statuses[60..].iter().all(|s| *s == 429),
        "from the 61st every request is refused: {statuses:?}"
    );
}

// ---------- the caps (bounds) ----------

/// A connection whose SOURCE address is `src` (a loopback address of its own on Linux), or `None`
/// where that is not possible.
fn connect_from(src: &str, port: u16) -> Option<TcpStream> {
    let rt = tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
        .ok()?;
    let std_stream = rt.block_on(async {
        let sock = tokio::net::TcpSocket::new_v4().ok()?;
        sock.bind(format!("{src}:0").parse().ok()?).ok()?;
        sock.connect(format!("127.0.0.1:{port}").parse().ok()?)
            .await
            .ok()?
            .into_std()
            .ok()
    })?;
    std_stream.set_nonblocking(false).ok()?;
    Some(std_stream)
}

/// Open `n` connections that say nothing. A connection the relay refuses at accept is closed with
/// not a byte read or written (a flood must not cost the relay an answer each): the client sees it
/// end at once. One that is kept is still open after `wait`. Returns (closed, kept).
fn refused_among_idle(port: u16, n: usize, wait: Duration) -> (usize, Vec<TcpStream>) {
    let mut kept = Vec::new();
    let mut refused = 0;
    for _ in 0..n {
        let mut s = TcpStream::connect(("127.0.0.1", port)).unwrap();
        s.set_read_timeout(Some(wait)).unwrap();
        let mut buf = [0u8; 64];
        match s.read(&mut buf) {
            // Closed (EOF or a reset): refused.
            Ok(0) => refused += 1,
            Err(e)
                if !matches!(
                    e.kind(),
                    std::io::ErrorKind::WouldBlock | std::io::ErrorKind::TimedOut
                ) =>
            {
                refused += 1;
            }
            _ => kept.push(s),
        }
    }
    (refused, kept)
}

/// One socket address may not hold the relay's connections: past `per_peer_connections` its new
/// connections are refused at accept, while another address is served at once.
#[test]
fn one_address_cannot_hold_more_than_its_share_of_connections() {
    let gw = fake_gateway(Mode::Fixed(200, "message/ohttp-res", vec![0u8; 1024]));
    let port = start_relay_with(
        &gw,
        600,
        Duration::from_secs(5),
        Limits {
            per_peer_connections: 8,
            ..Limits::default()
        },
        Duration::from_secs(5),
        Duration::from_secs(10),
    );
    let (refused, kept) = refused_among_idle(port, 40, Duration::from_millis(150));
    assert_eq!(
        kept.len(),
        8,
        "exactly the share is kept, {refused} refused"
    );
    assert_eq!(refused, 32);
    // Another SOURCE address (the kernel would pick 127.0.0.1 for a plain connect to 127.0.0.2,
    // so the socket is bound first) is served at once.
    if let Some(mut s) = connect_from("127.0.0.2", port) {
        let started = std::time::Instant::now();
        s.set_read_timeout(Some(Duration::from_secs(3))).unwrap();
        let body = [1u8; 64];
        s.write_all(
            format!(
                "POST /relay HTTP/1.1\r\nHost: r\r\nContent-Type: message/ohttp-req\r\nContent-Length: {}\r\n\r\n",
                body.len()
            )
            .as_bytes(),
        )
        .unwrap();
        s.write_all(&body).unwrap();
        let mut raw = Vec::new();
        let _ = s.read_to_end(&mut raw);
        assert!(
            raw.starts_with(b"HTTP/1.1 200"),
            "{}",
            String::from_utf8_lossy(&raw)
        );
        assert!(started.elapsed() < Duration::from_secs(1));
    }
    drop(kept);
}

/// The head cap and the global cap are each their own number: past either, a new connection is
/// closed at accept before a byte is read; after the head deadline the idle ones are gone and the
/// relay takes connections again.
#[test]
fn the_head_cap_and_the_global_cap_each_refuse_at_accept() {
    for limits in [
        Limits {
            heads: 3,
            connections: 100,
            per_peer_connections: 100,
            ..Limits::default()
        },
        Limits {
            heads: 100,
            connections: 3,
            per_peer_connections: 100,
            ..Limits::default()
        },
    ] {
        let gw = fake_gateway(Mode::Fixed(200, "message/ohttp-res", vec![0u8; 1024]));
        let port = start_relay_with(
            &gw,
            600,
            Duration::from_secs(5),
            limits,
            Duration::from_secs(1),
            Duration::from_secs(10),
        );
        let (refused, kept) = refused_among_idle(port, 6, Duration::from_millis(150));
        assert_eq!((kept.len(), refused), (3, 3), "{limits:?}");
        std::thread::sleep(Duration::from_millis(1500));
        assert_eq!(post(port, &[1u8; 64]).status, 200, "{limits:?}: free again");
        drop(kept);
    }
}

/// The body cap is small and separate: requests past their head that are reading a body or waiting
/// for the gateway. The one over it is refused 503 without its body being read, and a request that
/// is only refused (a 404) is not counted against it.
#[test]
fn the_body_cap_refuses_without_reading_the_body() {
    let gw = fake_gateway(Mode::Fixed(200, "message/ohttp-res", vec![0u8; 1024]));
    let port = start_relay_with(
        &gw,
        600,
        Duration::from_secs(5),
        Limits {
            bodies: 2,
            ..Limits::default()
        },
        Duration::from_secs(1),
        Duration::from_secs(3),
    );
    let slow = |ip: &str| {
        let mut s = TcpStream::connect(("127.0.0.1", port)).unwrap();
        s.set_read_timeout(Some(Duration::from_secs(8))).unwrap();
        s.write_all(
            format!(
                "POST /relay HTTP/1.1\r\nHost: relay.test\r\nContent-Type: message/ohttp-req\r\nX-Forwarded-For: {ip}\r\nContent-Length: 4096\r\n\r\n0123456789"
            )
            .as_bytes(),
        )
        .unwrap();
        s
    };
    let (_a, _b) = (slow("198.51.100.11"), slow("198.51.100.12"));
    std::thread::sleep(Duration::from_millis(300));
    let started = std::time::Instant::now();
    let third = request(
        "127.0.0.1",
        port,
        "POST",
        RELAY_PATH,
        &[
            ("Content-Type", "message/ohttp-req"),
            ("X-Forwarded-For", "198.51.100.13"),
        ],
        &[1u8; 64],
    );
    assert_eq!(third.status, 503, "{}", text(&third));
    assert!(text(&third).contains("relay_busy"));
    assert!(started.elapsed() < Duration::from_secs(2));
    let nope = request(
        "127.0.0.1",
        port,
        "GET",
        "/nope",
        &[("X-Forwarded-For", "198.51.100.14")],
        b"",
    );
    assert_eq!(nope.status, 404, "a refusal is not a body in flight");
    assert!(gw.seen.lock().unwrap().is_empty());
}

/// The connection as a whole is bounded, whatever it is doing: a gateway that never answers, with
/// a call timeout longer than the connection's, still frees the connection at its deadline.
#[test]
fn the_connection_deadline_closes_a_connection_whatever_it_is_waiting_for() {
    let gw = fake_gateway(Mode::Silent);
    let port = start_relay_inbound(
        &gw,
        600,
        Duration::from_secs(10),
        Limits::default(),
        Inbound {
            connection_deadline: Duration::from_millis(800),
            ..Inbound::default()
        },
    );
    let started = std::time::Instant::now();
    let mut s = TcpStream::connect(("127.0.0.1", port)).unwrap();
    s.set_read_timeout(Some(Duration::from_secs(8))).unwrap();
    let body = [1u8; 64];
    s.write_all(
        format!(
            "POST /relay HTTP/1.1\r\nHost: r\r\nContent-Type: message/ohttp-req\r\nContent-Length: {}\r\n\r\n",
            body.len()
        )
        .as_bytes(),
    )
    .unwrap();
    s.write_all(&body).unwrap();
    let mut raw = Vec::new();
    let _ = s.read_to_end(&mut raw);
    assert!(raw.is_empty(), "{}", String::from_utf8_lossy(&raw));
    assert!(
        started.elapsed() < Duration::from_secs(3),
        "{:?}",
        started.elapsed()
    );
}

// ---------- the body cap on the wire, and a large answer ----------

/// The body is exactly what the length says: bytes sent beyond it are never forwarded, and a body
/// of exactly the cap goes through while one byte over is refused from the head.
#[test]
fn the_body_cap_holds_on_the_wire() {
    let gw = fake_gateway(Mode::Fixed(200, "message/ohttp-res", vec![7u8; 1024]));
    let port = start_relay(&gw, 600, Duration::from_secs(5));
    // 64 declared, 4096 sent.
    let mut sent = b"POST /relay HTTP/1.1\r\nHost: r\r\nContent-Type: message/ohttp-req\r\nContent-Length: 64\r\n\r\n".to_vec();
    sent.extend_from_slice(&[9u8; 4096]);
    let raw = raw_exchange(port, &sent);
    assert_eq!(
        status_of(&raw),
        Some(200),
        "{}",
        String::from_utf8_lossy(&raw)
    );
    {
        let seen = gw.seen.lock().unwrap();
        assert_eq!(seen.len(), 1);
        assert_eq!(
            body_of(&seen[0].raw),
            &[9u8; 64][..],
            "only what was declared"
        );
    }
    // One byte over the cap is refused on the head; the body is not needed to say so.
    let over = request(
        "127.0.0.1",
        port,
        "POST",
        RELAY_PATH,
        &[
            ("Content-Type", "message/ohttp-req"),
            ("Content-Length", &(MAX_REQUEST_BODY + 1).to_string()),
        ],
        b"",
    );
    assert_eq!(over.status, 413);
    // A declared length of 0 is its own refusal, and a body shorter than declared is not forwarded.
    let empty = request(
        "127.0.0.1",
        port,
        "POST",
        RELAY_PATH,
        &[("Content-Type", "message/ohttp-req")],
        b"",
    );
    assert_eq!(empty.status, 400);
    let short = raw_exchange(
        port,
        b"POST /relay HTTP/1.1\r\nHost: r\r\nContent-Type: message/ohttp-req\r\nContent-Length: 500\r\n\r\nonly-a-few",
    );
    assert_ne!(status_of(&short), Some(200));
    assert_eq!(
        gw.seen.lock().unwrap().len(),
        1,
        "nothing else went upstream"
    );
}

/// An answer much larger than the head buffer comes back whole: the 16 KiB buffer is for heads.
#[test]
fn a_large_answer_comes_back_whole() {
    let big: Vec<u8> = (0..5 * 1024 * 1024)
        .map(|i: usize| (i % 251) as u8)
        .collect();
    let gw = fake_gateway(Mode::Fixed(200, "message/ohttp-res", big.clone()));
    let port = start_relay(&gw, 600, Duration::from_secs(10));
    let r = post(port, &[1u8; 4096]);
    assert_eq!(r.status, 200);
    assert_eq!(r.body.len(), big.len());
    assert!(r.body == big);
}

// ---------- malformed requests (the reader table) ----------

fn raw_exchange(port: u16, bytes: &[u8]) -> Vec<u8> {
    let mut s = TcpStream::connect(("127.0.0.1", port)).unwrap();
    s.set_read_timeout(Some(Duration::from_secs(4))).unwrap();
    let _ = s.write_all(bytes);
    let mut raw = Vec::new();
    let _ = s.read_to_end(&mut raw);
    raw
}

fn status_of(raw: &[u8]) -> Option<u16> {
    let line = std::str::from_utf8(raw.get(..12)?).ok()?;
    line.strip_prefix("HTTP/1.1 ")?.get(..3)?.parse().ok()
}

fn valid_head(extra: &str, length: &str) -> Vec<u8> {
    format!(
        "POST /relay HTTP/1.1\r\nHost: r\r\nContent-Type: message/ohttp-req\r\n{extra}Content-Length: {length}\r\n\r\n"
    )
    .into_bytes()
}

/// Every malformed or ambiguous request is refused or dropped, and NOTHING of it reaches the
/// gateway. Each row is a request, and what it must be answered with when it is answered at all.
#[test]
fn malformed_requests_are_refused_and_nothing_reaches_the_gateway() {
    let gw = fake_gateway(Mode::Fixed(200, "message/ohttp-res", vec![0u8; 64]));
    let port = start_relay(&gw, 100_000, Duration::from_secs(5));
    let body = [5u8; 16];
    let with_body = |mut head: Vec<u8>| {
        head.extend_from_slice(&body);
        head
    };
    let mut table: Vec<(&str, Vec<u8>, &[u16])> = Vec::new();
    // Header injection and bad syntax.
    table.push((
        "obs-fold continuation line",
        with_body(valid_head("X-A: v\r\n X-B: w\r\n", "16")),
        &[400],
    ));
    // hyper's parser (httparse) takes a bare LF as a line end, as RFC 9112 allows a recipient to.
    // These are therefore VALID requests, read the same way by the relay as the CRLF form (a second
    // header, not a longer value), and the rows below say that: accepted, and what reaches the
    // gateway is the same four headers. The hand-written reader refused them.
    table.push((
        "a request with bare LF line ends",
        with_body(b"POST /relay HTTP/1.1\nHost: r\nContent-Type: message/ohttp-req\nContent-Length: 16\n\n".to_vec()),
        &[200],
    ));
    table.push((
        "bare LF splitting a header into two",
        with_body(valid_head("X-A: v\nX-B: w\r\n", "16")),
        &[200],
    ));
    table.push((
        "bare CR inside a value",
        with_body(valid_head("X-A: v\rX-B: w\r\n", "16")),
        &[400],
    ));
    table.push((
        "NUL in a value",
        with_body(valid_head("X-A: v\0w\r\n", "16")),
        &[400],
    ));
    table.push((
        "NUL in a name",
        with_body(valid_head("X\0Y: 1\r\n", "16")),
        &[400],
    ));
    table.push((
        "space before the colon",
        with_body(valid_head("X-A : v\r\n", "16")),
        &[400],
    ));
    table.push(("no colon", with_body(valid_head("X-A\r\n", "16")), &[400]));
    table.push((
        "a header name that is not ASCII",
        with_body(valid_head("X-\u{e9}: v\r\n", "16")),
        &[400],
    ));
    table.push((
        "a non-ASCII content type",
        with_body(
            b"POST /relay HTTP/1.1\r\nHost: r\r\nContent-Type: message/ohttp-req\xff\r\nContent-Length: 16\r\n\r\n"
                .to_vec(),
        ),
        &[400, 415],
    ));
    table.push((
        "a request line of four parts",
        with_body(b"POST /relay extra HTTP/1.1\r\nHost: r\r\n\r\n".to_vec()),
        &[400],
    ));
    table.push((
        "an HTTP version that is not one",
        with_body(b"POST /relay HTTP/9.9\r\nHost: r\r\n\r\n".to_vec()),
        &[400, 505],
    ));
    table.push((
        "thirty-three headers",
        with_body(valid_head(
            &(0..33)
                .map(|i| format!("X-H{i}: v\r\n"))
                .collect::<String>(),
            "16",
        )),
        &[400, 431],
    ));
    table.push((
        "a head larger than 16 KiB",
        with_body(valid_head(
            &format!("X-Big: {}\r\n", "a".repeat(17 * 1024)),
            "16",
        )),
        &[400, 431],
    ));
    // Length framing.
    // hyper folds identical repeats into ONE length (RFC 9112 section 6.3 allows it), so the
    // service never sees two. The row says what that comes to: one length, one body, forwarded once.
    table.push((
        "duplicate Content-Length, equal (folded to one by hyper)",
        with_body(valid_head("Content-Length: 16\r\n", "16")),
        &[200],
    ));
    table.push((
        "duplicate Content-Length, different",
        with_body(valid_head("Content-Length: 99\r\n", "16")),
        &[400, 411],
    ));
    table.push((
        "Content-Length and Transfer-Encoding",
        with_body(valid_head("Transfer-Encoding: chunked\r\n", "16")),
        &[400, 411],
    ));
    table.push((
        "Transfer-Encoding alone, chunked",
        b"POST /relay HTTP/1.1\r\nHost: r\r\nContent-Type: message/ohttp-req\r\nTransfer-Encoding: chunked\r\n\r\n10\r\n0123456789abcdef\r\n0\r\n\r\n".to_vec(),
        &[400, 411],
    ));
    table.push((
        "Transfer-Encoding: identity",
        b"POST /relay HTTP/1.1\r\nHost: r\r\nContent-Type: message/ohttp-req\r\nTransfer-Encoding: identity\r\n\r\n".to_vec(),
        &[400, 411, 501],
    ));
    for (label, cl) in [
        ("a plus sign", "+16"),
        ("a minus sign", "-16"),
        ("hex", "0x10"),
        ("a space inside", "1 6"),
        ("a list", "16, 16"),
        ("a decimal point", "16.0"),
        ("an empty value", ""),
        ("trailing text", "16abc"),
        ("a number that overflows", "99999999999999999999999"),
        ("a non-ASCII digit", "\u{661}\u{666}"),
    ] {
        table.push((label, with_body(valid_head("", cl)), &[400, 411, 413]));
    }
    // Expect.
    table.push((
        "Expect: 100-continue",
        valid_head("Expect: 100-continue\r\n", "16"),
        &[417],
    ));
    table.push((
        "Expect: anything",
        with_body(valid_head("Expect: nonsense\r\n", "16")),
        &[417],
    ));
    // Routing and method, with a body that must not be forwarded.
    table.push((
        "a lower-case method",
        with_body(b"post /relay HTTP/1.1\r\nHost: r\r\nContent-Type: message/ohttp-req\r\nContent-Length: 16\r\n\r\n".to_vec()),
        &[400, 405],
    ));
    table.push((
        "a path with a dot segment",
        with_body(b"POST /relay/../relay HTTP/1.1\r\nHost: r\r\nContent-Type: message/ohttp-req\r\nContent-Length: 16\r\n\r\n".to_vec()),
        &[404],
    ));
    table.push((
        "an upgrade request",
        with_body(valid_head(
            "Connection: Upgrade\r\nUpgrade: websocket\r\n",
            "16",
        ))
        .into_iter()
        .collect::<Vec<u8>>(),
        &[200],
    ));
    let mut wrong = Vec::new();
    for (label, request_bytes, allowed) in &table {
        let before = gw.seen.lock().unwrap().len();
        let raw = raw_exchange(port, request_bytes);
        let got = status_of(&raw);
        let reached = gw.seen.lock().unwrap().len() - before;
        if *allowed == [200] {
            // A valid request read the way the CRLF form is read: it goes through, once. An
            // upgrade request is ignored, never honoured (no 101, no upgrade header back).
            let lower = String::from_utf8_lossy(&raw).to_ascii_lowercase();
            if got != Some(200) || reached != 1 || lower.contains("upgrade:") {
                wrong.push(format!(
                    "{label}: expected a plain 200, got {got:?}, reached {reached}"
                ));
            }
            continue;
        }
        if got == Some(200) || reached != 0 {
            wrong.push(format!(
                "{label}: answered {got:?}, reached the gateway {reached}x"
            ));
        } else if let Some(g) = got {
            if !allowed.contains(&g) {
                wrong.push(format!(
                    "{label}: answered {g}, expected one of {allowed:?}"
                ));
            }
        }
    }
    assert!(wrong.is_empty(), "{}", wrong.join("\n"));
    // After all of it the relay still serves.
    assert_eq!(post(port, &[1u8; 64]).status, 200);
}

/// Two requests in one packet: the first is answered and the connection is closed. The second is
/// never read as a request, and never reaches the gateway.
#[test]
fn pipelined_requests_are_not_served() {
    let gw = fake_gateway(Mode::Fixed(200, "message/ohttp-res", vec![0u8; 64]));
    let port = start_relay(&gw, 600, Duration::from_secs(5));
    let mut two = valid_head("", "16");
    two.extend_from_slice(&[5u8; 16]);
    two.extend_from_slice(&valid_head("", "16"));
    two.extend_from_slice(&[6u8; 16]);
    let raw = raw_exchange(port, &two);
    let text = String::from_utf8_lossy(&raw).to_string();
    assert_eq!(text.matches("HTTP/1.1 ").count(), 1, "{text}");
    assert_eq!(status_of(&raw), Some(200));
    std::thread::sleep(Duration::from_millis(300));
    let seen = gw.seen.lock().unwrap();
    assert_eq!(seen.len(), 1);
    assert_eq!(body_of(&seen[0].raw), &[5u8; 16][..]);
}

/// A property test without the property-test crate (which is not in the lock): a couple of hundred heads
/// made by flipping, cutting, doubling and inserting bytes of valid ones, from a fixed seed. For
/// every one: the relay answers with a well-formed status or closes, it is still serving
/// afterwards, and whatever reaches the gateway carries exactly the four framing headers.
#[test]
fn mutated_requests_never_break_the_relay_or_the_strip() {
    let gw = fake_gateway(Mode::Fixed(200, "message/ohttp-res", vec![0u8; 64]));
    // Short deadlines: a head or body that was cut short is let go in a fraction of a second.
    let port = start_relay_with(
        &gw,
        1_000_000,
        Duration::from_secs(5),
        Limits::default(),
        Duration::from_millis(250),
        Duration::from_millis(400),
    );
    let mut state = 0x9e37_79b9_7f4a_7c15u64;
    let mut next = move || {
        state ^= state << 13;
        state ^= state >> 7;
        state ^= state << 17;
        state
    };
    let seeds: Vec<Vec<u8>> = vec![
        {
            let mut v = valid_head("X-Forwarded-For: 198.51.100.77\r\nCookie: c=1\r\n", "16");
            v.extend_from_slice(&[5u8; 16]);
            v
        },
        b"OPTIONS /relay HTTP/1.1\r\nHost: r\r\nOrigin: https://www.konclave.xyz\r\n\r\n".to_vec(),
        b"GET /nope HTTP/1.1\r\nHost: r\r\n\r\n".to_vec(),
    ];
    let inserts: [&[u8]; 8] = [
        b"\r\n",
        b"\n",
        b"\r",
        b"\0",
        b": ",
        b"Content-Length: 3\r\n",
        b"Transfer-Encoding: chunked\r\n",
        b"\xff\xfe",
    ];
    for round in 0..200 {
        let mut bytes = seeds[(next() % seeds.len() as u64) as usize].clone();
        for _ in 0..(1 + next() % 4) {
            let at = (next() % (bytes.len() as u64 + 1)) as usize;
            match next() % 5 {
                0 if !bytes.is_empty() => {
                    let at = at.min(bytes.len() - 1);
                    bytes[at] ^= 1 << (next() % 8);
                }
                1 => bytes.truncate(at),
                2 => {
                    let ins = inserts[(next() % inserts.len() as u64) as usize];
                    bytes.splice(at..at, ins.iter().copied());
                }
                3 if !bytes.is_empty() => {
                    let at = at.min(bytes.len() - 1);
                    bytes.remove(at);
                }
                _ => {
                    let dup = bytes[..at].to_vec();
                    bytes.extend_from_slice(&dup);
                }
            }
        }
        let raw = raw_exchange(port, &bytes);
        if !raw.is_empty() {
            assert!(
                status_of(&raw).is_some(),
                "round {round}: not an HTTP answer: {:?} for {:?}",
                String::from_utf8_lossy(&raw[..raw.len().min(40)]),
                String::from_utf8_lossy(&bytes)
            );
        }
    }
    assert_eq!(post(port, &[1u8; 64]).status, 200, "still serving");
    for s in gw.seen.lock().unwrap().iter() {
        let mut names = header_names(&s.raw);
        names.sort();
        assert_eq!(
            names,
            [
                "content-length",
                "content-type",
                "host",
                "x-konclave-relay-secret"
            ],
            "{:?}",
            String::from_utf8_lossy(&s.raw)
        );
        assert!(!String::from_utf8_lossy(&s.raw).contains("198.51.100.77"));
    }
}

// ---------- DNS, deadlines, panics ----------

/// The name is resolved once, at boot, and never on the request path.
#[test]
fn the_name_is_resolved_at_boot_and_never_per_request() {
    let gw = fake_gateway(Mode::Fixed(200, "message/ohttp-res", vec![0u8; 64]));
    let lookups = Arc::new(std::sync::atomic::AtomicUsize::new(0));
    let (count, addr) = (lookups.clone(), gw.addr);
    let gateway = Gateway::parse(
        "http://gateway.test:8080/api/ohttp",
        &GatewayOptions::plain(),
    )
    .unwrap()
    .with_secret(SECRET)
    .unwrap()
    .with_resolver(move |host, port| {
        assert_eq!((host, port), ("gateway.test", 8080));
        count.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
        Ok(vec![addr])
    });
    gateway.resolve().unwrap(); // boot
    assert_eq!(lookups.load(std::sync::atomic::Ordering::SeqCst), 1);
    let config = Config {
        gateway,
        allowed_origins: vec![],
        flood_max: 10_000,
        timeouts: Timeouts::default(),
        limits: Limits::default(),
        inbound: Inbound::default(),
    };
    let listener = TcpListener::bind("0.0.0.0:0").unwrap();
    let port = listener.local_addr().unwrap().port();
    let relay = Arc::new(Relay::new(config));
    std::thread::spawn(move || konclave_ohttp_relay::serve(listener, relay, 2));
    for _ in 0..100 {
        assert_eq!(post(port, &[1u8; 64]).status, 200);
    }
    assert_eq!(
        lookups.load(std::sync::atomic::Ordering::SeqCst),
        1,
        "100 requests, no lookup"
    );
    // A name that was never resolved is a typed 502, not a lookup on the spot.
    let unresolved = Gateway::parse("http://never.test/x", &GatewayOptions::plain())
        .unwrap()
        .with_secret(SECRET)
        .unwrap();
    let config = Config {
        gateway: unresolved,
        allowed_origins: vec![],
        flood_max: 10_000,
        timeouts: Timeouts::default(),
        limits: Limits::default(),
        inbound: Inbound::default(),
    };
    let listener = TcpListener::bind("0.0.0.0:0").unwrap();
    let port = listener.local_addr().unwrap().port();
    let relay = Arc::new(Relay::new(config));
    std::thread::spawn(move || konclave_ohttp_relay::serve(listener, relay, 2));
    let r = post(port, &[1u8; 64]);
    assert_eq!(r.status, 502);
    assert!(text(&r).contains("gateway_unreachable"));
}

/// Every deadline of the relay is under what the browser client waits, and the client's
/// number is read from its source, so the two cannot drift.
#[test]
fn every_deadline_is_under_what_the_client_waits() {
    use konclave_ohttp_relay::upstream::CLIENT_PATIENCE;
    let ui = std::fs::read_to_string(concat!(
        env!("CARGO_MANIFEST_DIR"),
        "/../ui/src/oblivious-transport.ts"
    ))
    .unwrap();
    assert!(
        ui.contains("opts.timeoutMs ?? 15_000"),
        "the client's wait moved: update CLIENT_PATIENCE and the relay's deadlines"
    );
    assert_eq!(CLIENT_PATIENCE, Duration::from_secs(15));
    let t = Timeouts::default();
    let i = Inbound::default();
    assert!(t.connect < t.total && t.total < CLIENT_PATIENCE, "{t:?}");
    assert!(i.connection_deadline < CLIENT_PATIENCE, "{i:?}");
    assert!(i.head_deadline <= Duration::from_secs(2) && i.head_deadline < i.body_deadline);
    assert!(i.body_deadline < i.connection_deadline);
}

/// A panic in one connection's task stays in that task.
#[test]
fn a_panic_in_a_connection_task_does_not_stop_the_relay() {
    let rt = tokio::runtime::Builder::new_multi_thread()
        .worker_threads(2)
        .enable_all()
        .build()
        .unwrap();
    rt.block_on(async {
        let bad = konclave_ohttp_relay::spawn_isolated(async { panic!("one connection") });
        assert!(bad.await.unwrap_err().is_panic());
        let (tx, rx) = tokio::sync::oneshot::channel();
        konclave_ohttp_relay::spawn_isolated(async move {
            let _ = tx.send(7);
        });
        assert_eq!(rx.await.unwrap(), 7, "the runtime goes on");
    });
    // Every connection is started through that function and no other, and the accept loop
    // survives an accept error (it sleeps and goes on).
    let lib = std::fs::read_to_string(concat!(env!("CARGO_MANIFEST_DIR"), "/src/lib.rs")).unwrap();
    let accept = lib
        .split("async fn accept_loop")
        .nth(1)
        .unwrap()
        .split("/// Serve one connection")
        .next()
        .unwrap();
    assert!(accept.contains("spawn_isolated("));
    assert!(!accept.contains("tokio::spawn(") && !accept.contains(".await;\n        });"));
    assert!(accept.contains("Err(_) => {") && accept.contains("continue;"));
    assert_eq!(
        lib.matches("tokio::spawn(").count(),
        2,
        "spawn_isolated itself, and the DNS refresh: no other task is started"
    );
}

// ---------- the binary's boot line ----------

/// Start the real binary and read its boot lines (it runs until killed).
fn boot_lines(env: &[(&str, &str)]) -> String {
    use std::io::BufRead;
    let mut c = std::process::Command::new(env!("CARGO_BIN_EXE_konclave-ohttp-relay"));
    c.env_clear()
        .env("KONCLAVE_TRUSTED_PROXY_HOPS", "0")
        .env("KONCLAVE_OHTTP_RELAY_SECRET", SECRET)
        .env("PORT", "0")
        .stderr(std::process::Stdio::piped())
        .stdout(std::process::Stdio::null());
    for (k, v) in env {
        c.env(k, v);
    }
    let mut child = c.spawn().unwrap();
    let stderr = child.stderr.take().unwrap();
    let (tx, rx) = std::sync::mpsc::channel();
    std::thread::spawn(move || {
        for line in std::io::BufReader::new(stderr)
            .lines()
            .map_while(Result::ok)
        {
            let _ = tx.send(line);
        }
    });
    let mut all = String::new();
    while let Ok(line) = rx.recv_timeout(Duration::from_secs(3)) {
        let done = line.contains("listening on port");
        all.push_str(&line);
        all.push('\n');
        if done {
            break;
        }
    }
    let _ = child.kill();
    let _ = child.wait();
    all
}

/// The boot says what the hop to the gateway is.
#[test]
fn the_binary_says_loudly_at_boot_when_the_hop_is_plain() {
    let plain = boot_lines(&[
        ("KONCLAVE_OHTTP_GATEWAY", "http://127.0.0.1:1/api/ohttp"),
        ("KONCLAVE_OHTTP_GATEWAY_INSECURE", "1"),
    ]);
    assert!(
        plain.contains("WARNING") && plain.contains("PLAIN HTTP"),
        "{plain}"
    );
    assert!(
        plain.contains("UNENCRYPTED") && !plain.contains(SECRET),
        "{plain}"
    );
    let tls = boot_lines(&[("KONCLAVE_OHTTP_GATEWAY", "https://127.0.0.1:1/api/ohttp")]);
    assert!(tls.contains("TLS 1.3") && !tls.contains("PLAIN"), "{tls}");
    // An http:// gateway without the opt-in does not start at all.
    let refused = boot_lines(&[("KONCLAVE_OHTTP_GATEWAY", "http://127.0.0.1:1/api/ohttp")]);
    assert!(
        refused.contains("in the clear") && !refused.contains("listening"),
        "{refused}"
    );
}

// ---------- bounds on bodies, `Expect` and answers ----------

/// A slow body: the head declares `declared` bytes, one byte arrives, and the connection is held.
fn hold_slow_body(port: u16, xff: &str, declared: usize) -> TcpStream {
    let mut s = TcpStream::connect(("127.0.0.1", port)).unwrap();
    s.set_read_timeout(Some(Duration::from_secs(8))).unwrap();
    s.write_all(
        format!(
            "POST /relay HTTP/1.1\r\nHost: relay.test\r\nContent-Type: message/ohttp-req\r\nX-Forwarded-For: {xff}\r\nContent-Length: {declared}\r\n\r\nx"
        )
        .as_bytes(),
    )
    .unwrap();
    s
}

/// About 32 slow bodies from 4 addresses of ONE /64 (a VPS hands out the whole prefix) must not
/// take every body slot: the next client, at an address of its own, is served, with the defaults.
/// The prefix is one client for the per-address caps.
#[test]
fn slow_bodies_from_one_prefix_do_not_take_the_relay_from_everyone() {
    let gw = fake_gateway(Mode::Fixed(200, "message/ohttp-res", vec![0u8; 1024]));
    let port = start_relay(&gw, 600, Duration::from_secs(5));
    let mut held = Vec::new();
    for host in 1..=4 {
        for _ in 0..8 {
            held.push(hold_slow_body(
                port,
                &format!("2001:db8:aaaa:bbbb::{host}"),
                2_000_000,
            ));
        }
    }
    std::thread::sleep(Duration::from_millis(400));
    let legit = request(
        "127.0.0.1",
        port,
        "POST",
        RELAY_PATH,
        &[
            ("Content-Type", "message/ohttp-req"),
            ("X-Forwarded-For", "2001:db8:1:1::9"),
        ],
        &[1u8; 64],
    );
    assert_eq!(
        legit.status,
        200,
        "{} slow bodies held, another client got {}",
        held.len(),
        text(&legit)
    );
}

/// Memory is bounded by bytes received, not by requests open. Bodies that really send
/// what they declare, from many prefixes, stop being admitted at the byte budget while a small
/// request is still served.
#[test]
fn bodies_are_bounded_by_bytes_received() {
    let gw = fake_gateway(Mode::Fixed(200, "message/ohttp-res", vec![0u8; 1024]));
    let port = start_relay_with(
        &gw,
        600,
        Duration::from_secs(5),
        Limits {
            body_bytes: 64 * 1024,
            per_address_bytes: 40 * 1024,
            ..Limits::default()
        },
        Duration::from_secs(2),
        Duration::from_secs(10),
    );
    let send_part = |xff: &str, part: usize| {
        let mut s = TcpStream::connect(("127.0.0.1", port)).unwrap();
        s.set_read_timeout(Some(Duration::from_secs(5))).unwrap();
        s.write_all(
            format!(
                "POST /relay HTTP/1.1\r\nHost: r\r\nContent-Type: message/ohttp-req\r\nX-Forwarded-For: {xff}\r\nContent-Length: 100000\r\n\r\n"
            )
            .as_bytes(),
        )
        .unwrap();
        s.write_all(&vec![5u8; part]).unwrap();
        s
    };
    // One address: 30 KiB in, then another 30 KiB from a second request is past its 40 KiB share.
    let _a = send_part("198.51.100.21", 30 * 1024);
    std::thread::sleep(Duration::from_millis(300));
    let mut b = send_part("198.51.100.21", 30 * 1024);
    let mut raw = Vec::new();
    let _ = b.read_to_end(&mut raw);
    assert_eq!(
        status_of(&raw),
        Some(503),
        "{}",
        String::from_utf8_lossy(&raw)
    );
    // Other addresses fill the global 64 KiB; then even a small body is refused, a head-only
    // request is not.
    let _c = send_part("198.51.100.22", 30 * 1024);
    std::thread::sleep(Duration::from_millis(300));
    let mut d = send_part("198.51.100.23", 20 * 1024);
    let mut raw = Vec::new();
    let _ = d.read_to_end(&mut raw);
    assert_eq!(
        status_of(&raw),
        Some(503),
        "global budget: {}",
        String::from_utf8_lossy(&raw)
    );
    let nope = request(
        "127.0.0.1",
        port,
        "GET",
        "/nope",
        &[("X-Forwarded-For", "198.51.100.24")],
        b"",
    );
    assert_eq!(nope.status, 404);
}

/// The body deadline follows the declared size. A 1 KiB body that has not arrived after a
/// couple of seconds is not a client, and does not keep its place for the flat deadline.
#[test]
fn a_small_declared_body_gets_a_short_deadline() {
    let gw = fake_gateway(Mode::Fixed(200, "message/ohttp-res", vec![0u8; 1024]));
    let port = start_relay_with(
        &gw,
        600,
        Duration::from_secs(5),
        Limits::default(),
        Duration::from_secs(2),
        Duration::from_secs(10),
    );
    let mut s = hold_slow_body(port, "198.51.100.31", 1024);
    let started = std::time::Instant::now();
    let mut raw = Vec::new();
    let _ = s.read_to_end(&mut raw);
    assert_eq!(
        status_of(&raw),
        Some(408),
        "{}",
        String::from_utf8_lossy(&raw)
    );
    assert!(
        started.elapsed() < Duration::from_secs(4),
        "cut after {:?}",
        started.elapsed()
    );
}

/// `Expect` on any path but `/relay` is refused before it is drained: no `100 Continue`.
#[test]
fn expect_on_another_path_gets_no_100_continue() {
    let gw = fake_gateway(Mode::Fixed(200, "message/ohttp-res", vec![0u8; 1024]));
    let port = start_relay(&gw, 600, Duration::from_secs(5));
    for (method, path) in [("POST", "/nope"), ("PUT", "/relay"), ("POST", "/")] {
        let raw = raw_exchange(
            port,
            format!(
                "{method} {path} HTTP/1.1\r\nHost: r\r\nExpect: 100-continue\r\nContent-Length: 10\r\n\r\n"
            )
            .as_bytes(),
        );
        let text = String::from_utf8_lossy(&raw);
        assert!(!text.contains("100 Continue"), "{method} {path}: {text}");
        assert!(text.starts_with("HTTP/1.1 4"), "{method} {path}: {text}");
    }
}

/// The gateway's answer is counted in the byte budget as it is read, so an answer that does not
/// fit is a 503 and not memory; and what an exchange held goes back when it ends, so the next one
/// of the same size is served.
#[test]
fn the_answer_is_counted_in_the_budget_and_given_back() {
    let gw = fake_gateway(Mode::Fixed(200, "message/ohttp-res", vec![3u8; 48 * 1024]));
    let tight = start_relay_with(
        &gw,
        600,
        Duration::from_secs(5),
        Limits {
            body_bytes: 16 * 1024,
            per_address_bytes: 16 * 1024,
            ..Limits::default()
        },
        Duration::from_secs(2),
        Duration::from_secs(10),
    );
    let r = post(tight, &[1u8; 64]);
    assert_eq!(r.status, 503, "{}", text(&r));
    assert!(text(&r).contains("relay_busy"));
    // Room for one answer at a time: the same request, three times in a row, is served each time.
    let room = start_relay_with(
        &gw,
        600,
        Duration::from_secs(5),
        Limits {
            body_bytes: 64 * 1024,
            per_address_bytes: 64 * 1024,
            ..Limits::default()
        },
        Duration::from_secs(2),
        Duration::from_secs(10),
    );
    for i in 0..3 {
        let r = post(room, &[1u8; 64]);
        assert_eq!(r.status, 200, "round {i}: {}", text(&r));
        assert_eq!(r.body.len(), 48 * 1024);
    }
}

/// 32 random bytes in hex, from the OS-seeded hasher: a key nobody has read.
fn fresh_key_hex() -> String {
    use std::hash::{BuildHasher, Hasher};
    (0..4)
        .map(|i| {
            let mut h = std::collections::hash_map::RandomState::new().build_hasher();
            h.write_u8(i);
            format!("{:016x}", h.finish())
        })
        .collect()
}

// ---------- the last bounds on the DoS surface ----------

/// A head that declares `declared` bytes and sends none of them.
fn hold_declared_nothing(port: u16, xff: &str, declared: usize) -> TcpStream {
    let mut s = TcpStream::connect(("127.0.0.1", port)).unwrap();
    s.set_read_timeout(Some(Duration::from_secs(8))).unwrap();
    s.write_all(
        format!(
            "POST /relay HTTP/1.1\r\nHost: relay.test\r\nContent-Type: message/ohttp-req\r\nX-Forwarded-For: {xff}\r\nContent-Length: {declared}\r\n\r\n"
        )
        .as_bytes(),
    )
    .unwrap();
    s
}

fn legit_from(port: u16, xff: &str) -> Reply {
    request(
        "127.0.0.1",
        port,
        "POST",
        RELAY_PATH,
        &[
            ("Content-Type", "message/ohttp-req"),
            ("X-Forwarded-For", xff),
        ],
        &[1u8; 64],
    )
}

/// A body that declares the most and sends nothing loses its place in about the
/// progress window, not at the 10 s a 2 MiB body is due.
#[test]
fn declared_large_and_nothing_sent_is_dropped_fast() {
    let gw = fake_gateway(Mode::Fixed(200, "message/ohttp-res", vec![0u8; 1024]));
    let port = start_relay(&gw, 600, Duration::from_secs(5));
    let mut s = hold_declared_nothing(port, "198.51.100.41", 2_000_000);
    let started = std::time::Instant::now();
    let mut raw = Vec::new();
    let _ = s.read_to_end(&mut raw);
    assert_eq!(
        status_of(&raw),
        Some(408),
        "{}",
        String::from_utf8_lossy(&raw)
    );
    assert!(
        started.elapsed() < Duration::from_millis(3500),
        "cut after {:?}",
        started.elapsed()
    );
}

/// The /64s of one /48 share the /48's body slots. Eight /64s of one /48 holding eight
/// declared bodies each cannot take the 64 slots of a relay with 64: the /48 holds at most
/// `per_prefix48`, and a client elsewhere is served.
#[test]
fn one_slash_48_cannot_take_every_body_slot() {
    let gw = fake_gateway(Mode::Fixed(200, "message/ohttp-res", vec![0u8; 1024]));
    let port = start_relay(&gw, 600, Duration::from_secs(5));
    let port = {
        let _ = port;
        start_relay_with(
            &gw,
            600,
            Duration::from_secs(5),
            Limits {
                bodies: 64,
                ..Limits::default()
            },
            Duration::from_secs(5),
            Duration::from_secs(10),
        )
    };
    let mut held = Vec::new();
    for net in 1..=8 {
        for _ in 0..8 {
            held.push(hold_declared_nothing(
                port,
                &format!("2001:db8:aaaa:{net}::1"),
                2_000_000,
            ));
        }
    }
    std::thread::sleep(Duration::from_millis(500));
    let legit = legit_from(port, "2001:db8:1:1::9");
    assert_eq!(
        legit.status,
        200,
        "{} bodies held from one /48, another client got {}",
        held.len(),
        text(&legit)
    );
}

/// 4 IPv4 clients, each with 8 bodies of 2 MiB less a byte, cannot take the whole 64 MiB, and a
/// fifth address is not answered 503. An address holds one body's worth of request bytes.
#[test]
fn four_ipv4_clients_cannot_take_the_byte_budget() {
    let gw = fake_gateway(Mode::Fixed(200, "message/ohttp-res", vec![0u8; 1024]));
    let port = start_relay(&gw, 600, Duration::from_secs(5));
    let held = fill_request_bytes(port, 4, 8);
    std::thread::sleep(Duration::from_millis(400));
    let legit = legit_from(port, "198.51.100.200");
    assert_eq!(
        legit.status,
        200,
        "{} held, got {}",
        held.len(),
        text(&legit)
    );
}

/// `addresses` IPv4 addresses, each opening `per_address` bodies of 2 MiB less a byte and stopping.
fn fill_request_bytes(port: u16, addresses: usize, per_address: usize) -> Vec<TcpStream> {
    let mut held = Vec::new();
    for a in 0..addresses {
        for _ in 0..per_address {
            let mut s = TcpStream::connect(("127.0.0.1", port)).unwrap();
            s.set_read_timeout(Some(Duration::from_secs(8))).unwrap();
            let len = MAX_REQUEST_BODY;
            let _ = s.write_all(
                format!(
                    "POST /relay HTTP/1.1\r\nHost: r\r\nContent-Type: message/ohttp-req\r\nX-Forwarded-For: 198.51.100.{}\r\nContent-Length: {len}\r\n\r\n",
                    a + 1
                )
                .as_bytes(),
            );
            let _ = s.write_all(&vec![7u8; len - 1]);
            held.push(s);
        }
    }
    held
}

/// The measured threshold of the request-byte reserve: 15 addresses holding 2 MiB each leave room,
/// 16 take the 32 MiB that request bodies may hold, and a 17th is refused. Answers keep the other
/// half of the budget either way.
#[test]
fn sixteen_addresses_is_what_it_takes_to_fill_the_request_reserve() {
    let gw = fake_gateway(Mode::Fixed(200, "message/ohttp-res", vec![0u8; 1024]));
    let port = start_relay(&gw, 600, Duration::from_secs(5));
    let _held = fill_request_bytes(port, 15, 1);
    std::thread::sleep(Duration::from_millis(800));
    assert_eq!(legit_from(port, "198.51.100.201").status, 200, "15 held");
    let port2 = start_relay(&gw, 600, Duration::from_secs(5));
    let _held2 = fill_request_bytes(port2, 16, 1);
    std::thread::sleep(Duration::from_millis(800));
    assert_eq!(
        legit_from(port2, "198.51.100.202").status,
        503,
        "16 held: the request reserve is full"
    );
}

/// Answers that are not read stay counted until the connection is done with them. With room
/// for two 15 MiB answers, two clients that never read hold them, and a third is refused. Before,
/// the budget was given back when hyper dropped the body, and every one of them was admitted.
#[test]
fn unread_answers_stay_in_the_budget() {
    let gw = fake_gateway(Mode::Fixed(
        200,
        "message/ohttp-res",
        vec![9u8; 15 * 1024 * 1024],
    ));
    let port = start_relay_with(
        &gw,
        600,
        Duration::from_secs(8),
        Limits {
            body_bytes: 40 * 1024 * 1024,
            per_address_bytes: 40 * 1024 * 1024,
            ..Limits::default()
        },
        Duration::from_secs(2),
        Duration::from_secs(10),
    );
    let mut sleepers = Vec::new();
    for i in 1..=2 {
        let mut s = TcpStream::connect(("127.0.0.1", port)).unwrap();
        s.write_all(
            format!(
                "POST /relay HTTP/1.1\r\nHost: r\r\nContent-Type: message/ohttp-req\r\nX-Forwarded-For: 198.51.100.{}\r\nContent-Length: 64\r\n\r\n",
                50 + i
            )
            .as_bytes(),
        )
        .unwrap();
        s.write_all(&[1u8; 64]).unwrap();
        sleepers.push(s);
        std::thread::sleep(Duration::from_millis(1500));
    }
    let third = legit_from(port, "198.51.100.60");
    assert_eq!(third.status, 503, "{}", third.body.len());
}

/// With the flood limit hit, `Expect` still gets no `100 Continue`.
#[test]
fn expect_gets_no_100_continue_when_the_flood_limit_is_hit() {
    let gw = fake_gateway(Mode::Fixed(200, "message/ohttp-res", vec![0u8; 1024]));
    let port = start_relay(&gw, 2, Duration::from_secs(5));
    for _ in 0..3 {
        let _ = legit_from(port, "198.51.100.71");
    }
    let raw = raw_exchange(
        port,
        b"POST /relay HTTP/1.1\r\nHost: r\r\nContent-Type: message/ohttp-req\r\nX-Forwarded-For: 198.51.100.71\r\nExpect: 100-continue\r\nContent-Length: 10\r\n\r\n",
    );
    let text = String::from_utf8_lossy(&raw);
    assert!(!text.contains("100 Continue"), "{text}");
    assert!(text.starts_with("HTTP/1.1 4"), "{text}");
}

/// A refused request's body is read for a moment, not for half a second: a client that
/// trickles one on a path that is not served is answered within the 200 ms drain.
#[test]
fn the_drain_is_short() {
    let gw = fake_gateway(Mode::Fixed(200, "message/ohttp-res", vec![0u8; 1024]));
    let port = start_relay(&gw, 600, Duration::from_secs(5));
    let mut s = TcpStream::connect(("127.0.0.1", port)).unwrap();
    s.set_read_timeout(Some(Duration::from_secs(4))).unwrap();
    s.write_all(
        b"POST /nope HTTP/1.1\r\nHost: r\r\nX-Forwarded-For: 198.51.100.81\r\nContent-Length: 1000000\r\n\r\nx",
    )
    .unwrap();
    let started = std::time::Instant::now();
    let mut raw = Vec::new();
    let _ = s.read_to_end(&mut raw);
    assert_eq!(status_of(&raw), Some(404));
    assert!(
        started.elapsed() < Duration::from_millis(350),
        "answered after {:?}",
        started.elapsed()
    );
}
