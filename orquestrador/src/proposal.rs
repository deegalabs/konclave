//! The Proposal state machine (spec LOGICA_E_REGRAS §6) — modeled explicitly and
//! auditable, never implicit. Applies to both single payments and payroll.
//!
//! ```text
//! rascunho ─propor→ aguardando ─quórum→ pronta ─broadcast→ enviada ─confirma→ confirmada
//!                      │
//!                      ├─recusa inviabiliza quórum→ recusada
//!                      ├─expira→ expirada
//!                      └─cancela (só proponente)→ cancelada
//! ```
//! Rules: the proposer counts as the 1st approval; approvals needed = `t`; a member
//! cannot both approve and refuse; approval/refusal are idempotent; if refusals make
//! `t` unreachable the proposal is auto-`Rejected`.

use std::collections::BTreeSet;

/// A member is identified by their communication public key (hex).
pub type MemberId = String;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ProposalState {
    Draft,
    Awaiting,
    Ready,
    Sent,
    Confirmed,
    Rejected,
    Expired,
    Cancelled,
}

impl ProposalState {
    /// Terminal states admit no further transitions.
    pub fn is_terminal(self) -> bool {
        matches!(
            self,
            ProposalState::Confirmed
                | ProposalState::Rejected
                | ProposalState::Expired
                | ProposalState::Cancelled
        )
    }

    /// States shown in the "pending proposals" list (spec §6.7).
    pub fn is_open(self) -> bool {
        matches!(
            self,
            ProposalState::Awaiting | ProposalState::Ready | ProposalState::Sent
        )
    }
}

#[derive(Debug, PartialEq, Eq)]
pub enum ProposalError {
    /// Quorum threshold is invalid (must be 1 ≤ t ≤ n).
    InvalidQuorum { threshold: u16, total: u16 },
    /// The action isn't allowed from the current state.
    WrongState { state: ProposalState },
    /// Only the proposer may cancel.
    NotProposer,
    /// A member tried to both approve and refuse.
    ConflictingVote { member: MemberId },
}

impl std::fmt::Display for ProposalError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            ProposalError::InvalidQuorum { threshold, total } => {
                write!(f, "invalid quorum {threshold}-of-{total}")
            }
            ProposalError::WrongState { state } => {
                write!(f, "action not allowed while proposal is {state:?}")
            }
            ProposalError::NotProposer => write!(f, "only the proposer can cancel this proposal"),
            ProposalError::ConflictingVote { member } => {
                write!(f, "member {member} already voted the other way")
            }
        }
    }
}

impl std::error::Error for ProposalError {}

/// A t-of-n quorum, fixed at vault creation.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Quorum {
    pub threshold: u16,
    pub total: u16,
}

impl Quorum {
    pub fn new(threshold: u16, total: u16) -> Result<Self, ProposalError> {
        if threshold == 0 || threshold > total {
            Err(ProposalError::InvalidQuorum { threshold, total })
        } else {
            Ok(Quorum { threshold, total })
        }
    }
}

/// A proposal and its collected votes.
#[derive(Debug, Clone)]
pub struct Proposal {
    proposer: MemberId,
    quorum: Quorum,
    approvals: BTreeSet<MemberId>,
    refusals: BTreeSet<MemberId>,
    state: ProposalState,
}

impl Proposal {
    /// Propose (the 1st signature). The proposer counts as the first approval; if the
    /// quorum is 1 the proposal is immediately `Ready` (spec §3.2).
    pub fn propose(proposer: MemberId, quorum: Quorum) -> Self {
        let mut approvals = BTreeSet::new();
        approvals.insert(proposer.clone());
        let state = if approvals.len() as u16 >= quorum.threshold {
            ProposalState::Ready
        } else {
            ProposalState::Awaiting
        };
        Proposal {
            proposer,
            quorum,
            approvals,
            refusals: BTreeSet::new(),
            state,
        }
    }

    pub fn state(&self) -> ProposalState {
        self.state
    }
    pub fn quorum(&self) -> Quorum {
        self.quorum
    }
    pub fn proposer(&self) -> &str {
        &self.proposer
    }
    /// Approvals collected so far.
    pub fn approvals(&self) -> usize {
        self.approvals.len()
    }
    /// Approvals still required to reach the quorum.
    pub fn remaining(&self) -> u16 {
        (self.quorum.threshold as usize).saturating_sub(self.approvals.len()) as u16
    }

    /// A member approves. Idempotent; conflicts with a prior refusal are rejected.
    pub fn approve(&mut self, member: MemberId) -> Result<(), ProposalError> {
        if self.state != ProposalState::Awaiting {
            return Err(ProposalError::WrongState { state: self.state });
        }
        if self.refusals.contains(&member) {
            return Err(ProposalError::ConflictingVote { member });
        }
        self.approvals.insert(member); // idempotent
        if self.approvals.len() as u16 >= self.quorum.threshold {
            self.state = ProposalState::Ready;
        }
        Ok(())
    }

    /// A member refuses. If refusals make the quorum unreachable, the proposal is
    /// auto-`Rejected` (spec §6.3): unreachable when `n − refusals < t`.
    pub fn refuse(&mut self, member: MemberId) -> Result<(), ProposalError> {
        if self.state != ProposalState::Awaiting {
            return Err(ProposalError::WrongState { state: self.state });
        }
        if self.approvals.contains(&member) {
            return Err(ProposalError::ConflictingVote { member });
        }
        self.refusals.insert(member); // idempotent
        let reachable_approvals = self.quorum.total as usize - self.refusals.len();
        if (reachable_approvals as u16) < self.quorum.threshold {
            self.state = ProposalState::Rejected;
        }
        Ok(())
    }

    /// Broadcast a ready proposal to the network.
    pub fn broadcast(&mut self) -> Result<(), ProposalError> {
        self.transition(ProposalState::Ready, ProposalState::Sent)
    }

    /// Mark a sent proposal confirmed on-chain (driven by sync).
    pub fn confirm(&mut self) -> Result<(), ProposalError> {
        self.transition(ProposalState::Sent, ProposalState::Confirmed)
    }

    /// Expire an awaiting proposal (caller decides based on trusted, chain-derived time).
    pub fn expire(&mut self) -> Result<(), ProposalError> {
        self.transition(ProposalState::Awaiting, ProposalState::Expired)
    }

    /// Cancel — only the proposer, only while awaiting.
    pub fn cancel(&mut self, by: &str) -> Result<(), ProposalError> {
        if by != self.proposer {
            return Err(ProposalError::NotProposer);
        }
        self.transition(ProposalState::Awaiting, ProposalState::Cancelled)
    }

    fn transition(
        &mut self,
        from: ProposalState,
        to: ProposalState,
    ) -> Result<(), ProposalError> {
        if self.state == from {
            self.state = to;
            Ok(())
        } else {
            Err(ProposalError::WrongState { state: self.state })
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn q(t: u16, n: u16) -> Quorum {
        Quorum::new(t, n).unwrap()
    }

    #[test]
    fn quorum_rejects_invalid() {
        assert!(Quorum::new(0, 3).is_err()); // t must be >= 1
        assert!(Quorum::new(4, 3).is_err()); // t must be <= n
        assert!(Quorum::new(2, 3).is_ok());
    }

    #[test]
    fn propose_counts_proposer_as_first_approval() {
        let p = Proposal::propose("alice".into(), q(2, 3));
        assert_eq!(p.state(), ProposalState::Awaiting);
        assert_eq!(p.approvals(), 1);
        assert_eq!(p.remaining(), 1);
    }

    #[test]
    fn quorum_of_one_is_immediately_ready() {
        let p = Proposal::propose("alice".into(), q(1, 3));
        assert_eq!(p.state(), ProposalState::Ready);
        assert_eq!(p.remaining(), 0);
    }

    #[test]
    fn reaching_quorum_becomes_ready() {
        let mut p = Proposal::propose("alice".into(), q(2, 3));
        p.approve("bob".into()).unwrap();
        assert_eq!(p.state(), ProposalState::Ready);
    }

    #[test]
    fn double_approval_is_idempotent() {
        let mut p = Proposal::propose("alice".into(), q(3, 3));
        p.approve("bob".into()).unwrap();
        p.approve("bob".into()).unwrap(); // no double count
        assert_eq!(p.approvals(), 2);
        assert_eq!(p.state(), ProposalState::Awaiting);
    }

    #[test]
    fn cannot_approve_and_refuse() {
        let mut p = Proposal::propose("alice".into(), q(2, 3));
        p.refuse("bob".into()).unwrap();
        assert_eq!(
            p.approve("bob".into()),
            Err(ProposalError::ConflictingVote { member: "bob".into() })
        );
    }

    #[test]
    fn refusal_making_quorum_unreachable_rejects() {
        // 2-of-3: one refusal still leaves 2 possible approvals (reachable). A second
        // refusal leaves only 1 possible => unreachable => Rejected.
        let mut p = Proposal::propose("alice".into(), q(2, 3));
        p.refuse("bob".into()).unwrap();
        assert_eq!(p.state(), ProposalState::Awaiting);
        p.refuse("carol".into()).unwrap();
        assert_eq!(p.state(), ProposalState::Rejected);
    }

    #[test]
    fn single_refusal_can_reject_when_margin_is_zero() {
        // 3-of-3: any refusal makes the quorum unreachable immediately.
        let mut p = Proposal::propose("alice".into(), q(3, 3));
        p.refuse("bob".into()).unwrap();
        assert_eq!(p.state(), ProposalState::Rejected);
    }

    #[test]
    fn full_happy_path() {
        let mut p = Proposal::propose("alice".into(), q(2, 3));
        p.approve("bob".into()).unwrap();
        assert_eq!(p.state(), ProposalState::Ready);
        p.broadcast().unwrap();
        assert_eq!(p.state(), ProposalState::Sent);
        p.confirm().unwrap();
        assert_eq!(p.state(), ProposalState::Confirmed);
    }

    #[test]
    fn cancel_only_by_proposer() {
        let mut p = Proposal::propose("alice".into(), q(2, 3));
        assert_eq!(p.cancel("bob"), Err(ProposalError::NotProposer));
        p.cancel("alice").unwrap();
        assert_eq!(p.state(), ProposalState::Cancelled);
    }

    #[test]
    fn no_transitions_from_terminal_states() {
        let mut p = Proposal::propose("alice".into(), q(1, 3)); // Ready
        p.broadcast().unwrap();
        p.confirm().unwrap(); // Confirmed (terminal)
        assert!(p.state().is_terminal());
        assert!(matches!(p.approve("bob".into()), Err(ProposalError::WrongState { .. })));
        assert!(matches!(p.broadcast(), Err(ProposalError::WrongState { .. })));
        assert!(matches!(p.expire(), Err(ProposalError::WrongState { .. })));
        assert!(matches!(p.cancel("alice"), Err(ProposalError::WrongState { .. })));
    }

    #[test]
    fn cannot_broadcast_before_ready() {
        let mut p = Proposal::propose("alice".into(), q(2, 3)); // Awaiting
        assert!(matches!(p.broadcast(), Err(ProposalError::WrongState { .. })));
    }

    #[test]
    fn expire_only_from_awaiting() {
        let mut ready = Proposal::propose("alice".into(), q(1, 3)); // Ready
        assert!(matches!(ready.expire(), Err(ProposalError::WrongState { .. })));
        let mut awaiting = Proposal::propose("alice".into(), q(2, 3));
        awaiting.expire().unwrap();
        assert_eq!(awaiting.state(), ProposalState::Expired);
    }
}
