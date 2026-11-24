//! Against the real relay binary: a request it answers without reading the whole declared body
//! must leave the relay serving the next one.

use std::io::{Read, Write};
use std::net::{SocketAddr, TcpStream};
use std::process::{Child, Command, Stdio};
use std::time::{Duration, Instant};

struct Relay(Child, SocketAddr);

impl Drop for Relay {
    fn drop(&mut self) {
        let _ = self.0.kill();
        let _ = self.0.wait();
    }
}

fn start() -> Relay {
    let port = std::net::TcpListener::bind("127.0.0.1:0")
        .unwrap()
        .local_addr()
        .unwrap()
        .port();
    let child = Command::new(env!("CARGO_BIN_EXE_relay-server"))
        .env("PORT", port.to_string())
        .env("KONCLAVE_RELAY_WORKERS", "2")
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .spawn()
        .unwrap();
    let addr: SocketAddr = format!("127.0.0.1:{port}").parse().unwrap();
    let t = Instant::now();
    while TcpStream::connect(addr).is_err() {
        assert!(t.elapsed() < Duration::from_secs(10), "relay did not start");
        std::thread::sleep(Duration::from_millis(50));
    }
    Relay(child, addr)
}

fn exchange(addr: SocketAddr, raw: &[u8]) -> String {
    let Ok(mut c) = TcpStream::connect(addr) else {
        return String::new();
    };
    c.set_read_timeout(Some(Duration::from_secs(5))).unwrap();
    let _ = c.write_all(raw);
    let mut got = Vec::new();
    let mut buf = [0u8; 4096];
    while let Ok(n) = c.read(&mut buf) {
        if n == 0 {
            break;
        }
        got.extend_from_slice(&buf[..n]);
        if got.windows(4).any(|w| w == b"\r\n\r\n") {
            break;
        }
    }
    String::from_utf8_lossy(&got).into_owned()
}

fn still_alive(relay: &mut Relay) {
    std::thread::sleep(Duration::from_millis(300));
    assert!(
        relay.0.try_wait().unwrap().is_none(),
        "the relay process ended"
    );
    let health = exchange(relay.1, b"GET /health HTTP/1.1\r\nHost: x\r\n\r\n");
    assert!(
        health.starts_with("HTTP/1.1 200"),
        "health answered {health:?}"
    );
}

const HUGE: &str = "4611686018427387904";

#[test]
fn a_huge_declared_body_over_the_cap_does_not_end_the_relay() {
    let mut relay = start();
    let req =
        format!("POST /api/relay/post HTTP/1.1\r\nHost: x\r\nContent-Length: {HUGE}\r\n\r\nabc");
    let _ = exchange(relay.1, req.as_bytes());
    still_alive(&mut relay);
}

#[test]
fn a_huge_declared_body_on_a_route_that_reads_none_does_not_end_the_relay() {
    let mut relay = start();
    for path in ["/health", "/nowhere"] {
        let req = format!("POST {path} HTTP/1.1\r\nHost: x\r\nContent-Length: {HUGE}\r\n\r\nabc");
        let _ = exchange(relay.1, req.as_bytes());
    }
    let req =
        format!("OPTIONS /api/relay/post HTTP/1.1\r\nHost: x\r\nContent-Length: {HUGE}\r\n\r\n");
    let _ = exchange(relay.1, req.as_bytes());
    still_alive(&mut relay);
}
