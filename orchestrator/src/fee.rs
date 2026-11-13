//! The coordinator's side of the fee rule (#847, B3b): the operator's switch, the permission a send
//! is built with, and the guard that checks the coordinator's own build.
//!
//! What a fee MAY be lives in `konclave_seal::epochs` (`fee_rule_for`, `fee_marginals_permitted`) and
//! what a PCZT pays is read by `konclave_seal::spends`, the reader the device judges with. This file
//! decides nothing about eras: it only says whether this coordinator may ask for the ZIP 2009 one.

use crate::tools::ToolError;
use konclave_seal::epochs::{
    fee_in, fee_marginals_permitted, zip2009_in_force, LEGACY_MARGINAL_FEE,
};

/// The operator's variable: `KONCLAVE_FEE_MARGINAL_MAX`.
pub const FEE_SWITCH_VAR: &str = "KONCLAVE_FEE_MARGINAL_MAX";

/// The value that opens the switch to each vault's own permission.
pub const FEE_SWITCH_PER_VAULT: &str = "per-vault";

/// The operator's switch. `On` forces every vault to the legacy marginal fee; `Off` leaves the
/// decision to each vault's own permission. The safe side is the default: the variable ABSENT is `On`,
/// so a service that never had it set (a clone, a new environment) pays what it always paid.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub enum FeeSwitch {
    #[default]
    On,
    Off,
}

impl FeeSwitch {
    /// Read the variable. Absent or exactly the legacy marginal fee (`5000`) is `On`; exactly
    /// `per-vault` is `Off`; ANY other value (empty, `1000`, text) is an error, so the coordinator
    /// refuses to boot: a switch that silently fell back to a default would be one nobody could trust.
    pub fn from_env(value: Option<&str>) -> Result<FeeSwitch, String> {
        match value {
            None => Ok(FeeSwitch::On),
            Some(v) if v == LEGACY_MARGINAL_FEE.to_string() => Ok(FeeSwitch::On),
            Some(FEE_SWITCH_PER_VAULT) => Ok(FeeSwitch::Off),
            Some(_) => Err(format!(
                "{FEE_SWITCH_VAR} must be unset or {LEGACY_MARGINAL_FEE} (every vault pays that) or {FEE_SWITCH_PER_VAULT} (each vault's own permission decides); refusing to start"
            )),
        }
    }

    /// The one line the coordinator logs at boot. No vault ids.
    pub fn boot_line(self) -> String {
        match self {
            FeeSwitch::On => format!(
                "[konclave] fee: switch ON, every vault pays {} per action",
                thousands(LEGACY_MARGINAL_FEE)
            ),
            FeeSwitch::Off => format!(
                "[konclave] fee: switch OFF (per-vault), a vault pays the ZIP 2009 fee only when every seat accepts it, {} otherwise",
                thousands(LEGACY_MARGINAL_FEE)
            ),
        }
    }
}

/// `5000` as `5,000`.
fn thousands(n: u64) -> String {
    let d = n.to_string();
    let mut out = String::new();
    for (i, c) in d.chars().enumerate() {
        if i > 0 && (d.len() - i).is_multiple_of(3) {
            out.push(',');
        }
        out.push(c);
    }
    out
}

/// Whether a send may be built at the ZIP 2009 fee: the switch is not forcing the legacy fee AND the
/// vault's seats permit it. `seats_permit` is false everywhere until B2's report reader is wired.
pub fn fee_permission(switch: FeeSwitch, seats_permit: bool) -> bool {
    switch == FeeSwitch::Off && seats_permit
}

/// The coordinator checks its OWN build before it asks anyone to approve it: the fee the PCZT pays
/// must be one the rule for this vault allows at the build's target (the coordinator's own tip plus
/// one). The rule is `konclave_seal::epochs::zip2009_in_force`, the predicate the signer decides its
/// marginal with, so the guard cannot allow what the signer would not pay. The device judges the fee it
/// signs either way; this catches the coordinator's own mistake (a signer binary of another build, a
/// rule that drifted) as an error here, instead of as every member's refusal.
///
/// A tip of 0 means the coordinator does not know the chain: refused, never read as a height.
pub fn guard_built_fee(
    pczt_bytes: &[u8],
    tip: u64,
    mainnet: bool,
    permitted: bool,
    from: Option<u32>,
) -> Result<(), ToolError> {
    if tip == 0 {
        return Err(ToolError::parse(
            "fee",
            "the chain tip is unknown, so the fee of this build cannot be checked; nothing was sent to the members",
        ));
    }
    guard_fee_in(pczt_bytes, &guard_set(tip, mainnet, permitted, from))
}

/// The marginal fees the guard allows for a build whose chain tip is `tip`: the build's target is the
/// next block, and the set follows the shared predicate, so it is 5,000 alone unless the ZIP 2009 rule
/// is in force for that target.
fn guard_set(tip: u64, mainnet: bool, permitted: bool, from: Option<u32>) -> Vec<u64> {
    let target = u32::try_from(tip.saturating_add(1)).unwrap_or(u32::MAX);
    fee_marginals_permitted(target, zip2009_in_force(mainnet, target, permitted, from))
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
    fn the_switch_is_on_unless_per_vault_and_refuses_everything_else() {
        assert_eq!(FeeSwitch::from_env(None), Ok(FeeSwitch::On));
        assert_eq!(FeeSwitch::from_env(Some("5000")), Ok(FeeSwitch::On));
        assert_eq!(FeeSwitch::from_env(Some("per-vault")), Ok(FeeSwitch::Off));
        assert_eq!(FeeSwitch::default(), FeeSwitch::On);
        for bad in [
            "",
            " ",
            "1000",
            "5,000",
            "05000",
            "5000 ",
            "abc",
            "0",
            "10000",
            "Per-Vault",
            "per-vault ",
            "off",
            "zip2009",
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
            "[konclave] fee: switch OFF (per-vault), a vault pays the ZIP 2009 fee only when every seat accepts it, 5,000 otherwise"
        );
        assert_eq!(thousands(1_000), "1,000");
        assert_eq!(thousands(123_456), "123,456");
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
        for (tip, permitted) in [(3_500_000, false), (3_590_000, false), (3_590_000, true)] {
            assert!(
                guard_built_fee(&p, tip, true, permitted, Some(3_590_000)).is_ok(),
                "{tip} {permitted}"
            );
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
        assert!(guard_built_fee(b"not a pczt", 3_590_000, true, true, Some(0)).is_err());
    }

    #[test]
    fn the_guard_refuses_an_unknown_tip_explicitly() {
        let p = vector("ironwood_single_spend.proven.pczt");
        let e = guard_built_fee(&p, 0, true, false, None)
            .unwrap_err()
            .to_string();
        assert!(e.contains("chain tip is unknown"), "{e}");
    }

    // The guard asks the SAME predicate as the signer: the set it allows is 5,000 alone unless the
    // permission is in force for the target, on this network, from this height.
    #[test]
    fn the_guards_set_is_the_signers_predicate() {
        for (mainnet, tip, permitted, from, want) in [
            (true, 3_590_000u64, true, Some(3_600_000u32), vec![5_000u64]),
            (true, 3_599_998, true, Some(3_600_000), vec![5_000]),
            (true, 3_599_999, true, Some(3_600_000), vec![5_000, 1_000]),
            (true, 3_589_998, true, Some(0), vec![5_000]),
            (true, 3_589_999, true, Some(0), vec![5_000, 1_000]),
            (false, 3_600_000, true, Some(0), vec![5_000]),
            (true, 3_600_000, true, None, vec![5_000]),
            (true, 3_600_000, false, Some(0), vec![5_000]),
        ] {
            assert_eq!(
                guard_set(tip, mainnet, permitted, from),
                want,
                "{mainnet} {tip} {permitted} {from:?}"
            );
        }
    }
}
