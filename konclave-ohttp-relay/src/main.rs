//! The OHTTP relay binary. Configuration, all from the environment, all read once at boot:
//! - `KONCLAVE_OHTTP_GATEWAY` (required): `https://host[:port]/path` of the ONE gateway. The host
//!   should be a name in a zone the project controls, never the hosting platform's own domain. The
//!   hop is TLS 1.3, and the certificate must be valid for that name under the Mozilla roots bundled
//!   in this binary (the host's trust store is not read); there is NO pin. The name is resolved at
//!   boot and every five minutes in the background, never per request; a restart refreshes it too;
//! - `KONCLAVE_OHTTP_GATEWAY_INSECURE`: only the exact value `1` allows a plain `http://` gateway, for a
//!   local test or a loopback hop. Without it an `http://` gateway is refused at boot, and with it the
//!   boot says in capitals that the relay secret crosses the hop unencrypted;
//! - `KONCLAVE_OHTTP_ORIGINS`: comma-separated origins allowed to read an answer;
//! - `KONCLAVE_OHTTP_FLOOD_MAX`: requests per address per 10 s (default 60);
//! - `KONCLAVE_OHTTP_RELAY_SECRET` (required, 16 or more printable characters): sent to the gateway in
//!   one header; the gateway reads nothing of a request without it. The same value is the gateway's;
//! - `KONCLAVE_TRUSTED_PROXY_HOPS` (required, `0` if no proxy is in front): which `X-Forwarded-For`
//!   value names the client for the flood limit. There is no default: a relay run by someone else
//!   sits behind a proxy of their choosing, and it must be an HTTP proxy that appends the client's
//!   address to `X-Forwarded-For` (a TCP-level terminator is not supported: every client would be
//!   one address);
//! - `PORT` (default 8081), `KONCLAVE_OHTTP_THREADS` (runtime threads, 2 to 32, default 4).
//!
//! TLS: inbound is terminated by the host in front of this process (HTTP/1.1 behind it, one request
//! per connection). Outbound is TLS 1.3 by `rustls` (`src/upstream.rs`), with no proxy from the
//! environment, no redirect, no compression and one attempt, so the relay's secret does not cross
//! that hop in the clear unless the operator opted in.

use std::sync::Arc;

use konclave_ohttp_relay::{
    parse_origins, require_hops_choice, serve,
    upstream::{self, Gateway, GatewayOptions},
    Config, Inbound, Limits, Relay, DEFAULT_FLOOD_MAX,
};

fn die(msg: &str) -> ! {
    eprintln!("konclave ohttp relay: {msg}");
    std::process::exit(2);
}

fn main() {
    // The forwarding rule is the same one the other servers boot with; here the address is only
    // ever a flood-limit key. Unlike the others it must be CHOSEN: no default.
    if let Err(why) =
        require_hops_choice(std::env::var_os(konclave_http::TRUSTED_PROXY_HOPS_VAR).as_deref())
    {
        die(&why);
    }
    konclave_http::boot_forwarding_rule("konclave ohttp relay");
    let secret = std::env::var("KONCLAVE_OHTTP_RELAY_SECRET")
        .unwrap_or_else(|_| die("KONCLAVE_OHTTP_RELAY_SECRET is required"));
    let opts =
        GatewayOptions::from_env_value(std::env::var(upstream::INSECURE_VAR).ok().as_deref());
    let gateway = match std::env::var("KONCLAVE_OHTTP_GATEWAY") {
        Ok(url) => Gateway::parse(&url, &opts)
            .and_then(|g| g.with_secret(&secret))
            .unwrap_or_else(|e| die(&e)),
        Err(_) => die("KONCLAVE_OHTTP_GATEWAY is required"),
    };
    // Resolved here, once, before the first request; `serve` refreshes it in the background.
    if !gateway.host_is_address() {
        if let Err(e) = gateway.resolve() {
            die(&e);
        }
    }
    let allowed_origins =
        parse_origins(&std::env::var("KONCLAVE_OHTTP_ORIGINS").unwrap_or_default())
            .unwrap_or_else(|e| die(&e));
    let flood_max = match std::env::var("KONCLAVE_OHTTP_FLOOD_MAX") {
        Ok(v) => v
            .trim()
            .parse::<u32>()
            .ok()
            .filter(|n| *n > 0)
            .unwrap_or_else(|| die("KONCLAVE_OHTTP_FLOOD_MAX must be a positive whole number")),
        Err(_) => DEFAULT_FLOOD_MAX,
    };
    let port: u16 = std::env::var("PORT")
        .ok()
        .and_then(|p| p.parse().ok())
        .unwrap_or(8081);
    let threads: usize = std::env::var("KONCLAVE_OHTTP_THREADS")
        .ok()
        .and_then(|p| p.parse().ok())
        .filter(|n| (2..=32).contains(n))
        .unwrap_or(4);
    let listener = std::net::TcpListener::bind(format!("0.0.0.0:{port}"))
        .unwrap_or_else(|e| die(&format!("cannot bind: {e}")));
    // No request is ever logged. These lines name no address and no client.
    eprintln!("konclave ohttp relay: {}", gateway.hop_summary());
    eprintln!(
        "konclave ohttp relay listening on port {port}, {} origin(s) allowed, flood limit {flood_max}/10s",
        allowed_origins.len()
    );
    let relay = Relay::new(Config {
        gateway,
        allowed_origins,
        flood_max,
        timeouts: Default::default(),
        limits: Limits::default(),
        inbound: Inbound::default(),
    });
    serve(listener, Arc::new(relay), threads);
}
