import { useCallback, useEffect, useState } from 'react'
import { actingAs, type ActingAs } from './api'
import { usePoll } from './usePoll'

/** Who a proposing screen shows as the proposer (#591). Only DISPLAY: the name that is sent and the
 *  seat that signs it are read again by `createProposal` / `createPayroll` at send time, from the
 *  same `actingAs`. While it cannot say, the screen keeps Propose closed and says what is needed,
 *  and it asks again on its own so unlocking the vault elsewhere opens it without a reload. */
export function useProposer(vault: { id: string; roster_differs?: boolean; own_members?: string[] } | null) {
  const [acting, setActing] = useState<ActingAs | null>(null)
  const id = vault?.id
  const ask = useCallback(() => {
    if (!id) return
    void actingAs(id).then((a) => setActing((prev) => (prev && prev.ok && a.ok && prev.name === a.name && prev.seat === a.seat ? prev : a)))
  }, [id])
  useEffect(() => { ask() }, [ask])
  // Only while it cannot say: a name that was read is not asked for again every few seconds.
  usePoll(ask, 5_000, !!id && !(acting && acting.ok))
  // Protocol 3: this device's own roster names the seat differently from what the coordinator serves.
  // Said beside the name, never blocking: nobody here can tell who is right.
  const differs = !!(vault?.roster_differs && acting?.ok && vault.own_members && (vault.own_members[acting.seat - 1] ?? '').trim() !== acting.name)
  return { acting, name: acting?.ok ? acting.name : null, differs }
}
