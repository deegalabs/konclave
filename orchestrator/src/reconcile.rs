//! Multi-device reconciliation (CLAUDE.md §8, spec §6): the local SQLite cache can diverge from
//! on-chain reality when **another device** operates the same vault (it approved, it sent, or the
//! chain simply moved). **On-chain always wins.**
//!
//! This module is **pure**: it takes an authoritative on-chain snapshot plus the local active
//! proposals and returns what must change - it never touches I/O, the store, or the wallet. The
//! caller applies the outcomes (promote a confirmed send, invalidate an underfunded proposal).
//! Keeping the decision pure is deliberate: it makes "on-chain wins" exhaustively testable (the
//! destructive suite, §8) and auditable, and it keeps sync/persistence where they belong.
//!
//! The divergences it resolves:
//!   1. A locally-`Sent` proposal whose txid is now **confirmed** on-chain → promote to `Confirmed`.
//!   2. Live proposals (`Awaiting`/`Ready`) hold optimistic **reservations** against the cached
//!      balance. If their total exceeds the freshly-synced on-chain spendable - because another
//!      device already spent those notes - the **excess is invalidated**. Oldest keeps priority
//!      (FIFO by `created_at`, `id` as the tiebreak), so **every device reaches the same decision**
//!      regardless of the order its cache holds.
//!
//! Store wiring has landed: [`crate::store::Store::reconcile_proposals`] maps the cached records
//! into this engine and persists the outcomes (`Confirm` → `Confirmed`, `Invalidate` →
//! `Superseded`). The fresh-sync trigger has landed too - `server::reconcile_vault` +
//! `POST /api/vault/reconcile` read the on-chain shielded spendable (Orchard + Ironwood) and run this engine. The one
//! honest gap left is the `confirmed_txids` source for the `Confirm` half: promoting a `Sent`
//! proposal needs a wallet tx-status query the reader does not yet expose. The balance half -
//! invalidating reservations the chain can no longer fund - is complete end to end.

use crate::money::{MoneyError, Zatoshis};
use crate::proposal::ProposalState;

/// The authoritative on-chain view, from a **fresh wallet sync** (never the local cache).
#[derive(Debug, Clone)]
pub struct ChainSnapshot {
    /// Spendable (confirmed, unspent) balance right now.
    pub spendable: Zatoshis,
    /// Txids observed confirmed on-chain - promotes a locally-`Sent` proposal to `Confirmed`.
    pub confirmed_txids: Vec<String>,
}

/// A local proposal as reconciliation sees it: the minimum drawn from the cache.
#[derive(Debug, Clone)]
pub struct LocalProposal {
    pub id: String,
    pub state: ProposalState,
    /// What this proposal would spend if it goes out (value + fee): its reservation.
    pub reserved: Zatoshis,
    /// The broadcast txid, set once `Sent`.
    pub txid: Option<String>,
    /// Creation time (unix secs). Older proposals keep their reservation first (FIFO), so the
    /// divergence resolves the same way on every device.
    pub created_at: i64,
}

/// What reconciliation decides for one proposal. On-chain always wins.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Outcome {
    /// No divergence - leave it as it is.
    Unchanged,
    /// Locally `Sent` and its txid is confirmed on-chain → promote to `Confirmed`.
    Confirm,
    /// A live (`Awaiting`/`Ready`) proposal the on-chain balance can no longer fund - another
    /// device already spent those notes. It cannot proceed; on-chain won.
    Invalidate { reason: String },
}

/// A per-proposal reconciliation decision.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Decision {
    pub id: String,
    pub outcome: Outcome,
}

/// The result of reconciling the local cache against the chain.
#[derive(Debug, Clone)]
pub struct ReconcileReport {
    /// One decision per non-terminal, non-draft local proposal, in the input order.
    pub decisions: Vec<Decision>,
    /// Sum of reservations still held live (`Awaiting`/`Ready` kept) after reconciliation -
    /// never more than the on-chain spendable.
    pub reserved_live: Zatoshis,
    /// How much the live reservations exceeded the on-chain spendable *before* invalidation
    /// (`0` when the cache agreed with the chain).
    pub over_reserved: Zatoshis,
}

impl ReconcileReport {
    /// The proposals reconciliation wants to change (anything but `Unchanged`).
    pub fn changes(&self) -> impl Iterator<Item = &Decision> {
        self.decisions
            .iter()
            .filter(|d| d.outcome != Outcome::Unchanged)
    }

    /// Whether the local cache diverged from the chain at all.
    pub fn diverged(&self) -> bool {
        self.changes().next().is_some()
    }
}

/// Reconcile the local proposals against the authoritative chain snapshot. On-chain wins.
///
/// Terminal proposals (`Confirmed`/`Rejected`/`Expired`/`Cancelled`) and `Draft`s hold no live
/// reservation and are reported `Unchanged`. `Sent`-but-unconfirmed proposals keep their state
/// (their notes have already left the wallet); they do not take part in the funding walk.
pub fn reconcile(
    snapshot: &ChainSnapshot,
    locals: &[LocalProposal],
) -> Result<ReconcileReport, MoneyError> {
    let mut decisions: Vec<Decision> = Vec::with_capacity(locals.len());

    // 1) Promote Sent -> Confirmed when the chain shows the txid.
    for p in locals {
        if p.state == ProposalState::Sent {
            let confirmed = p
                .txid
                .as_ref()
                .is_some_and(|tx| snapshot.confirmed_txids.iter().any(|c| c == tx));
            if confirmed {
                decisions.push(Decision {
                    id: p.id.clone(),
                    outcome: Outcome::Confirm,
                });
            } else {
                decisions.push(Decision {
                    id: p.id.clone(),
                    outcome: Outcome::Unchanged,
                });
            }
        }
    }

    // 2) Fund the live reservations (Awaiting/Ready) oldest-first; invalidate the excess.
    //    Deterministic order: (created_at, id) - independent of the cache's insertion order.
    let mut live: Vec<&LocalProposal> = locals
        .iter()
        .filter(|p| matches!(p.state, ProposalState::Awaiting | ProposalState::Ready))
        .collect();
    live.sort_by(|a, b| {
        a.created_at
            .cmp(&b.created_at)
            .then_with(|| a.id.cmp(&b.id))
    });

    let mut acc = Zatoshis::ZERO; // running reservation total as we keep proposals
    let mut reserved_live = Zatoshis::ZERO;
    let mut total_live = Zatoshis::ZERO;
    for p in &live {
        total_live = total_live.checked_add(p.reserved)?;
        // A proposal fits only if keeping it does not push the running total past spendable.
        let would_be = acc.checked_add(p.reserved)?;
        if would_be <= snapshot.spendable {
            acc = would_be;
            reserved_live = acc;
            decisions.push(Decision {
                id: p.id.clone(),
                outcome: Outcome::Unchanged,
            });
        } else {
            decisions.push(Decision {
                id: p.id.clone(),
                outcome: Outcome::Invalidate {
                    reason: format!(
                        "on-chain spendable {} can no longer fund this reservation ({}); \
                         another device already spent",
                        snapshot.spendable.to_zec_string(),
                        p.reserved.to_zec_string()
                    ),
                },
            });
        }
    }

    // 3) The rest (Draft + terminal) never diverge here.
    for p in locals {
        let already = matches!(
            p.state,
            ProposalState::Sent | ProposalState::Awaiting | ProposalState::Ready
        );
        if !already {
            decisions.push(Decision {
                id: p.id.clone(),
                outcome: Outcome::Unchanged,
            });
        }
    }

    let over_reserved = total_live
        .checked_sub(snapshot.spendable)
        .unwrap_or(Zatoshis::ZERO);

    Ok(ReconcileReport {
        decisions,
        reserved_live,
        over_reserved,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn zat(n: u64) -> Zatoshis {
        Zatoshis::from_u64(n).unwrap()
    }

    fn snap(spendable: u64, confirmed: &[&str]) -> ChainSnapshot {
        ChainSnapshot {
            spendable: zat(spendable),
            confirmed_txids: confirmed.iter().map(|s| s.to_string()).collect(),
        }
    }

    fn prop(id: &str, state: ProposalState, reserved: u64, created_at: i64) -> LocalProposal {
        LocalProposal {
            id: id.into(),
            state,
            reserved: zat(reserved),
            txid: None,
            created_at,
        }
    }

    fn sent(id: &str, reserved: u64, txid: &str, created_at: i64) -> LocalProposal {
        LocalProposal {
            id: id.into(),
            state: ProposalState::Sent,
            reserved: zat(reserved),
            txid: Some(txid.into()),
            created_at,
        }
    }

    fn outcome_of<'a>(r: &'a ReconcileReport, id: &str) -> &'a Outcome {
        &r.decisions.iter().find(|d| d.id == id).unwrap().outcome
    }

    #[test]
    fn no_divergence_keeps_everything() {
        // Two live reservations that fit inside spendable -> all Unchanged, no over-reservation.
        let locals = [
            prop("a", ProposalState::Ready, 40_000, 1),
            prop("b", ProposalState::Awaiting, 30_000, 2),
        ];
        let r = reconcile(&snap(100_000, &[]), &locals).unwrap();
        assert!(!r.diverged());
        assert_eq!(outcome_of(&r, "a"), &Outcome::Unchanged);
        assert_eq!(outcome_of(&r, "b"), &Outcome::Unchanged);
        assert_eq!(r.reserved_live, zat(70_000));
        assert_eq!(r.over_reserved, Zatoshis::ZERO);
    }

    #[test]
    fn over_reservation_invalidates_the_newest_first() {
        // Spendable only covers the older proposal; on-chain won -> the newer is invalidated.
        let locals = [
            prop("old", ProposalState::Ready, 60_000, 10),
            prop("new", ProposalState::Ready, 60_000, 20),
        ];
        let r = reconcile(&snap(90_000, &[]), &locals).unwrap();
        assert!(r.diverged());
        assert_eq!(outcome_of(&r, "old"), &Outcome::Unchanged);
        assert!(matches!(outcome_of(&r, "new"), Outcome::Invalidate { .. }));
        assert_eq!(r.reserved_live, zat(60_000));
        assert_eq!(r.over_reserved, zat(30_000)); // 120k reserved - 90k spendable
    }

    #[test]
    fn sent_txid_confirmed_on_chain_is_promoted() {
        let locals = [sent("s", 50_000, "deadbeef", 5)];
        let r = reconcile(&snap(0, &["deadbeef"]), &locals).unwrap();
        assert_eq!(outcome_of(&r, "s"), &Outcome::Confirm);
    }

    #[test]
    fn sent_txid_not_yet_on_chain_stays_unchanged() {
        let locals = [sent("s", 50_000, "deadbeef", 5)];
        let r = reconcile(&snap(0, &["otherhash"]), &locals).unwrap();
        assert_eq!(outcome_of(&r, "s"), &Outcome::Unchanged);
    }

    #[test]
    fn a_single_proposal_larger_than_spendable_is_invalidated() {
        let locals = [prop("big", ProposalState::Ready, 200_000, 1)];
        let r = reconcile(&snap(100_000, &[]), &locals).unwrap();
        assert!(matches!(outcome_of(&r, "big"), Outcome::Invalidate { .. }));
        assert_eq!(r.reserved_live, Zatoshis::ZERO);
        assert_eq!(r.over_reserved, zat(100_000));
    }

    #[test]
    fn exact_boundary_reservation_equals_spendable_is_kept() {
        let locals = [prop("a", ProposalState::Ready, 100_000, 1)];
        let r = reconcile(&snap(100_000, &[]), &locals).unwrap();
        assert_eq!(outcome_of(&r, "a"), &Outcome::Unchanged);
        assert_eq!(r.over_reserved, Zatoshis::ZERO);
    }

    #[test]
    fn terminal_and_draft_proposals_never_diverge() {
        let locals = [
            prop("d", ProposalState::Draft, 999_999, 1),
            prop("x", ProposalState::Expired, 999_999, 2),
            prop("c", ProposalState::Confirmed, 999_999, 3),
            prop("r", ProposalState::Rejected, 999_999, 4),
            prop("k", ProposalState::Cancelled, 999_999, 5),
        ];
        // Even with huge reservations, none count against a zero spendable.
        let r = reconcile(&snap(0, &[]), &locals).unwrap();
        assert!(!r.diverged());
        assert_eq!(r.over_reserved, Zatoshis::ZERO);
        assert_eq!(r.reserved_live, Zatoshis::ZERO);
    }

    #[test]
    fn decision_is_independent_of_input_order() {
        // The same three live proposals in two different cache orders must reconcile identically:
        // spendable funds the two oldest (created_at 1 and 2), invalidates the newest (3).
        let a = prop("a", ProposalState::Ready, 40_000, 1);
        let b = prop("b", ProposalState::Ready, 40_000, 2);
        let c = prop("c", ProposalState::Ready, 40_000, 3);
        let r1 = reconcile(&snap(90_000, &[]), &[a.clone(), b.clone(), c.clone()]).unwrap();
        let r2 = reconcile(&snap(90_000, &[]), &[c, a, b]).unwrap();
        for id in ["a", "b", "c"] {
            assert_eq!(
                outcome_of(&r1, id),
                outcome_of(&r2, id),
                "id {id} diverged by order"
            );
        }
        assert!(matches!(outcome_of(&r1, "c"), Outcome::Invalidate { .. }));
        assert_eq!(r1.reserved_live, zat(80_000));
    }

    #[test]
    fn ties_on_created_at_break_by_id_deterministically() {
        // Same created_at: the id tiebreak keeps "a" (lower) and drops "b".
        let locals = [
            prop("b", ProposalState::Ready, 60_000, 7),
            prop("a", ProposalState::Ready, 60_000, 7),
        ];
        let r = reconcile(&snap(90_000, &[]), &locals).unwrap();
        assert_eq!(outcome_of(&r, "a"), &Outcome::Unchanged);
        assert!(matches!(outcome_of(&r, "b"), Outcome::Invalidate { .. }));
    }

    #[test]
    fn mixed_confirm_and_invalidate_in_one_pass() {
        // A Sent tx confirms while an unfundable live proposal is invalidated - one reconciliation.
        let locals = [
            sent("s", 10_000, "tx1", 1),
            prop("live", ProposalState::Ready, 80_000, 2),
        ];
        let r = reconcile(&snap(50_000, &["tx1"]), &locals).unwrap();
        assert_eq!(outcome_of(&r, "s"), &Outcome::Confirm);
        assert!(matches!(outcome_of(&r, "live"), Outcome::Invalidate { .. }));
    }
}
