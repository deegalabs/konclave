//! What a member signs to approve or refuse a proposal's content, and what a device states after it
//! signed a transaction for it. Both are built here only, from typed fields, so the device that
//! signs and the coordinator that counts read the same bytes (ADR-0011 D2, amended).
//!
//! Nothing calls these yet.

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
    let _ = (vault_id, action, hash, seat, ts_ms, nonce, reason_hash);
    todo!()
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
    let _ = (vault_id, hash, sighash, spend_index, seat, ts_ms);
    todo!()
}

/// The hash a refusal carries for its reason: SHA-256 of the reason's bytes, or zeros when it has
/// none. An approval always carries zeros.
pub fn reason_hash(reason: &str) -> [u8; 32] {
    let _ = reason;
    todo!()
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
    BadKey,
    BadSignature,
}

/// Verifies `env` as a vote of the holder of `write_pub`, in `vault_id`, over `hash`. The message is
/// rebuilt here from the hash the caller holds, never from bytes the envelope carries.
#[cfg(feature = "share-sig")]
pub fn verify_envelope(
    write_pub: &[u8; 32],
    vault_id: &[u8; 32],
    env: &Envelope,
    hash: &ContentHash,
) -> Result<VoteAction, EnvelopeError> {
    let _ = (write_pub, vault_id, env, hash);
    todo!()
}

#[cfg(test)]
#[path = "approval_tests.rs"]
mod tests;
