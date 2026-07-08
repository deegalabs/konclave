//! Validation at the boundary — every user input is checked before use, and every
//! failure is explicit (never silent). Covers ZIP 317 fee estimation, memo/value
//! rules, and payroll aggregation.
//!
//! Full Zcash address parsing (unified/Orchard vs Sapling vs transparent) requires
//! the `zcash_address` crate and lives in the orchestration layer; here we keep a
//! prefix heuristic only for the UX warning ("this destination is public"), clearly
//! marked as non-authoritative.

use crate::money::{MoneyError, Zatoshis};

/// ZIP 317: marginal fee per logical action.
pub const MARGINAL_FEE: u64 = 5_000;
/// ZIP 317: grace actions (the minimum billed).
pub const GRACE_ACTIONS: u64 = 2;
/// Maximum memo size, in bytes (ZIP 302 / spec §8).
pub const MEMO_MAX_BYTES: usize = 512;

#[derive(Debug, PartialEq, Eq)]
pub enum ValidationError {
    ZeroValue,
    InsufficientFunds { needed: u64, available: u64 },
    MemoTooLong { bytes: usize },
    MemoOnTransparent,
    EmptyPayroll,
    Money(MoneyError),
}

impl std::fmt::Display for ValidationError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            ValidationError::ZeroValue => write!(f, "amount must be greater than zero"),
            ValidationError::InsufficientFunds { needed, available } => write!(
                f,
                "insufficient funds: need {needed} zat but only {available} zat available to propose"
            ),
            ValidationError::MemoTooLong { bytes } => {
                write!(f, "memo is {bytes} bytes; the maximum is {MEMO_MAX_BYTES}")
            }
            ValidationError::MemoOnTransparent => {
                write!(f, "a memo can only be attached to a shielded destination")
            }
            ValidationError::EmptyPayroll => write!(f, "a payroll needs at least one line"),
            ValidationError::Money(e) => write!(f, "{e}"),
        }
    }
}

impl std::error::Error for ValidationError {}

impl From<MoneyError> for ValidationError {
    fn from(e: MoneyError) -> Self {
        ValidationError::Money(e)
    }
}

/// Heuristic address family, by encoding prefix. NON-AUTHORITATIVE: used only to
/// drive the "this destination is public" warning. Real validation is done by the
/// orchestration layer via `zcash_address`.
#[derive(Debug, PartialEq, Eq, Clone, Copy)]
pub enum AddressKind {
    /// Unified address (`u1…`) — the shielded default; may carry an Orchard receiver.
    Unified,
    /// Legacy Sapling (`zs…`).
    Sapling,
    /// Transparent (`t1…`/`t3…`) — PUBLIC; requires explicit confirmation.
    Transparent,
    /// Unrecognized prefix.
    Unknown,
}

impl AddressKind {
    pub fn classify(addr: &str) -> AddressKind {
        if addr.starts_with("u1") {
            AddressKind::Unified
        } else if addr.starts_with("zs") {
            AddressKind::Sapling
        } else if addr.starts_with("t1") || addr.starts_with("t3") {
            AddressKind::Transparent
        } else {
            AddressKind::Unknown
        }
    }

    /// Whether a memo is meaningful for this destination (shielded only).
    pub fn supports_memo(self) -> bool {
        matches!(self, AddressKind::Unified | AddressKind::Sapling)
    }

    /// Whether sending here reveals the payment publicly.
    pub fn is_public(self) -> bool {
        matches!(self, AddressKind::Transparent)
    }
}

/// ZIP 317 conventional fee for an Orchard-only transaction.
///
/// `logical_actions = max(orchard_spends, orchard_outputs)`, and
/// `fee = MARGINAL_FEE * max(GRACE_ACTIONS, logical_actions)`.
///
/// This is an ESTIMATE for the preview: the authoritative fee is computed by the
/// wallet when it builds the PCZT (note selection determines the real spend count).
pub fn estimate_fee_orchard(n_input_notes: u64, n_orchard_outputs: u64) -> Zatoshis {
    let logical_actions = n_input_notes.max(n_orchard_outputs);
    let billed = GRACE_ACTIONS.max(logical_actions);
    // MARGINAL_FEE * billed cannot overflow for any realistic action count.
    Zatoshis::from_u64(MARGINAL_FEE * billed).expect("fee within money supply")
}

/// Estimate the fee for a payment/payroll to `n_recipients` shielded destinations.
/// Outputs = recipients + 1 change note; spends estimated as `n_input_notes` (>=1).
pub fn estimate_fee_for_payment(n_recipients: u64, n_input_notes: u64) -> Zatoshis {
    let outputs = n_recipients + 1; // + change
    estimate_fee_orchard(n_input_notes.max(1), outputs)
}

/// "Available to propose" = confirmed balance − already reserved − estimated fee.
/// Never goes negative.
pub fn available_to_propose(
    confirmed: Zatoshis,
    reserved: Zatoshis,
    estimated_fee: Zatoshis,
) -> Result<Zatoshis, MoneyError> {
    confirmed
        .checked_sub(reserved)
        .and_then(|r| r.checked_sub(estimated_fee))
        .or(Ok(Zatoshis::ZERO)) // underflow => nothing available, not an error
}

/// Validate a single memo against a destination.
pub fn validate_memo(memo: &str, dest: AddressKind) -> Result<(), ValidationError> {
    if memo.is_empty() {
        return Ok(());
    }
    if !dest.supports_memo() {
        return Err(ValidationError::MemoOnTransparent);
    }
    let bytes = memo.as_bytes().len();
    if bytes > MEMO_MAX_BYTES {
        return Err(ValidationError::MemoTooLong { bytes });
    }
    Ok(())
}

/// Validate a single payment amount against what's available to propose.
pub fn validate_amount(value: Zatoshis, available: Zatoshis) -> Result<(), ValidationError> {
    if value.is_zero() {
        return Err(ValidationError::ZeroValue);
    }
    if value > available {
        return Err(ValidationError::InsufficientFunds {
            needed: value.as_u64(),
            available: available.as_u64(),
        });
    }
    Ok(())
}

// Payroll aggregation/validation and CSV import live in the `payroll` module, which
// builds on these primitives (fee, memo, amount, available).

#[cfg(test)]
mod tests {
    use super::*;

    fn zat(z: u64) -> Zatoshis {
        Zatoshis::from_u64(z).unwrap()
    }

    #[test]
    fn zip317_single_payment_is_min_fee() {
        // 1 recipient => 2 outputs (recipient + change), 1 spend => 2 actions => min fee.
        assert_eq!(estimate_fee_for_payment(1, 1), zat(10_000)); // 0.0001 ZEC
    }

    #[test]
    fn zip317_fee_grows_with_payroll() {
        // 8 recipients => 9 outputs => 9 actions => 45_000 zat.
        assert_eq!(estimate_fee_for_payment(8, 1), zat(45_000));
        // Fee is monotonic in recipient count.
        assert!(estimate_fee_for_payment(20, 1) > estimate_fee_for_payment(8, 1));
    }

    #[test]
    fn zip317_never_below_grace() {
        // Even a zero-output edge stays at the grace minimum.
        assert_eq!(estimate_fee_orchard(1, 1), zat(10_000));
    }

    #[test]
    fn address_classification_and_memo_rules() {
        assert_eq!(AddressKind::classify("u1vjgxlvz4"), AddressKind::Unified);
        assert_eq!(AddressKind::classify("zs1abc"), AddressKind::Sapling);
        assert_eq!(AddressKind::classify("t1abc"), AddressKind::Transparent);
        assert!(AddressKind::Transparent.is_public());
        assert!(!AddressKind::Unified.is_public());
        // Memo on a transparent destination is rejected.
        assert_eq!(
            validate_memo("payslip", AddressKind::Transparent),
            Err(ValidationError::MemoOnTransparent)
        );
    }

    #[test]
    fn memo_length_boundary() {
        let ok = "a".repeat(MEMO_MAX_BYTES);
        assert!(validate_memo(&ok, AddressKind::Unified).is_ok());
        let too_long = "a".repeat(MEMO_MAX_BYTES + 1);
        assert_eq!(
            validate_memo(&too_long, AddressKind::Unified),
            Err(ValidationError::MemoTooLong {
                bytes: MEMO_MAX_BYTES + 1
            })
        );
        // Multi-byte chars count as bytes, not chars.
        let emoji = "🔒".repeat(129); // 4 bytes each = 516 bytes
        assert!(matches!(
            validate_memo(&emoji, AddressKind::Unified),
            Err(ValidationError::MemoTooLong { .. })
        ));
    }

    #[test]
    fn amount_rejects_zero_and_overspend() {
        assert_eq!(
            validate_amount(zat(0), zat(1000)),
            Err(ValidationError::ZeroValue)
        );
        assert!(validate_amount(zat(1000), zat(1000)).is_ok());
        assert_eq!(
            validate_amount(zat(1001), zat(1000)),
            Err(ValidationError::InsufficientFunds {
                needed: 1001,
                available: 1000
            })
        );
    }

    #[test]
    fn available_never_negative() {
        // reserved + fee exceed confirmed => 0 available, not an error.
        assert_eq!(
            available_to_propose(zat(10_000), zat(8_000), zat(5_000)),
            Ok(Zatoshis::ZERO)
        );
    }
}
