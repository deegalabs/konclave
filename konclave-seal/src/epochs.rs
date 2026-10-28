//! The network-upgrade rules, in ONE place (#638).
//!
//! Which consensus branch a transaction is valid under, up to which height it can still be mined, and
//! where the chain's height is estimated from a clock, were three rules written twice: the device
//! (konclave-wasm) and the coordinator (orchestrator) each carried their own copy of a ten-block
//! margin, and the device picked its epoch from the clock. This module has no dependencies and no
//! feature gate, so every crate that needs the rule reads the same code: the device's gate, the
//! coordinator's send record and its build hold, and the signer. The two sides differ only in the
//! height they feed in (the device its clock's window, the coordinator the chain tip).
//!
//! The mainnet table has ONE row today (NU6.3). The row for the next upgrade is added the day its
//! activation height is decided; until then nothing here can cap a transaction, and every rule
//! reduces to what the device and the coordinator did before (`expiry + REORG_MARGIN`).
//!
//! Test tables (with a later row) are defined by the tests that need them, never here.

/// Blocks added to the last height a transaction can be mined at before it is called dead, so a
/// short reorg cannot return it to a mempool after the vault has been told it is gone. The ONE copy:
/// the device's `still_counted` and the coordinator's `settle` both read this.
pub const REORG_MARGIN: u32 = 10;

/// Blocks the coordinator allows a wallet's SCAN to be behind its tip before it believes a
/// transaction that is not listed as mined is dead because of an upgrade. The wallet reports the tip
/// it knows, not the height it scanned, so this is a scan margin and not a reorg one; it is used only
/// until the engine exposes a scanned height.
pub const SCAN_MARGIN: u32 = 100;

/// The consensus branch of NU6.3, the upgrade every record written before the branch was kept was
/// signed under (the device's signed record and the coordinator's send record both read an absent
/// branch as this one).
pub const NU6_3: u32 = 0x37a5_165b;

/// Whether a transaction whose last mineable height is `last` is still within the reorg margin as of
/// `height`. THE one expression of the margin: the device's window floor and the coordinator's
/// chain tip both go through here.
pub fn within_margin(last: u32, height: impl Into<u64>) -> bool {
    u64::from(last) + u64::from(REORG_MARGIN) >= height.into()
}

/// ZIP 318: a pool crossing expires at the same height for every wallet in a modulus period, so that
/// nothing singles it out. The modulus is given in REFERENCE blocks of 75 s (the expiry is two moduli
/// past the last boundary) and is scaled by how many blocks of the row's spacing make one reference
/// block (3 at 25 s), which is what
/// `zcash_protocol` 0.11.0 does (zip318.rs:195-211): 34,560 blocks before NU7, 103,680 from it. The
/// device read the 75 s numbers for ever; this is the ONE place that scales them.
pub const ZIP318_MODULUS: u32 = 34_560;
/// The spacing, in seconds, the modulus above is written in.
const REFERENCE_SPACING_S: i64 = 75;

/// One network upgrade, from `activation_height` until the next row's.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Epoch {
    pub activation_height: u32,
    pub branch_id: u32,
    pub tx_version: u32,
    pub version_group_id: u32,
    /// The target spacing between blocks, in seconds.
    pub spacing_s: i64,
    /// Blocks past the target height at which an ordinary transaction built under this row expires.
    pub expiry_delta: u32,
}

/// A MEASURED block time: the last one known when the build was cut. The device's clock is turned
/// into a height from here.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Anchor {
    pub height: u32,
    pub unix: i64,
}

/// A network's rows, sorted by height, and its anchor.
#[derive(Clone, Copy, Debug)]
pub struct Table {
    pub epochs: &'static [Epoch],
    pub anchor: Anchor,
}

/// The consensus branch of NU7 (ZIP 259), carried by `zcash_protocol` 0.11.0 as `BranchId::Nu7`. The
/// id proposed earlier (0x77190AD8) is retired.
pub const NU7: u32 = 0x7719_0ad9;

/// Mainnet. NU6.3 activated at block 3,428,143, whose header time is 1785247643 (2026-07-28
/// 14:07:23 UTC). NU7 (#638) activates at block 3,543,405 (`zcash_protocol` 0.11.0, consensus.rs:567;
/// Zebra 7.0.0): its row is shipped before it activates, because a device on a bundle without it
/// refuses every transaction of the new epoch. It keeps the v6 transaction format and group id; its
/// blocks come every 25 s (ZIP 218), so an ordinary transaction expires 120 blocks past its target
/// (`NU7_DEFAULT_TX_EXPIRY_DELTA` = 3 x 40, `zcash_primitives` 0.31.0).
pub const MAINNET: Table = Table {
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
            activation_height: 3_543_405,
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

/// The window of heights a device's clock allows, as `height_bounds` gives it.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct HeightBounds {
    pub lo: u32,
    pub est: u32,
    /// The highest height an ordinary transaction built now may expire at: `top` plus the largest
    /// expiry delta of the rows the window meets.
    pub hi: u32,
    /// The highest height the clock allows a payment to be BUILT at (`hi` without the delta).
    pub top: u32,
}

/// The margin, in blocks at the anchor's spacing, a clock's estimate is widened by: this many, plus
/// one per [`SLACK_GROWTH`] blocks since the anchor (the chain drifts from its nominal spacing).
const SLACK_BLOCKS: u32 = 144;
const SLACK_GROWTH: u32 = 100;

impl Table {
    /// The row that holds `height`: the last one activated at or below it. A height below the first
    /// row reads as the first row (the table does not model what came before it).
    pub fn epoch_of(&self, height: u32) -> &'static Epoch {
        self.epochs
            .iter()
            .rfind(|e| e.activation_height <= height)
            .unwrap_or(&self.epochs[0])
    }

    /// The row for a consensus branch, if the table knows it.
    pub fn epoch_by_branch(&self, branch_id: u32) -> Option<&'static Epoch> {
        self.epochs.iter().find(|e| e.branch_id == branch_id)
    }

    /// The height at which the row AFTER `branch_id`'s activates: the first height a transaction of
    /// this branch can no longer be mined at. None for the latest row, and for an unknown branch.
    pub fn next_activation_after(&self, branch_id: u32) -> Option<u32> {
        let i = self.epochs.iter().position(|e| e.branch_id == branch_id)?;
        self.epochs.get(i + 1).map(|e| e.activation_height)
    }

    /// The last height at which a transaction of `branch_id` expiring at `expiry` can be in a block:
    /// its expiry (`0` = none, ZIP 203) or the block before the next upgrade, whichever is first.
    /// None for a branch the table does not know: callers treat that as "cannot judge".
    pub fn minable_until(&self, branch_id: u32, expiry: u32) -> Option<u32> {
        self.epoch_by_branch(branch_id)?;
        let cap = self
            .next_activation_after(branch_id)
            .map_or(u32::MAX, |a| a.saturating_sub(1));
        Some(if expiry == 0 { cap } else { expiry.min(cap) })
    }

    /// Whether a later upgrade, and not the transaction's own expiry, ends its life: one exists after
    /// the branch's row and the transaction (no expiry counts as one) outlives the block before it.
    pub fn capped_by_next(&self, branch_id: u32, expiry: u32) -> bool {
        self.next_activation_after(branch_id)
            .is_some_and(|next| expiry == 0 || expiry >= next)
    }

    /// Whether the transaction may still be mined as of `height`: [`REORG_MARGIN`] past the last height
    /// it can be in a block. A branch the table does not know cannot be judged dead, so it counts.
    /// The device feeds its window's floor in, the coordinator the chain tip.
    pub fn can_still_be_mined(&self, branch_id: u32, expiry: u32, height: u32) -> bool {
        match self.minable_until(branch_id, expiry) {
            Some(last) => within_margin(last, height),
            None => true,
        }
    }

    /// The row the anchor lies in.
    fn anchor_epoch(&self) -> &'static Epoch {
        self.epoch_of(self.anchor.height)
    }

    /// The height a clock reading corresponds to, walking the rows from the anchor at each row's own
    /// spacing. Monotonic in `t`: every spacing is positive. Before the anchor it extends backwards
    /// at the anchor row's spacing (callers decide what a clock before the anchor means).
    pub fn height_at(&self, t: i64) -> u32 {
        let a = self.anchor;
        let mut spacing = self.anchor_epoch().spacing_s.max(1);
        if t < a.unix {
            let back = (a.unix - t + spacing - 1) / spacing;
            return i64::from(a.height).saturating_sub(back).max(0) as u32;
        }
        let (mut h, mut at) = (i64::from(a.height), a.unix);
        for next in self
            .epochs
            .iter()
            .filter(|e| e.activation_height > a.height)
        {
            let reaches = at + (i64::from(next.activation_height) - h) * spacing;
            if t < reaches {
                break;
            }
            h = i64::from(next.activation_height);
            at = reaches;
            spacing = next.spacing_s.max(1);
        }
        (h + (t - at) / spacing).clamp(0, i64::from(u32::MAX)) as u32
    }

    /// The margin a clock reading is widened by, in SECONDS, so it converts to blocks at whichever
    /// spacing applies: 144 blocks at the anchor's spacing plus one per hundred blocks since the
    /// anchor, counted at that spacing. Seconds, not blocks, so that after a faster upgrade the same
    /// time is worth more blocks.
    pub fn slack(&self, t: i64) -> i64 {
        let spacing = self.anchor_epoch().spacing_s.max(1);
        let since = ((t - self.anchor.unix).max(0) / spacing) as u32;
        spacing * i64::from(SLACK_BLOCKS + since.div_ceil(SLACK_GROWTH))
    }

    /// The heights a transaction built now may honestly sit at, from the DEVICE's clock alone:
    /// `lo = height_at(now - slack)`, `est = height_at(now)`, `hi = height_at(now + slack)` plus the
    /// largest expiry delta of the rows that window meets. A clock before the anchor confirms nothing
    /// (an empty window).
    pub fn height_bounds(&self, now_unix: i64) -> HeightBounds {
        if now_unix < self.anchor.unix {
            return HeightBounds {
                lo: u32::MAX,
                est: 0,
                hi: 0,
                top: 0,
            };
        }
        let s = self.slack(now_unix);
        let est = self.height_at(now_unix);
        let lo = self.height_at(now_unix - s);
        let top = self.height_at(now_unix.saturating_add(s));
        let delta = self
            .epochs
            .iter()
            .enumerate()
            .filter(|(i, e)| {
                let end = self
                    .epochs
                    .get(i + 1)
                    .map_or(u32::MAX, |n| n.activation_height - 1);
                e.activation_height <= top && end >= lo
            })
            .map(|(_, e)| e.expiry_delta)
            .max()
            .unwrap_or(0);
        HeightBounds {
            lo,
            est,
            hi: top.saturating_add(delta),
            top,
        }
    }

    /// The modulus in force for a target in `row`: [`ZIP318_MODULUS`] reference blocks, scaled by the
    /// row's spacing (a row of 25 s blocks has three blocks to the reference block).
    fn zip318_modulus(row: &Epoch) -> u32 {
        let ratio = (REFERENCE_SPACING_S / row.spacing_s.max(1)).max(1) as u32;
        ZIP318_MODULUS.saturating_mul(ratio)
    }

    /// The expiry a pool crossing built at `target` has (ZIP 318): the next-but-one modulus boundary,
    /// at the modulus of the row `target` is in. Always past `target`; saturates at `u32::MAX`.
    pub fn crossing_expiry(&self, target: u32) -> u32 {
        let m = u64::from(Self::zip318_modulus(self.epoch_of(target)));
        let h = u64::from(target);
        u32::try_from(h - h % m + 2 * m).unwrap_or(u32::MAX)
    }

    /// Whether `expiry` is the expiry of a crossing a header naming `branch_id` can carry: one of the
    /// values `crossing_expiry` gives for a target in `[lo, top]` that lies in that branch's own row.
    /// The branch decides which scale is honest. Without it a window that straddles an upgrade would
    /// accept the old scale for a header of the new branch (and the new scale for the old one), and
    /// whoever builds the transaction would pick the crossing's expiry, hence how long its notes stay
    /// reserved. An unknown branch is refused.
    pub fn is_crossing_expiry(&self, expiry: u32, branch_id: u32, lo: u32, top: u32) -> bool {
        let Some(i) = self.epochs.iter().position(|e| e.branch_id == branch_id) else {
            return false;
        };
        let row = &self.epochs[i];
        let end = self
            .epochs
            .get(i + 1)
            .map_or(u32::MAX, |next| next.activation_height - 1);
        let (a, b) = (lo.max(row.activation_height), top.min(end));
        a <= b
            && expiry.is_multiple_of(Self::zip318_modulus(row))
            && (self.crossing_expiry(a)..=self.crossing_expiry(b)).contains(&expiry)
    }

    /// Whether a header naming `branch_id` and expiring at `expiry` may be accepted when the window of
    /// heights it could be mined at is `[lo, hi]`: that window, cut at the last height the transaction
    /// can be in a block, must meet the branch's own range. Far from an upgrade only one row qualifies;
    /// around it both do, which is exactly the device's own uncertainty. An unknown branch, and an
    /// empty window, are refused.
    pub fn header_may_be_mined(&self, branch_id: u32, expiry: u32, lo: u32, hi: u32) -> bool {
        let Some(row) = self.epoch_by_branch(branch_id) else {
            return false;
        };
        let Some(last) = self.minable_until(branch_id, expiry) else {
            return false;
        };
        let top = hi.min(last);
        let start = lo.max(row.activation_height);
        let end = self
            .next_activation_after(branch_id)
            .map_or(u32::MAX, |a| a - 1);
        start <= top.min(end)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const NU63: u32 = NU6_3;
    const A: u32 = 3_500_000;

    /// A table WITH a later row, for the rules that only act across an upgrade. Defined here, never in
    /// the production table: the mainnet row is added the day its height is decided.
    const WITH_NEXT: Table = Table {
        epochs: &[
            Epoch {
                activation_height: 3_428_143,
                branch_id: NU63,
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
        anchor: MAINNET.anchor,
    };

    /// The published mainnet height of NU7, read from `zcash_protocol` 0.11.0 (consensus.rs:567) on
    /// 2026-10-24, with Zebra 7.0.0 saying the same. The branch, version, group and spacing come from
    /// the same crate and `zcash_primitives` 0.31.0 (`NU7_DEFAULT_TX_EXPIRY_DELTA` = 3 x 40).
    const NU7_HEIGHT: u32 = 3_543_405;

    /// A table with NO later row: the rules that only matter when nothing follows (a cap that is the
    /// expiry alone, a latest row). Defined here, never in the production table, which has two rows.
    const ONE_ROW: Table = Table {
        epochs: &[MAINNET.epochs[0]],
        anchor: MAINNET.anchor,
    };

    #[test]
    fn the_mainnet_table_has_the_nu63_row_then_the_nu7_row_and_is_ordered() {
        assert_eq!(MAINNET.epochs.len(), 2);
        assert_eq!(MAINNET.epochs[0].branch_id, NU63);
        assert_eq!(
            MAINNET.epochs[1],
            Epoch {
                activation_height: NU7_HEIGHT,
                branch_id: NU7,
                tx_version: 6,
                version_group_id: 0xD884_B698,
                spacing_s: 25,
                expiry_delta: 120,
            }
        );
        assert_eq!(MAINNET.anchor.height, 3_428_143);
        assert_eq!(MAINNET.anchor.unix, 1_785_247_643);
        for t in [&MAINNET, &WITH_NEXT] {
            assert!(t
                .epochs
                .windows(2)
                .all(|w| w[0].activation_height < w[1].activation_height));
            let mut b: Vec<u32> = t.epochs.iter().map(|e| e.branch_id).collect();
            b.sort();
            b.dedup();
            assert_eq!(b.len(), t.epochs.len(), "branches are distinct");
        }
    }

    #[test]
    fn minable_until_is_the_expiry_or_the_block_before_the_upgrade() {
        let t = &WITH_NEXT;
        assert_eq!(t.minable_until(NU63, A - 100), Some(A - 100));
        assert_eq!(t.minable_until(NU63, A + 5), Some(A - 1));
        assert_eq!(t.minable_until(NU63, 69_120_000), Some(A - 1));
        assert_eq!(t.minable_until(NU63, 0), Some(A - 1), "no expiry: capped");
        assert_eq!(t.minable_until(NU63, A), Some(A - 1));
        assert_eq!(t.minable_until(NU63, A - 1), Some(A - 1));
        assert_eq!(t.minable_until(NU7, A + 40), Some(A + 40));
        assert_eq!(t.minable_until(NU7, 0), Some(u32::MAX));
        assert_eq!(t.minable_until(0xdead_beef, 5), None, "unknown branch");
    }

    #[test]
    fn capped_by_next_is_true_only_for_a_transaction_that_outlives_the_block_before_it() {
        assert!(WITH_NEXT.capped_by_next(NU63, A));
        assert!(WITH_NEXT.capped_by_next(NU63, 0));
        assert!(!WITH_NEXT.capped_by_next(NU63, A - 1));
        assert!(
            !WITH_NEXT.capped_by_next(NU7, A + 100),
            "the latest row has no later upgrade"
        );
        assert!(!WITH_NEXT.capped_by_next(0xdead_beef, A));
        assert!(
            !ONE_ROW.capped_by_next(NU63, 0),
            "no later row: nothing caps it"
        );
    }

    #[test]
    fn without_a_later_row_the_cap_is_the_expiry_alone() {
        assert_eq!(ONE_ROW.minable_until(NU63, 3_500_000), Some(3_500_000));
        assert_eq!(ONE_ROW.minable_until(NU63, 0), Some(u32::MAX));
        assert_eq!(ONE_ROW.next_activation_after(NU63), None);
    }

    #[test]
    fn can_still_be_mined_flips_between_ten_and_eleven_past_the_last_height() {
        let last = A - 1;
        assert!(WITH_NEXT.can_still_be_mined(NU63, A + 50, last + REORG_MARGIN));
        assert!(!WITH_NEXT.can_still_be_mined(NU63, A + 50, last + REORG_MARGIN + 1));
        // An ordinary transaction that expires before the upgrade: the plain expiry rule.
        assert!(WITH_NEXT.can_still_be_mined(NU63, 3_000_000, 3_000_000 + REORG_MARGIN));
        assert!(!WITH_NEXT.can_still_be_mined(NU63, 3_000_000, 3_000_000 + REORG_MARGIN + 1));
        // The margin is the constant, not a number written next to it.
        assert_eq!(REORG_MARGIN, 10);
        // An unknown branch cannot be judged dead.
        assert!(WITH_NEXT.can_still_be_mined(0xdead_beef, 1, u32::MAX));
        // No expiry, no later row: never dead.
        assert!(ONE_ROW.can_still_be_mined(NU63, 0, u32::MAX - REORG_MARGIN));
    }

    #[test]
    fn epoch_of_picks_the_row_that_holds_the_height() {
        assert_eq!(WITH_NEXT.epoch_of(A - 1).branch_id, NU63);
        assert_eq!(WITH_NEXT.epoch_of(A).branch_id, NU7);
        assert_eq!(WITH_NEXT.epoch_of(0).branch_id, NU63, "below the table");
        assert_eq!(ONE_ROW.epoch_of(u32::MAX).branch_id, NU63);
    }

    #[test]
    fn height_at_is_nominal_before_an_upgrade_and_faster_after_it() {
        let a = MAINNET.anchor;
        assert_eq!(WITH_NEXT.height_at(a.unix), a.height);
        assert_eq!(WITH_NEXT.height_at(a.unix + 75 * 1000), a.height + 1000);
        // The time block A is reached, then 25 s a block.
        let t_a = a.unix + 75 * i64::from(A - a.height);
        assert_eq!(WITH_NEXT.height_at(t_a), A);
        assert_eq!(WITH_NEXT.height_at(t_a - 1), A - 1);
        assert_eq!(WITH_NEXT.height_at(t_a + 25 * 10), A + 10);
        assert_eq!(WITH_NEXT.height_at(t_a + 25 * 10 + 24), A + 10);
        // Without the later row it stays at 75 s.
        assert_eq!(MAINNET.height_at(t_a + 25 * 10), A + 3);
    }

    #[test]
    fn height_at_and_the_window_floor_never_fall_as_the_clock_advances_across_a_boundary() {
        let a = WITH_NEXT.anchor;
        let t_a = a.unix + 75 * i64::from(A - a.height);
        let mut prev = WITH_NEXT.height_bounds(t_a - 200_000);
        let mut prev_h = WITH_NEXT.height_at(t_a - 200_000);
        let mut t = t_a - 200_000;
        while t < t_a + 400_000 {
            t += 997;
            let b = WITH_NEXT.height_bounds(t);
            let h = WITH_NEXT.height_at(t);
            assert!(h >= prev_h, "height_at fell at {t}");
            assert!(b.lo >= prev.lo, "lo fell at {t}: {} -> {}", prev.lo, b.lo);
            assert!(b.hi >= prev.hi, "hi fell at {t}: {} -> {}", prev.hi, b.hi);
            prev = b;
            prev_h = h;
        }
    }

    #[test]
    fn a_clock_before_the_anchor_is_an_empty_window() {
        let b = MAINNET.height_bounds(MAINNET.anchor.unix - 1);
        assert_eq!((b.lo, b.est, b.hi), (u32::MAX, 0, 0));
        let b = WITH_NEXT.height_bounds(MAINNET.anchor.unix - 86_400);
        assert_eq!((b.lo, b.est, b.hi), (u32::MAX, 0, 0));
        // An empty window accepts nothing.
        assert!(!WITH_NEXT.header_may_be_mined(NU63, 3_500_000, b.lo, b.hi));
        assert!(!WITH_NEXT.header_may_be_mined(NU7, 3_500_100, b.lo, b.hi));
    }

    #[test]
    fn slack_converts_to_more_blocks_after_the_faster_upgrade() {
        let a = WITH_NEXT.anchor;
        let t_a = a.unix + 75 * i64::from(A - a.height);
        let s = WITH_NEXT.slack(t_a);
        // 144 blocks at 75 s, plus one per hundred of the 71,857 blocks since the anchor.
        assert_eq!(s, 75 * (144 + 719));
        let b = WITH_NEXT.height_bounds(t_a + 10 * 25 * 1000);
        // After the upgrade each second is worth three times as many blocks as before it.
        assert!(b.est - A >= 10_000);
    }

    #[test]
    fn a_window_that_crosses_the_upgrade_takes_the_larger_delta() {
        let a = WITH_NEXT.anchor;
        let t_a = a.unix + 75 * i64::from(A - a.height);
        let far_before = WITH_NEXT.height_bounds(t_a - 5_000_000);
        let t0 = t_a - 5_000_000;
        assert_eq!(
            far_before.hi,
            WITH_NEXT.height_at(t0 + WITH_NEXT.slack(t0)) + 40,
            "far from the upgrade only the old row's delta is added"
        );
        let around = WITH_NEXT.height_bounds(t_a);
        assert!(around.lo < A && around.hi > A);
        let top = WITH_NEXT.height_at(t_a + WITH_NEXT.slack(t_a));
        assert_eq!(around.hi, top + 120);
    }

    #[test]
    fn header_acceptance_by_interval_intersection() {
        let t = &WITH_NEXT;
        // Far before A: only NU6.3.
        assert!(t.header_may_be_mined(NU63, A - 5_000, A - 10_000, A - 9_000));
        assert!(!t.header_may_be_mined(NU7, A - 4_960, A - 10_000, A - 9_000));
        // The device's uncertainty reaches A: both are accepted.
        assert!(t.header_may_be_mined(NU63, A + 40, A - 100, A + 100));
        assert!(t.header_may_be_mined(NU7, A + 40, A - 100, A + 100));
        // NU7 refused while hi is below A.
        assert!(!t.header_may_be_mined(NU7, A + 40, A - 300, A - 1));
        // NU7 accepted when [lo, hi] crosses A.
        assert!(t.header_may_be_mined(NU7, A + 40, A - 300, A));
        // NU6.3 refused once lo > A - 1 (the floor is at or past A).
        assert!(!t.header_may_be_mined(NU63, A + 40, A, A + 400));
        assert!(t.header_may_be_mined(NU63, A + 40, A - 1, A + 400));
        // A ZIP 318 crossing under NU6.3 (a long expiry) is accepted before A, refused once lo > A.
        let long = A + 34_560;
        assert!(t.header_may_be_mined(NU63, long, A - 500, A - 300));
        assert!(!t.header_may_be_mined(NU63, long, A, A + 300));
        // An unknown branch is refused.
        assert!(!t.header_may_be_mined(0xdead_beef, A + 40, A - 100, A + 100));
        // An expiry below the window cuts the interval to nothing.
        assert!(!t.header_may_be_mined(NU63, A - 1_000, A - 500, A));
    }

    #[test]
    fn the_single_row_table_accepts_what_the_window_allows() {
        let b = MAINNET.height_bounds(MAINNET.anchor.unix + 86_400 * 30);
        assert!(MAINNET.header_may_be_mined(NU63, b.est, b.lo, b.hi));
        assert!(!MAINNET.header_may_be_mined(NU7, b.est, b.lo, b.hi));
    }

    // The rules of this file, read on the MAINNET table with its real upgrade height: the numbers the
    // design note (section 9) promised and nothing else.

    #[test]
    fn on_mainnet_an_nu63_transaction_is_capped_at_the_block_before_nu7() {
        let last = NU7_HEIGHT - 1;
        assert_eq!(MAINNET.next_activation_after(NU63), Some(NU7_HEIGHT));
        assert_eq!(MAINNET.minable_until(NU63, NU7_HEIGHT + 5), Some(last));
        assert_eq!(MAINNET.minable_until(NU63, 0), Some(last));
        assert_eq!(
            MAINNET.minable_until(NU63, NU7_HEIGHT - 100),
            Some(NU7_HEIGHT - 100)
        );
        // A ZIP 318 crossing weeks away is dead at the upgrade too.
        assert_eq!(MAINNET.minable_until(NU63, 69_120_000), Some(last));
        assert!(MAINNET.capped_by_next(NU63, NU7_HEIGHT));
        assert!(!MAINNET.capped_by_next(NU7, NU7_HEIGHT + 100));
        // Dead (no longer minable even with the reorg margin) from A + 10, still counted at A + 9.
        assert!(MAINNET.can_still_be_mined(NU63, NU7_HEIGHT + 20, NU7_HEIGHT + 9));
        assert!(!MAINNET.can_still_be_mined(NU63, NU7_HEIGHT + 20, NU7_HEIGHT + 10));
    }

    #[test]
    fn on_mainnet_a_header_is_accepted_only_under_the_branch_its_window_can_reach() {
        let (lo, hi) = (NU7_HEIGHT - 2_000, NU7_HEIGHT - 1_000);
        // Well before A: NU6.3 yes, NU7 no.
        assert!(MAINNET.header_may_be_mined(NU63, hi + 40, lo, hi));
        assert!(!MAINNET.header_may_be_mined(NU7, hi + 120, lo, hi));
        // The window straddles A (the device's own uncertainty): both are accepted.
        let (lo, hi) = (NU7_HEIGHT - 500, NU7_HEIGHT + 500);
        assert!(MAINNET.header_may_be_mined(NU63, NU7_HEIGHT - 10, lo, hi));
        assert!(MAINNET.header_may_be_mined(NU7, NU7_HEIGHT + 120, lo, hi));
        // Past A: an NU6.3 header that cannot be mined before A is refused, NU7 is accepted.
        let (lo, hi) = (NU7_HEIGHT + 1_000, NU7_HEIGHT + 2_000);
        assert!(!MAINNET.header_may_be_mined(NU63, NU7_HEIGHT + 1_020, lo, hi));
        assert!(MAINNET.header_may_be_mined(NU7, hi + 120, lo, hi));
    }

    #[test]
    fn on_mainnet_the_clock_crosses_a_at_75_seconds_a_block_and_then_runs_at_25() {
        // 115,262 blocks of 75 s from the NU6.3 anchor: 2026-11-05 15:24:53 UTC by the device's clock (the
        // anchor's time plus 75 s a block). The chain has run about 0.5% slower, so the real time is later; the
        // margin around this estimate (about 27 hours) is what covers the difference.
        let at_a = MAINNET.anchor.unix + i64::from(NU7_HEIGHT - MAINNET.anchor.height) * 75;
        assert_eq!(at_a, 1_793_892_293);
        assert_eq!(MAINNET.height_at(at_a - 75), NU7_HEIGHT - 1);
        assert_eq!(MAINNET.height_at(at_a), NU7_HEIGHT);
        // After A each block is 25 s: ten blocks in 250 s.
        assert_eq!(MAINNET.height_at(at_a + 250), NU7_HEIGHT + 10);
        // Monotonic across A, which the bisection of `lapses_at` relies on.
        let mut prev = 0;
        for t in (at_a - 10_000..at_a + 10_000).step_by(7) {
            let h = MAINNET.height_at(t);
            assert!(h >= prev);
            prev = h;
        }
    }

    #[test]
    fn on_mainnet_the_slack_at_a_is_about_27_hours_with_the_nu63_anchor() {
        // The design note's figure, pinned: (144 + 1153) blocks at 75 s. A re-anchored release shortens it.
        let at_a = MAINNET.anchor.unix + i64::from(NU7_HEIGHT - MAINNET.anchor.height) * 75;
        assert_eq!(MAINNET.slack(at_a), 97_275);
        let b = MAINNET.height_bounds(at_a);
        assert!(b.lo < NU7_HEIGHT - 1_000 && b.top > NU7_HEIGHT);
        assert_eq!(
            b.hi,
            b.top + 120,
            "the window meets the NU7 row, whose delta is 120"
        );
    }

    // ZIP 318: a pool crossing's expiry is the same for every wallet in a modulus period, and the
    // period is 34,560 blocks of 75 s before NU7 and 103,680 blocks of 25 s from it (both about 30
    // days; zcash_protocol 0.11.0 zip318.rs:195-211). The device used the first modulus for ever. The
    // values below were computed outside this code: `h - h % m + 2 * m` with m = 34,560 x (75 / spacing).

    #[test]
    fn on_mainnet_the_zip318_expiry_changes_scale_at_the_upgrade() {
        assert_eq!(MAINNET.crossing_expiry(3_500_000), 3_559_680);
        assert_eq!(MAINNET.crossing_expiry(NU7_HEIGHT - 1), 3_594_240);
        assert_eq!(MAINNET.crossing_expiry(NU7_HEIGHT), 3_732_480);
        assert_eq!(MAINNET.crossing_expiry(3_600_000), 3_732_480);
        // Always past its target, and never going back as the target rises.
        let mut prev = 0;
        for t in (NU7_HEIGHT - 5_000..NU7_HEIGHT + 5_000).step_by(37) {
            let e = MAINNET.crossing_expiry(t);
            assert!(e > t && e >= prev, "target {t}");
            prev = e;
        }
    }

    #[test]
    fn a_crossing_expiry_is_read_by_the_scale_of_the_row_its_target_is_in() {
        let (lo, top) = (NU7_HEIGHT - 100, NU7_HEIGHT + 100);
        // Targets straddling A: a builder just before it gave the old scale, just after the new one.
        assert!(MAINNET.is_crossing_expiry(3_594_240, NU63, lo, top));
        assert!(MAINNET.is_crossing_expiry(3_732_480, NU7, lo, top));
        // Wholly after A only the new scale is honest: the old one is a pre-NU7 builder's.
        assert!(MAINNET.is_crossing_expiry(3_732_480, NU7, NU7_HEIGHT + 1_000, NU7_HEIGHT + 2_000));
        assert!(!MAINNET.is_crossing_expiry(
            3_594_240,
            NU7,
            NU7_HEIGHT + 1_000,
            NU7_HEIGHT + 2_000
        ));
        // Wholly before A the new scale does not exist yet.
        assert!(MAINNET.is_crossing_expiry(
            3_594_240,
            NU63,
            NU7_HEIGHT - 2_000,
            NU7_HEIGHT - 1_000
        ));
        assert!(!MAINNET.is_crossing_expiry(
            3_732_480,
            NU63,
            NU7_HEIGHT - 2_000,
            NU7_HEIGHT - 1_000
        ));
        // Not a multiple of any modulus, or not what any target in the window gives.
        assert!(!MAINNET.is_crossing_expiry(3_594_241, NU63, lo, top));
        assert!(!MAINNET.is_crossing_expiry(
            3_559_680,
            NU7,
            NU7_HEIGHT + 1_000,
            NU7_HEIGHT + 2_000
        ));
    }

    // The branch of the header decides which row's scale applies: the window straddling A would
    // otherwise accept the old scale for a NU7 header and the new one for a NU6.3 header, and the
    // coordinator would be the one choosing a crossing's expiry (and how long its notes stay reserved).
    #[test]
    fn a_crossing_expiry_is_read_only_at_the_scale_of_the_branch_the_header_names() {
        let (lo, top) = (NU7_HEIGHT - 100, NU7_HEIGHT + 100);
        assert!(
            !MAINNET.is_crossing_expiry(3_594_240, NU7, lo, top),
            "a NU7 header with the old scale"
        );
        assert!(
            !MAINNET.is_crossing_expiry(3_732_480, NU63, lo, top),
            "a NU6.3 header with the new scale"
        );
        assert!(
            !MAINNET.is_crossing_expiry(3_594_240, 0xdead_beef, lo, top),
            "an unknown branch"
        );
    }
}
