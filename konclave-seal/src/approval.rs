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
    if env.vault_id != *vault_id {
        return Err(EnvelopeError::WrongVault);
    }
    // Bytes against bytes: the envelope's hash is never turned into a `ContentHash`.
    if env.content_hash != *hash.as_bytes() {
        return Err(EnvelopeError::WrongContent);
    }
    if env.nonce.is_empty() || env.nonce.len() > NONCE_MAX_BYTES {
        return Err(EnvelopeError::Malformed);
    }
    if env.action == VoteAction::Approve && env.reason_hash != [0u8; 32] {
        return Err(EnvelopeError::Malformed);
    }
    let vk =
        ed25519_dalek::VerifyingKey::from_bytes(write_pub).map_err(|_| EnvelopeError::BadKey)?;
    let msg = vote_message_v2(
        vault_id,
        env.action,
        hash,
        env.seat,
        env.ts_ms,
        &env.nonce,
        &env.reason_hash,
    );
    vk.verify_strict(&msg, &ed25519_dalek::Signature::from_bytes(&env.sig))
        .map(|()| env.action)
        .map_err(|_| EnvelopeError::BadSignature)
}

#[cfg(test)]
#[path = "approval_tests.rs"]
mod tests;
