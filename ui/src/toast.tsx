import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react'

// Transient feedback for Konclave: a context exposes `useToast()` with `ok/warn/err/info`, and a
// single <Toaster/> renders the live stack (bottom-right on desktop, bottom-centre on mobile).
//
// What belongs here and what does not. A toast ACKNOWLEDGES - "recorded", "copied", "imported". It
// never carries something the reader must act on and could miss, so a failure on the money path
// keeps its inline message on the screen where the action is, and the toast only mirrors it. A
// message that disappears after a few seconds is the wrong home for "your payment did not go out".
//
// Severity is never colour alone: each kind carries a glyph and its own dwell time, and warnings and
// errors are announced assertively while the quiet kinds stay polite. Hovering or focusing the stack
// holds every timer, so a toast cannot slip away while it is being read.

export type ToastKind = 'ok' | 'warn' | 'err' | 'info'

type Toast = { id: number; kind: ToastKind; message: string; leaving?: boolean }

type ToastApi = {
  ok: (message: string) => void
  warn: (message: string) => void
  err: (message: string) => void
  info: (message: string) => void
}

/** How long each kind stays. The more it matters, the longer you get to read it. */
export const DWELL_MS: Record<ToastKind, number> = { ok: 3500, info: 3500, warn: 6000, err: 9000 }
/** Length of the leave animation; the row is removed after it. */
const LEAVE_MS = 160
const MAX_TOASTS = 3

const GLYPH: Record<ToastKind, string> = { ok: '✓', warn: '!', err: '×', info: 'i' }

const ToastContext = createContext<ToastApi | null>(null)

/**
 * Add `t` to `stack`, keeping it bounded and dropping an identical message that is still showing.
 * Pure, so the queue rules are testable without timers: a repeated action (a second click, a retry)
 * should refresh one row rather than stack three copies of the same sentence.
 */
export function queueToast(stack: Toast[], t: Toast, max = MAX_TOASTS): Toast[] {
  const withoutDupe = stack.filter((x) => !(x.kind === t.kind && x.message === t.message))
  return [...withoutDupe, t].slice(-max)
}

let nextId = 1

export function ToastProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<Toast[]>([])
  const timers = useRef<Map<number, ReturnType<typeof setTimeout>>>(new Map())
  const held = useRef(false)

  const clearTimer = useCallback((id: number) => {
    const t = timers.current.get(id)
    if (t) { clearTimeout(t); timers.current.delete(id) }
  }, [])

  const dismiss = useCallback((id: number) => {
    clearTimer(id)
    // Mark, then remove: the row animates out instead of vanishing mid-sentence.
    setToasts((prev) => prev.map((x) => (x.id === id ? { ...x, leaving: true } : x)))
    setTimeout(() => setToasts((prev) => prev.filter((x) => x.id !== id)), LEAVE_MS)
  }, [clearTimer])

  const arm = useCallback((id: number, kind: ToastKind) => {
    clearTimer(id)
    timers.current.set(id, setTimeout(() => dismiss(id), DWELL_MS[kind]))
  }, [clearTimer, dismiss])

  const push = useCallback((kind: ToastKind, message: string) => {
    const id = nextId++
    setToasts((prev) => {
      const next = queueToast(prev, { id, kind, message })
      for (const gone of prev) if (!next.some((x) => x.id === gone.id)) clearTimer(gone.id)
      return next
    })
    if (!held.current) arm(id, kind)
  }, [arm, clearTimer])

  const api = useMemo<ToastApi>(() => ({
    ok: (m) => push('ok', m),
    warn: (m) => push('warn', m),
    err: (m) => push('err', m),
    info: (m) => push('info', m),
  }), [push])

  // Hold every timer while the stack is hovered or focused, so nothing slips away mid-read.
  const hold = useCallback(() => {
    held.current = true
    for (const id of timers.current.keys()) clearTimer(id)
  }, [clearTimer])
  const release = useCallback(() => {
    held.current = false
    setToasts((prev) => { prev.forEach((t) => { if (!t.leaving) arm(t.id, t.kind) }); return prev })
  }, [arm])

  useEffect(() => {
    const map = timers.current
    return () => { for (const t of map.values()) clearTimeout(t); map.clear() }
  }, [])

  // Escape dismisses the newest, wherever focus happens to be.
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key !== 'Escape') return
      const last = toasts[toasts.length - 1]
      if (last) dismiss(last.id)
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [toasts, dismiss])

  return (
    <ToastContext.Provider value={api}>
      {children}
      <div className="kc-toaster" onMouseEnter={hold} onMouseLeave={release} onFocus={hold} onBlur={release}>
        {toasts.map((t) => (
          <div
            key={t.id}
            className={'kc-toast' + (t.leaving ? ' out' : '')}
            data-kind={t.kind}
            role={t.kind === 'err' || t.kind === 'warn' ? 'alert' : 'status'}
            aria-live={t.kind === 'err' || t.kind === 'warn' ? 'assertive' : 'polite'}
          >
            <span className="kc-toast-glyph" aria-hidden="true">{GLYPH[t.kind]}</span>
            <span className="kc-toast-msg">{t.message}</span>
            <button type="button" className="kc-toast-close" onClick={() => dismiss(t.id)} aria-label="Dismiss">×</button>
          </div>
        ))}
      </div>
    </ToastContext.Provider>
  )
}

export function useToast(): ToastApi {
  const ctx = useContext(ToastContext)
  if (!ctx) throw new Error('useToast must be used within a <ToastProvider>')
  return ctx
}
