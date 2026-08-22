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

// A small, dismissible toast system for Konclave. Local-first, no dependencies: a context
// exposes `useToast()` with `ok/err/info`, and a single <Toaster/> renders the live stack
// (bottom-right on desktop, bottom-center on mobile). Each toast auto-dismisses after ~3.5s,
// can be closed manually (× or Escape), and is announced politely to assistive tech.
// Styling uses the existing design tokens only (see lacre.css) - no new colors.

type ToastKind = 'ok' | 'err' | 'info'

type Toast = {
  id: number
  kind: ToastKind
  message: string
}

type ToastApi = {
  ok: (message: string) => void
  err: (message: string) => void
  info: (message: string) => void
}

const AUTO_DISMISS_MS = 3500
const MAX_TOASTS = 3

const ToastContext = createContext<ToastApi | null>(null)

// Map each semantic kind to its token-backed dot color.
const DOT_COLOR: Record<ToastKind, string> = {
  ok: 'var(--success)',
  err: 'var(--danger)',
  info: 'var(--accent)',
}

let nextId = 1

export function ToastProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<Toast[]>([])
  // Track each toast's auto-dismiss timer so we can clear it on manual close / unmount.
  const timers = useRef<Map<number, ReturnType<typeof setTimeout>>>(new Map())

  const dismiss = useCallback((id: number) => {
    const t = timers.current.get(id)
    if (t) {
      clearTimeout(t)
      timers.current.delete(id)
    }
    setToasts((prev) => prev.filter((x) => x.id !== id))
  }, [])

  const push = useCallback(
    (kind: ToastKind, message: string) => {
      const id = nextId++
      setToasts((prev) => {
        // Keep the stack bounded: drop the oldest when we exceed the cap.
        const next = [...prev, { id, kind, message }]
        const trimmed = next.slice(-MAX_TOASTS)
        // Clear timers for any toast we just evicted so they don't fire against a dead id.
        for (const old of next.slice(0, next.length - trimmed.length)) {
          const timer = timers.current.get(old.id)
          if (timer) {
            clearTimeout(timer)
            timers.current.delete(old.id)
          }
        }
        return trimmed
      })
      const timer = setTimeout(() => dismiss(id), AUTO_DISMISS_MS)
      timers.current.set(id, timer)
    },
    [dismiss],
  )

  const api = useMemo<ToastApi>(
    () => ({
      ok: (m: string) => push('ok', m),
      err: (m: string) => push('err', m),
      info: (m: string) => push('info', m),
    }),
    [push],
  )

  // Clear every pending timer on unmount.
  useEffect(() => {
    const map = timers.current
    return () => {
      for (const t of map.values()) clearTimeout(t)
      map.clear()
    }
  }, [])

  return (
    <ToastContext.Provider value={api}>
      {children}
      <Toaster toasts={toasts} onDismiss={dismiss} />
    </ToastContext.Provider>
  )
}

export function useToast(): ToastApi {
  const ctx = useContext(ToastContext)
  if (!ctx) throw new Error('useToast must be used within a <ToastProvider>')
  return ctx
}

function Toaster({ toasts, onDismiss }: { toasts: Toast[]; onDismiss: (id: number) => void }) {
  return (
    <>
      <style>{TOASTER_CSS}</style>
      <div className="kc-toaster" role="status" aria-live="polite" aria-relevant="additions">
        {toasts.map((t) => (
          <div key={t.id} className="kc-toast" data-kind={t.kind}>
            <span className="kc-toast-dot" style={{ background: DOT_COLOR[t.kind] }} aria-hidden="true" />
            <span className="kc-toast-msg">{t.message}</span>
            <button
              type="button"
              className="kc-toast-close"
              onClick={() => onDismiss(t.id)}
              onKeyDown={(e) => {
                if (e.key === 'Escape') onDismiss(t.id)
              }}
              aria-label="Dismiss"
            >
              ×
            </button>
          </div>
        ))}
      </div>
    </>
  )
}

// Scoped styles for the toaster. Tokens only; the global reduced-motion rule in lacre.css
// disables the entry animation, and we re-assert it here so the component is self-contained.
const TOASTER_CSS = `
.kc-toaster{
  position:fixed; z-index:1000; bottom:22px; right:22px;
  display:flex; flex-direction:column; gap:10px; align-items:flex-end;
  pointer-events:none; max-width:min(92vw,380px);
}
.kc-toast{
  pointer-events:auto;
  display:flex; align-items:center; gap:10px;
  width:100%;
  padding:11px 12px 11px 14px;
  background:var(--surface-1); border:1px solid var(--line);
  border-radius:var(--radius); box-shadow:var(--shadow-overlay);
  color:var(--text); font-family:var(--font-sans); font-size:13.5px; line-height:1.4;
  animation:kc-toast-in .18s ease-out;
}
.kc-toast-dot{
  flex:0 0 auto; width:9px; height:9px; border-radius:var(--radius-pill);
}
.kc-toast-msg{ flex:1 1 auto; min-width:0; word-break:break-word; }
.kc-toast-close{
  flex:0 0 auto; appearance:none; border:0; background:transparent;
  color:var(--text-muted); cursor:pointer;
  font-family:var(--font-mono); font-size:17px; line-height:1;
  padding:2px 4px; border-radius:var(--radius-sm);
}
.kc-toast-close:hover{ color:var(--text); }
@keyframes kc-toast-in{
  from{ opacity:0; transform:translateY(8px); }
  to{ opacity:1; transform:none; }
}
@media (max-width:520px){
  .kc-toaster{ left:12px; right:12px; bottom:14px; align-items:center; max-width:none; }
}
@media (prefers-reduced-motion:reduce){
  .kc-toast{ animation:none; }
}
`
