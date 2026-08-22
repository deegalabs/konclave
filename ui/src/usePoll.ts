import { useEffect, useRef } from 'react'

// Visibility-aware polling (#123). A backgrounded tab should NOT keep hammering the helper (its
// wallet sync is costly), and a user returning to the tab should see fresh data at once instead of
// waiting out the interval. `startVisiblePoll` is the pure core (no React), so it is unit-testable
// with a mocked document/window; `usePoll` is the hook wrapper for components.

type Listenable = {
  addEventListener(type: string, handler: () => void): void
  removeEventListener(type: string, handler: () => void): void
}
type DocLike = Listenable & { hidden: boolean }

/**
 * Call `fn` every `intervalMs`, but PAUSE while `doc.hidden` and refresh immediately (then resume)
 * when the tab becomes visible or the window regains focus. Does NOT call `fn` on start — the caller
 * owns the first load. Returns a cleanup function that stops the timer and removes the listeners.
 */
export function startVisiblePoll(
  fn: () => void,
  intervalMs: number,
  doc: DocLike = document as unknown as DocLike,
  win: Listenable = window,
): () => void {
  let timer: ReturnType<typeof setInterval> | null = null
  const tick = () => { if (!doc.hidden) fn() }
  const start = () => { if (timer == null && !doc.hidden) timer = setInterval(tick, intervalMs) }
  const stop = () => { if (timer != null) { clearInterval(timer); timer = null } }
  const onVisible = () => {
    if (doc.hidden) { stop() }
    else { fn(); start() } // returned to the tab: refresh now, then resume polling
  }
  start()
  doc.addEventListener('visibilitychange', onVisible)
  win.addEventListener('focus', onVisible)
  return () => {
    stop()
    doc.removeEventListener('visibilitychange', onVisible)
    win.removeEventListener('focus', onVisible)
  }
}

/**
 * Poll `fn` on an interval with visibility awareness (see `startVisiblePoll`). The latest `fn` is
 * always used (no stale closure). Set `enabled` false to suspend (e.g. a terminal proposal needs no
 * more polling). The caller is responsible for the first load; this only handles refreshes.
 */
export function usePoll(fn: () => void, intervalMs: number, enabled = true): void {
  const fnRef = useRef(fn)
  fnRef.current = fn
  useEffect(() => {
    if (!enabled) return
    return startVisiblePoll(() => fnRef.current(), intervalMs)
  }, [intervalMs, enabled])
}
