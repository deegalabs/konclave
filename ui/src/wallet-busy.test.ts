import { describe, expect, it, vi } from 'vitest'
import { codeOf } from './source-scan'

// COORD-LOCK phase 1 (coordinator): a balance or transactions read no longer waits behind a send; it
// answers 503 {"busy": "wallet"} at once. The web app turned every non-ok answer into "nothing", so a
// page opened during a send said "Wallet not connected" and blocked a new payment. A busy answer is
// "not yet", never "not connected": the last figure stays, or the skeleton on a first load, with a
// note that a payment is being sent. This must ship before the coordinator change.
const vault = 'cc'.repeat(32)
let answer: () => Response = () => new Response('{}', { status: 404 })

const mem = new Map<string, string>()
if (typeof globalThis.localStorage === 'undefined' || !globalThis.localStorage?.setItem) {
  vi.stubGlobal('localStorage', {
    getItem: (k: string) => mem.get(k) ?? null,
    setItem: (k: string, v: string) => void mem.set(k, String(v)),
    removeItem: (k: string) => void mem.delete(k),
    clear: () => mem.clear(),
  })
}
localStorage.setItem('konclave.coord.mode', 'custom')
localStorage.setItem('konclave.coord.url', 'https://coordinator.invalid')
localStorage.setItem('konclave.selectedVault', vault)
vi.stubGlobal('fetch', async () => answer())
const api = await import('./api')
const { WALLET_BUSY } = await import('./helper')
const { nextBalanceView, balanceReader, keepOnBusy } = await import('./useVaultBalance')

const busy = () => new Response(JSON.stringify({ error: 'the vault is sending', busy: 'wallet' }), { status: 503 })

describe('a busy wallet is read as busy, not as missing', () => {
  it('the balance read says busy on 503 {busy: "wallet"}', async () => {
    answer = busy
    expect(await api.readBalance(vault)).toBe(WALLET_BUSY)
  })
  it('any other failure is still nothing', async () => {
    answer = () => new Response('{}', { status: 503 })
    expect(await api.readBalance(vault)).toBeNull()
    answer = () => new Response('{}', { status: 500 })
    expect(await api.readBalance(vault)).toBeNull()
  })
  it('getBalance keeps its contract (busy is null) for the screens that keep their last figure', async () => {
    answer = busy
    expect(await api.getBalance(vault)).toBeNull()
  })
  it('the transactions read says busy too', async () => {
    answer = busy
    expect(await api.readTransactions()).toBe(WALLET_BUSY)
  })
})

describe('a balance read moves the view only where it brings news', () => {
  const bal = { configured: true, total_zat: 5, spendable_zat: 5 } as never
  const other = { configured: true, total_zat: 9, spendable_zat: 9 } as never
  it('busy keeps the last balance and says busy', () => {
    expect(nextBalanceView({ bal, busy: false }, WALLET_BUSY)).toEqual({ bal, busy: true })
    expect(nextBalanceView({ bal: null, busy: false }, WALLET_BUSY)).toEqual({ bal: null, busy: true })
  })
  it('a real balance replaces it and clears busy', () => {
    expect(nextBalanceView({ bal, busy: true }, other)).toEqual({ bal: other, busy: false })
  })
  it('nothing (no coordinator, an error) keeps the last balance and is not busy', () => {
    expect(nextBalanceView({ bal, busy: true }, null)).toEqual({ bal, busy: false })
    expect(nextBalanceView({ bal, busy: false }, { configured: false } as never)).toEqual({ bal, busy: false })
  })
})

describe('one balance read at a time', () => {
  it('a tick while a read is in flight starts no second read, and the next tick after it does', async () => {
    // Until the coordinator stops making reads wait, each read during a send holds one of its workers
    // for minutes; stacking one every 12 s is the shape of the 2026-08-27 incident.
    let release: (v: null) => void = () => {}
    let reads = 0
    const applied: unknown[] = []
    const tick = balanceReader(() => { reads++; return new Promise((r) => { release = r }) }, (r) => applied.push(r))
    tick(); tick(); tick()
    expect(reads).toBe(1)
    release(null)
    await new Promise((r) => setTimeout(r, 0))
    expect(applied).toEqual([null])
    tick()
    expect(reads).toBe(2)
  })
  it('the hook reads on mount and on the poll, through that one reader', () => {
    const hook = codeOf('./useVaultBalance.ts')
    expect(hook).toMatch(/useEffect\(\(\) => \{ tick\(\) \}, \[tick\]\)/)
    expect(hook).toMatch(/usePoll\(tick, 12_000\)/)
  })
})

describe('a list keeps what it had through a busy read', () => {
  it('busy keeps the previous value; anything else replaces it', () => {
    const prev = [{ txid: 'a', mined_height: 1 }]
    expect(keepOnBusy(prev, WALLET_BUSY)).toBe(prev)
    expect(keepOnBusy(prev, null)).toBeNull()
    const next = [{ txid: 'b', mined_height: 2 }]
    expect(keepOnBusy(prev, next)).toBe(next)
  })
})

describe('the screens keep what they had while the wallet is busy', () => {
  it('the dashboard keeps the last balance and says why, and never calls it not connected', () => {
    const src = codeOf('./screens/Dashboard.tsx')
    // The note says what is on screen: a kept balance, or none yet.
    expect(src).toMatch(/<div role="status">\{walletBusy && <div className="hint mt-sm">\{t\(hasBal \? 'wallet\.busyKept' : 'wallet\.busyFirst'\)\}<\/div>\}<\/div>/)
    // One rule for busy or kept: the same function the payment screens use.
    expect(src).toMatch(/setView\(\(v\) => nextBalanceView\(v, b\)\)/)
  })
  it('the dashboard and the receive screen keep their transactions while busy', () => {
    const rcv = codeOf('./screens/Receive.tsx')
    expect(rcv).toContain('readTransactions(')
    expect(rcv).toMatch(/setTxs\(\(prev\) => keepOnBusy\(prev, r\)\)/)
    expect(codeOf('./screens/Dashboard.tsx')).toMatch(/setTxs\(\(prev\) => keepOnBusy\(prev, list\)\)/)
    // /net keeps its balance through a busy read too.
    expect(codeOf('./screens/NetVault.tsx')).toMatch(/setBalance\(\(prev\) => \(b === WALLET_BUSY \? prev :/)
    expect(codeOf('./api.ts')).not.toContain('export async function getTransactions')
  })
  it('the payment and payroll screens read the balance through one hook that refreshes it', () => {
    for (const f of ['./screens/NewPayment.tsx', './screens/NewPayroll.tsx']) {
      const src = codeOf(f)
      expect(src, f).toMatch(/const \{ bal(?:: [a-zA-Z]+)?, busy: walletBusy \} = useVaultBalance\(\)/)
      expect(src, f).not.toContain('readBalance(')
      expect(src, f).not.toContain('getBalance(')
      // Kept balance: the button may well be on; no balance yet: it is off until the vault is free.
      expect(src, f).toMatch(/<div role="status" id="[a-z-]+">\{walletBusy && <div className="hint mt-sm">\{t\(bal \? 'wallet\.busyKept' : 'wallet\.busyBlocked'\)\}<\/div>\}<\/div>/)
      // The button is described by the note only when the busy vault is what turns it off.
      expect(src, f).toMatch(/aria-describedby=\{walletBusy && block === 'balance-unknown' \? "[a-z-]+" : undefined\}/)
      expect(src, f).toMatch(/!\(walletBusy && block === 'balance-unknown'\)/)
    }
    const hook = codeOf('./useVaultBalance.ts')
    expect(hook).toMatch(/usePoll\(tick, 12_000\)/)
  })
})

describe('what the delta audit on 6445e5c asked to be pinned', () => {
  it('the hook ticks through the one-at-a-time reader, not a plain callback', () => {
    expect(codeOf('./useVaultBalance.ts')).toMatch(/const tick = useMemo\(\(\) => balanceReader\(/)
  })
  it('a busy read is not a load: no "not connected", no empty history', () => {
    expect(codeOf('./screens/Dashboard.tsx')).toMatch(/if \(b !== WALLET_BUSY\) setBalLoaded\(true\)/)
    expect(codeOf('./screens/Receive.tsx')).toMatch(/if \(r !== WALLET_BUSY\) setTxLoaded\(true\)/)
  })
  it('the free-funds row says it does not know while no balance has been read, busy or syncing', () => {
    const src = codeOf('./screens/Dashboard.tsx')
    expect(src).toMatch(/: !hasBal\s*\? t\('dashboard\.readyFreeUnknown'\)/)
    // Not a warning mark for something it does not know yet.
    expect(src).toMatch(/\{hasFree \? '✓' : hasBal \? '!' : '…'\}/)
  })
})
