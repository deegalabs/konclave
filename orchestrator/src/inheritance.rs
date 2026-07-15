//! Inheritance / dead-man's-switch — the second human-layer feature that matches Steward.
//!
//! The owner sends signed "proof-of-life" heartbeats. If they ever lapse for longer than the
//! configured window, the vault's quorum is authorized to **release** the funds to a named heir
//! — the release itself is an ordinary quorum-signed payment (it reuses the FROST send path;
//! nothing new cryptographically). The novelty, and the whole safety of it, is this policy: who
//! decides the owner is gone, and when.
//!
//! This module is the pure decision engine (no clock, no I/O, no store) so every edge is
//! unit-testable. The caller owns the clock and persists the last heartbeat.

/// The policy attached to a vault to arm the dead-man's-switch.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct InheritancePolicy {
    /// How long the owner may be silent before the switch arms, in seconds.
    pub lapse_secs: i64,
    /// A grace period AFTER the lapse before a release can actually be proposed — a last window
    /// for the owner to come back and cancel. Zero disables the grace.
    pub grace_secs: i64,
    /// The heir's Zcash address the release pays to.
    pub heir_address: String,
}

impl InheritancePolicy {
    /// Build a policy, rejecting nonsensical values so a misconfigured switch can never arm.
    pub fn new(
        lapse_secs: i64,
        grace_secs: i64,
        heir_address: impl Into<String>,
    ) -> Result<Self, String> {
        if lapse_secs <= 0 {
            return Err("the lapse window must be greater than zero".into());
        }
        if grace_secs < 0 {
            return Err("the grace period cannot be negative".into());
        }
        let heir_address = heir_address.into();
        if heir_address.trim().is_empty() {
            return Err("an heir address is required to arm inheritance".into());
        }
        Ok(InheritancePolicy {
            lapse_secs,
            grace_secs,
            heir_address,
        })
    }
}

/// Where the switch stands right now.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum SwitchState {
    /// The owner is present (a recent heartbeat) — funds are locked to the normal quorum.
    Active,
    /// The owner has gone silent past the lapse, but the grace period is still running — the
    /// release is pending; the owner can still return and reset it.
    Pending,
    /// The lapse and the grace have both passed — the quorum may now propose the release.
    Released,
}

/// Evaluate the switch from the last proof-of-life. Pure: the caller supplies both timestamps.
/// A `last_heartbeat` in the future (clock skew) is treated as "just now" (Active), never as a
/// reason to arm early.
pub fn evaluate(
    policy: &InheritancePolicy,
    last_heartbeat_unix: i64,
    now_unix: i64,
) -> SwitchState {
    let silent = now_unix.saturating_sub(last_heartbeat_unix);
    if silent < policy.lapse_secs {
        SwitchState::Active
    } else if silent < policy.lapse_secs.saturating_add(policy.grace_secs) {
        SwitchState::Pending
    } else {
        SwitchState::Released
    }
}

/// Whether the quorum may now propose the release to the heir. Only in the `Released` state —
/// a lapse alone (still in grace) is not enough, so a brief outage never leaks the vault.
pub fn release_authorized(
    policy: &InheritancePolicy,
    last_heartbeat_unix: i64,
    now_unix: i64,
) -> bool {
    evaluate(policy, last_heartbeat_unix, now_unix) == SwitchState::Released
}

/// Seconds until the switch would move to `Released` (0 if already there). Lets the UI show a
/// live countdown, and lets the owner know exactly how long a heartbeat buys them.
pub fn secs_until_release(
    policy: &InheritancePolicy,
    last_heartbeat_unix: i64,
    now_unix: i64,
) -> i64 {
    let deadline = last_heartbeat_unix
        .saturating_add(policy.lapse_secs)
        .saturating_add(policy.grace_secs);
    (deadline - now_unix).max(0)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn policy() -> InheritancePolicy {
        // 30-day silence arms the switch; 7 more days of grace before release.
        InheritancePolicy::new(30 * 86_400, 7 * 86_400, "u1heir...").unwrap()
    }

    #[test]
    fn a_present_owner_keeps_the_vault_locked() {
        let p = policy();
        let hb = 1_000_000;
        assert_eq!(evaluate(&p, hb, hb + 10 * 86_400), SwitchState::Active);
        assert!(!release_authorized(&p, hb, hb + 10 * 86_400));
    }

    #[test]
    fn silence_past_the_lapse_enters_grace_not_release() {
        let p = policy();
        let hb = 1_000_000;
        // 31 days of silence: past the 30-day lapse, inside the 7-day grace.
        let now = hb + 31 * 86_400;
        assert_eq!(evaluate(&p, hb, now), SwitchState::Pending);
        assert!(
            !release_authorized(&p, hb, now),
            "grace must protect against a brief outage"
        );
    }

    #[test]
    fn silence_past_lapse_plus_grace_authorizes_release() {
        let p = policy();
        let hb = 1_000_000;
        let now = hb + 38 * 86_400; // 30 + 7 + 1
        assert_eq!(evaluate(&p, hb, now), SwitchState::Released);
        assert!(release_authorized(&p, hb, now));
    }

    #[test]
    fn a_fresh_heartbeat_resets_the_switch() {
        let p = policy();
        let hb0 = 1_000_000;
        let now = hb0 + 40 * 86_400; // would be Released...
        assert_eq!(evaluate(&p, hb0, now), SwitchState::Released);
        // ...but the owner checks in: last_heartbeat = now.
        assert_eq!(evaluate(&p, now, now), SwitchState::Active);
    }

    #[test]
    fn clock_skew_never_arms_the_switch_early() {
        let p = policy();
        let now = 1_000_000;
        // A heartbeat "in the future" (skew) must read as Active, not as ancient silence.
        assert_eq!(evaluate(&p, now + 5_000, now), SwitchState::Active);
    }

    #[test]
    fn countdown_reaches_zero_exactly_at_release() {
        let p = policy();
        let hb = 1_000_000;
        assert_eq!(secs_until_release(&p, hb, hb), (30 + 7) * 86_400);
        assert_eq!(secs_until_release(&p, hb, hb + 37 * 86_400), 0);
        assert_eq!(secs_until_release(&p, hb, hb + 99 * 86_400), 0);
    }

    #[test]
    fn a_misconfigured_policy_cannot_arm() {
        assert!(InheritancePolicy::new(0, 0, "u1heir").is_err());
        assert!(InheritancePolicy::new(86_400, -1, "u1heir").is_err());
        assert!(InheritancePolicy::new(86_400, 0, "  ").is_err());
    }
}
