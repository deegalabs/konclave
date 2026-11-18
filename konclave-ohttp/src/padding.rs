//! The one padding table. Padding is BHTTP padding (RFC 9292 section 3.8: zero bytes after the
//! message), inside the encrypted message, never a header. The buckets are chosen so the size of
//! the ENCAPSULATED message, which is what an observer measures, lands exactly on a bucket.

/// Bytes the encapsulation adds to a request: key id (1) + kem (2) + kdf (2) + aead (2), the
/// X25519 encapsulated key (32) and the AES-128-GCM tag (16).
pub const REQUEST_OVERHEAD: usize = 1 + 2 + 2 + 2 + 32 + 16;
/// Bytes the encapsulation adds to a response: the response nonce (16) and the tag (16).
pub const RESPONSE_OVERHEAD: usize = 16 + 16;

const KIB: usize = 1024;

/// Request sizes on the wire: 4 KiB for everything small, then 16 KiB and doubling up to 2 MiB.
/// The last bucket is `konclave_http::MAX_BODY`, what the coordinator reads from one request: a
/// bucket larger than that could be built and sent and never read. A test pins the two together.
pub const REQUEST_BUCKETS: [usize; 9] = [
    4 * KIB,
    16 * KIB,
    32 * KIB,
    64 * KIB,
    128 * KIB,
    256 * KIB,
    512 * KIB,
    1024 * KIB,
    2048 * KIB,
];

/// Response sizes: powers of two from 1 KiB to 16 MiB. Exponential on purpose: steps of 4 KiB would
/// let the size of a vault's answer, which grows slowly with its history, name the vault to whoever
/// watches the wire (the relay sees the size and the address). Here a vault's answers share a
/// bucket until it doubles, at the price of up to twice the bytes.
pub const RESPONSE_BUCKETS: [usize; 15] = {
    let mut t = [0usize; 15];
    let mut i = 0;
    while i < 15 {
        t[i] = KIB << i;
        i += 1;
    }
    t
};
/// The largest response the gateway will encapsulate.
pub const RESPONSE_MAX: usize = RESPONSE_BUCKETS[RESPONSE_BUCKETS.len() - 1];

/// The wire size a request of `unpadded` encapsulated bytes is padded to, or `None` if too large.
#[must_use]
pub fn request_bucket(unpadded: usize) -> Option<usize> {
    REQUEST_BUCKETS.iter().copied().find(|b| *b >= unpadded)
}

/// The wire size a response of `unpadded` encapsulated bytes is padded to, or `None` if too large.
#[must_use]
pub fn response_bucket(unpadded: usize) -> Option<usize> {
    RESPONSE_BUCKETS.iter().copied().find(|b| *b >= unpadded)
}

/// True if `wire_len` is exactly a request bucket.
#[must_use]
pub fn is_request_bucket(wire_len: usize) -> bool {
    REQUEST_BUCKETS.contains(&wire_len)
}

/// Append zero bytes to a BHTTP message so that message + `overhead` equals `target`.
pub(crate) fn pad_to(msg: &mut Vec<u8>, overhead: usize, target: usize) {
    debug_assert!(msg.len() + overhead <= target);
    msg.resize(target - overhead, 0);
}

/// True if every byte of `rest` is zero (valid BHTTP padding).
pub(crate) fn is_padding(rest: &[u8]) -> bool {
    rest.iter().all(|b| *b == 0)
}

/// True if `wire_len` is a size a padded response can have.
#[must_use]
pub fn is_response_bucket(wire_len: usize) -> bool {
    RESPONSE_BUCKETS.contains(&wire_len)
}
