//! Konclave Orquestrador — Layer 2.
//!
//! The backend Konclave owns: the explicit proposal state machine, boundary
//! validation (ZIP 317 fees, memo/value rules), and — added incrementally — the
//! orchestration of the official FROST/Zcash tools with structured I/O.
//!
//! This module is the dependency-free domain core (std only): explicit states and
//! validated inputs, exhaustively unit-tested. Orchestration (subprocess wrappers),
//! the SQLite store, and OS-keychain share storage are layered on top.

pub mod money;
pub mod proposal;
pub mod validation;

pub use money::{Zatoshis, MoneyError};
pub use proposal::{Proposal, ProposalError, ProposalState, Quorum};
pub use validation::{
    available_to_propose, estimate_fee_for_payment, validate_amount, validate_memo,
    validate_payroll, AddressKind, PayrollLine, ValidationError,
};
