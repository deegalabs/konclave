//! Konclave Orchestrator — Layer 2.
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
pub mod payroll;
pub mod proposal;
pub mod validation;

// --- authoritative Zcash address validation (audit M2; uses zcash_address) ---
pub mod address;

// --- at-rest secret protection (shares) ---
pub mod secrets;

// --- local per-device persistence ---
pub mod store;

// --- orchestration layer (drives the official tools + our bridge) ---
pub mod ceremony;
pub mod dkg;
pub mod pczt;
pub mod send;
pub mod signer;
pub mod tools;
pub mod wallet;

// --- local HTTP bridge to the UI (ADR-0004) ---
pub mod server;

// --- the blind mailbox: the konclave.app network transport (Milestone 1) ---
pub mod relay;

pub use address::{validate_recipient, AddressError, AddressReport};
pub use money::{MoneyError, Zatoshis};
pub use payroll::PayrollLine;
pub use payroll::{import_csv, ImportReport, ImportRowError, PayrollPlan, PayrollSummary};
pub use proposal::{Proposal, ProposalError, ProposalState, Quorum};
pub use validation::{
    available_to_propose, estimate_fee_for_payment, validate_amount, validate_memo, AddressKind,
    ValidationError,
};

pub use secrets::{
    generate_key, seal, unseal, unseal_to_file, with_unsealed_file, KeyStore, SecretError,
    UnsealedFile,
};
pub use signer::{parse_extract, Randomizer, SigningInput};
pub use store::{
    Beneficiary, Member, ProposalKind, ProposalRecord, Store, StoreError, VaultRecord,
};
pub use tools::{ToolError, Tools};
pub use wallet::{Balance, ChainInfo};
