// #317: a button that shows and hides a group of links (the WAI-ARIA "disclosure navigation"
// pattern), for the shell's "More" sheet and vault switcher. They used to announce role="menu" and
// implement none of what a menu promises (arrow keys, focus management). Navigation is not an
// application menu, so they follow the simpler pattern and implement all of it:
//   · the button says whether the panel is open and, while it is, which element it controls;
//   · Escape, from anywhere while it is open, closes the panel and returns focus to the button (a
//     click in Safari does not focus the button, so listening only on the pair would miss it);
//   · focus leaving the button and the panel closes it (so focus never sits behind the scrim);
//   · the caller closes it on a choice, returning focus to the button when nothing else takes it.
// Focus is NOT moved into the panel on open: the panel is the next Tab stop, as the pattern says.
import { useCallback, useEffect, useId, useRef, type FocusEvent } from 'react'

export function useDisclosure(open: boolean, setOpen: (open: boolean) => void) {
  const panelId = useId()
  const triggerRef = useRef<HTMLButtonElement>(null)
  const panelRef = useRef<HTMLDivElement>(null)

  /** Close; with `refocus`, give focus back to the button (Escape, or a choice that goes nowhere). */
  const close = useCallback((refocus: boolean) => {
    setOpen(false)
    if (refocus) triggerRef.current?.focus()
  }, [setOpen])

  useEffect(() => {
    if (!open) return
    const onKey = (e: globalThis.KeyboardEvent) => {
      // A dialog or field that already handled this Escape keeps it.
      if (e.key !== 'Escape' || e.defaultPrevented) return
      close(true)
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [open, close])

  // Only a move to a known element outside closes it: a null target (Safari does not focus a link
  // on click, a tap on an item) must not close the panel before the item's click lands.
  const onBlur = useCallback((e: FocusEvent) => {
    const to = e.relatedTarget as Node | null
    if (!open || !to) return
    if (triggerRef.current?.contains(to) || panelRef.current?.contains(to)) return
    setOpen(false)
  }, [open, setOpen])

  return {
    close,
    trigger: {
      ref: triggerRef,
      'aria-expanded': open,
      'aria-controls': open ? panelId : undefined,
      onBlur,
    },
    panel: { ref: panelRef, id: panelId, role: 'group' as const, onBlur },
  }
}
