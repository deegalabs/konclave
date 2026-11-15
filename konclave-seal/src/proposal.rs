//! What a proposal pays, as one canonical byte string, and the hash a member's approval will sign.
//!
//! Today an approval signs a proposal's id and the device learns what that id pays from the
//! coordinator. This module is the one place that turns a proposal's content into bytes and a hash,
//! so the device that approves, the device that signs and the coordinator that counts all read the
//! same function. Nothing calls it yet: later changes make approvals sign `content_hash` and make
//! the device check a transaction against the content before its share moves.
//!
//! Rules:
//! - `Content` is plain data; only `validate` turns it into a `ValidContent`, and only a
//!   `ValidContent` can be encoded or hashed. `ContentHash` exists only as the output of
//!   `content_hash`, so no caller can hand a hash of its own in place of one.
//! - `validate` checks the content against the device's own record of the vault (`Context`), never
//!   against fields the content claims about itself.
//! - Expiry is checked by `check_expiry` alone, by every reader, with the constants below.
//! - The fee is not in the hash; only a ceiling the transaction's fee must stay under (`fee_cap`),
//!   itself bounded here, so a change of fee era never changes a hash.

use sha2::{Digest, Sha256};

use crate::epochs::{GRACE_ACTIONS, MAINNET};

/// Domain of the canonical content bytes.
pub const CONTENT_DOMAIN: &[u8] = b"konclave-proposal-v1\0";
/// Domain of the content hash over those bytes.
pub const HASH_DOMAIN: &[u8] = b"konclave-proposal-hash-v1\0";

/// The longest a proposal stays open after the approval that creates it.
pub const EXPIRY_MAX_MS: i64 = 72 * 60 * 60 * 1000;
/// Clock slack allowed between the device that approves and the one that checks.
pub const EXPIRY_MARGIN_MS: i64 = 10 * 60 * 1000;
/// A memo's longest form, in bytes (a shielded output carries 512).
pub const MAX_MEMO_BYTES: usize = 512;
/// The most lines a payroll pays in one transaction.
pub const MAX_LINES: usize = 300;
/// The most valued change outputs a transaction may carry per pool. The signer splits change into
/// at most this many outputs, and the device's check allows at most this many: one number.
pub const CHANGE_SPLIT_MAX: usize = 4;
/// The actions the fee ceiling is computed for: the per-block budget of shielded actions (ZIP 218),
/// so a fee cap never exceeds what the largest minable transaction can pay.
pub const MAX_ACTIONS_FOR_CAP: u64 = 330;
/// ZIP 317 money supply bound, in zatoshis.
pub const MAX_MONEY: u64 = 21_000_000 * 100_000_000;

/// Network byte.
pub const NETWORK_MAINNET: u8 = 1;
pub const NETWORK_TESTNET: u8 = 2;
/// Proposal kind byte.
pub const KIND_PAYMENT: u8 = 1;
pub const KIND_PAYROLL: u8 = 2;
/// Receiver type byte: the 43-byte Orchard raw receiver.
pub const RECEIVER_ORCHARD: u8 = 1;
pub const ORCHARD_RECEIVER_LEN: usize = 43;

const _: () = assert!(
    (MAX_LINES as u64) + 1 + (CHANGE_SPLIT_MAX as u64) <= MAX_ACTIONS_FOR_CAP,
    "a payroll at MAX_LINES with one spend and a full change split must fit the fee ceiling"
);

/// One payment line.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Line {
    pub receiver_type: u8,
    pub receiver: [u8; ORCHARD_RECEIVER_LEN],
    pub amount: u64,
    /// UTF-8 text, no NUL, at most `MAX_MEMO_BYTES` bytes; empty means no memo.
    pub memo: String,
}

/// What a proposal pays and under which terms, before it is checked.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Content {
    pub network: u8,
    pub vault_id: [u8; 32],
    pub kind: u8,
    pub lines: Vec<Line>,
    pub proposer: u16,
    pub expiry_unix: u64,
    pub threshold: u16,
    pub total: u16,
    pub salt: [u8; 32],
    pub fee_cap: u64,
    pub extra: [u8; 32],
}

/// The device's own record of the vault, against which a content is checked.
#[derive(Clone, Copy, Debug)]
pub struct Context<'a> {
    pub network: u8,
    pub vault_id: [u8; 32],
    pub threshold: u16,
    pub total: u16,
    /// The vault's own receivers (deposit and change): a line may never pay one of them.
    pub own_receivers: &'a [[u8; ORCHARD_RECEIVER_LEN]],
}

/// A content that passed `validate`. Its field is private: it cannot be built any other way.
///
/// The way that compiles (the twin of the refused one below, so it fails for the right reason):
///
/// ```
/// use konclave_seal::proposal::*;
/// let own = [[0x44u8; ORCHARD_RECEIVER_LEN]];
/// let ctx = Context { network: NETWORK_MAINNET, vault_id: [1; 32], threshold: 1, total: 1, own_receivers: &own };
/// let c = Content {
///     network: NETWORK_MAINNET, vault_id: [1; 32], kind: KIND_PAYMENT,
///     lines: vec![Line { receiver_type: RECEIVER_ORCHARD, receiver: [2; ORCHARD_RECEIVER_LEN], amount: 1, memo: String::new() }],
///     proposer: 1, expiry_unix: 1, threshold: 1, total: 1, salt: [3; 32], fee_cap: fee_cap_floor(), extra: [0; 32],
/// };
/// let v: ValidContent = validate(c, &ctx).unwrap();
/// let h: ContentHash = content_hash(&v);
/// assert_eq!(proposal_id(&h).len(), 64);
/// ```
///
/// ```compile_fail
/// use konclave_seal::proposal::{Content, ValidContent};
/// fn forge(c: Content) -> ValidContent { ValidContent(c) }
/// ```
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ValidContent(Content);

impl ValidContent {
    pub fn content(&self) -> &Content {
        &self.0
    }
}

/// The hash an approval signs. Only `content_hash` makes one.
///
/// ```compile_fail
/// use konclave_seal::proposal::ContentHash;
/// let _forged = ContentHash([0u8; 32]);
/// ```
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct ContentHash([u8; 32]);

impl ContentHash {
    pub fn as_bytes(&self) -> &[u8; 32] {
        &self.0
    }
}

/// Why a content was refused.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ContentError {
    Network,
    VaultId,
    Kind,
    LineCount,
    ReceiverType,
    OwnReceiver,
    Amount,
    TotalAmount,
    Memo,
    Proposer,
    Quorum,
    Salt,
    FeeCap,
    Expiry,
    Expired,
    ExpiryTooFar,
}

/// The lowest fee cap a content may carry: ZIP 317's floor at the lowest rate any era accepts.
pub fn fee_cap_floor() -> u64 {
    let lowest = MAINNET
        .fees
        .iter()
        .flat_map(|era| era.accepts.iter().copied())
        .min()
        .expect("the fee table has an era");
    lowest * GRACE_ACTIONS
}

/// The highest fee cap a content may carry: the highest accepted rate over `MAX_ACTIONS_FOR_CAP`.
pub fn fee_cap_ceiling() -> u64 {
    let highest = MAINNET
        .fees
        .iter()
        .flat_map(|era| era.accepts.iter().copied())
        .max()
        .expect("the fee table has an era");
    highest * MAX_ACTIONS_FOR_CAP
}

/// Checks `content` against the device's own record of the vault.
pub fn validate(content: Content, ctx: &Context) -> Result<ValidContent, ContentError> {
    let c = &content;
    if !matches!(c.network, NETWORK_MAINNET | NETWORK_TESTNET) || c.network != ctx.network {
        return Err(ContentError::Network);
    }
    if c.vault_id != ctx.vault_id {
        return Err(ContentError::VaultId);
    }
    if c.threshold != ctx.threshold || c.total != ctx.total {
        return Err(ContentError::Quorum);
    }
    let lines_ok = match c.kind {
        KIND_PAYMENT => c.lines.len() == 1,
        KIND_PAYROLL => (1..=MAX_LINES).contains(&c.lines.len()),
        _ => return Err(ContentError::Kind),
    };
    if !lines_ok {
        return Err(ContentError::LineCount);
    }
    let mut sum: u64 = 0;
    for l in &c.lines {
        if l.receiver_type != RECEIVER_ORCHARD {
            return Err(ContentError::ReceiverType);
        }
        if ctx.own_receivers.contains(&l.receiver) {
            return Err(ContentError::OwnReceiver);
        }
        if l.amount == 0 || l.amount > MAX_MONEY {
            return Err(ContentError::Amount);
        }
        sum = sum
            .checked_add(l.amount)
            .filter(|s| *s <= MAX_MONEY)
            .ok_or(ContentError::TotalAmount)?;
        if l.memo.len() > MAX_MEMO_BYTES || l.memo.as_bytes().contains(&0) {
            return Err(ContentError::Memo);
        }
    }
    if c.proposer == 0 || c.proposer > c.total {
        return Err(ContentError::Proposer);
    }
    if c.expiry_unix == 0 {
        return Err(ContentError::Expiry);
    }
    if c.salt == [0u8; 32] {
        return Err(ContentError::Salt);
    }
    if c.fee_cap < fee_cap_floor() || c.fee_cap > fee_cap_ceiling() {
        return Err(ContentError::FeeCap);
    }
    Ok(ValidContent(content))
}

/// The canonical bytes of a valid content. Pure: no check, no clock.
pub fn encode(content: &ValidContent) -> Vec<u8> {
    let c = &content.0;
    let mut b = Vec::with_capacity(160 + c.lines.len() * 96);
    b.extend_from_slice(CONTENT_DOMAIN);
    b.push(c.network);
    b.extend_from_slice(&c.vault_id);
    b.push(c.kind);
    // `validate` bounds the count by MAX_LINES, so it fits a u32.
    b.extend_from_slice(&(c.lines.len() as u32).to_be_bytes());
    for l in &c.lines {
        b.push(l.receiver_type);
        b.extend_from_slice(&l.receiver);
        b.extend_from_slice(&l.amount.to_be_bytes());
        b.extend_from_slice(&(l.memo.len() as u32).to_be_bytes());
        b.extend_from_slice(l.memo.as_bytes());
    }
    b.extend_from_slice(&c.proposer.to_be_bytes());
    b.extend_from_slice(&c.expiry_unix.to_be_bytes());
    b.extend_from_slice(&c.threshold.to_be_bytes());
    b.extend_from_slice(&c.total.to_be_bytes());
    b.extend_from_slice(&c.salt);
    b.extend_from_slice(&c.fee_cap.to_be_bytes());
    b.extend_from_slice(&c.extra);
    b
}

/// `SHA-256(HASH_DOMAIN || encode(content))`.
pub fn content_hash(content: &ValidContent) -> ContentHash {
    let mut h = Sha256::new();
    h.update(HASH_DOMAIN);
    h.update(encode(content));
    ContentHash(h.finalize().into())
}

/// A proposal's id: the full content hash in lowercase hex.
pub fn proposal_id(hash: &ContentHash) -> String {
    crate::hex::encode_lower(&hash.0)
}

/// Whether a content expiring at `expiry_unix` (seconds) is still open at `now_ms`, and was set
/// within `EXPIRY_MAX_MS` (+ margin) of the approval made at `ts_ms`. Every reader calls this one.
pub fn check_expiry(expiry_unix: u64, ts_ms: i64, now_ms: i64) -> Result<(), ContentError> {
    // i128 so no input overflows.
    let expiry_ms = i128::from(expiry_unix) * 1000;
    if expiry_ms <= i128::from(now_ms) {
        return Err(ContentError::Expired);
    }
    if expiry_ms > i128::from(ts_ms) + i128::from(EXPIRY_MAX_MS + EXPIRY_MARGIN_MS) {
        return Err(ContentError::ExpiryTooFar);
    }
    Ok(())
}

#[cfg(test)]
#[path = "proposal_tests.rs"]
mod tests;
