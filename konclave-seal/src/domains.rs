//! The closed list of domain separators Konclave signs or hashes under (ADR-0012 D2).
//!
//! Every message the Rust crates sign, and every canonical form they hash for a signature, starts
//! with one of these (key-derivation labels and the browser's fingerprint strings are not on the
//! list), and they live here only, so two messages cannot share a prefix by accident and a new one
//! is added where the others can be seen. A scan (tests/one_home_for_domains.rs) refuses a domain
//! literal anywhere else in the Rust crates.

/// Room messages (signing and creation rooms).
pub const ROOM: &[u8] = b"konclave-room-v1\0";
/// A seat certificate.
pub const SEAT: &[u8] = b"konclave-seat-v1\0";
/// The public key package digest.
pub const PKP: &[u8] = b"konclave-pkp-v1\0";
/// The read-key hash.
pub const READKEY: &[u8] = b"konclave-readkey-v1\0";
/// A governance write signed with the device write key (ADR-0011 D2).
pub const WRITE_V1: &[u8] = b"konclave-write-v1\0";
/// A vote over a proposal's content hash.
pub const VOTE_V2: &[u8] = b"konclave-vote-v2\0";
/// A device's statement that it signed a sighash for a content.
pub const SIGNED_V1: &[u8] = b"konclave-signed-v1\0";
/// A proposal's canonical content bytes.
pub const PROPOSAL_V1: &[u8] = b"konclave-proposal-v1\0";
/// The hash over a proposal's canonical content.
pub const PROPOSAL_HASH_V1: &[u8] = b"konclave-proposal-hash-v1\0";
/// Reserved for the demo signer, which may sign only messages under this prefix.
pub const DEMO_V1: &[u8] = b"konclave-demo-v1\0";

/// Every domain above.
pub const ALL: [&[u8]; 10] = [
    ROOM,
    SEAT,
    PKP,
    READKEY,
    WRITE_V1,
    VOTE_V2,
    SIGNED_V1,
    PROPOSAL_V1,
    PROPOSAL_HASH_V1,
    DEMO_V1,
];
