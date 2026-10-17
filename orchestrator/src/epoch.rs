//! The coordinator's side of a network upgrade (#638).
//!
//! The rules themselves (the table of upgrades, how long a transaction can still be mined, the
//! ten-block reorg margin) live in `konclave_seal::epochs`, where the device reads them too. This
//! module holds what only the coordinator does with them:
//!
//! * the BUILD HOLD: no new transaction is built for a branch that is about to stop being valid. An
//!   ordinary payment is held when `tip + expiry_delta + K >= A` (A: the next upgrade's activation
//!   height), a ZIP 318 crossing, whose notes stay reserved by the wallet until the transaction's
//!   long expiry, when `tip + K_c >= A`;
//! * the POST-BUILD BRANCH CHECK: the PCZT the engine built must be on the branch of the epoch the
//!   next block belongs to, else the coordinator has not been updated for the upgrade;
//! * the BOOT CHECK of the table's A against the engine's, which decides whether `settle` may call a
//!   transaction dead because of an upgrade at all.
//!
//! With the table as it is on mainnet today (one row) none of the first and third can act: there is
//! no A. Nothing here changes what a send does until the next upgrade's row is added.

use std::path::Path;
use std::sync::atomic::{AtomicBool, Ordering};

use konclave_seal::epochs::{Table, NU6_3};

use crate::tools::ToolError;

/// The most polls (one a second) a send waits for the quorum's ceremony: helper-server clamps the
/// request's `max_polls` to this, and the build hold reads the same number, so the two cannot drift.
pub const CEREMONY_MAX_POLLS: u32 = 600;
/// Seconds between those polls.
pub const CEREMONY_POLL_SECS: i64 = 1;
/// DEFAULT, for Daniel to confirm: the time a build, a prove and a wallet sync can take.
pub const BUILD_PROVE_SECS: i64 = 600;
/// DEFAULT, for Daniel to confirm: the time to get a broadcast transaction into a block.
pub const MINING_SECS: i64 = 600;
/// DEFAULT, for Daniel to confirm: blocks before the upgrade from which no new crossing is built.
/// A crossing's note stays reserved by the wallet until its long expiry (weeks), whatever its branch,
/// so a crossing that is caught by the upgrade holds its funds; 288 blocks is about six hours at
/// 75 s, covering the ceremony and mining with room to spare.
pub const K_CROSSING: u32 = 288;

/// `K`: blocks before the upgrade from which no new ordinary payment is built (beyond its own
/// expiry delta). The ceremony's ceiling (600 polls of one second) plus build, prove and mining,
/// at the spacing of the epoch the tip is in: 1800 s, which is 24 blocks at 75 s.
pub fn k_blocks(spacing_s: i64) -> u32 {
    let secs = i64::from(CEREMONY_MAX_POLLS) * CEREMONY_POLL_SECS + BUILD_PROVE_SECS + MINING_SECS;
    let spacing = spacing_s.max(1);
    ((secs + spacing - 1) / spacing) as u32
}

/// What a member is told (drafts: the in-app wording is Daniel's to approve). Each is short enough
/// for the screen to show verbatim, and carries the `epoch` reason so the app words it itself.
pub const HOLD_TEXT: &str =
    "the network is upgrading; this payment can be sent once the upgrade block is mined";
pub const CROSSING_HOLD_TEXT: &str =
    "this payment moves funds between pools and would be held by the network across the upgrade; send it after the upgrade";
pub const NOT_UPDATED_TEXT: &str = "the coordinator has not been updated for the network upgrade";
pub const NEEDS_NEW_SIGNATURE_TEXT: &str =
    "this payment needs a new signature: the network upgraded before it was mined";

/// `ToolError::Parse { what, .. }` carrying one of the texts above: how a refusal of this module
/// crosses `SendSteps::prepare` without a new error type in every match over `ToolError`.
pub const REFUSAL: &str = "epoch";

/// A refusal of this module as the error `prepare` returns.
pub fn refusal(text: &'static str) -> ToolError {
    ToolError::parse(REFUSAL, text)
}

/// Whether `e` is a refusal of this module, and its text.
pub fn refusal_text(e: &ToolError) -> Option<&str> {
    match e {
        ToolError::Parse { what, detail } if what == REFUSAL => Some(detail),
        _ => None,
    }
}

fn as_height(tip: u64) -> u32 {
    u32::try_from(tip).unwrap_or(u32::MAX)
}

/// The hold BEFORE a build: `Some(text)` when a new transaction for the epoch the next block is in
/// would cross into the next upgrade before it could be mined. Never without a later row.
pub fn hold_before_build(table: &Table, tip: u64) -> Option<&'static str> {
    let tip = as_height(tip);
    let row = table.epoch_of(tip.saturating_add(1));
    let a = table.next_activation_after(row.branch_id)?;
    let reach = tip
        .saturating_add(row.expiry_delta)
        .saturating_add(k_blocks(row.spacing_s));
    (reach >= a).then_some(HOLD_TEXT)
}

/// The checks on a BUILT transaction, read from the PCZT itself: its branch is the one the next
/// block is under, and, when its expiry is beyond what an ordinary payment gets (a ZIP 318
/// crossing), the upgrade is not within `K_c` blocks.
pub fn check_built(
    table: &Table,
    tip: u64,
    branch_id: u32,
    expiry_height: u32,
) -> Result<(), ToolError> {
    let tip = as_height(tip);
    let row = table.epoch_of(tip.saturating_add(1));
    if branch_id != row.branch_id {
        return Err(refusal(NOT_UPDATED_TEXT));
    }
    if let Some(a) = table.next_activation_after(row.branch_id) {
        let plain_reach = tip
            .saturating_add(row.expiry_delta)
            .saturating_add(k_blocks(row.spacing_s));
        let long = expiry_height == 0 || expiry_height > plain_reach;
        if long && tip.saturating_add(K_CROSSING) >= a {
            return Err(refusal(CROSSING_HOLD_TEXT));
        }
    }
    Ok(())
}

/// What the coordinator reads the chain with, for the hold and the branch check. The tip is asked
/// only when the table has a later row to be near.
pub struct EpochGate<'a> {
    pub table: &'a Table,
    pub tip: &'a dyn Fn() -> Result<u64, ToolError>,
}

impl EpochGate<'_> {
    /// The chain tip, or `0` when the table has one row and the tip decides nothing.
    pub fn tip(&self) -> Result<u64, ToolError> {
        if self.table.epochs.len() < 2 {
            return Ok(0);
        }
        (self.tip)()
    }
}

/// Whether the epoch cap in `settle` is on. Off until the boot check has shown the table's A is the
/// engine's; a process that never ran the check has the cap off, which is today's behaviour.
static CAP_ON: AtomicBool = AtomicBool::new(false);

pub fn cap_is_on() -> bool {
    CAP_ON.load(Ordering::Relaxed)
}

/// The boot check's answer, and why.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Cap {
    On,
    Off(String),
}

/// Compare the table's next activation height with the one the engine reports. The cap is on only
/// when both exist and are equal: a table with no later row has no A to cap at, an engine that
/// reports none cannot confirm ours, and a disagreement means one of them is wrong, in which case
/// declaring a transaction dead could make a transaction that can still be mined look settled.
pub fn check_cap(table: &Table, engine_activation: Option<u32>) -> Cap {
    let Some(ours) = table.next_activation_after(NU6_3) else {
        return Cap::Off(
            "the coordinator's table has no later upgrade, so there is no height to cap at".into(),
        );
    };
    match engine_activation {
        None => Cap::Off(format!(
            "the engine reports no activation height for the next upgrade (the table says {ours}), so it cannot be confirmed"
        )),
        Some(theirs) if theirs != ours => Cap::Off(format!(
            "the table says the next upgrade activates at {ours} and the engine says {theirs}"
        )),
        Some(_) => Cap::On,
    }
}

/// Run the boot check and set the switch; returns the line the operator reads in the log.
pub fn apply_boot_check(table: &Table, engine_activation: Option<u32>) -> String {
    match check_cap(table, engine_activation) {
        Cap::On => {
            CAP_ON.store(true, Ordering::Relaxed);
            "epoch cap: ON (the table and the engine agree on the next upgrade's height)".into()
        }
        Cap::Off(why) => {
            CAP_ON.store(false, Ordering::Relaxed);
            format!("epoch cap: off ({why}); a send is judged by its expiry alone")
        }
    }
}

/// The boot check against mainnet's table and the live engine: the one call the coordinator makes.
pub fn boot_check_live(konclave_signer: &Path) -> String {
    apply_boot_check(
        &konclave_seal::epochs::MAINNET,
        read_engine_activation(konclave_signer),
    )
}

/// Ask the engine for the next upgrade's activation height: `konclave-signer next-upgrade`, which
/// prints `{"activation_height": <number|null>}`. The engine that runs today has no such command,
/// and any failure to answer reads as "reports none": the cap stays off. (The command arrives with
/// the engine move that carries a crate that knows the height, #638 commit 2.)
pub fn read_engine_activation(konclave_signer: &Path) -> Option<u32> {
    let out = crate::tools::run_text(konclave_signer, &["next-upgrade"], None).ok()?;
    parse_engine_activation(&out)
}

pub fn parse_engine_activation(out: &str) -> Option<u32> {
    let v: serde_json::Value = serde_json::from_str(out.trim()).ok()?;
    u32::try_from(v.get("activation_height")?.as_u64()?).ok()
}

#[cfg(test)]
pub(crate) fn set_cap_for_test(on: bool) {
    CAP_ON.store(on, Ordering::Relaxed);
}

/// A table WITH a later row, for the tests of every module that acts across an upgrade. It exists
/// only when testing: the mainnet row is added the day its height is decided.
#[cfg(test)]
pub(crate) mod test_table {
    use konclave_seal::epochs::{Anchor, Epoch, Table, NU6_3};

    pub const NU7: u32 = 0x7719_0ad9;
    pub const A: u32 = 3_500_000;
    pub const WITH_NEXT: Table = Table {
        epochs: &[
            Epoch {
                activation_height: 3_428_143,
                branch_id: NU6_3,
                tx_version: 6,
                version_group_id: 0xD884_B698,
                spacing_s: 75,
                expiry_delta: 40,
            },
            Epoch {
                activation_height: A,
                branch_id: NU7,
                tx_version: 6,
                version_group_id: 0xD884_B698,
                spacing_s: 25,
                expiry_delta: 120,
            },
        ],
        anchor: Anchor {
            height: 3_428_143,
            unix: 1_785_247_643,
        },
    };
}

#[cfg(test)]
mod tests {
    use super::test_table::*;
    use super::*;
    use konclave_seal::epochs::MAINNET;

    #[test]
    fn k_is_the_ceremony_ceiling_plus_build_and_mining_in_blocks() {
        // 600 polls x 1 s + 600 s build/prove + 600 s mining = 1800 s = 24 blocks at 75 s.
        assert_eq!(k_blocks(75), 24);
        assert_eq!(
            k_blocks(25),
            72,
            "the same half hour is more blocks at 25 s"
        );
        assert_eq!(CEREMONY_MAX_POLLS, 600);
    }

    #[test]
    fn the_hold_never_fires_without_a_later_row() {
        for tip in [0u64, 1, 3_428_143, 3_500_000, 10_000_000, u64::MAX] {
            assert_eq!(hold_before_build(&MAINNET, tip), None, "tip {tip}");
        }
        for (tip, expiry) in [
            (3_500_000u64, 0u32),
            (3_500_000, 99_999_999),
            (5, 3_500_041),
        ] {
            check_built(&MAINNET, tip, NU6_3, expiry).unwrap_or_else(|e| panic!("{tip}: {e}"));
        }
    }

    #[test]
    fn the_hold_starts_at_a_minus_delta_minus_k_and_not_a_block_before() {
        let k = k_blocks(75);
        let edge = u64::from(A - 40 - k);
        assert_eq!(hold_before_build(&WITH_NEXT, edge - 1), None);
        assert_eq!(hold_before_build(&WITH_NEXT, edge), Some(HOLD_TEXT));
        assert_eq!(
            hold_before_build(&WITH_NEXT, u64::from(A) - 2),
            Some(HOLD_TEXT)
        );
        // Once the NEXT block is the upgrade's own the transaction is built under the new branch
        // and nothing is held (the branch check then demands it).
        assert_eq!(hold_before_build(&WITH_NEXT, u64::from(A) - 1), None);
        assert_eq!(hold_before_build(&WITH_NEXT, u64::from(A)), None);
    }

    #[test]
    fn a_crossing_is_held_further_out_than_an_ordinary_payment() {
        let long = 3_500_000 + 34_560; // far beyond an ordinary expiry
        let edge = u64::from(A - K_CROSSING);
        check_built(&WITH_NEXT, edge - 1, NU6_3, long).unwrap();
        let e = check_built(&WITH_NEXT, edge, NU6_3, long).unwrap_err();
        assert_eq!(refusal_text(&e), Some(CROSSING_HOLD_TEXT));
        // An ordinary expiry at that tip is not a crossing: it passes (the pre-build hold handles it).
        check_built(&WITH_NEXT, edge, NU6_3, (edge as u32) + 41).unwrap();
        // No expiry at all counts as long.
        assert!(check_built(&WITH_NEXT, edge, NU6_3, 0).is_err());
    }

    #[test]
    fn a_built_transaction_must_be_on_the_branch_of_the_next_block() {
        // Before the upgrade: NU6.3 passes, the new branch does not exist yet.
        check_built(&WITH_NEXT, 3_000_000, NU6_3, 3_000_041).unwrap();
        let e = check_built(&WITH_NEXT, 3_000_000, NU7, 3_000_041).unwrap_err();
        assert_eq!(refusal_text(&e), Some(NOT_UPDATED_TEXT));
        // From the upgrade: an engine that still builds NU6.3 is refused.
        let e = check_built(&WITH_NEXT, u64::from(A), NU6_3, A + 41).unwrap_err();
        assert_eq!(refusal_text(&e), Some(NOT_UPDATED_TEXT));
        check_built(&WITH_NEXT, u64::from(A), NU7, A + 121).unwrap();
        // And a branch the table does not know is refused on any table.
        assert!(check_built(&MAINNET, 3_500_000, 0xdead_beef, 3_500_041).is_err());
    }

    #[test]
    fn the_cap_is_on_only_when_the_table_and_the_engine_agree() {
        assert!(
            matches!(check_cap(&MAINNET, None), Cap::Off(_)),
            "no row: no A"
        );
        assert!(
            matches!(check_cap(&MAINNET, Some(A)), Cap::Off(_)),
            "no row: no A"
        );
        assert!(
            matches!(check_cap(&WITH_NEXT, None), Cap::Off(_)),
            "the engine reports none"
        );
        assert!(
            matches!(check_cap(&WITH_NEXT, Some(A + 1)), Cap::Off(_)),
            "they disagree"
        );
        assert_eq!(check_cap(&WITH_NEXT, Some(A)), Cap::On);
        let Cap::Off(why) = check_cap(&WITH_NEXT, Some(A + 1)) else {
            unreachable!()
        };
        assert!(
            why.contains(&A.to_string()) && why.contains(&(A + 1).to_string()),
            "{why}"
        );
    }

    #[test]
    fn the_boot_check_sets_the_switch_and_says_why() {
        let line = apply_boot_check(&MAINNET, None);
        assert!(!cap_is_on() && line.contains("off"), "{line}");
        let line = apply_boot_check(&WITH_NEXT, Some(A));
        assert!(cap_is_on() && line.contains("ON"), "{line}");
        let line = apply_boot_check(&WITH_NEXT, Some(A + 5));
        assert!(!cap_is_on() && line.contains("off"), "{line}");
        set_cap_for_test(false);
    }

    #[test]
    fn the_engine_answer_is_read_and_anything_else_is_none() {
        assert_eq!(
            parse_engine_activation("{\"activation_height\": 3500000}"),
            Some(A)
        );
        assert_eq!(
            parse_engine_activation("{\"activation_height\": null}"),
            None
        );
        assert_eq!(parse_engine_activation("not json"), None);
        assert_eq!(parse_engine_activation(""), None);
        assert_eq!(
            parse_engine_activation("{\"activation_height\": 99999999999}"),
            None
        );
        // An engine without the command: the spawn fails and reads as "reports none".
        assert_eq!(
            read_engine_activation(Path::new("/nonexistent/konclave-signer")),
            None
        );
    }

    #[test]
    fn the_gate_asks_for_the_tip_only_when_there_is_something_to_be_near() {
        let panics = || -> Result<u64, ToolError> { panic!("the tip was read") };
        assert_eq!(
            EpochGate {
                table: &MAINNET,
                tip: &panics
            }
            .tip()
            .unwrap(),
            0
        );
        let tip = || -> Result<u64, ToolError> { Ok(7) };
        assert_eq!(
            EpochGate {
                table: &WITH_NEXT,
                tip: &tip
            }
            .tip()
            .unwrap(),
            7
        );
    }
}
