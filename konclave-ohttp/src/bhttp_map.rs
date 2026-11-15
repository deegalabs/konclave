//! The one mapping between our messages and BHTTP (known-length), including the padding.
//! Not exported: both halves of the crate use it, so it exists once.

// One half of the crate alone leaves the other half's helpers unused.
#![cfg_attr(
    not(all(feature = "client", feature = "server")),
    allow(dead_code, unused_imports)
)]

use std::io::Cursor;

use bhttp::{Message, Mode, StatusCode};

use crate::{padding, InnerRequest, Refusal, HDR_CONTENT_TYPE, HDR_DATE, HDR_READ};

const SCHEME: &[u8] = b"https";
const AUTHORITY: &[u8] = b"konclave";

fn token_ok(s: &str) -> bool {
    s.bytes().all(|b| (0x21..=0x7e).contains(&b))
}

fn value_ok(s: &str) -> bool {
    s.bytes().all(|b| (0x20..=0x7e).contains(&b))
}

/// Encode a request as an UNPADDED BHTTP message.
#[cfg(feature = "client")]
pub(crate) fn encode_request(r: &InnerRequest) -> Result<Vec<u8>, &'static str> {
    if r.method.is_empty() || !token_ok(&r.method) {
        return Err("method");
    }
    if !r.path.starts_with('/') || !token_ok(&r.path) {
        return Err("path");
    }
    if !value_ok(&r.content_type) {
        return Err("content-type");
    }
    let mut m = Message::request(
        r.method.as_bytes().to_vec(),
        SCHEME.to_vec(),
        AUTHORITY.to_vec(),
        r.path.as_bytes().to_vec(),
    );
    if !r.content_type.is_empty() {
        m.put_header(HDR_CONTENT_TYPE, r.content_type.as_bytes());
    }
    if let Some(k) = &r.read_key {
        if !token_ok(k) {
            return Err("read key");
        }
        m.put_header(HDR_READ, k.as_bytes());
    }
    m.put_header(HDR_DATE, r.date_unix.to_string().into_bytes());
    m.write_content(&r.body);
    let mut out = Vec::new();
    m.write_bhttp(Mode::KnownLength, &mut out)
        .map_err(|_| "bhttp")?;
    Ok(out)
}

/// Split a decoded message from its trailing padding. The padding must be all zero.
fn read_message(bytes: &[u8], first_byte: u8) -> Result<Message, &'static str> {
    if bytes.first() != Some(&first_byte) {
        return Err("framing");
    }
    let mut cur = Cursor::new(bytes);
    let m = Message::read_bhttp::<_, Cursor<&[u8]>>(&mut cur).map_err(|_| "bhttp")?;
    let pos = usize::try_from(cur.position()).map_err(|_| "bhttp")?;
    if !padding::is_padding(&bytes[pos..]) {
        return Err("padding");
    }
    if !m.trailer().is_empty() {
        return Err("trailer");
    }
    Ok(m)
}

/// Decode a request. Allow-list of headers, date required, no duplicates.
#[cfg(feature = "server")]
pub(crate) fn decode_request(bytes: &[u8]) -> Result<InnerRequest, Refusal> {
    let m = read_message(bytes, 0).map_err(Refusal::Malformed)?;
    if !m.informational().is_empty() {
        return Err(Refusal::Malformed("informational"));
    }
    let c = m.control();
    if c.scheme() != Some(SCHEME) || c.authority() != Some(AUTHORITY) {
        return Err(Refusal::Malformed("scheme or authority"));
    }
    let text = |b: Option<&[u8]>, what: &'static str| -> Result<String, Refusal> {
        let s = std::str::from_utf8(b.ok_or(Refusal::Malformed(what))?)
            .map_err(|_| Refusal::Malformed(what))?;
        Ok(s.to_owned())
    };
    let method = text(c.method(), "method")?;
    let path = text(c.path(), "path")?;
    if method.is_empty() || !token_ok(&method) || !path.starts_with('/') || !token_ok(&path) {
        return Err(Refusal::Malformed("control data"));
    }
    let mut content_type = None;
    let mut read_key = None;
    let mut date = None;
    for f in m.header().fields() {
        let name = std::str::from_utf8(f.name()).map_err(|_| Refusal::Malformed("header name"))?;
        let val = std::str::from_utf8(f.value()).map_err(|_| Refusal::Malformed("header value"))?;
        let slot = match name {
            HDR_CONTENT_TYPE => &mut content_type,
            HDR_READ => &mut read_key,
            HDR_DATE => &mut date,
            _ => return Err(Refusal::ForbiddenHeader),
        };
        if slot.is_some() {
            return Err(Refusal::Malformed("duplicate header"));
        }
        if !value_ok(val) {
            return Err(Refusal::Malformed("header value"));
        }
        *slot = Some(val.to_owned());
    }
    let date = date.ok_or(Refusal::MissingDate)?;
    let date_unix = date.parse::<i64>().map_err(|_| Refusal::BadDate)?;
    Ok(InnerRequest {
        method,
        path,
        content_type: content_type.unwrap_or_default(),
        read_key,
        body: m.content().to_vec(),
        date_unix,
    })
}

/// Encode a response as an UNPADDED BHTTP message.
#[cfg(feature = "server")]
pub(crate) fn encode_response(
    status: u16,
    content_type: &str,
    body: &[u8],
) -> Result<Vec<u8>, &'static str> {
    let code = StatusCode::try_from(status).map_err(|_| "status")?;
    if code.informational() {
        return Err("status");
    }
    if !value_ok(content_type) {
        return Err("content-type");
    }
    let mut m = Message::response(code);
    if !content_type.is_empty() {
        m.put_header(HDR_CONTENT_TYPE, content_type.as_bytes());
    }
    m.write_content(body);
    let mut out = Vec::new();
    m.write_bhttp(Mode::KnownLength, &mut out)
        .map_err(|_| "bhttp")?;
    Ok(out)
}

/// Decode a response into (status, content-type, body). Only content-type is allowed.
#[cfg(feature = "client")]
pub(crate) fn decode_response(bytes: &[u8]) -> Result<(u16, String, Vec<u8>), &'static str> {
    let m = read_message(bytes, 1)?;
    if !m.informational().is_empty() {
        return Err("informational");
    }
    let status = m.control().status().ok_or("status")?;
    let mut content_type = String::new();
    for (i, f) in m.header().fields().iter().enumerate() {
        if i > 0 || f.name() != HDR_CONTENT_TYPE.as_bytes() {
            return Err("header");
        }
        content_type = std::str::from_utf8(f.value())
            .map_err(|_| "header")?
            .to_owned();
    }
    Ok((status.code(), content_type, m.content().to_vec()))
}
