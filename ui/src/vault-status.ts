// A vault's situation on the list of vaults: what this device last saw of each vault's balance
// and open proposals, each figure with when it saw it.
//
// The list does not read balances itself: a balance read makes the coordinator sync a wallet and
// hold a worker, and a list of N vaults would do it N times on every visit. Instead, whichever
// screen reads a vault's balance or proposals leaves the figures here, on this device, and the
// list shows them with their time, or says nothing was read here yet. Whole zatoshi.
//
// A private vault (one whose secret this tab holds) keeps no amounts on the device: only the count
// of open proposals and the times. Its amounts live in this tab's memory and are shown only while
// its secret is held here, that is, while it is unlocked. An open vault keeps its figures.
import { balanceParts, reservedZatOf } from './balance-parts'
import { isOpen } from './desk'
import { readSecretFor } from './session'
import type { Proposal } from './api'

type Amounts = { totalZat?: number; spendableZat?: number; reservedZat?: number }
type Times = {
  balanceAt?: number
  openCount?: number
  lastActivity?: number
  proposalsAt?: number
}
type Stored = Amounts & Times & {
  /** A private vault's record: amounts, if any, are not trusted from storage. */
  private?: boolean
}

export type VaultStatus = {
  /** Spendable minus what open proposals hold; null until both a balance and the proposals were seen. */
  freeZat: number | null
  /** The free figure is made of two reads; this is the OLDER of them, the time it honestly carries. */
  freeAt: number | null
  openCount: number | null
  /** The newest proposal's creation time, as a unix timestamp. */
  lastProposal: number | null
  /** When this device last read the proposals: the time the count carries. */
  proposalsAt: number | null
}

const key = (vault: string) => `konclave.status.${vault}`
/** A private vault's amounts, in this tab only. */
const memory = new Map<string, Amounts>()

/** A number from storage, or nothing: a hand-edited record must not put NaN on the screen. */
const num = (v: unknown): number | undefined => (typeof v === 'number' && Number.isFinite(v) ? v : undefined)

function read(vault: string): Stored | null {
  try {
    const raw = localStorage.getItem(key(vault))
    if (!raw) return null
    const d = JSON.parse(raw) as Record<string, unknown> | null
    if (!d || typeof d !== 'object') return null
    return {
      private: d.private === true,
      totalZat: num(d.totalZat), spendableZat: num(d.spendableZat), reservedZat: num(d.reservedZat),
      balanceAt: num(d.balanceAt), openCount: num(d.openCount), lastActivity: num(d.lastActivity), proposalsAt: num(d.proposalsAt),
    }
  } catch { return null }
}
function write(vault: string, s: Stored) {
  try { localStorage.setItem(key(vault), JSON.stringify(s)) } catch { /* a device that cannot keep it shows nothing */ }
}

const isPrivate = (vault: string) => !!readSecretFor(vault)
const now = () => Math.floor(Date.now() / 1000)
const timesOf = (s: Stored): Times => ({ balanceAt: s.balanceAt, openCount: s.openCount, lastActivity: s.lastActivity, proposalsAt: s.proposalsAt })

/** Keeps the amounts where they may live: in storage for an open vault, in memory for a private one. */
function keep(vault: string, amounts: Amounts, times: Times) {
  const prev = read(vault) ?? {}
  if (isPrivate(vault)) {
    memory.set(vault, { ...(memory.get(vault) ?? {}), ...amounts })
    write(vault, { ...timesOf(prev), ...times, private: true })
  } else {
    write(vault, { ...prev, ...amounts, ...times })
  }
}

export function rememberBalance(vault: string, bal: { total_zat?: number | null; spendable_zat?: number | null } | null): void {
  if (!bal || bal.total_zat == null) return
  keep(vault, { totalZat: bal.total_zat, spendableZat: bal.spendable_zat ?? bal.total_zat }, { balanceAt: now() })
}

export function rememberProposals(vault: string, proposals: readonly Proposal[] | null): void {
  if (!proposals) return
  const last = proposals.reduce<number>((m, p) => Math.max(m, p.created_at ?? 0), 0)
  // Open is the desk's own rule (`isOpen`): a proposal past its deadline on this clock is not open.
  keep(vault, { reservedZat: reservedZatOf(proposals) ?? 0 },
    { openCount: proposals.filter(isOpen).length, lastActivity: last || undefined, proposalsAt: now() })
}

/** What this device last saw of the vault, or null when it never read it here. */
export function vaultStatus(vault: string): VaultStatus | null {
  const s = read(vault)
  if (!s || (s.balanceAt == null && s.proposalsAt == null)) return null
  const amounts: Amounts = s.private ? (isPrivate(vault) ? memory.get(vault) ?? {} : {}) : s
  const both = amounts.totalZat != null && amounts.spendableZat != null && amounts.reservedZat != null && s.balanceAt != null && s.proposalsAt != null
  return {
    freeZat: both ? balanceParts(amounts.totalZat!, amounts.spendableZat!, amounts.reservedZat!).freeZat : null,
    freeAt: both ? Math.min(s.balanceAt!, s.proposalsAt!) : null,
    openCount: s.openCount ?? null,
    lastProposal: s.lastActivity ?? null,
    proposalsAt: s.proposalsAt ?? null,
  }
}

/** The free figure is grey once it is more than a day old: by its own time, not the newest read's. */
export function statusIsStale(st: VaultStatus, nowSec: number = now()): boolean {
  return st.freeAt !== null && st.freeAt < nowSec - 86_400
}

export function openCountKey(n: number): string {
  return n === 0 ? 'vaults.stateNoOpen' : n === 1 ? 'vaults.stateOpenOne' : 'vaults.stateOpen'
}

/** Called by `clearVaultTraces` when the vault is removed from this device. */
export function forgetStatus(vault: string): void {
  memory.delete(vault)
  try { localStorage.removeItem(key(vault)) } catch { /* nothing to forget */ }
}
