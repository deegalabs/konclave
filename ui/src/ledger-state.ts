// The proposal's states grouped the way the vocabulary guide fixes them: one grouping, one colour
// meaning, one word, the same on the screen, in the list and in the exported workbook.
//
//   need    awaiting, ready            colour: action      "needs someone"
//   way     sent                       colour: neutral     "on its way"
//   ok      confirmed                  colour: ok          "settled"
//   closed  everything else            colour: muted       "closed without payment"
//
// The colours are tokens of the stylesheet (`.st-need`, `.st-way`, `.st-ok`, `.st-closed`), never a
// colour inside a component; the colour never goes alone, the state's word is always beside it.
export type StateGroup = 'need' | 'way' | 'ok' | 'closed'

export function stateGroupOf(state: string): StateGroup {
  if (state === 'awaiting' || state === 'ready') return 'need'
  if (state === 'sent') return 'way'
  if (state === 'confirmed') return 'ok'
  return 'closed'
}
