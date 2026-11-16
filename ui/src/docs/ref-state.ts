import type { Locale } from './content'
import type { RefKind } from './roadmap'
import type { RefState } from './roadmap-refs'

/** GitHub's states in words, by kind: an issue is never a draft or merged, a pull request never "not planned". */
export type RefStateWords = {
  issue: Record<'open' | 'closed' | 'not-planned', string>
  pull: Record<'open' | 'draft' | 'merged' | 'closed-unmerged', string>
}

export const REF_STATE_WORDS: Record<Locale, RefStateWords> = {
  'pt-BR': {
    issue: { open: 'Aberta', closed: 'Fechada', 'not-planned': 'Não planejada' },
    pull: { open: 'Aberto', draft: 'Rascunho', merged: 'Mesclado', 'closed-unmerged': 'Fechado sem mesclar' },
  },
  en: {
    issue: { open: 'Open', closed: 'Closed', 'not-planned': 'Not planned' },
    pull: { open: 'Open', draft: 'Draft', merged: 'Merged', 'closed-unmerged': 'Closed unmerged' },
  },
}

/** The word for a state, by kind, with no cast: a pairing GitHub cannot give (an issue "merged") has no
 *  word, and the roadmap's tests fail on it before it can reach the page. */
export function wordFor(kind: RefKind, state: RefState, words: RefStateWords): string | undefined {
  if (kind === 'issue') return state === 'open' || state === 'closed' || state === 'not-planned' ? words.issue[state] : undefined
  return state === 'open' || state === 'draft' || state === 'merged' || state === 'closed-unmerged' ? words.pull[state] : undefined
}
