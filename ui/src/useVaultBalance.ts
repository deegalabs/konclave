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

/** What one transactions read means, for every screen that reads the history (Add funds, the
 *  dashboard). A list is an answer. `WALLET_BUSY` is a coordinator holding the vault (COORD-LOCK).
 *  null is a read that FAILED: a 401 before the read key is in the session, a timeout, a 5xx. Only an
 *  answer replaces what a screen shows. This replaced `keepOnBusy`, which kept the list through a
 *  busy read but took a failed one for an empty history: after an unlock, Add funds said "Nothing has
 *  arrived yet" for 20 to 40 seconds on a vault with transactions (Daniel, 16/10). */
export function historyReadKind(read: readonly unknown[] | null | WalletBusy): 'answer' | 'busy' | 'failed' {
  if (read === WALLET_BUSY) return 'busy'
  return read === null ? 'failed' : 'answer'
}

/** The same rule as a type guard, for the screens that then use the list. */
export function isHistoryAnswer<T>(read: T[] | null | WalletBusy): read is T[] {
  return historyReadKind(read) === 'answer'
}

/** After a failed history read, how long to wait before each retry. Short, growing, and finite: a
 *  failure that lasts is left to the screen's poll, so a tab left open cannot press the coordinator
 *  every few seconds (the shape of the #375 incident). */
export const HISTORY_RETRY_MS = [3_000, 6_000, 12_000] as const

/** One history read at a time, retried after a failure on `HISTORY_RETRY_MS` and never from a hidden
 *  tab. `tick` is what the screen's poll calls and replaces a pending retry; `stop` ends everything,
 *  so nothing reads or reports after the screen is gone. Busy is not retried early: the coordinator
 *  is holding the vault, and the poll comes back to it. */
export function historyReader<T>(d: {
  read: () => Promise<T[] | null | WalletBusy>
  onStart: () => void
  onResult: (r: T[] | null | WalletBusy) => void
  hidden?: () => boolean
}): { tick: () => void; stop: () => void } {
  const hidden = d.hidden ?? (() => typeof document !== 'undefined' && document.hidden)
  let inFlight = false
  let stopped = false
  let failures = 0
  let retry: ReturnType<typeof setTimeout> | undefined
  const tick = () => {
    if (stopped || inFlight) return
    clearTimeout(retry)
    retry = undefined
    inFlight = true
    d.onStart()
    void d.read().then(
      (r) => {
        inFlight = false
        if (stopped) return
        d.onResult(r)
        if (historyReadKind(r) !== 'failed') { failures = 0; return }
        if (failures >= HISTORY_RETRY_MS.length || hidden()) return
        retry = setTimeout(tick, HISTORY_RETRY_MS[failures++])
      },
      () => { inFlight = false },
    )
  }
  return { tick, stop: () => { stopped = true; clearTimeout(retry) } }
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
