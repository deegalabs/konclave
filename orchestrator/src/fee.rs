//! The coordinator's side of the fee rule (#847, B3b): the operator's switch, the permission a send
//! is built with, and the guard that checks the coordinator's own build.
//!
//! What a fee MAY be lives in `konclave_seal::epochs` (`fee_rule_for`, `fee_marginals_permitted`) and
//! what a PCZT pays is read by `konclave_seal::spends`, the reader the device judges with. This file
//! decides nothing about eras: it only says whether this coordinator may ask for the ZIP 2009 one.

use crate::tools::ToolError;
use konclave_seal::epochs::{fee_in, fee_marginals_permitted, LEGACY_MARGINAL_FEE};

/// The operator's variable: `KONCLAVE_FEE_MARGINAL_MAX`.
pub const FEE_SWITCH_VAR: &str = "KONCLAVE_FEE_MARGINAL_MAX";

/// The operator's switch. `On` forces every vault to the legacy marginal fee (the set value names it);
/// `Off` leaves the decision to each vault's own permission.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub enum FeeSwitch {
    #[default]
    Off,
    On,
}

impl FeeSwitch {
    /// Read the variable. Unset is `Off`; exactly the legacy marginal fee (`5000`) is `On`; ANY other
    /// value (empty, `1000`, text) is an error, so the coordinator refuses to boot: a switch that
    /// silently fell back to a default would be a switch nobody could trust.
    pub fn from_env(value: Option<&str>) -> Result<FeeSwitch, String> {
        match value {
            None => Ok(FeeSwitch::Off),
            Some(v) if v == LEGACY_MARGINAL_FEE.to_string() => Ok(FeeSwitch::On),
            Some(_) => Err(format!(
                "{FEE_SWITCH_VAR} must be unset (the per-vault permission decides) or exactly {LEGACY_MARGINAL_FEE} (every vault pays that); refusing to start"
            )),
        }
    }

    /// The one line the coordinator logs at boot. No vault ids.
    pub fn boot_line(self) -> &'static str {
        match self {
            FeeSwitch::On => "[konclave] fee: switch ON, every vault pays 5,000 per action",
            FeeSwitch::Off => "[konclave] fee: switch OFF, a vault pays the ZIP 2009 fee from its seats' reported height, 5,000 otherwise",
        }
    }
}

/// Whether a send may be built at the ZIP 2009 fee: the switch is not forcing the legacy fee AND the
/// vault's seats permit it. `seats_permit` is false everywhere until B2's report reader is wired.
pub fn fee_permission(switch: FeeSwitch, seats_permit: bool) -> bool {
    switch == FeeSwitch::Off && seats_permit
}

/// The coordinator checks its OWN build before it asks anyone to approve it: the fee the PCZT pays
/// must be one the rule for this vault allows at `target_height`. The device judges the fee it signs
/// either way; this catches the coordinator's own mistake (a signer binary of another build, a rule
/// that drifted) as an error here, instead of as every member's refusal.
pub fn guard_built_fee(
    pczt_bytes: &[u8],
    target_height: u32,
    permitted: bool,
) -> Result<(), ToolError> {
    guard_fee_in(
        pczt_bytes,
        &fee_marginals_permitted(target_height, permitted),
    )
}

/// `guard_built_fee` against a given set of marginal fees, so the refusal can be driven with the
/// vectors the repo has: every one pays 5,000, and none pays a rate the rule forbids.
fn guard_fee_in(pczt_bytes: &[u8], allowed: &[u64]) -> Result<(), ToolError> {
    let (fee, actions) = crate::pczt::fee_and_actions_of(pczt_bytes)?;
    if fee_in(fee, actions, allowed) {
        return Ok(());
    }
    Err(ToolError::parse(
        "fee",
        format!(
            "the transaction built for this send pays {fee} zatoshis for its {actions} actions, which the fee rule for this vault does not permit; nothing was sent to the members"
        ),
    ))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_switch_has_three_cases_and_refuses_everything_else() {
        assert_eq!(FeeSwitch::from_env(None), Ok(FeeSwitch::Off));
        assert_eq!(FeeSwitch::from_env(Some("5000")), Ok(FeeSwitch::On));
        for bad in [
            "", " ", "1000", "5,000", "05000", "5000 ", "abc", "0", "10000",
        ] {
            let e = FeeSwitch::from_env(Some(bad)).unwrap_err();
            assert!(
                e.contains("refusing to start") && e.contains(FEE_SWITCH_VAR),
                "{bad:?}: {e}"
            );
        }
    }

    #[test]
    fn the_boot_lines_are_the_ones_the_runbook_cites() {
        assert_eq!(
            FeeSwitch::On.boot_line(),
            "[konclave] fee: switch ON, every vault pays 5,000 per action"
        );
        assert_eq!(
            FeeSwitch::Off.boot_line(),
            "[konclave] fee: switch OFF, a vault pays the ZIP 2009 fee from its seats' reported height, 5,000 otherwise"
        );
    }

    #[test]
    fn the_switch_on_never_permits_and_the_switch_off_follows_the_seats() {
        assert!(!fee_permission(FeeSwitch::On, true));
        assert!(!fee_permission(FeeSwitch::On, false));
        assert!(!fee_permission(FeeSwitch::Off, false));
        assert!(fee_permission(FeeSwitch::Off, true));
    }

    const V: &str = "../konclave-wasm/tests/vectors/";
    fn vector(name: &str) -> Vec<u8> {
        std::fs::read(format!("{V}{name}")).unwrap()
    }

    // The guard against real PCZTs. Every vector pays the 5,000 rule (4 actions, 20,000).
    #[test]
    fn the_guard_passes_the_legacy_fee_with_and_without_permission() {
        let p = vector("ironwood_single_spend.proven.pczt");
        for (h, permitted) in [(3_500_000, false), (3_590_000, false), (3_590_000, true)] {
            assert!(guard_built_fee(&p, h, permitted).is_ok(), "{h} {permitted}");
        }
    }

    #[test]
    fn the_guard_refuses_a_build_whose_fee_is_not_in_the_set() {
        let p = vector("ironwood_single_spend.proven.pczt");
        let e = guard_fee_in(&p, &[1_000]).unwrap_err().to_string();
        assert!(e.contains("20000") && e.contains("4 actions"), "{e}");
        assert!(guard_fee_in(&p, &[5_000]).is_ok());
        // Not a fee at all: a set that holds 5,000 does not pass 20,000 for 3 actions, either.
        assert!(guard_fee_in(&p, &[]).is_err());
    }

    #[test]
    fn the_guard_refuses_what_it_cannot_read() {
        assert!(guard_built_fee(b"not a pczt", 3_590_000, true).is_err());
    }
}
