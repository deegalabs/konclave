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

/// THE decision whether a vault's sends may be built at the ZIP 2009 fee, and from which height.
///
/// `(true, Some(from))` only when the operator's switch is OFF (`per-vault`) AND `reports` is `Some`,
/// non-empty and EVERY seat reported a height (`seat_fee_reports`); `from` is then the highest of the
/// table's own `table_from` and every report. The table's floor is a floor: a seat that reports a
/// LOWER height than the table's (a forged or stale report) cannot bring the era earlier than the
/// table has it. Anything else is `(false, None)`: switch ON, no seat count (`None`), no seats (empty),
/// or one seat that reported nothing.
///
/// A report is self-declared and NOT authenticated against the members: whoever may register a seat's keys
/// (anyone holding the vault id, on a vault with no read key) can change that seat's report, and two devices of one seat share one registration (the newest speaks
/// for the seat). So the coordinator can build at the lower fee for a vault where a signing device
/// still refuses it, and that device then refuses the ceremony: availability (the payment does not go
/// out at that fee), never funds. The device's own fee check is the defence; the operator's switch
/// (`KONCLAVE_FEE_MARGINAL_MAX=5000`) is the remedy. The height the permission is judged at is the
/// coordinator's own tip, never a report (`guard_built_fee`, the signer's own wallet target).
pub fn vault_fee_permission(
    switch: FeeSwitch,
    reports: Option<&[Option<u32>]>,
    table_from: u32,
) -> (bool, Option<u32>) {
    if switch != FeeSwitch::Off {
        return (false, None);
    }
    let Some(reports) = reports.filter(|r| !r.is_empty()) else {
        return (false, None);
    };
    let mut from = table_from;
    for r in reports {
        match r {
            Some(h) => from = from.max(*h),
            None => return (false, None),
        }
    }
    (true, Some(from))
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

    const F: u32 = 3_590_000;

    #[test]
    fn the_switch_on_ignores_full_reports() {
        let all = [Some(F), Some(F)];
        assert_eq!(
            vault_fee_permission(FeeSwitch::On, Some(&all), F),
            (false, None)
        );
    }

    #[test]
    fn switch_off_with_every_seat_reporting_permits_from_the_highest_height() {
        assert_eq!(
            vault_fee_permission(FeeSwitch::Off, Some(&[Some(F), Some(F)]), F),
            (true, Some(F))
        );
        assert_eq!(
            vault_fee_permission(
                FeeSwitch::Off,
                Some(&[Some(F), Some(F + 500), Some(F + 7)]),
                F
            ),
            (true, Some(F + 500))
        );
    }

    // The decisive test: a seat cannot report the era earlier than the table has it.
    #[test]
    fn a_seat_reporting_below_the_table_cannot_bring_the_era_earlier() {
        assert_eq!(
            vault_fee_permission(FeeSwitch::Off, Some(&[Some(1), Some(F + 3)]), F),
            (true, Some(F + 3))
        );
        assert_eq!(
            vault_fee_permission(FeeSwitch::Off, Some(&[Some(0), Some(5)]), F),
            (true, Some(F))
        );
    }

    #[test]
    fn nothing_is_permitted_unless_every_seat_reported() {
        let off = FeeSwitch::Off;
        assert_eq!(
            vault_fee_permission(off, Some(&[Some(F), None]), F),
            (false, None)
        );
        assert_eq!(vault_fee_permission(off, Some(&[None]), F), (false, None));
        assert_eq!(vault_fee_permission(off, None, F), (false, None));
        assert_eq!(vault_fee_permission(off, Some(&[]), F), (false, None));
    }

    #[test]
    fn the_table_floor_is_the_tables_zip_2009_height() {
        assert_eq!(konclave_seal::epochs::ZIP2009_FROM, 3_590_000);
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
