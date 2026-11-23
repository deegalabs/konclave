//! Konclave patch: the head of a request has a ceiling.
//!
//! Each line of the head has a ceiling, and so do the number of headers and their total size. Past
//! any of them the server answers 400 and closes, as for a malformed header.

extern crate tiny_http;

use std::io::{Read, Write};
use std::thread;
use std::time::Duration;

#[allow(dead_code)]
mod support;

/// Sends `head` from another thread (the server may stop reading part way and close), then reads
/// what the server answers. Asserts it is a 400 and that no request reached the handler.
fn refused_with_400(head: Vec<u8>) {
    let (server, stream) = support::new_one_server_one_client();
    stream
        .set_read_timeout(Some(Duration::from_secs(5)))
        .unwrap();
    let mut writer = stream.try_clone().unwrap();
    let sender = thread::spawn(move || {
        let _ = writer.write_all(&head);
        let _ = writer.flush();
    });

    let mut got = Vec::new();
    let mut reader = stream;
    let mut buf = [0u8; 1024];
    while let Ok(n) = reader.read(&mut buf) {
        if n == 0 {
            break;
        }
        got.extend_from_slice(&buf[..n]);
        if got.windows(4).any(|w| w == b"\r\n\r\n") {
            break;
        }
    }
    let got = String::from_utf8_lossy(&got).to_string();
    assert!(got.starts_with("HTTP/1.1 400"), "got {got:?}");
    assert!(server
        .recv_timeout(Duration::from_millis(200))
        .unwrap()
        .is_none());
    let _ = sender.join();
}

#[test]
fn a_request_line_past_the_ceiling_is_refused() {
    let mut head = b"GET /".to_vec();
    head.extend(std::iter::repeat(b'a').take(1 << 20));
    refused_with_400(head);
}

#[test]
fn a_header_line_past_the_ceiling_is_refused() {
    let mut head = b"GET / HTTP/1.1\r\nX-Long: ".to_vec();
    head.extend(std::iter::repeat(b'a').take(1 << 20));
    refused_with_400(head);
}

#[test]
fn too_many_headers_are_refused() {
    let mut head = b"GET / HTTP/1.1\r\n".to_vec();
    for i in 0..1_000 {
        head.extend(format!("X-H{i}: a\r\n").as_bytes());
    }
    head.extend(b"\r\n");
    refused_with_400(head);
}

#[test]
fn headers_past_the_total_ceiling_are_refused() {
    // Each line is under the line ceiling and their number is under the count ceiling.
    let mut head = b"GET / HTTP/1.1\r\n".to_vec();
    let value = "a".repeat(4_000);
    for i in 0..50 {
        head.extend(format!("X-H{i}: {value}\r\n").as_bytes());
    }
    head.extend(b"\r\n");
    refused_with_400(head);
}

#[test]
fn an_ordinary_head_is_served() {
    let (server, mut stream) = support::new_one_server_one_client();
    let mut head = String::from("GET /ok HTTP/1.1\r\nHost: localhost\r\n");
    let value = "a".repeat(1_000);
    for i in 0..20 {
        head.push_str(&format!("X-H{i}: {value}\r\n"));
    }
    head.push_str("\r\n");
    stream.write_all(head.as_bytes()).unwrap();
    let rq = server
        .recv_timeout(Duration::from_secs(5))
        .unwrap()
        .expect("an ordinary request is served");
    assert_eq!(rq.url(), "/ok");
    assert_eq!(rq.headers().len(), 21);
}
