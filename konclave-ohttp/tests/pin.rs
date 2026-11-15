#![cfg(all(feature = "client", feature = "server"))]
//! The client configuration parser binds the key it seals with, and the padding tables are one
//! number.

use konclave_ohttp::{
    generate_key_config, padding, seal_request, ClientConfig, ClientError, Gateway, InnerRequest,
};

const NOW: i64 = 1_800_000_000;

fn one_entry(id: u8) -> Vec<u8> {
    Gateway::new(generate_key_config(id).unwrap(), NOW)
        .unwrap()
        .config_list()
        .unwrap()
}

/// A frame (u16 length, then the config bytes) of a given shape.
fn frame(key_id: u8, kem: u16, pk: &[u8], suites: &[(u16, u16)]) -> Vec<u8> {
    let mut body = vec![key_id];
    body.extend_from_slice(&kem.to_be_bytes());
    body.extend_from_slice(pk);
    body.extend_from_slice(&u16::try_from(suites.len() * 4).unwrap().to_be_bytes());
    for (kdf, aead) in suites {
        body.extend_from_slice(&kdf.to_be_bytes());
        body.extend_from_slice(&aead.to_be_bytes());
    }
    let mut out = u16::try_from(body.len()).unwrap().to_be_bytes().to_vec();
    out.extend(body);
    out
}

fn inner() -> InnerRequest {
    InnerRequest {
        method: "GET".into(),
        path: "/api/health".into(),
        content_type: String::new(),
        read_key: None,
        body: Vec::new(),
        date_unix: NOW,
    }
}

/// `decode_list` drops an entry it does not support, so `[A: id 1, unknown KEM][B: id 9]`
/// must not pass the "one entry" test, report id 1 (from A) and seal with B.
#[test]
fn a_list_in_which_an_entry_would_be_dropped_is_refused() {
    let b = one_entry(9);
    let mut list = frame(1, 0x0010, &[0xaa; 65], &[(1, 1)]);
    list.extend_from_slice(&b);
    assert!(
        matches!(ClientConfig::parse(&list), Err(ClientError::BadConfig)),
        "a list with a dropped entry was accepted"
    );
}

/// A supported KEM with only suites this client does not use reached `symmetric[0]` in
/// the `ohttp` crate and panicked. It must be refused where it is parsed.
#[test]
fn a_config_with_no_usable_suite_is_refused_before_the_crate_sees_it() {
    let list = frame(3, 0x0020, &[7u8; 32], &[(2, 1)]); // HKDF-SHA384 / AES-128-GCM
    let parsed = ClientConfig::parse(&list);
    assert!(
        matches!(parsed, Err(ClientError::BadConfig)),
        "accepted: {parsed:?}"
    );
}

#[test]
fn a_config_with_extra_suites_or_other_kems_is_refused() {
    let extra = frame(3, 0x0020, &[7u8; 32], &[(1, 1), (1, 3)]);
    assert!(ClientConfig::parse(&extra).is_err(), "extra suite accepted");
    let other = frame(3, 0x0010, &[7u8; 65], &[(1, 1)]);
    assert!(ClientConfig::parse(&other).is_err(), "other KEM accepted");
}

/// Trailing bytes after the one frame are refused, and so is a frame shorter than it says.
#[test]
fn trailing_bytes_and_truncation_are_refused() {
    let mut list = one_entry(5);
    list.push(0);
    assert!(ClientConfig::parse(&list).is_err());
    let mut cut = one_entry(5);
    cut.pop();
    assert!(ClientConfig::parse(&cut).is_err());
}

/// The id it reports is the id of the entry it seals with, and sealing works.
#[test]
fn the_reported_key_id_is_the_sealing_entry() {
    let list = one_entry(42);
    let cfg = ClientConfig::parse(&list).unwrap();
    assert_eq!(cfg.key_id(), 42);
    let (wire, _ctx) = seal_request(&cfg, inner()).unwrap();
    assert_eq!(wire[0], 42);
}

/// 5 KiB and 9 KiB answers must not be told apart by size.
#[test]
fn response_sizes_are_exponential_buckets() {
    assert_eq!(
        padding::response_bucket(5 * 1024),
        padding::response_bucket(7 * 1024)
    );
    assert_ne!(
        padding::response_bucket(900),
        padding::response_bucket(3000)
    );
    let mut sizes = std::collections::BTreeSet::new();
    for n in (1..=16 * 1024 * 1024).step_by(997) {
        let b = padding::response_bucket(n).unwrap();
        assert!(b >= n);
        assert!(b.is_power_of_two() && b >= 1024, "{b} for {n}");
        assert!(
            b < n * 2 || b == 1024,
            "bucket {b} is more than twice the size {n}"
        );
        assert!(padding::is_response_bucket(b));
        sizes.insert(b);
    }
    assert!(sizes.len() <= 15, "{} distinct sizes", sizes.len());
    assert!(!padding::is_response_bucket(5 * 1024));
    assert_eq!(padding::response_bucket(16 * 1024 * 1024 + 1), None);
}

/// One number. The largest request bucket is what the helper reads.
#[test]
fn the_largest_request_bucket_is_what_the_helper_reads() {
    let largest = *padding::REQUEST_BUCKETS.last().unwrap() as u64;
    assert!(
        largest <= konclave_http::MAX_BODY,
        "the largest bucket ({largest}) is more than the helper reads ({})",
        konclave_http::MAX_BODY
    );
}
