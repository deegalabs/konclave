// Global page-load progress: a thin bar that runs across the top of the app while any screen is
// fetching, plus a tiny counter so screens can mark their load in-flight. The goal (issue: loading
// UX) is that a page never renders half-built with placeholders - it shows the bar, and each screen
// gates its real content on a `ready` flag until its data has arrived.

import { createContext, useCallback, useContext, useState, type ReactNode } from 'react'

interface LoadingCtx {
  /** Mark one load in-flight (increments the counter; the top bar shows while > 0). */
  begin: () => void
  /** Mark one load done. */
  end: () => void
  active: boolean
}

const Ctx = createContext<LoadingCtx | null>(null)

/** Safe no-op outside a provider, so a screen can call it unconditionally. */
export function useLoading(): LoadingCtx {
  return useContext(Ctx) ?? { begin: () => {}, end: () => {}, active: false }
}

export function LoadingProvider({ children }: { children: ReactNode }) {
  const [count, setCount] = useState(0)
  const begin = useCallback(() => setCount((n) => n + 1), [])
  const end = useCallback(() => setCount((n) => Math.max(0, n - 1)), [])
  return <Ctx.Provider value={{ begin, end, active: count > 0 }}>{children}</Ctx.Provider>
}

/** The top-of-page progress line; shows an indeterminate sweep while any load is in-flight. */
export function TopProgress() {
  const { active } = useLoading()
  if (!active) return null
  return (
    <div className="top-progress" aria-hidden="true">
      <div className="top-progress-bar" />
    </div>
  )
}
