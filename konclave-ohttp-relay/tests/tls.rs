//! The relay's one outbound hop, over REAL TLS: a local gateway with certificates made at test time
//! (a CA, a leaf, an expired leaf, a leaf for another name, a second CA nobody trusts).
//!
//! Each test names the property it pins. The refusals assert `Failure::Untrusted`, which only a
//! certificate verdict produces, so a refusal cannot be satisfied by the port being shut. There is
//! no pin (see `upstream.rs`): the hop is WebPKI plus the host name, and one test says out loud
//! what that admits.

use std::io::{Read, Write};
use std::net::{SocketAddr, TcpListener, TcpStream};
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use konclave_ohttp_relay::upstream::{
    self, Answer, Failure, Gateway, GatewayOptions, Timeouts, INSECURE_VAR,
};
use konclave_ohttp_relay::{Config, Inbound, Relay, MAX_ANSWER, RELAY_PATH};
use rcgen::{
    date_time_ymd, BasicConstraints, CertificateParams, DistinguishedName, IsCa, Issuer, KeyPair,
    KeyUsagePurpose, SanType,
};
use rustls::pki_types::{CertificateDer, PrivateKeyDer};
use rustls::{RootCertStore, ServerConfig, StreamOwned};

/// The relay's call, driven from a test thread.
fn post_once(gw: &Gateway, body: &[u8], t: Timeouts, max: usize) -> Result<Answer, Failure> {
    tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
        .unwrap()
        .block_on(upstream::post_once(
            gw,
            hyper::body::Bytes::copy_from_slice(body),
            t,
            max,
            &|_| true,
        ))
}

const SECRET: &str = "relay-secret-for-the-tests-0123";
const ORIGIN: &str = "https://www.konclave.xyz";

// ---------- certificates ----------

struct Ca {
    cert_der: CertificateDer<'static>,
    key: KeyPair,
    params: CertificateParams,
}

fn make_ca(name: &str) -> Ca {
    let mut params = CertificateParams::default();
    params.is_ca = IsCa::Ca(BasicConstraints::Unconstrained);
    params.key_usages = vec![KeyUsagePurpose::KeyCertSign, KeyUsagePurpose::CrlSign];
    params.distinguished_name = DistinguishedName::new();
    params
        .distinguished_name
        .push(rcgen::DnType::CommonName, name);
    let key = KeyPair::generate().unwrap();
    let cert = params.self_signed(&key).unwrap();
    Ca {
        cert_der: cert.der().clone(),
        key,
        params,
    }
}

impl Ca {
    fn roots(&self) -> RootCertStore {
        let mut r = RootCertStore::empty();
        r.add(self.cert_der.clone()).unwrap();
        r
    }
}

struct Leaf {
    der: CertificateDer<'static>,
    key: KeyPair,
}

fn make_leaf(ca: &Ca, san: SanType, valid: Option<(i32, i32)>) -> Leaf {
    let mut params = CertificateParams::default();
    params.subject_alt_names = vec![san];
    params.is_ca = IsCa::NoCa;
    if let Some((from, to)) = valid {
        params.not_before = date_time_ymd(from, 1, 1);
        params.not_after = date_time_ymd(to, 1, 1);
    }
    let key = KeyPair::generate().unwrap();
    let issuer = Issuer::from_params(&ca.params, &ca.key);
    let cert = params.signed_by(&key, &issuer).unwrap();
    Leaf {
        der: cert.der().clone(),
        key,
    }
}

fn loopback() -> SanType {
    SanType::IpAddress("127.0.0.1".parse().unwrap())
}

// ---------- a TLS gateway ----------

#[derive(Clone)]
enum Mode {
    Ok,
    /// 302 to this URL.
    Redirect(String),
    /// 200 with `Content-Encoding: gzip`.
    Encoded,
    /// Complete the handshake and read the request, then say nothing.
    Silent,
    /// Answer 200 declaring 40 bytes, one byte every 150 ms.
    Drip,
    Status(u16),
    /// 200 with a chunked body.
    Chunked,
    /// 200 with no Content-Length, ended by closing.
    NoLength,
}

struct TlsGateway {
    addr: SocketAddr,
    /// The decrypted request of every connection that got as far as sending one.
    seen: Arc<Mutex<Vec<Vec<u8>>>>,
    /// TCP connections accepted, handshake or not.
    accepted: Arc<AtomicUsize>,
    /// The ALPN protocol each completed handshake settled on.
    alpn: Arc<Mutex<Vec<Option<Vec<u8>>>>>,
}

fn tls_gateway(leaf: &Leaf, mode: Mode) -> TlsGateway {
    tls_gateway_with(leaf, mode, &[&rustls::version::TLS13], Vec::new())
}

/// A TLS gateway that speaks only these protocol versions and offers these ALPN protocols.
fn tls_gateway_with(
    leaf: &Leaf,
    mode: Mode,
    versions: &[&'static rustls::SupportedProtocolVersion],
    alpn_offered: Vec<Vec<u8>>,
) -> TlsGateway {
    let provider = Arc::new(rustls::crypto::ring::default_provider());
    let mut server_config = ServerConfig::builder_with_provider(provider)
        .with_protocol_versions(versions)
        .unwrap()
        .with_no_client_auth()
        .with_single_cert(
            vec![leaf.der.clone()],
            PrivateKeyDer::Pkcs8(leaf.key.serialize_der().into()),
        )
        .unwrap();
    server_config.alpn_protocols = alpn_offered;
    let cfg = Arc::new(server_config);
    let alpn_seen = Arc::new(Mutex::new(Vec::new()));
    let alpn_log = alpn_seen.clone();
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    let addr = listener.local_addr().unwrap();
    let seen = Arc::new(Mutex::new(Vec::new()));
    let accepted = Arc::new(AtomicUsize::new(0));
    let (log, count) = (seen.clone(), accepted.clone());
    std::thread::spawn(move || {
        for conn in listener.incoming() {
            let Ok(tcp) = conn else { continue };
            count.fetch_add(1, Ordering::SeqCst);
            let (cfg, log, mode, alpn_log) =
                (cfg.clone(), log.clone(), mode.clone(), alpn_log.clone());
            std::thread::spawn(move || {
                let _ = tcp.set_read_timeout(Some(Duration::from_secs(5)));
                let Ok(conn) = rustls::ServerConnection::new(cfg) else {
                    return;
                };
                let mut s = StreamOwned::new(conn, tcp);
                let Some(raw) = read_request(&mut s) else {
                    return;
                };
                alpn_log
                    .lock()
                    .unwrap()
                    .push(s.conn.alpn_protocol().map(<[u8]>::to_vec));
                log.lock().unwrap().push(raw);
                let _ = answer(&mut s, &mode);
            });
        }
    });
    TlsGateway {
        addr,
        seen,
        accepted,
        alpn: alpn_seen,
    }
}

fn read_request(s: &mut impl Read) -> Option<Vec<u8>> {
    let mut raw = Vec::new();
    let mut buf = [0u8; 4096];
    loop {
        let n = s.read(&mut buf).ok()?;
        if n == 0 {
            return None;
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
                return Some(raw);
            }
        }
    }
}

fn answer(s: &mut impl Write, mode: &Mode) -> std::io::Result<()> {
    let body = b"sealed-answer";
    match mode {
        Mode::Ok => s.write_all(
            format!(
                "HTTP/1.1 200 OK\r\nContent-Type: message/ohttp-res\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
                body.len()
            )
            .as_bytes(),
        )
        .and_then(|()| s.write_all(body)),
        Mode::Status(c) => s.write_all(
            format!("HTTP/1.1 {c} X\r\nContent-Type: application/json\r\nContent-Length: 2\r\nConnection: close\r\n\r\n{{}}")
                .as_bytes(),
        ),
        Mode::Redirect(to) => s.write_all(
            format!("HTTP/1.1 302 Found\r\nLocation: {to}\r\nContent-Length: 0\r\nConnection: close\r\n\r\n")
                .as_bytes(),
        ),
        Mode::Encoded => s.write_all(
            b"HTTP/1.1 200 OK\r\nContent-Type: message/ohttp-res\r\nContent-Encoding: gzip\r\nContent-Length: 4\r\nConnection: close\r\n\r\nabcd",
        ),
        Mode::Chunked => s.write_all(
            b"HTTP/1.1 200 OK\r\nContent-Type: message/ohttp-res\r\nTransfer-Encoding: chunked\r\nConnection: close\r\n\r\n4\r\nabcd\r\n0\r\n\r\n",
        ),
        Mode::NoLength => s.write_all(
            b"HTTP/1.1 200 OK\r\nContent-Type: message/ohttp-res\r\nConnection: close\r\n\r\nabcd",
        ),
        Mode::Silent => {
            std::thread::sleep(Duration::from_secs(4));
            Ok(())
        }
        Mode::Drip => {
            s.write_all(
                b"HTTP/1.1 200 OK\r\nContent-Type: message/ohttp-res\r\nContent-Length: 40\r\nConnection: close\r\n\r\n",
            )?;
            for _ in 0..40 {
                std::thread::sleep(Duration::from_millis(150));
                s.write_all(b"x")?;
                s.flush()?;
            }
            Ok(())
        }
    }
}

fn gateway_for(gw: &TlsGateway, roots: RootCertStore) -> Gateway {
    Gateway::parse_with_roots(
        &format!("https://{}/api/ohttp", gw.addr),
        &GatewayOptions::default(),
        roots,
    )
    .unwrap()
    .with_secret(SECRET)
    .unwrap()
}

fn quick() -> Timeouts {
    Timeouts {
        connect: Duration::from_secs(2),
        total: Duration::from_secs(10),
    }
}

fn head_of(raw: &[u8]) -> String {
    let end = raw.windows(4).position(|w| w == b"\r\n\r\n").unwrap();
    String::from_utf8_lossy(&raw[..end]).to_string()
}

fn header_names(raw: &[u8]) -> Vec<String> {
    let mut v: Vec<String> = head_of(raw)
        .split("\r\n")
        .skip(1)
        .map(|l| l.split(':').next().unwrap().to_ascii_lowercase())
        .collect();
    v.sort();
    v
}

/// A listener that records whether anything ever connected to it.
fn spy() -> (SocketAddr, Arc<AtomicUsize>, Arc<Mutex<Vec<u8>>>) {
    let l = TcpListener::bind("127.0.0.1:0").unwrap();
    let addr = l.local_addr().unwrap();
    let hits = Arc::new(AtomicUsize::new(0));
    let bytes = Arc::new(Mutex::new(Vec::new()));
    let (h, b) = (hits.clone(), bytes.clone());
    std::thread::spawn(move || {
        for c in l.incoming() {
            let Ok(mut s) = c else { continue };
            h.fetch_add(1, Ordering::SeqCst);
            let _ = s.set_read_timeout(Some(Duration::from_millis(500)));
            let mut buf = [0u8; 4096];
            while let Ok(n) = s.read(&mut buf) {
                if n == 0 {
                    break;
                }
                b.lock().unwrap().extend_from_slice(&buf[..n]);
            }
        }
    });
    (addr, hits, bytes)
}

// ---------- the chain and the name ----------

#[test]
fn a_valid_chain_and_name_succeed_and_the_secret_arrives_over_tls() {
    let ca = make_ca("test root");
    let leaf = make_leaf(&ca, loopback(), None);
    let gw = tls_gateway(&leaf, Mode::Ok);
    let g = gateway_for(&gw, ca.roots());
    assert!(g.is_tls());
    let a = post_once(&g, &[9u8; 256], quick(), MAX_ANSWER).expect("answer");
    assert_eq!((a.status, a.body.as_slice()), (200, &b"sealed-answer"[..]));
    assert_eq!(a.content_type.as_deref(), Some("message/ohttp-res"));
    let seen = gw.seen.lock().unwrap();
    assert!(head_of(&seen[0])
        .to_ascii_lowercase()
        .contains(&format!("x-konclave-relay-secret: {SECRET}")));
    assert_eq!(
        gw.alpn.lock().unwrap().as_slice(),
        &[None],
        "a server that offers no protocol settles on none"
    );
}

/// What dropping the pin admits, written as a test so the decision cannot be forgotten: ANY
/// certificate that a trusted CA issues for the gateway's name is accepted, whoever holds its key.
/// The key of the gateway is not checked; the chain and the name are.
#[test]
fn any_trusted_ca_may_issue_for_the_gateway_name_and_that_is_the_decision() {
    let ca = make_ca("a root we trust");
    let another = make_ca("another root we trust");
    let mut roots = ca.roots();
    roots.add(another.cert_der.clone()).unwrap();
    // A second, unrelated leaf for the same name, from the second CA.
    let gw = tls_gateway(&make_leaf(&another, loopback(), None), Mode::Ok);
    let g = gateway_for(&gw, roots);
    assert!(post_once(&g, b"x", quick(), MAX_ANSWER).is_ok());
    // And with only the first CA trusted it is refused: the chain decides, not the key.
    let g = gateway_for(&gw, ca.roots());
    assert_eq!(
        post_once(&g, b"x", quick(), MAX_ANSWER),
        Err(Failure::Untrusted)
    );
}

#[test]
fn a_valid_chain_from_an_unknown_ca_fails() {
    let trusted = make_ca("the root we trust");
    let rogue = make_ca("a root nobody gave us");
    let leaf = make_leaf(&rogue, loopback(), None);
    let gw = tls_gateway(&leaf, Mode::Ok);
    let g = gateway_for(&gw, trusted.roots());
    assert_eq!(
        post_once(&g, b"x", quick(), MAX_ANSWER),
        Err(Failure::Untrusted)
    );
    assert!(gw.seen.lock().unwrap().is_empty());
    assert_eq!(
        gw.accepted.load(Ordering::SeqCst),
        1,
        "one attempt, no retry"
    );
}

#[test]
fn an_expired_certificate_fails() {
    let ca = make_ca("test root");
    let leaf = make_leaf(&ca, loopback(), Some((2020, 2021)));
    let gw = tls_gateway(&leaf, Mode::Ok);
    let g = gateway_for(&gw, ca.roots());
    assert_eq!(
        post_once(&g, b"x", quick(), MAX_ANSWER),
        Err(Failure::Untrusted)
    );
    assert!(gw.seen.lock().unwrap().is_empty());
}

#[test]
fn a_certificate_for_another_name_fails() {
    let ca = make_ca("test root");
    let leaf = make_leaf(
        &ca,
        SanType::DnsName("gateway.example".try_into().unwrap()),
        None,
    );
    let gw = tls_gateway(&leaf, Mode::Ok);
    // The relay dials 127.0.0.1; the certificate names gateway.example.
    let g = gateway_for(&gw, ca.roots());
    assert_eq!(
        post_once(&g, b"x", quick(), MAX_ANSWER),
        Err(Failure::Untrusted)
    );
    assert!(gw.seen.lock().unwrap().is_empty(), "no secret was sent");
}

#[test]
fn the_bundled_roots_do_not_trust_a_test_ca() {
    // The production path: `parse` uses the bundled roots, so a self-made CA is refused. The
    // host's trust store plays no part (nothing here installs the CA anywhere).
    let ca = make_ca("test root");
    let leaf = make_leaf(&ca, loopback(), None);
    let gw = tls_gateway(&leaf, Mode::Ok);
    let g = Gateway::parse(
        &format!("https://{}/api/ohttp", gw.addr),
        &GatewayOptions::default(),
    )
    .unwrap()
    .with_secret(SECRET)
    .unwrap();
    assert_eq!(
        post_once(&g, b"x", quick(), MAX_ANSWER),
        Err(Failure::Untrusted)
    );
    assert!(gw.seen.lock().unwrap().is_empty());
}

#[test]
fn only_tls_1_3_is_spoken_and_the_secret_never_goes_to_a_tls_1_2_server() {
    let ca = make_ca("test root");
    let leaf = make_leaf(&ca, loopback(), None);
    let gw = tls_gateway_with(&leaf, Mode::Ok, &[&rustls::version::TLS12], Vec::new());
    let g = gateway_for(&gw, ca.roots());
    let r = post_once(&g, b"x", quick(), MAX_ANSWER);
    assert!(r.is_err(), "{r:?}");
    assert!(gw.seen.lock().unwrap().is_empty(), "no secret reached it");
    assert_eq!(gw.accepted.load(Ordering::SeqCst), 1);
}

#[test]
fn alpn_is_http_1_1_even_when_the_server_prefers_h2() {
    let ca = make_ca("test root");
    let leaf = make_leaf(&ca, loopback(), None);
    // A server that lists h2 first would pick it if the client offered it. The client offers only
    // http/1.1, so the call works and settles on that.
    let gw = tls_gateway_with(
        &leaf,
        Mode::Ok,
        &[&rustls::version::TLS13],
        vec![b"h2".to_vec(), b"http/1.1".to_vec()],
    );
    let g = gateway_for(&gw, ca.roots());
    assert!(post_once(&g, b"x", quick(), MAX_ANSWER).is_ok());
    assert_eq!(
        gw.alpn.lock().unwrap().as_slice(),
        &[Some(b"http/1.1".to_vec())]
    );
    // A server that speaks only h2 cannot be spoken to, and is refused without a request.
    let h2_only = tls_gateway_with(
        &leaf,
        Mode::Ok,
        &[&rustls::version::TLS13],
        vec![b"h2".to_vec()],
    );
    let g = gateway_for(&h2_only, ca.roots());
    assert!(post_once(&g, b"x", quick(), MAX_ANSWER).is_err());
    assert!(h2_only.seen.lock().unwrap().is_empty());
}

// ---------- boot rules ----------

#[test]
fn boot_rules_for_the_gateway_url() {
    // http:// without the opt-in refuses; with it, it is accepted.
    assert!(Gateway::parse("http://127.0.0.1:1/x", &GatewayOptions::default()).is_err());
    assert!(Gateway::parse("http://127.0.0.1:1/x", &GatewayOptions::plain()).is_ok());
    // https:// needs nothing but the URL: there is no pin to supply.
    assert!(Gateway::parse("https://gw.example/x", &GatewayOptions::default()).is_ok());
    assert!(Gateway::parse("https://[::1]:8443/x", &GatewayOptions::default()).is_ok());
    for bad in [
        "ftp://gw.example/",
        "https://",
        "https://user@gw.example/",
        "https://gw.example:port/",
        "https://gw.example/a b",
        "https://gw.exämple/",
    ] {
        assert!(
            Gateway::parse(bad, &GatewayOptions::default()).is_err(),
            "{bad}"
        );
    }
    // The opt-in is the exact value 1, nothing looser.
    for off in [
        None,
        Some(""),
        Some("0"),
        Some("true"),
        Some("yes"),
        Some("11"),
    ] {
        assert!(!GatewayOptions::from_env_value(off).plain_ok, "{off:?}");
    }
    assert!(GatewayOptions::from_env_value(Some("1")).plain_ok);
    assert!(INSECURE_VAR.ends_with("GATEWAY_INSECURE"));
}

/// The boot line says what the hop is, and a plain hop says so in capitals.
#[test]
fn the_boot_line_says_loudly_when_the_hop_is_plain() {
    let plain = Gateway::parse("http://127.0.0.1:1/x", &GatewayOptions::plain())
        .unwrap()
        .with_secret(SECRET)
        .unwrap();
    let line = plain.hop_summary();
    assert!(
        line.contains("PLAIN") && line.contains("UNENCRYPTED"),
        "{line}"
    );
    assert!(!line.contains(SECRET));
    let tls = Gateway::parse("https://gw.example/x", &GatewayOptions::default())
        .unwrap()
        .with_secret(SECRET)
        .unwrap();
    let line = tls.hop_summary();
    assert!(
        line.contains("TLS 1.3") && !line.contains("PLAIN"),
        "{line}"
    );
    assert!(!line.contains(SECRET));
}

#[test]
fn the_secret_never_travels_on_the_plain_path_unless_opted_in() {
    let (addr, hits, bytes) = spy();
    // Not opted in: there is no Gateway to send with, so nothing connects.
    let refused = Gateway::parse(
        &format!("http://{addr}/api/ohttp"),
        &GatewayOptions::default(),
    );
    assert!(refused.is_err());
    // An https:// gateway that is really a plain HTTP server: the client speaks TLS to it, so the
    // secret is never written in the clear, and the call fails.
    let g = Gateway::parse(
        &format!("https://{addr}/api/ohttp"),
        &GatewayOptions::default(),
    )
    .unwrap()
    .with_secret(SECRET)
    .unwrap();
    assert!(post_once(&g, b"x", quick(), MAX_ANSWER).is_err());
    std::thread::sleep(Duration::from_millis(700));
    assert_eq!(hits.load(Ordering::SeqCst), 1, "one attempt");
    let got = bytes.lock().unwrap();
    assert!(!got.is_empty(), "a ClientHello arrived");
    assert!(
        !String::from_utf8_lossy(&got).contains(SECRET),
        "the secret is not in what a plain listener received"
    );
}

// ---------- no redirect, no proxy, no compression, one attempt ----------

#[test]
fn a_redirect_is_not_followed() {
    let ca = make_ca("test root");
    let leaf = make_leaf(&ca, loopback(), None);
    let (elsewhere, hits, _) = spy();
    let gw = tls_gateway(&leaf, Mode::Redirect(format!("http://{elsewhere}/steal")));
    let g = gateway_for(&gw, ca.roots());
    assert_eq!(
        post_once(&g, b"x", quick(), MAX_ANSWER),
        Err(Failure::BadAnswer)
    );
    std::thread::sleep(Duration::from_millis(300));
    assert_eq!(
        hits.load(Ordering::SeqCst),
        0,
        "the Location was never visited"
    );
    assert_eq!(gw.accepted.load(Ordering::SeqCst), 1);
}

#[test]
fn an_environment_proxy_is_ignored() {
    let ca = make_ca("test root");
    let leaf = make_leaf(&ca, loopback(), None);
    let gw = tls_gateway(&leaf, Mode::Ok);
    let (proxy, hits, _) = spy();
    for var in [
        "HTTP_PROXY",
        "http_proxy",
        "HTTPS_PROXY",
        "https_proxy",
        "ALL_PROXY",
        "all_proxy",
    ] {
        std::env::set_var(var, format!("http://{proxy}"));
    }
    std::env::remove_var("NO_PROXY");
    std::env::remove_var("no_proxy");
    let g = gateway_for(&gw, ca.roots());
    let r = post_once(&g, b"x", quick(), MAX_ANSWER);
    // And the plain path, same variables.
    let (plain_addr, plain_hits, _) = spy();
    let plain = Gateway::parse(&format!("http://{plain_addr}/x"), &GatewayOptions::plain())
        .unwrap()
        .with_secret(SECRET)
        .unwrap();
    let _ = post_once(&plain, b"x", quick(), MAX_ANSWER);
    std::thread::sleep(Duration::from_millis(300));
    assert!(
        r.is_ok(),
        "{r:?}: the connection went straight to the gateway"
    );
    assert_eq!(
        hits.load(Ordering::SeqCst),
        0,
        "the proxy was never contacted"
    );
    assert_eq!(
        plain_hits.load(Ordering::SeqCst),
        1,
        "the plain hop went direct too"
    );
}

#[test]
fn no_compression_is_asked_for_and_an_encoded_answer_is_refused() {
    let ca = make_ca("test root");
    let leaf = make_leaf(&ca, loopback(), None);
    let ok = tls_gateway(&leaf, Mode::Ok);
    let g = gateway_for(&ok, ca.roots());
    assert!(post_once(&g, b"x", quick(), MAX_ANSWER).is_ok());
    let names = header_names(&ok.seen.lock().unwrap()[0]);
    assert!(!names.contains(&"accept-encoding".to_string()), "{names:?}");
    let enc = tls_gateway(&leaf, Mode::Encoded);
    let g = gateway_for(&enc, ca.roots());
    assert_eq!(
        post_once(&g, b"x", quick(), MAX_ANSWER),
        Err(Failure::BadAnswer)
    );
}

#[test]
fn one_attempt_and_the_gateways_refusal_passes_through_over_tls() {
    let ca = make_ca("test root");
    let leaf = make_leaf(&ca, loopback(), None);
    for code in [403u16, 500, 503] {
        let gw = tls_gateway(&leaf, Mode::Status(code));
        let g = gateway_for(&gw, ca.roots());
        let a = post_once(&g, b"x", quick(), MAX_ANSWER).expect("a refusal is an answer");
        assert_eq!(a.status, code);
        std::thread::sleep(Duration::from_millis(200));
        assert_eq!(gw.accepted.load(Ordering::SeqCst), 1, "no retry on {code}");
    }
}

// ---------- timeouts ----------

#[test]
fn a_gateway_that_goes_silent_is_cut_at_the_bound() {
    let ca = make_ca("test root");
    let leaf = make_leaf(&ca, loopback(), None);
    let gw = tls_gateway(&leaf, Mode::Silent);
    let g = gateway_for(&gw, ca.roots());
    let t = Timeouts {
        total: Duration::from_millis(400),
        ..quick()
    };
    let started = Instant::now();
    assert_eq!(post_once(&g, b"x", t, MAX_ANSWER), Err(Failure::Timeout));
    assert!(started.elapsed() < Duration::from_secs(3));
}

#[test]
fn the_total_timeout_cuts_a_gateway_that_drips() {
    let ca = make_ca("test root");
    let leaf = make_leaf(&ca, loopback(), None);
    let gw = tls_gateway(&leaf, Mode::Drip);
    let g = gateway_for(&gw, ca.roots());
    // Every byte arrives 150 ms after the last, far inside any per-read bound: only the total can
    // stop it, and the drip needs 6 s.
    let t = Timeouts {
        total: Duration::from_millis(900),
        ..quick()
    };
    let started = Instant::now();
    let r = post_once(&g, b"x", t, MAX_ANSWER);
    assert!(r.is_err(), "{r:?}");
    assert!(
        started.elapsed() < Duration::from_millis(2500),
        "cut by the total ({:?}), not by the 6 s the drip needs",
        started.elapsed()
    );
}

#[test]
fn the_connect_timeout_bounds_a_gateway_that_never_answers_the_connect() {
    // 192.0.2.1 is TEST-NET-1: nothing answers. On a host with no route it fails at once, which is
    // also inside the bound; either way the call is over well before the io/total timeouts.
    let g = Gateway::parse("https://192.0.2.1:9/x", &GatewayOptions::default())
        .unwrap()
        .with_secret(SECRET)
        .unwrap();
    let t = Timeouts {
        connect: Duration::from_millis(500),
        total: Duration::from_secs(30),
    };
    let started = Instant::now();
    let r = post_once(&g, b"x", t, MAX_ANSWER);
    assert!(
        matches!(r, Err(Failure::Timeout | Failure::Unreachable)),
        "{r:?}"
    );
    assert!(started.elapsed() < Duration::from_secs(5));
}

// ---------- the relay itself, in front of a TLS gateway ----------

fn start_relay(gw: Gateway) -> u16 {
    let config = Config {
        gateway: gw,
        allowed_origins: vec![ORIGIN.to_string()],
        flood_max: 60,
        timeouts: quick(),
        limits: konclave_ohttp_relay::Limits::default(),
        inbound: Inbound::default(),
    };
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    let port = listener.local_addr().unwrap().port();
    let relay = Arc::new(Relay::new(config));
    std::thread::spawn(move || konclave_ohttp_relay::serve(listener, relay, 4));
    port
}

fn post_to_relay(port: u16, headers: &[(&str, &str)], body: &[u8]) -> (u16, String) {
    let mut s = TcpStream::connect(("127.0.0.1", port)).unwrap();
    s.set_read_timeout(Some(Duration::from_secs(10))).unwrap();
    let mut head =
        format!("POST {RELAY_PATH} HTTP/1.1\r\nHost: relay.test\r\nConnection: close\r\n");
    for (n, v) in headers {
        head.push_str(&format!("{n}: {v}\r\n"));
    }
    head.push_str(&format!("Content-Length: {}\r\n\r\n", body.len()));
    s.write_all(head.as_bytes()).unwrap();
    s.write_all(body).unwrap();
    let mut raw = Vec::new();
    let _ = s.read_to_end(&mut raw);
    let text = String::from_utf8_lossy(&raw).to_string();
    let status = text.split(' ').nth(1).unwrap().parse().unwrap();
    (status, text)
}

#[test]
fn the_header_strip_and_the_client_ip_hold_over_tls() {
    let ca = make_ca("test root");
    let leaf = make_leaf(&ca, loopback(), None);
    let gw = tls_gateway(&leaf, Mode::Ok);
    let port = start_relay(gateway_for(&gw, ca.roots()));
    let (status, _) = post_to_relay(
        port,
        &[
            ("Content-Type", "message/ohttp-req"),
            ("Cookie", "session=canary-cookie-9f1"),
            ("User-Agent", "canary-agent-9f2"),
            ("Origin", "https://canary-origin-9f3.example"),
            ("X-Forwarded-For", "198.51.100.77"),
            ("X-Real-IP", "198.51.100.77"),
            ("Forwarded", "for=198.51.100.77"),
            ("Authorization", "Bearer canary-auth"),
            ("Accept-Encoding", "gzip"),
            ("X-Konclave-Relay-Secret", "canary-secret-9f7-0123456789"),
        ],
        &[5u8; 512],
    );
    assert_eq!(status, 200);
    let seen = gw.seen.lock().unwrap();
    let head = head_of(&seen[0]);
    for c in ["canary", "198.51.100.77", "gzip", "Bearer"] {
        assert!(
            !head.contains(c),
            "{c} reached the gateway over TLS:\n{head}"
        );
    }
    assert_eq!(
        header_names(&seen[0]),
        [
            "content-length",
            "content-type",
            "host",
            "x-konclave-relay-secret"
        ]
    );
    assert!(head
        .to_ascii_lowercase()
        .contains(&format!("x-konclave-relay-secret: {SECRET}")));
}

#[test]
fn through_the_relay_a_refused_certificate_a_redirect_and_a_bad_answer_are_typed_502s() {
    let ca = make_ca("test root");
    let leaf = make_leaf(&ca, loopback(), None);
    // A certificate from a CA the relay does not trust: the relay's own answer says the gateway
    // could not be reached, once, and nothing was sent.
    let gw = tls_gateway(&leaf, Mode::Ok);
    let port = start_relay(gateway_for(&gw, make_ca("another root").roots()));
    let (status, text) = post_to_relay(port, &[("Content-Type", "message/ohttp-req")], b"x");
    assert_eq!(status, 502);
    assert!(text.contains("gateway_unreachable"), "{text}");
    assert_eq!(gw.accepted.load(Ordering::SeqCst), 1);
    assert!(gw.seen.lock().unwrap().is_empty());
    // Redirect, encoded, chunked, and no declared length: gateway_bad_answer.
    for mode in [
        Mode::Redirect("https://elsewhere.invalid/".into()),
        Mode::Encoded,
        Mode::Chunked,
        Mode::NoLength,
    ] {
        let gw = tls_gateway(&leaf, mode);
        let port = start_relay(gateway_for(&gw, ca.roots()));
        let (status, text) = post_to_relay(port, &[("Content-Type", "message/ohttp-req")], b"x");
        assert_eq!(status, 502);
        assert!(text.contains("gateway_bad_answer"), "{text}");
    }
}
