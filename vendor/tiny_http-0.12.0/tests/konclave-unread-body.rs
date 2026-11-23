//! Konclave patch: a request body the handler leaves unread closes the connection.
//!
//! Whatever is left of a body is not a request, so the connection reads nothing more. Each test puts
//! a whole request inside a body, leaves the body unread, and checks only the first one is served.

extern crate tiny_http;

use std::io::Write;
use std::time::Duration;

#[allow(dead_code)]
mod support;

const HIDDEN: &str = "GET /hidden HTTP/1.1\r\nHost: localhost\r\n\r\n";

/// Sends `first`, reads `read_first` bytes of its body, as a handler with a ceiling does, and
/// answers without reading the rest.
fn hidden_request_is_not_served(first: String, read_first: usize) {
    let (server, mut stream) = support::new_one_server_one_client();
    stream.write_all(first.as_bytes()).unwrap();
    stream.flush().unwrap();

    let request = server.recv().unwrap();
    let mut request = request;
    assert_eq!(request.url(), "/upload");
    let mut head = vec![0u8; read_first];
    std::io::Read::read_exact(request.as_reader(), &mut head).unwrap();
    let _ = request.respond(tiny_http::Response::from_string("no"));

    while let Some(next) = server.recv_timeout(Duration::from_millis(500)).unwrap() {
        assert_ne!(next.url(), "/hidden", "a request from inside an unread body was served");
    }
}

fn with_length(body: &str) -> String {
    format!(
        "POST /upload HTTP/1.1\r\nHost: localhost\r\nContent-Length: {}\r\n\r\n{body}",
        body.len()
    )
}

#[test]
fn an_unread_body_closes_the_connection() {
    // Over the 1 KiB the server buffers whole, so the body is read through the socket.
    hidden_request_is_not_served(with_length(&format!("{HIDDEN}{}", "x".repeat(2_000))), 0);
}

#[test]
fn an_unread_large_body_closes_the_connection() {
    hidden_request_is_not_served(with_length(&format!("{HIDDEN}{}", "x".repeat(200_000))), 0);
}

#[test]
fn a_body_read_in_part_closes_the_connection() {
    let body = format!("{}{HIDDEN}{}", "a".repeat(10), "x".repeat(2_000));
    hidden_request_is_not_served(with_length(&body), 10);
}

#[test]
fn a_chunked_body_read_in_part_closes_the_connection() {
    let chunk = format!("{}{HIDDEN}", "a".repeat(10));
    hidden_request_is_not_served(
        format!(
            "POST /upload HTTP/1.1\r\nHost: localhost\r\nTransfer-Encoding: chunked\r\n\r\n\
             {:x}\r\n{chunk}\r\n0\r\n\r\n",
            chunk.len()
        ),
        10,
    );
}

#[test]
fn a_chunked_body_read_to_its_end_keeps_the_connection() {
    let (server, mut stream) = support::new_one_server_one_client();
    write!(
        stream,
        "POST /upload HTTP/1.1\r\nHost: localhost\r\nTransfer-Encoding: chunked\r\n\r\n\
         5\r\nhello\r\n0\r\n\r\nGET /second HTTP/1.1\r\nHost: localhost\r\n\r\n"
    )
    .unwrap();
    stream.flush().unwrap();

    let mut request = server.recv().unwrap();
    let mut body = String::new();
    std::io::Read::read_to_string(request.as_reader(), &mut body).unwrap();
    assert_eq!(body, "hello");
    request.respond(tiny_http::Response::from_string("ok")).unwrap();

    let next = server
        .recv_timeout(Duration::from_secs(2))
        .unwrap()
        .expect("the next request on a connection whose body was read");
    assert_eq!(next.url(), "/second");
}
