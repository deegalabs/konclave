// The proposal's states grouped the way the vocabulary guide fixes them: one grouping, one colour
// meaning, one word. Only the Ledger uses it today, for the colour of each row's state.
//
//   need    open (`isOpen`)            colour: action      "needs someone"
//   way     sent                       colour: neutral     "on its way"
//   ok      confirmed                  colour: ok          "settled"
//   closed  everything else, an open   colour: muted       "closed without payment"
//           proposal past its deadline on this clock included
//
// The colours are tokens of the stylesheet (`.st-need`, `.st-way`, `.st-ok`, `.st-closed`), never a
// colour inside a component; the colour never goes alone, the state's word is always beside it.
import { isOpen } from './desk'
import type { Proposal } from './api'

export type StateGroup = 'need' | 'way' | 'ok' | 'closed'

/** Sent or confirmed: the money left, or is leaving. The one rule for the book's settled column. */
export const SETTLED = (s: string): boolean => s === 'sent' || s === 'confirmed'

/** The group takes the proposal, not its state's name: "needs someone" is the desk's own rule
 *  (`isOpen`), so a proposal past its deadline on this clock is closed here as it is there. */
export function stateGroupOf(p: Proposal): StateGroup {
  if (isOpen(p)) return 'need'
  if (p.state === 'sent') return 'way'
  if (p.state === 'confirmed') return 'ok'
  return 'closed'
}
