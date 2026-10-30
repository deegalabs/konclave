// The notice a vault's dashboard shows around a network upgrade, before a member tries to pay.
//
// Today the pause around an upgrade reaches a member only as an error when they try to propose or send.
// A payroll approved the day before is refused at the moment it matters. The notice comes from what the
// app already reads: the chain tip in the balance answer (`chain_tip_height`) and the height of the
// upgrade, which WASM carries from the epoch table (`upgradeHeight`), so no height is typed here.
//
// It does not know whether the coordinator has been updated, and says nothing that depends on it: it
// tells of the upgrade, that payments pause around it, and that nothing is lost.

/** How many blocks before the upgrade the notice starts (about the length of the pause for a pool
 *  crossing, six hours at 75 s a block). */
export const UPGRADE_NOTICE_BEFORE = 300

/** How many blocks after the upgrade it stays (about 14 hours at 25 s a block, a night's margin for
 *  the coordinator to be updated). */
export const UPGRADE_NOTICE_AFTER = 2_000

export type UpgradeNotice = 'before' | 'after' | null

/** Which notice, if any, a dashboard shows at chain tip `tip` for an upgrade at `activation`. Nothing
 *  while the tip or the height is unknown. */
export function upgradeNotice(tip: number | undefined, activation: number | undefined): UpgradeNotice {
  if (!tip || !activation) return null
  if (tip >= activation - UPGRADE_NOTICE_BEFORE && tip < activation) return 'before'
  if (tip >= activation && tip < activation + UPGRADE_NOTICE_AFTER) return 'after'
  return null
}
