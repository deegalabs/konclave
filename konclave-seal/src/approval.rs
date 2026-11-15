//! What a member signs to approve or refuse a proposal's content, and what a device states after it
//! signed a transaction for it. Both are built here only, from typed fields, so the device that
//! signs and the coordinator that counts read the same bytes (ADR-0011 D2, amended).
//!
//! Nothing calls these yet.

use sha2::{Digest, Sha256};

use crate::domains::{SIGNED_V1, VOTE_V2};
use crate::proposal::ContentHash;

/// The longest nonce a vote carries, in bytes.
pub const NONCE_MAX_BYTES: usize = 64;

/// A vote's action byte.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum VoteAction {
    Approve = 1,
    Refuse = 2,
}

/// `domains::VOTE_V2 || vault_id || action || content_hash || seat || ts_ms || len nonce || nonce
/// || reason_hash`, integers big-endian.
pub fn vote_message_v2(
    vault_id: &[u8; 32],
    action: VoteAction,
    hash: &ContentHash,
    seat: u16,
    ts_ms: i64,
    nonce: &str,
    reason_hash: &[u8; 32],
) -> Vec<u8> {
    let mut out = Vec::with_capacity(VOTE_V2.len() + 32 + 1 + 32 + 2 + 8 + 4 + nonce.len() + 32);
    out.extend_from_slice(VOTE_V2);
    out.extend_from_slice(vault_id);
    out.push(action as u8);
    out.extend_from_slice(hash.as_bytes());
    out.extend_from_slice(&seat.to_be_bytes());
    out.extend_from_slice(&ts_ms.to_be_bytes());
    out.extend_from_slice(&(nonce.len() as u32).to_be_bytes());
    out.extend_from_slice(nonce.as_bytes());
    out.extend_from_slice(reason_hash);
    out
}

/// `domains::SIGNED_V1 || vault_id || content_hash || sighash || spend_index || seat || ts_ms`.
pub fn signed_v1(
    vault_id: &[u8; 32],
    hash: &ContentHash,
    sighash: &[u8; 32],
    spend_index: u32,
    seat: u16,
    ts_ms: i64,
) -> Vec<u8> {
    let mut out = Vec::with_capacity(SIGNED_V1.len() + 32 + 32 + 32 + 4 + 2 + 8);
    out.extend_from_slice(SIGNED_V1);
    out.extend_from_slice(vault_id);
    out.extend_from_slice(hash.as_bytes());
    out.extend_from_slice(sighash);
    out.extend_from_slice(&spend_index.to_be_bytes());
    out.extend_from_slice(&seat.to_be_bytes());
    out.extend_from_slice(&ts_ms.to_be_bytes());
    out
}

/// The hash a refusal carries for its reason: SHA-256 of the reason's bytes, or zeros when it has
/// none. An approval always carries zeros.
pub fn reason_hash(reason: &str) -> [u8; 32] {
    if reason.is_empty() {
        return [0u8; 32];
    }
    Sha256::digest(reason.as_bytes()).into()
}

/// A vote as it travels: the fields the message is built from, and the signature over it.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Envelope {
    pub vault_id: [u8; 32],
    pub action: VoteAction,
    pub content_hash: [u8; 32],
    pub seat: u16,
    pub ts_ms: i64,
    pub nonce: String,
    pub reason_hash: [u8; 32],
    pub sig: [u8; 64],
}

/// Why an envelope was refused.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum EnvelopeError {
    WrongVault,
    WrongContent,
    Malformed,
    UnknownSeat,
    Replay,
    BadKey,
    BadSignature,
}

/// A seat's registered write key.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct SeatKey {
    pub seat: u16,
    pub write_pub: [u8; 32],
}

/// A vote that verified: the seat it counts for is the seat whose key signed it. Only
/// `verify_vote` makes one.
///
/// ```compile_fail
/// use konclave_seal::approval::{VerifiedVote, VoteAction};
/// let _forged = VerifiedVote { seat: 1, action: VoteAction::Approve, ts_ms: 0 };
/// ```
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct VerifiedVote {
    seat: u16,
    action: VoteAction,
    ts_ms: i64,
}

impl VerifiedVote {
    pub fn seat(&self) -> u16 {
        self.seat
    }
    pub fn action(&self) -> VoteAction {
        self.action
    }
    pub fn ts_ms(&self) -> i64 {
        self.ts_ms
    }
}

/// Verifies `env` as a vote in `vault_id` over `hash`, by the seat it names, with THAT seat's key
/// from `keys`. `seen_nonce` answers whether the nonce was used before (and records it); a device
/// checking its own envelope passes a function that answers false. The message is rebuilt here from
/// the hash the caller holds, never from bytes the envelope carries.
///
/// Cheap checks come before any signature verification, as in the v1 rule.
#[cfg(feature = "share-sig")]
pub fn verify_vote(
    keys: &[SeatKey],
    vault_id: &[u8; 32],
    env: &Envelope,
    hash: &ContentHash,
    seen_nonce: impl FnOnce(&str) -> bool,
) -> Result<VerifiedVote, EnvelopeError> {
    let _ = (keys, vault_id, env, hash, seen_nonce);
    todo!()
}

#[cfg(test)]
#[path = "approval_tests.rs"]
mod tests;
