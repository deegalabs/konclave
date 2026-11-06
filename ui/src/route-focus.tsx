import { useEffect, useRef } from 'react'
import { useLocation } from 'react-router-dom'

// #662. The app is a single page: moving between screens replaces the content and leaves keyboard
// focus where it was, on the link that was used or on the body, so a screen-reader or keyboard user
// gets no sign that the page changed (WCAG 2.4.3, 4.1.3). On every route change this moves focus to
// the new screen's main heading, without scrolling the page away from the top, and names the page
// in the tab. It skips the first load (the browser already announces the document) and a change
// made while a dialog is open (focus belongs to the dialog, #228).

const APP = 'Konclave'
/** How long to wait for a heading that a screen draws only after its first read. */
const WAIT_MS = 2000

/** The heading the focus goes to: the first h1 inside main, or the first h1 on the page. */
function routeHeading(root: ParentNode = document): HTMLElement | null {
  return root.querySelector<HTMLElement>('main h1') ?? root.querySelector<HTMLElement>('h1')
}

/** True while a modal dialog is open: focus is inside it and must stay there. */
function dialogOpen(root: ParentNode = document): boolean {
  return root.querySelector('[role="dialog"][aria-modal="true"]') !== null
}

/** Move focus to `h1` without scrolling, and put its text in the tab's title. */
function focusHeading(h1: HTMLElement): void {
  if (!h1.hasAttribute('tabindex')) h1.setAttribute('tabindex', '-1')
  h1.focus({ preventScroll: true })
  const text = (h1.textContent ?? '').trim()
  document.title = text ? `${text} · ${APP}` : APP
}

export function RouteFocus() {
  const { pathname } = useLocation()
  const first = useRef(true)

  useEffect(() => {
    if (first.current) { first.current = false; return }
    if (dialogOpen()) return
    const now = routeHeading()
    if (now) { focusHeading(now); return }
    // The screen draws its heading only after its first read: wait for it, briefly.
    let done = false
    const observer = new MutationObserver(() => {
      const h1 = routeHeading()
      if (!h1 || done) return
      done = true; observer.disconnect(); window.clearTimeout(timer)
      if (!dialogOpen()) focusHeading(h1)
    })
    observer.observe(document.body, { childList: true, subtree: true })
    const timer = window.setTimeout(() => { done = true; observer.disconnect() }, WAIT_MS)
    return () => { done = true; observer.disconnect(); window.clearTimeout(timer) }
  }, [pathname])

  return null
}
