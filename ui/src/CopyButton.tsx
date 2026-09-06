// Copying a public code, as ONE control (#474).
//
// The vault fingerprint's Copy button existed in three screens - Settings, NetVault and Ceremony -
// each with its own `copied` state and its own 1500ms timer. Making one icon-only and leaving the
// other two with a word would have been the inconsistency; extracting it is what makes the change
// apply everywhere at once.
//
// Icon-only, because the value beside it is what matters and a button labelled "Copiar" next to a
// fingerprint spends more width on the verb than on the code. That is a real accessibility cost if
// handled carelessly, so both channels are kept:
//
//   · the icon FLIPS to a check, which is the sighted confirmation the label used to carry;
//   · the accessible NAME flips too, and a name change on the focused element is announced - which
//     is how the labelled version confirmed to a screen reader in the first place.
//
// `title` gives the pointer user the word back on hover, since the label is gone.

import { useEffect, useRef, useState } from 'react'
import { useT } from './i18n'

export interface CopyButtonProps {
  /** The text to place on the clipboard. */
  value: string
  /** Extra classes for the caller's layout. The button styles itself. */
  className?: string
}

export default function CopyButton({ value, className }: CopyButtonProps) {
  const t = useT()
  const [done, setDone] = useState(false)
  const timer = useRef<number | undefined>(undefined)

  // The timer outlives the component if the screen changes under it, and a setState after unmount
  // is a warning nobody reads and a leak nobody sees.
  useEffect(() => () => window.clearTimeout(timer.current), [])

  async function copy() {
    try {
      await navigator.clipboard.writeText(value)
      setDone(true)
      window.clearTimeout(timer.current)
      timer.current = window.setTimeout(() => setDone(false), 1500)
    } catch {
      // A blocked clipboard is not worth an error state on a public code the member can select and
      // copy by hand. Saying nothing is honest here; claiming success would not be.
    }
  }

  const label = done ? t('members.fpCopied') : t('members.fpCopy')
  return (
    <button
      type="button"
      className={'copy-btn' + (done ? ' done' : '') + (className ? ' ' + className : '')}
      onClick={() => void copy()}
      aria-label={label}
      title={label}
    >
      {done ? (
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor"
          strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
          <path d="M4 12.5l5 5L20 6.5" />
        </svg>
      ) : (
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor"
          strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
          <rect x="9" y="9" width="11" height="11" rx="2" />
          <path d="M5 15V6a1 1 0 0 1 1-1h9" />
        </svg>
      )}
    </button>
  )
}
