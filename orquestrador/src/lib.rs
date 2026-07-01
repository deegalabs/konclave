//! Konclave Orquestrador — Layer 2.
//!
//! The backend Konclave owns: the explicit proposal state machine, boundary
//! validation (ZIP 317 fees, memo/value rules), and — added incrementally — the
//! orchestration of the official FROST/Zcash tools with structured I/O.
//!
//! This module is the dependency-free domain core (std only): explicit states and
//! validated inputs, exhaustively unit-tested. Orchestration (subprocess wrappers),
//! the SQLite store, and OS-keychain share storage are layered on top.

// --- domain core (dependency-free) ---
pub mod money;
pub mod proposal;
pub mod validation;

// --- orchestration layer (drives the official tools + our bridge) ---
pub mod ceremony;
pub mod pczt;
pub mod signer;
pub mod tools;
pub mod wallet;

pub use money::{MoneyError, Zatoshis};
pub use proposal::{Proposal, ProposalError, ProposalState, Quorum};
pub use validation::{
    available_to_propose, estimate_fee_for_payment, validate_amount, validate_memo,
    validate_payroll, AddressKind, PayrollLine, ValidationError,
};

pub use signer::{parse_extract, Randomizer, SigningInput};
pub use tools::{ToolError, Tools};
pub use wallet::{Balance, ChainInfo};
