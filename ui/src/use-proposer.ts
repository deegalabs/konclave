import { useCallback, useEffect, useRef, useState } from 'react'
import { actingAs, type ActingAs } from './api'
import { usePoll } from './usePoll'

/** How often to ask again while the answer can change by itself: a vault unlocked in another tab, a
 *  coordinator that answers again. */
export const ASK_EVERY_MS = 5_000
/** A seat the coordinator has no name for changes only when its operator changes the list, which no
 *  one here can hurry: a slow cadence, plus the poll's own refresh on focus and on returning to the tab. */
export const ASK_NAMELESS_EVERY_MS = 60_000

/** Who a proposing screen shows as the proposer (#591). Only DISPLAY: the name that is sent and the
 *  seat that signs it are read again by `createProposal` / `createPayroll` at send time, from the
 *  same `actingAs`. While it cannot say, the screen keeps Propose closed and says what is needed.
 *  It asks again on its own (never two requests at once, never once it has a name), and `refresh`
 *  asks at once, for the moment the member unlocks here. */
export function useProposer(vault: { id: string; roster_differs?: boolean; own_members?: string[] } | null) {
  const [acting, setActing] = useState<ActingAs | null>(null)
  const id = vault?.id
  // Which ask is the latest, and whether the latest has answered. A poll tick is skipped while an ask
  // is out (never two at once); `refresh` is not skipped, it starts a fresh ask and the older one's
  // answer, if it ever comes, is ignored. A read that never answers must not freeze the screen or
  // swallow the refresh that follows an unlock.
  const gen = useRef(0)
  const out = useRef(false)
  const start = useCallback((force: boolean) => {
    if (!id || (out.current && !force)) return
    const mine = ++gen.current
    out.current = true
    void actingAs(id)
      .then((a) => {
        if (mine !== gen.current) return
        setActing((prev) => (prev && prev.ok && a.ok && prev.name === a.name && prev.seat === a.seat ? prev : a))
      })
      .finally(() => { if (mine === gen.current) out.current = false })
  }, [id])
  const ask = useCallback(() => start(false), [start])
  const refresh = useCallback(() => start(true), [start])
  useEffect(() => { ask() }, [ask])
  const resolved = !!acting && acting.ok
  const nameless = !!acting && !acting.ok && acting.why === 'no-seat-name'
  usePoll(ask, nameless ? ASK_NAMELESS_EVERY_MS : ASK_EVERY_MS, !!id && !resolved)
  // Protocol 3: this device's own roster names the seat differently from what the coordinator serves.
  // Said beside the name, never blocking: nobody here can tell who is right.
  const differs = !!(vault?.roster_differs && acting?.ok && vault.own_members && (vault.own_members[acting.seat - 1] ?? '').trim() !== acting.name)
  return { acting, name: acting?.ok ? acting.name : null, differs, refresh }
}
