import { createContext, useContext, useEffect, useRef, useState, type Dispatch, type ReactNode, type SetStateAction } from 'react'

// A tip that explains a badge, reachable the three ways a member reaches a badge: a mouse hovering, a
// keyboard focusing, a finger tapping. One component for the vault card, so the three rules below live
// once:
//
// - The tip is a SIBLING of its trigger, never inside it, and stays in the page while hidden, so the
//   trigger's `aria-describedby` always points at something. No `aria-expanded`: a tip is a description.
// - Hover opens only for a mouse (a finger passing over is not hover), focus only when it is visible
//   focus (a click's focus is not the keyboard), and a tap is a click: it opens, and a second closes.
// - One tip at a time; Esc closes it and leaves the focus where it was; a tap outside closes it; the
//   pointer may travel from the badge onto its tip, so leaving closes after a pause the tip cancels.

type Group = { open: string | null; setOpen: Dispatch<SetStateAction<string | null>> }
const TipCtx = createContext<Group | null>(null)

/** The area within which one tip is open at a time. */
export function TipGroup({ children }: { children: ReactNode }) {
  const [open, setOpen] = useState<string | null>(null)
  useEffect(() => {
    if (!open) return
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setOpen(null) }
    const onDown = (e: PointerEvent) => {
      const at = e.target instanceof Element ? e.target : null
      if (at?.closest(`[data-tip="${CSS.escape(open)}"]`)) return
      setOpen(null)
    }
    document.addEventListener('keydown', onKey)
    document.addEventListener('pointerdown', onDown)
    return () => { document.removeEventListener('keydown', onKey); document.removeEventListener('pointerdown', onDown) }
  }, [open])
  return <TipCtx.Provider value={{ open, setOpen }}>{children}</TipCtx.Provider>
}

const focusVisible = (el: Element): boolean => {
  try { return el.matches(':focus-visible') } catch { return false }
}

/** How long a mouse may take to travel from the badge onto its tip. */
const TRAVEL_MS = 150

type PointerLike = { pointerType: string }
export type TipTrigger = {
  'aria-describedby': string
  onPointerDown: (e: PointerLike) => void
  onPointerEnter: (e: PointerLike) => void
  onPointerLeave: (e: PointerLike) => void
  onFocus: (e: { currentTarget: Element }) => void
  onBlur: () => void
  onClick: () => void
}

function useTip(id: string): { trigger: TipTrigger; tip: { id: string; role: 'tooltip'; hidden: boolean; onPointerEnter: (e: PointerLike) => void; onPointerLeave: (e: PointerLike) => void } } {
  const group = useContext(TipCtx)
  if (!group) throw new Error('a tip needs a TipGroup around it')
  const { open, setOpen } = group
  const shown = open === id
  const timer = useRef<number | undefined>(undefined)
  const pointer = useRef('')
  // Opened by keyboard focus and not acted on since: the Enter that follows confirms it, not a toggle.
  const byFocus = useRef(false)
  const cancel = () => { if (timer.current !== undefined) { window.clearTimeout(timer.current); timer.current = undefined } }
  const show = () => { cancel(); setOpen(id) }
  const hide = () => { cancel(); byFocus.current = false; setOpen((cur) => (cur === id ? null : cur)) }
  const hideSoon = () => { cancel(); timer.current = window.setTimeout(hide, TRAVEL_MS) }
  useEffect(() => cancel, [])
  return {
    trigger: {
      'aria-describedby': id,
      onPointerDown: (e) => { pointer.current = e.pointerType },
      onPointerEnter: (e) => { if (e.pointerType === 'mouse') show() },
      onPointerLeave: (e) => { if (e.pointerType === 'mouse') hideSoon() },
      onFocus: (e) => { if (focusVisible(e.currentTarget)) { show(); byFocus.current = true } },
      onBlur: hide,
      // A mouse click keeps open what its hover opened, a key keeps open what its focus opened; past
      // that, a tap or a key toggles.
      onClick: () => {
        const by = pointer.current
        const focused = byFocus.current
        pointer.current = ''
        byFocus.current = false
        if (by === 'mouse' || (focused && !by) || !shown) show()
        else hide()
      },
    },
    tip: {
      id, role: 'tooltip', hidden: !shown,
      onPointerEnter: (e) => { if (e.pointerType === 'mouse') cancel() },
      onPointerLeave: (e) => { if (e.pointerType === 'mouse') hideSoon() },
    },
  }
}

/** A tip around any trigger: `children` receives the handlers to put on the one control that is tapped. */
export function TipAnchor({ id, tip, children }: { id: string; tip: ReactNode; children: (trigger: TipTrigger) => ReactNode }) {
  const { trigger, tip: tipProps } = useTip(id)
  return (
    <span className="tipwrap" data-tip={id}>
      {children(trigger)}
      <span className="tip" {...tipProps}>{tip}</span>
    </span>
  )
}

/** The common case: a button that is the badge, and its tip beside it. */
export function TipButton({ id, tip, className, children }: { id: string; tip: ReactNode; className?: string; children: ReactNode }) {
  return (
    <TipAnchor id={id} tip={tip}>
      {(trigger) => <button type="button" className={className} {...trigger}>{children}</button>}
    </TipAnchor>
  )
}
