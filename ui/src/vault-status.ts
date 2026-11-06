// A vault's situation on the list of vaults: what this device last saw of each vault's balance
// and open proposals, with when it saw it.
//
// The list does not read balances itself: a balance read makes the coordinator sync a wallet and
// hold a worker, and a list of N vaults would do it N times on every visit. Instead, whichever
// screen reads a vault's balance or proposals leaves the figures here, on this device, and the
// list shows them with their time, or says the vault was not opened here yet. Whole zatoshi.
import { balanceParts, reservedZatOf } from './balance-parts'
import type { Proposal } from './api'

type Stored = {
  totalZat?: number
  spendableZat?: number
  balanceAt?: number
  reservedZat?: number
  openCount?: number
  lastActivity?: number
  proposalsAt?: number
}

export type VaultStatus = {
  /** Spendable minus what open proposals hold; null until both a balance and the proposals were seen. */
  freeZat: number | null
  /** The free figure is made of two reads; this is the OLDER of them, the time it honestly carries. */
  freeAt: number | null
  openCount: number | null
  /** The newest proposal's creation time, as a unix timestamp. */
  lastProposal: number | null
  /** When this device last read the proposals. */
  proposalsAt: number | null
  /** When this device last read any of it. */
  at: number
}

const key = (vault: string) => `konclave.status.${vault}`

function read(vault: string): Stored | null {
  try {
    const raw = localStorage.getItem(key(vault))
    if (!raw) return null
    const d = JSON.parse(raw)
    return d && typeof d === 'object' ? (d as Stored) : null
  } catch { return null }
}
function write(vault: string, s: Stored) {
  try { localStorage.setItem(key(vault), JSON.stringify(s)) } catch { /* a device that cannot keep it shows nothing */ }
}

const now = () => Math.floor(Date.now() / 1000)

export function rememberBalance(vault: string, bal: { total_zat?: number | null; spendable_zat?: number | null } | null): void {
  if (!bal || bal.total_zat == null) return
  write(vault, { ...(read(vault) ?? {}), totalZat: bal.total_zat, spendableZat: bal.spendable_zat ?? bal.total_zat, balanceAt: now() })
}

export function rememberProposals(vault: string, proposals: readonly Proposal[] | null): void {
  if (!proposals) return
  const open = proposals.filter((p) => p.state === 'awaiting' || p.state === 'ready')
  const last = proposals.reduce<number>((m, p) => Math.max(m, p.created_at ?? 0), 0)
  write(vault, { ...(read(vault) ?? {}), reservedZat: reservedZatOf(proposals) ?? 0, openCount: open.length, lastActivity: last || undefined, proposalsAt: now() })
}

/** What this device last saw of the vault, or null when it never opened it. */
export function vaultStatus(vault: string): VaultStatus | null {
  const s = read(vault)
  if (!s || (s.balanceAt == null && s.proposalsAt == null)) return null
  const both = s.totalZat != null && s.spendableZat != null && s.reservedZat != null && s.balanceAt != null && s.proposalsAt != null
  return {
    freeZat: both ? balanceParts(s.totalZat!, s.spendableZat!, s.reservedZat!).freeZat : null,
    freeAt: both ? Math.min(s.balanceAt!, s.proposalsAt!) : null,
    openCount: s.openCount ?? null,
    lastProposal: s.lastActivity ?? null,
    proposalsAt: s.proposalsAt ?? null,
    at: Math.max(s.balanceAt ?? 0, s.proposalsAt ?? 0),
  }
}

export function forgetStatus(vault: string): void {
  try { localStorage.removeItem(key(vault)) } catch { /* nothing to forget */ }
}
