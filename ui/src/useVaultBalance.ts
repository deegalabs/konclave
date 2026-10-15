// The vault's balance for the screens that create payments (New payment, Payroll): read on mount and
// refreshed on the shared cadence, in one place. Two copies of this went their own ways once: the
// payment screen polled and the payroll screen read once, so a payroll opened while the wallet was
// busy stayed blocked under a note that promised to update (v0.13.1 audit). The Dashboard reads the
// same way and applies the same rule (`nextBalanceView`).
import { useEffect, useMemo, useState } from 'react'
import { readBalance, type Balance } from './api'
import { WALLET_BUSY, type WalletBusy } from './helper'
import { usePoll } from './usePoll'

export interface BalanceView {
  /** The last balance read, kept through a busy read or a failed one. */
  bal: Balance | null
  /** The last read found the coordinator's wallet in use (COORD-LOCK phase 1). */
  busy: boolean
}

/** What a balance read changes: a real balance replaces the last one; a busy read keeps it and says
 *  busy; nothing (no coordinator, an error, an unconfigured wallet) keeps it and is not busy. */
export function nextBalanceView(prev: BalanceView, read: Balance | null | WalletBusy): BalanceView {
  if (read === WALLET_BUSY) return { bal: prev.bal, busy: true }
  if (read?.configured) return { bal: read, busy: false }
  return { bal: prev.bal, busy: false }
}

/** A list (transactions) through a read: a busy read keeps what the screen had, anything else
 *  replaces it. A busy coordinator is not an empty history. */
export function keepOnBusy<T>(prev: T, read: T | WalletBusy): T {
  return read === WALLET_BUSY ? prev : read
}

/** One read at a time: a tick while a read is in flight starts nothing. Until the coordinator stops
 *  making reads wait, a read during a send holds one of its workers for minutes, and stacking one per
 *  tick is the shape of the 2026-08-27 incident. With one in flight, answers also cannot arrive out of
 *  order. */
export function balanceReader(
  read: () => Promise<Balance | null | WalletBusy>,
  apply: (r: Balance | null | WalletBusy) => void,
): () => void {
  let inFlight = false
  return () => {
    if (inFlight) return
    inFlight = true
    void read().then(apply, () => {}).finally(() => { inFlight = false })
  }
}

export function useVaultBalance(): BalanceView {
  const [view, setView] = useState<BalanceView>({ bal: null, busy: false })
  const tick = useMemo(() => balanceReader(() => readBalance(), (r) => setView((v) => nextBalanceView(v, r))), [])
  useEffect(() => { tick() }, [tick])
  // A disabled money control has to watch the condition that disabled it, or it is a dead end.
  usePoll(tick, 12_000)
  return view
}
