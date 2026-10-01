import { useEffect, useLayoutEffect, useRef, useState, type FocusEvent } from 'react'
import { REF_TITLES, refKey, refUrl, type Ref } from './roadmap'

export type IssueRefLabels = { issue: string; pull: string; newTab: string; hint: string }

/** Only one card open at a time: hovering one number while another has focus would stack two. */
let closeOpenCard: (() => void) | null = null

/** Hovering across a row of numbers should not flash a card for each one it passes. Focus is immediate. */
const HOVER_DELAY_MS = 120

/** A link to a GitHub issue or pull request. Its name carries the title ("#599: ..."), so a screen
 *  reader's list of links reads titles, not bare numbers; on a phone the title is shown under the
 *  step. With a mouse or a keyboard, the title also opens in a small card that is only visual
 *  (aria-hidden), stays up while the pointer is over it, and closes on Escape (WCAG 1.4.13). The
 *  title comes from a local copy, so reading the docs makes no call to GitHub. */
export default function IssueRef({ r, labels }: { r: Ref; labels: IssueRefLabels }) {
  const [open, setOpen] = useState(false)
  const [dx, setDx] = useState(0)
  const cardRef = useRef<HTMLSpanElement>(null)
  const hoverTimer = useRef<number | undefined>(undefined)
  const title = REF_TITLES[refKey(r)]

  const show = () => {
    if (closeOpenCard) closeOpenCard()
    closeOpenCard = () => setOpen(false)
    setOpen(true)
  }
  const hide = () => {
    window.clearTimeout(hoverTimer.current)
    setOpen(false)
  }

  useEffect(() => () => window.clearTimeout(hoverTimer.current), [])

  // Escape has to work for a card the pointer opened too, and then nothing inside it has focus, so
  // the key is heard on the document while the card is up rather than on the link.
  useEffect(() => {
    if (!open) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false)
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [open])

  // Keep the card on screen: a number near either edge would otherwise push it past the viewport.
  useLayoutEffect(() => {
    if (!open) {
      setDx(0)
      return
    }
    const rect = cardRef.current?.getBoundingClientRect()
    if (!rect) return
    const gutter = 12
    if (rect.right > window.innerWidth - gutter) setDx(window.innerWidth - gutter - rect.right)
    else if (rect.left < gutter) setDx(gutter - rect.left)
  }, [open])

  // Open on keyboard focus only. Coming back from the GitHub tab returns focus to the link, and a
  // card reopening then, under a reader who used the mouse, is noise.
  const onFocus = (e: FocusEvent<HTMLSpanElement>) => {
    if ((e.target as HTMLElement).matches(':focus-visible')) show()
  }

  return (
    <span
      className="docs-ref"
      onMouseEnter={() => {
        window.clearTimeout(hoverTimer.current)
        hoverTimer.current = window.setTimeout(show, HOVER_DELAY_MS)
      }}
      onMouseLeave={hide}
      onFocus={onFocus}
      onBlur={hide}
    >
      <a className="docs-ref-chip" href={refUrl(r)} target="_blank" rel="noopener noreferrer">
        <span className="docs-ref-num">#{r.n}</span>
        <span className="docs-ref-name">
          {': '}
          <span lang="en">{title}</span>
        </span>
        <span className="visually-hidden"> ({labels.newTab})</span>
      </a>
      <span
        ref={cardRef}
        aria-hidden="true"
        className="docs-ref-card"
        hidden={!open}
        style={dx ? { transform: `translateX(${dx}px)` } : undefined}
      >
        <span className="docs-ref-kind">
          {r.kind === 'pull' ? labels.pull : labels.issue} #{r.n}
        </span>
        <span className="docs-ref-title" lang="en">{title}</span>
        <span className="docs-ref-hint">{labels.hint}</span>
      </span>
    </span>
  )
}
