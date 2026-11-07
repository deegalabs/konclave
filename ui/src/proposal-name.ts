// The name a proposal is shown under (#296), in ONE place. Every screen and the exported book used
// to write `p.memo || <kind label>` on its own, and a payroll on the web path, whose memo is always
// empty, had no name anywhere. A payroll now carries its own `title`, never its memo: on a single
// payment the memo is the on-chain memo.
//
// The title is display-only. It is not covered by the vote's signature (#567), so no copy may
// present it as something the members approved.

/** The longest title the coordinator stores, in characters (`orchestrator::helper::PAYROLL_TITLE_MAX_CHARS`). */
export const PAYROLL_TITLE_MAX = 120

/** A payroll's own title, else its memo (a payment's memo, or the local bridge's payroll description), else `fallback`. */
export function proposalName(p: { title?: string | null; memo?: string | null }, fallback: string): string {
  return p.title?.trim() || p.memo?.trim() || fallback
}

/** Characters, not UTF-16 units, so the screen counts the way the coordinator does. */
export function titleTooLong(title: string): boolean {
  return [...title.trim()].length > PAYROLL_TITLE_MAX
}
