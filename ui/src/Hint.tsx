// An explanation you ask for, instead of one you have to read past (#487).
//
// Settings carried six paragraphs of prose set as `.set-hint` - mono, 11.5px, muted - stacked
// between the cards they explained. Every one of them is true and worth having, and together they
// turned a screen of controls into a wall of small grey text that a member scrolls through to reach
// the thing they came for.
//
// So the text moves behind a `?` next to the row it explains. That is a trade, not a free win: an
// explanation nobody opens is an explanation nobody reads. It is the right trade HERE because these
// are second readings - a treasurer needs "what does this policy cover" once, and needs the quorum
// row every time.
//
// It is a <details>, not a hover tooltip. Hover excludes touch and keyboard, and the browser already
// gives <details> the open/close state, the keyboard behaviour and the screen-reader announcement
// for free - all the things a hand-rolled tooltip gets wrong.

import { useT } from './i18n'
import type { ReactNode } from 'react'

export default function Hint({ children }: { children: ReactNode }) {
  const t = useT()
  return (
    <details className="hintbox">
      <summary aria-label={t('common.whatIsThis')} title={t('common.whatIsThis')}>
        <svg viewBox="0 0 24 24" width="13" height="13" aria-hidden="true" fill="none"
          stroke="currentColor" strokeWidth="2" strokeLinecap="round">
          <circle cx="12" cy="12" r="9.2" strokeWidth="1.6" />
          <path d="M9.6 9.4a2.5 2.5 0 1 1 3.2 2.4c-.6.2-.9.7-.9 1.3v.5" />
          <circle cx="12" cy="17" r=".9" fill="currentColor" stroke="none" />
        </svg>
      </summary>
      <div className="hintbox-body">{children}</div>
    </details>
  )
}
