//! The one outbound call: a single `POST` to the gateway, with exactly one attempt, over TLS.
//!
//! The client is hyper's HTTP/1 client connection over `tokio-rustls` (ring provider). Every
//! property below is pinned by a test in `tests/tls.rs` or `tests/relay.rs`:
//!
//! - **TLS 1.3 only, ALPN `http/1.1`, WebPKI and the hostname, no pin.** The chain must validate
//!   against the Mozilla roots bundled in `webpki-roots` (the host's trust store is never read) and
//!   the certificate must be valid for the gateway's host name. NOTHING ELSE is checked: any
//!   certificate that a CA in those roots issues for the gateway's name is accepted. That is a
//!   decision, not an oversight, and it replaces an earlier one (2026-11-15) that pinned the
//!   gateway's SubjectPublicKeyInfo. The pin was dropped because the gateway sits behind a
//!   platform edge that renews its certificate about every 60 days with a NEW key each time
//!   (measured in Certificate Transparency for the platform's own domain), so a leaf pin takes
//!   private mode down at every renewal until a third party edits configuration, and a downed
//!   private mode is what pushes a member back to a direct request that shows their address.
//!   What the pin protected is narrow: the relay's shared secret, and the bytes and timing of one
//!   hop. It protected nothing of a member (the content is sealed end to end with HPKE and the
//!   relay sends no address), and nothing against the platform that hosts the gateway, which ends
//!   TLS and reads the secret whatever is pinned. What replaces it is outside this file: the
//!   gateway is addressed by a name in a zone the project controls, with a CAA record, a
//!   Certificate Transparency monitor and a locked registrar account (ADR-0013).
//! - **The roots ride in the binary.** A CA removed from the Mozilla store stays trusted by a relay
//!   until it is rebuilt from a newer pinned commit.
//! - **Plain `http://` only by explicit opt-in** ([`GatewayOptions::plain_ok`], the environment
//!   switch `KONCLAVE_OHTTP_GATEWAY_INSECURE=1`), for local tests and loopback or private-network
//!   hops; without it a boot refuses. The relay's secret crosses such a hop in the clear, and the
//!   boot line says so ([`Gateway::hop_summary`]).
//! - **No proxy from the environment** (no environment variable is ever read here), **no redirect
//!   followed** (a 3xx is a typed 502), **no compression** (no `Accept-Encoding` is sent, and an
//!   answer that carries a `Content-Encoding` is refused), **no pooling and no retry**: one TCP
//!   connection, one request, then it is closed.
//! - **DNS is resolved at boot and on a slow timer, never on the request path** ([`Gateway::resolve`],
//!   refreshed by `serve` every [`DNS_REFRESH`]; a restart also refreshes it). A resolver that
//!   answered each request would show the resolver's operator when private traffic happens. A
//!   refresh that fails keeps the last good addresses.
//! - Two timeouts, both under the 15 s the browser client waits ([`Timeouts`]): connect, and the
//!   whole call.
//!
//! What goes out is fixed here and built from nothing the client sent: `Host` (from the
//! configured URL), `Content-Type`, `Content-Length` (from the body) and the relay's own secret.
//! No `User-Agent`, no `Accept`: hyper's client adds no header of its own, and there is no function
//! that takes a client header.

use std::net::{IpAddr, SocketAddr, ToSocketAddrs};
use std::sync::{Arc, RwLock};
use std::time::{Duration, Instant};

use http_body_util::{BodyExt, Full};
use hyper::body::Bytes;
use hyper::header::{HeaderValue, CONTENT_ENCODING, CONTENT_LENGTH, CONTENT_TYPE, HOST};
use hyper::{Method, Request};
use hyper_util::rt::TokioIo;
use rustls::pki_types::ServerName;
use rustls::{ClientConfig, RootCertStore};
use tokio::net::TcpStream;
use tokio_rustls::TlsConnector;

/// The request type the relay accepts and forwards.
pub const REQUEST_TYPE: &str = "message/ohttp-req";

/// The header that carries the relay's secret to the gateway. The gateway reads nothing of a
/// request that does not carry it. The name is `konclave_http::RELAY_SECRET_HEADER`, read by this
/// crate and by the helper, so there is no second copy to drift.
pub const SECRET_HEADER: &str = konclave_http::RELAY_SECRET_HEADER;
/// A secret shorter than this is a word, not a secret.
pub const MIN_SECRET_LEN: usize = 16;
/// The environment switch that allows a plain `http://` gateway. Only the exact value `1` counts.
pub const INSECURE_VAR: &str = "KONCLAVE_OHTTP_GATEWAY_INSECURE";
/// How often the gateway's name is resolved again, off the request path.
pub const DNS_REFRESH: Duration = Duration::from_secs(300);
/// How long the browser client waits for the relay before it gives up
/// (`ui/src/oblivious-transport.ts`, `timeoutMs`, 15 s). Every deadline of the relay is under it,
/// so a gateway the client has left is not held for. A test reads the client's number from the
/// source and pins this one to it.
pub const CLIENT_PATIENCE: Duration = Duration::from_secs(15);

/// What boot decided about how the gateway may be reached.
#[derive(Debug, Clone, Copy, Default)]
pub struct GatewayOptions {
    /// Allow a plain `http://` gateway. Off by default.
    pub plain_ok: bool,
}

impl GatewayOptions {
    /// Plain HTTP allowed: what the local tests use.
    #[must_use]
    pub fn plain() -> Self {
        Self { plain_ok: true }
    }

    /// From the environment value. The switch is on only for exactly `1`.
    #[must_use]
    pub fn from_env_value(insecure: Option<&str>) -> Self {
        Self {
            plain_ok: insecure == Some("1"),
        }
    }
}

/// A parsed `http(s)://host[:port]/path`, the relay's secret, the TLS policy for `https://`, and
/// the addresses the name resolved to (shared by every clone, so one refresh serves all).
#[derive(Clone)]
pub struct Gateway {
    host: String,
    port: u16,
    path: String,
    /// The text of the URL's authority, written to `Host` exactly as configured.
    authority: String,
    secret: String,
    tls: Option<(Arc<ClientConfig>, ServerName<'static>)>,
    addrs: Arc<RwLock<Arc<[SocketAddr]>>>,
    resolver: Resolver,
}

/// How a host name becomes addresses: the system's, unless a test swaps it. Called at boot and by
/// the background refresh, never by a request.
type Resolver = Arc<dyn Fn(&str, u16) -> std::io::Result<Vec<SocketAddr>> + Send + Sync>;

fn system_resolver() -> Resolver {
    Arc::new(|host, port| Ok((host, port).to_socket_addrs()?.collect()))
}

impl std::fmt::Debug for Gateway {
    // The secret never prints.
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("Gateway")
            .field("host", &self.host)
            .field("port", &self.port)
            .field("path", &self.path)
            .field("tls", &self.tls.is_some())
            .finish_non_exhaustive()
    }
}

impl Gateway {
    /// The URL, the options boot read, and the bundled roots.
    pub fn parse(url: &str, opts: &GatewayOptions) -> Result<Self, String> {
        Self::parse_with_roots(url, opts, bundled_roots())
    }

    /// As [`Gateway::parse`], trusting THESE roots instead of the bundled ones. For tests, which
    /// make their own CA. No environment variable reaches it: the binary calls `parse`.
    pub fn parse_with_roots(
        url: &str,
        opts: &GatewayOptions,
        roots: RootCertStore,
    ) -> Result<Self, String> {
        let (tls_on, rest) = if let Some(r) = url.strip_prefix("https://") {
            (true, r)
        } else if let Some(r) = url.strip_prefix("http://") {
            (false, r)
        } else {
            return Err("the gateway must be an https://host[:port]/path URL".to_string());
        };
        if !tls_on && !opts.plain_ok {
            return Err(format!(
                "an http:// gateway sends the relay's secret in the clear: use https://, \
                 or set {INSECURE_VAR}=1 for a local test"
            ));
        }
        let (authority, path) = match rest.find('/') {
            Some(i) => (&rest[..i], &rest[i..]),
            None => (rest, "/"),
        };
        if authority.is_empty()
            || authority.contains(['@', ' ', '\r', '\n', '\t'])
            || path.contains(['\r', '\n', ' ', '\t', '#'])
            || !authority.is_ascii()
            || !path.is_ascii()
        {
            return Err("the gateway URL is malformed".to_string());
        }
        let (host, port) = split_authority(authority, tls_on)?;
        if host.is_empty() {
            return Err("the gateway URL has no host".to_string());
        }
        let tls = if tls_on {
            let name = ServerName::try_from(host.clone())
                .map_err(|_| "the gateway host is not a valid name".to_string())?;
            Some((Arc::new(client_config(roots)?), name))
        } else {
            None
        };
        // An address written as a number needs no lookup.
        let addrs: Vec<SocketAddr> = host
            .parse::<IpAddr>()
            .map(|ip| vec![SocketAddr::new(ip, port)])
            .unwrap_or_default();
        Ok(Self {
            host,
            port,
            path: path.to_string(),
            authority: authority.to_string(),
            secret: String::new(),
            tls,
            addrs: Arc::new(RwLock::new(addrs.into())),
            resolver: system_resolver(),
        })
    }

    /// Resolve with `resolver` instead of the system's (tests: it counts its own calls).
    #[must_use]
    pub fn with_resolver<F>(mut self, resolver: F) -> Self
    where
        F: Fn(&str, u16) -> std::io::Result<Vec<SocketAddr>> + Send + Sync + 'static,
    {
        self.resolver = Arc::new(resolver);
        self
    }

    /// The secret this relay presents to the gateway. Printable ASCII only (it goes into a header),
    /// and long enough to be a secret.
    pub fn with_secret(mut self, secret: &str) -> Result<Self, String> {
        if secret.len() < MIN_SECRET_LEN {
            return Err(format!(
                "the relay secret must be at least {MIN_SECRET_LEN} characters"
            ));
        }
        if !secret.bytes().all(|b| (0x21..=0x7e).contains(&b)) {
            return Err("the relay secret must be printable ASCII with no spaces".to_string());
        }
        self.secret = secret.to_string();
        Ok(self)
    }

    /// True if the hop is TLS.
    #[must_use]
    pub fn is_tls(&self) -> bool {
        self.tls.is_some()
    }

    /// True if the host is written as an address, so no lookup is ever needed.
    #[must_use]
    pub fn host_is_address(&self) -> bool {
        self.host.parse::<IpAddr>().is_ok()
    }

    /// One line for the boot log. It names no secret. A plain hop says so in capitals.
    #[must_use]
    pub fn hop_summary(&self) -> String {
        if self.is_tls() {
            format!(
                "gateway hop: TLS 1.3 to {}:{}, WebPKI against bundled roots and the host name, no pin",
                self.host, self.port
            )
        } else {
            format!(
                "WARNING gateway hop: PLAIN HTTP to {}:{}: the relay secret and every sealed request cross this hop UNENCRYPTED ({INSECURE_VAR}=1)",
                self.host, self.port
            )
        }
    }

    /// Resolve the host and keep the answer. An empty answer or an error leaves what was there.
    /// Returns how many addresses are now held. BLOCKS: boot calls it, and `serve`'s refresh calls
    /// it on a blocking thread. The request path never does.
    pub fn resolve(&self) -> Result<usize, String> {
        let found = (self.resolver)(&self.host, self.port)
            .map_err(|e| format!("cannot resolve the gateway host: {e}"))?;
        if found.is_empty() {
            return Err("the gateway host resolved to no address".to_string());
        }
        let n = found.len();
        *self
            .addrs
            .write()
            .unwrap_or_else(std::sync::PoisonError::into_inner) = found.into();
        Ok(n)
    }

    fn addresses(&self) -> Arc<[SocketAddr]> {
        self.addrs
            .read()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .clone()
    }
}

/// `host[:port]` with an optional bracketed IPv6 literal.
fn split_authority(authority: &str, tls_on: bool) -> Result<(String, u16), String> {
    let default = if tls_on { 443 } else { 80 };
    let bad_port = |_| "the gateway port is not a number".to_string();
    if let Some(inner) = authority.strip_prefix('[') {
        let (host, after) = inner
            .split_once(']')
            .ok_or_else(|| "the gateway URL is malformed".to_string())?;
        return match after {
            "" => Ok((host.to_string(), default)),
            p => Ok((
                host.to_string(),
                p.strip_prefix(':')
                    .ok_or_else(|| "the gateway URL is malformed".to_string())?
                    .parse()
                    .map_err(bad_port)?,
            )),
        };
    }
    match authority.rsplit_once(':') {
        Some((h, p)) => Ok((h.to_string(), p.parse().map_err(bad_port)?)),
        None => Ok((authority.to_string(), default)),
    }
}

/// The Mozilla roots bundled in `webpki-roots`.
#[must_use]
pub fn bundled_roots() -> RootCertStore {
    RootCertStore::from_iter(webpki_roots::TLS_SERVER_ROOTS.iter().cloned())
}

/// The TLS policy, in one place: TLS 1.3 only, these roots, the stock WebPKI verifier (which also
/// checks the host name), ALPN `http/1.1`, no client certificate, no session resumption (each call
/// is a fresh handshake, so nothing links one call to the next at the TLS layer).
fn client_config(roots: RootCertStore) -> Result<ClientConfig, String> {
    let provider = Arc::new(rustls::crypto::ring::default_provider());
    let mut config = ClientConfig::builder_with_provider(provider)
        .with_protocol_versions(&[&rustls::version::TLS13])
        .map_err(|e| format!("cannot select TLS 1.3: {e}"))?
        .with_root_certificates(roots)
        .with_no_client_auth();
    config.alpn_protocols = vec![b"http/1.1".to_vec()];
    config.resumption = rustls::client::Resumption::disabled();
    Ok(config)
}

// ---------- the call ----------

/// The two bounds on the call, both under what the browser client waits ([`CLIENT_PATIENCE`]).
///
/// `total` is the one that cannot be defeated by a peer that sends a byte every few seconds: it
/// covers the TCP connect, the TLS handshake, the request, the head and the body together, and a
/// gateway that goes silent is cut at it. `connect` bounds opening the connection (all addresses
/// together). There is no lookup in either: the name was resolved at boot.
#[derive(Debug, Clone, Copy)]
pub struct Timeouts {
    /// Opening the TCP connection.
    pub connect: Duration,
    /// The whole call, from the first connect to the last byte of the answer.
    pub total: Duration,
}

impl Default for Timeouts {
    fn default() -> Self {
        Self {
            connect: Duration::from_secs(4),
            total: Duration::from_secs(12),
        }
    }
}

/// Why the one attempt failed. Every variant becomes a typed 502 and none is retried.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Failure {
    Unreachable,
    /// The TLS handshake was refused by OUR side: the chain, the name or the validity. Told apart
    /// from `Unreachable` here so tests can tell a refused certificate from a closed port; the
    /// client hears the same typed 502 as for an unreachable gateway.
    Untrusted,
    Timeout,
    Cut,
    BadAnswer,
    /// The answer would not fit in the relay's byte budget (see `Limits::body_bytes`); the
    /// client hears a 503, not a 502, because the gateway did nothing wrong.
    Busy,
}

/// What the gateway said, unchanged.
#[derive(Debug, PartialEq, Eq)]
pub struct Answer {
    pub status: u16,
    pub content_type: Option<String>,
    pub body: Vec<u8>,
}

/// Ends a spawned task when dropped, so a call that is over (or cancelled by its deadline) takes
/// its connection down with it.
struct AbortOnDrop(tokio::task::JoinHandle<()>);

impl Drop for AbortOnDrop {
    fn drop(&mut self) {
        self.0.abort();
    }
}

/// One attempt. `max_answer` bounds what is read back. The whole call is cut at `t.total`.
///
/// `body` is sent as it is, not copied. `admit` is asked, with the size of each piece of the
/// answer, before the piece is kept; `false` ends the call with [`Failure::Busy`]. That is how
/// the answer is counted in the caller's memory budget while it arrives and not after.
pub async fn post_once(
    gw: &Gateway,
    body: Bytes,
    t: Timeouts,
    max_answer: usize,
    admit: &(dyn Fn(usize) -> bool + Sync),
) -> Result<Answer, Failure> {
    match tokio::time::timeout(t.total, attempt(gw, body, t, max_answer, admit)).await {
        Ok(r) => r,
        Err(_) => Err(Failure::Timeout),
    }
}

async fn attempt(
    gw: &Gateway,
    body: Bytes,
    t: Timeouts,
    max_answer: usize,
    admit: &(dyn Fn(usize) -> bool + Sync),
) -> Result<Answer, Failure> {
    let tcp = connect(&gw.addresses(), t.connect).await?;
    let _ = tcp.set_nodelay(true);
    match &gw.tls {
        Some((config, name)) => {
            let tls = TlsConnector::from(config.clone())
                .connect(name.clone(), tcp)
                .await
                .map_err(|e| classify_handshake(&e))?;
            exchange(TokioIo::new(tls), gw, body, max_answer, admit).await
        }
        None => exchange(TokioIo::new(tcp), gw, body, max_answer, admit).await,
    }
}

/// Open the TCP connection to the first address that takes it, within `budget` for all of them.
/// Trying the next address after a refusal is not a second attempt: nothing was sent.
async fn connect(addrs: &[SocketAddr], budget: Duration) -> Result<TcpStream, Failure> {
    let until = Instant::now() + budget;
    let mut failure = Failure::Unreachable;
    for addr in addrs {
        let left = until.saturating_duration_since(Instant::now());
        if left.is_zero() {
            return Err(Failure::Timeout);
        }
        match tokio::time::timeout(left, TcpStream::connect(addr)).await {
            Ok(Ok(s)) => return Ok(s),
            Ok(Err(_)) => failure = Failure::Unreachable,
            Err(_) => return Err(Failure::Timeout),
        }
    }
    Err(failure)
}

fn classify_handshake(e: &std::io::Error) -> Failure {
    if let Some(rustls::Error::InvalidCertificate(_)) = e
        .get_ref()
        .and_then(|inner| inner.downcast_ref::<rustls::Error>())
    {
        return Failure::Untrusted;
    }
    Failure::Unreachable
}

/// Send the request on an open connection and read the answer. The request is built here from
/// constants and the body; hyper's client adds no header of its own.
async fn exchange<T>(
    io: T,
    gw: &Gateway,
    body: Bytes,
    max_answer: usize,
    admit: &(dyn Fn(usize) -> bool + Sync),
) -> Result<Answer, Failure>
where
    T: hyper::rt::Read + hyper::rt::Write + Unpin + Send + 'static,
{
    let (mut sender, conn) = hyper::client::conn::http1::Builder::new()
        .max_buf_size(16 * 1024)
        .handshake::<_, Full<Bytes>>(io)
        .await
        .map_err(|_| Failure::Cut)?;
    let _driver = AbortOnDrop(tokio::spawn(async move {
        let _ = conn.await;
    }));
    let mut secret = HeaderValue::from_str(&gw.secret).map_err(|_| Failure::BadAnswer)?;
    secret.set_sensitive(true);
    let req = Request::builder()
        .method(Method::POST)
        .uri(gw.path.as_str())
        .header(HOST, gw.authority.as_str())
        .header(CONTENT_TYPE, REQUEST_TYPE)
        .header(SECRET_HEADER, secret)
        .body(Full::new(body))
        .map_err(|_| Failure::BadAnswer)?;
    let resp = sender.send_request(req).await.map_err(|_| Failure::Cut)?;
    let status = resp.status().as_u16();
    // A redirect is never followed, and is not an answer either: the gateway is one URL.
    if !(200..300).contains(&status) && !(400..600).contains(&status) {
        return Err(Failure::BadAnswer);
    }
    let headers = resp.headers();
    // We asked for no encoding. One that arrives anyway is refused, not decoded.
    if headers.get_all(CONTENT_ENCODING).iter().any(|v| {
        let v = v.as_bytes().trim_ascii();
        !v.is_empty() && !v.eq_ignore_ascii_case(b"identity")
    }) {
        return Err(Failure::BadAnswer);
    }
    // A chunked answer cannot be checked for completeness by length: refuse, do not guess.
    if headers.contains_key(hyper::header::TRANSFER_ENCODING) {
        return Err(Failure::BadAnswer);
    }
    // No declared length means no way to tell a cut from the end: fail closed. Exactly one, and
    // only digits.
    let mut lengths = headers.get_all(CONTENT_LENGTH).iter();
    let length: usize = match (lengths.next(), lengths.next()) {
        (Some(v), None)
            if !v.as_bytes().is_empty() && v.as_bytes().iter().all(u8::is_ascii_digit) =>
        {
            std::str::from_utf8(v.as_bytes())
                .ok()
                .and_then(|s| s.parse().ok())
                .ok_or(Failure::BadAnswer)?
        }
        _ => return Err(Failure::BadAnswer),
    };
    if length > max_answer {
        return Err(Failure::BadAnswer);
    }
    let content_type = headers
        .get(CONTENT_TYPE)
        .and_then(|v| v.to_str().ok())
        .map(|v| v.trim().to_string());
    let mut incoming = resp.into_body();
    // Grown as the answer arrives, never sized by the length the gateway declared.
    let mut out = Vec::with_capacity(length.min(64 * 1024));
    while let Some(frame) = incoming.frame().await {
        let frame = frame.map_err(|_| Failure::Cut)?;
        if let Some(data) = frame.data_ref() {
            if out.len() + data.len() > length {
                return Err(Failure::BadAnswer);
            }
            if !admit(data.len()) {
                return Err(Failure::Busy);
            }
            out.extend_from_slice(data);
        }
    }
    if out.len() < length {
        return Err(Failure::Cut);
    }
    Ok(Answer {
        status,
        content_type,
        body: out,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn authority_forms() {
        assert_eq!(
            split_authority("gw.example", true),
            Ok(("gw.example".into(), 443))
        );
        assert_eq!(
            split_authority("gw.example:8443", true),
            Ok(("gw.example".into(), 8443))
        );
        assert_eq!(
            split_authority("gw.example", false),
            Ok(("gw.example".into(), 80))
        );
        assert_eq!(split_authority("[::1]:9", false), Ok(("::1".into(), 9)));
        assert_eq!(split_authority("[::1]", true), Ok(("::1".into(), 443)));
        assert!(split_authority("gw.example:notaport", true).is_err());
        assert!(split_authority("[::1", true).is_err());
        assert!(split_authority("[::1]x", true).is_err());
    }

    #[test]
    fn a_failed_refresh_keeps_the_last_good_addresses() {
        let a: SocketAddr = "192.0.2.7:81".parse().unwrap();
        let b: SocketAddr = "192.0.2.8:81".parse().unwrap();
        let answers = Arc::new(std::sync::Mutex::new(vec![Ok(vec![a])]));
        let feed = answers.clone();
        let g = Gateway::parse("http://gw.example:81/x", &GatewayOptions::plain())
            .unwrap()
            .with_resolver(move |_, _| feed.lock().unwrap().remove(0));
        assert!(g.addresses().is_empty(), "nothing resolved yet");
        assert_eq!(g.resolve(), Ok(1));
        answers
            .lock()
            .unwrap()
            .push(Err(std::io::Error::other("down")));
        assert!(g.resolve().is_err());
        answers.lock().unwrap().push(Ok(Vec::new()));
        assert!(g.resolve().is_err());
        assert_eq!(&*g.addresses(), &[a][..]);
        // A clone shares them.
        let c = g.clone();
        answers.lock().unwrap().push(Ok(vec![b]));
        c.resolve().unwrap();
        assert_eq!(&*g.addresses(), &[b][..]);
    }
}
