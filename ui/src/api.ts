// Client for the local bridge (`konclave serve`, ADR-0004). Same-origin `/api/*` in
// production (the bridge serves this bundle); proxied to :4762 in `npm run dev`.
//
// Every call degrades gracefully: on any failure it returns `null` so screens fall back
// to their static placeholder and still render (useful in dev without the backend, and
// resilient if the local daemon is momentarily down).

import type { TFn } from './i18n'
import {
  helperConfigured,
  helperHealth,
  getVault as netGetVault,
  vaultBalance as netVaultBalance,
  listProposals as netListProposals,
  createProposal as netCreateProposal,
  createPayroll as netCreatePayroll,
  voteProposal as netVote,
  listMembers as netListMembers,
  setMembers as netSetMembers,
  renameMember as netRenameMember,
  listTransactions as netListTransactions,
  type WalletTx,
  type Proposal as NetProposal,
} from './helper'
import { fmtZecExact, zatToZec, parseZecToZat } from './format'
import { listVaults, updateVaultMeta } from './storage'
import { getUnlockedShare, setUnlockedShare } from './session'

export type Member = { name: string; pubkey: string }

export type Vault = {
  id: string
  name: string
  threshold: number
  total: number
  members: number
  member_list: Member[]
  group_pubkey: string
  orchard_address: string
  // ufvk is intentionally NOT sent by the bridge (it decrypts the whole tx graph + memos).
  server_url?: string
  locked?: boolean
}

export type Proposal = {
  id: string
  vault_id: string
  kind: 'payment' | 'payroll'
  state: string
  proposer: string
  value_zat: number
  value_zec: string
  memo?: string
  to_address?: string
  is_public: boolean
  expiry_unix?: number
  created_at?: number
  txid?: string
  approvals: string[]
  refusals: string[]
  approvals_count: number
}

export type Balance = {
  configured: boolean
  chain_tip_height?: number
  total_zat?: number
  total_zec?: string
  spendable_zat?: number
  spendable_zec?: string
  pending_zat?: number
  pending_zec?: string
}

const ENV = import.meta.env as Record<string, string | undefined>
const BASE: string = ENV.VITE_API_BASE ?? ''

// Browser-native mode (Etapa 3 convergence): when a hosted blind helper is configured, the PWA
// screens (Dashboard / Proposals / Ledger) read the SELECTED /net vault from the helper instead of
// the local bridge, so the same polished app operates the browser-born vault.
const NET = helperConfigured()
/** True when the app operates a browser-native (/net) vault via the hosted helper. Screens use it
 *  to route signing to /net (where the share lives) instead of a server-side ceremony. */
export const IS_NET = NET

/** Map a helper proposal state to the lowercase states the PWA screens expect. */
export function netState(s: string): string {
  return s === 'pending' ? 'awaiting' : s === 'refused' ? 'rejected' : s
}

/** Adapt a helper `Proposal` into the PWA's `Proposal` shape. */
export function mapNetProposal(p: NetProposal): Proposal {
  return {
    id: p.id,
    vault_id: p.vault_id,
    kind: p.kind === 'payroll' ? 'payroll' : 'payment',
    state: netState(p.state),
    proposer: p.proposer,
    value_zat: p.amount_zat,
    value_zec: zatToZec(p.amount_zat),
    memo: p.memo ?? undefined,
    to_address: p.to,
    is_public: classifyAddress(p.to) !== 'unified',
    expiry_unix: p.expiry_unix || undefined,
    created_at: p.created_at_unix,
    txid: p.txid ?? undefined,
    approvals: p.approvals,
    refusals: p.refusals,
    approvals_count: p.approvals.length,
  }
}

// Per-session CSRF token, injected into index.html by the local bridge (window.__KONCLAVE_SESSION__).
// Sent back on state-changing requests so a cross-site page cannot drive the vault. Reads are
// protected by the bridge's Host gate + the browser same-origin policy, so they don't carry it.
const SESSION: string =
  (typeof window !== 'undefined' && (window as { __KONCLAVE_SESSION__?: string }).__KONCLAVE_SESSION__) || ''
function postHeaders(): Record<string, string> {
  return { 'Content-Type': 'application/json', 'X-Konclave-Session': SESSION }
}

// Which vault the UI is currently inside. Persisted so a reload stays in the same
// vault; sent as ?vault=<id> so the bridge scopes data per vault (not always the first).
const VAULT_KEY = 'konclave.selectedVault'
export function setSelectedVault(id: string): void {
  try { localStorage.setItem(VAULT_KEY, id) } catch { /* storage unavailable */ }
}
export function getSelectedVault(): string | null {
  try { return localStorage.getItem(VAULT_KEY) } catch { return null }
}
export function clearSelectedVault(): void {
  try { localStorage.removeItem(VAULT_KEY) } catch { /* storage unavailable */ }
}
/** Append `?vault=<selected>` to a path when a vault is selected. */
function withVault(path: string): string {
  const id = getSelectedVault()
  if (!id) return path
  return `${path}${path.includes('?') ? '&' : '?'}vault=${encodeURIComponent(id)}`
}

// Vaults unlocked in THIS browser session (in-memory: a reload re-locks, so the
// passphrase is asked again on every fresh entry - that is the intended behaviour).
const unlockedSession = new Set<string>()
export function markVaultUnlocked(id: string): void { unlockedSession.add(id) }
export function isVaultUnlocked(id: string): boolean { return unlockedSession.has(id) }

async function getJson<T>(path: string, timeoutMs = 4000): Promise<T | null> {
  const ctrl = new AbortController()
  const t = setTimeout(() => ctrl.abort(), timeoutMs)
  try {
    const res = await fetch(`${BASE}${path}`, { signal: ctrl.signal })
    if (!res.ok) return null
    return (await res.json()) as T
  } catch {
    return null
  } finally {
    clearTimeout(t)
  }
}

/** True when the bridge answers `/api/health`. Lets the UI show a live/offline badge. */
export async function health(): Promise<boolean> {
  if (NET) return (await helperHealth()) !== null
  const h = await getJson<{ status?: string }>('/api/health')
  return h?.status === 'ok'
}

export async function getVault(): Promise<Vault | null> {
  if (NET) {
    const id = getSelectedVault()
    if (!id) return null
    const v = await netGetVault(id)
    if (!v) return null
    const total = v.total ?? 0
    // Members: use the stored names (Members screen) when set; otherwise "member N" seats, so the
    // vote UI always has options and a vote from the PWA matches one from /net (same member id).
    const names = (await netListMembers(id)) ?? []
    const member_list = Array.from({ length: total }, (_, i) => {
      const name = names[i] && names[i].trim() ? names[i] : `member ${i + 1}`
      return { name, pubkey: name }
    })
    // The vault's real name is the one the operator chose at create/join, kept on this device.
    // Use it instead of a generic 'Networked vault' label; fall back only when there is no record.
    let vaultName = 'Vault'
    try {
      const saved = await listVaults()
      const rec = saved.find((s) => s.id === id)
      if (rec?.name && rec.name.trim()) vaultName = rec.name
    } catch { /* local-bridge mode / no on-device record - keep the neutral fallback */ }
    return {
      id: v.vault_id,
      name: vaultName,
      threshold: v.threshold ?? 0,
      total,
      members: total,
      member_list,
      group_pubkey: v.vault_id,
      orchard_address: v.address,
    }
  }
  const r = await getJson<{ vault: Vault | null }>(withVault('/api/vault'))
  return r?.vault ?? null
}

export async function getProposals(): Promise<Proposal[] | null> {
  if (NET) {
    const id = getSelectedVault()
    if (!id) return null
    const ps = await netListProposals(id)
    return ps ? ps.map(mapNetProposal) : null
  }
  const r = await getJson<{ proposals: Proposal[] }>(withVault('/api/proposals'))
  return r?.proposals ?? null
}

export async function getBalance(): Promise<Balance | null> {
  if (NET) {
    const id = getSelectedVault()
    if (!id) return null
    const b = await netVaultBalance(id)
    if (!b) return null
    // Since NU6.3 the spendable funds live in the Ironwood pool. Use the helper's combined
    // shielded_spendable_zat (Orchard + Ironwood); fall back to orchard-only for an older helper.
    const spendable = b.shielded_spendable_zat ?? b.orchard_spendable_zat
    return {
      configured: true,
      total_zat: b.total_zat,
      total_zec: zatToZec(b.total_zat),
      spendable_zat: spendable,
      spendable_zec: zatToZec(spendable),
    }
  }
  return await getJson<Balance>(withVault('/api/balance'))
}

/** Shorten an address for display: `u1vjgx…d406dr`. */
// shortAddr moved to format.ts (display formatting belongs there, not in the transport client);
// re-exported so existing `import { shortAddr } from '../api'` call sites keep working.
export { shortAddr } from './format'

// ---- writes ----

export type NewProposal = {
  proposer: string
  to_address: string
  value_zec: string
  memo?: string
}

export type CreateResult =
  | { ok: true; proposal: Proposal }
  | { ok: false; error: string; detail?: string }

/** POST a new payment proposal. Returns a typed success or a readable error. */
export async function createProposal(input: NewProposal): Promise<CreateResult> {
  if (NET) {
    const id = getSelectedVault()
    if (!id) return { ok: false, error: 'no vault' }
    const zat = parseZecToZat(input.value_zec)
    if (zat == null || zat <= 0) return { ok: false, error: 'invalid amount' }
    const p = await netCreateProposal({
      vault: id,
      proposer: input.proposer,
      to: input.to_address,
      amountZat: zat,
      memo: input.memo,
    })
    return p
      ? { ok: true, proposal: mapNetProposal(p) }
      : { ok: false, error: 'invalid address', detail: 'the coordinator rejected the destination or amount' }
  }
  try {
    const res = await fetch(`${BASE}${withVault('/api/proposals')}`, {
      method: 'POST',
      headers: postHeaders(),
      body: JSON.stringify(input),
    })
    const data = (await res.json().catch(() => ({}))) as Record<string, unknown>
    if (res.status === 201) return { ok: true, proposal: data as unknown as Proposal }
    return { ok: false, error: (data.error as string) ?? `HTTP ${res.status}`, detail: data.detail as string }
  } catch (e) {
    return { ok: false, error: 'no connection', detail: String(e) }
  }
}

/** Classify a destination the same way the backend does (drives the UI warnings). */
export type AddressKind = 'unified' | 'sapling' | 'transparent' | 'unknown'
export function classifyAddress(addr: string): AddressKind {
  if (addr.startsWith('u1')) return 'unified'
  if (addr.startsWith('zs')) return 'sapling'
  if (addr.startsWith('t1') || addr.startsWith('t3')) return 'transparent'
  return 'unknown'
}

/**
 * Turn a backend error (code + technical detail) into a clear, actionable message via i18n
 * (§6.11 "human-readable errors"). Matches on the backend's English error CODES; returns a
 * localized message. Keeps the raw detail only as a last resort.
 */
export function humanError(t: TFn, error?: string, detail?: string): string {
  const e = (error ?? '').toLowerCase()
  const d = (detail ?? '').toLowerCase()
  const has = (s: string) => e.includes(s) || d.includes(s)

  // The engine reports the two figures that decide it. Pass them through: "the vault has X and this
  // needs Y" is actionable, where a generic "insufficient funds" leaves you guessing by how much -
  // and the gap is usually the fee, which is exactly the part nobody can compute in their head.
  const funds = /available:\s*Zatoshis\((\d+)\)[\s\S]*?required:\s*Zatoshis\((\d+)\)/i.exec(`${error ?? ''} ${detail ?? ''}`)
  if (funds) {
    const have = Number(funds[1]), need = Number(funds[2])
    if (Number.isFinite(have) && Number.isFinite(need)) {
      // Exact, not rounded: the gap between the two is the whole point of the message.
      return t('error.insufficientExact', { have: fmtZecExact(have / 1e8), need: fmtZecExact(need / 1e8) })
    }
  }
  if (has('insufficient') || has('saldo')) return t('error.insufficient')
  // A client-side fetch failure surfaces as 'no connection' - match it BEFORE the ceremony
  // rule below, whose bare 'connection' substring would otherwise swallow it.
  if (has('no connection') || has('failed to fetch')) return t('error.noConnection')
  if (e === 'send failed' || has('connection') || has('frostd') || has('transport') || has('refused') || has('timed out'))
    return t('error.ceremony')
  if (has('signature') || has('apply_signature') || has('share')) return t('error.share')
  if (has('expiry') || has('expired') || e === 'expired') return t('error.expired')
  if (e === 'vote rejected') return t('error.voteRejected')
  if (e === 'not ready') return t('error.notReady')
  if (e === 'invalid address' || has('unrecognized address')) return t('error.invalidAddress')
  if (e === 'invalid memo' || has('transparent')) return t('error.invalidMemo')
  if (e === 'invalid amount') return t('error.invalidAmount')
  if (e === 'no vault') return t('error.noVault')
  if (e === 'no destination') return t('error.noDestination')
  if (e === 'empty payroll' || has('payroll has no lines')) return t('error.emptyPayroll')

  // Fallback: a short detail is probably already readable; otherwise a generic message.
  if (detail && detail.length > 0 && detail.length < 140) return detail
  return error && error.length < 140 ? error : t('error.unexpected')
}

export type { WalletTx } from './helper'

/** The vault's full on-chain transaction history (newest first) for the Add-funds record. Wired on
 *  BOTH paths (#211): browser-native via the helper, local bridge via `GET /api/transactions`. */
export async function getTransactions(): Promise<WalletTx[] | null> {
  if (NET) {
    const id = getSelectedVault()
    if (!id) return null
    return netListTransactions(id)
  }
  return (await getJson<{ transactions: WalletTx[] }>(withVault('/api/transactions')))?.transactions ?? null
}

/** Set the member names of the selected /net vault (seat order). Only in browser-native mode. */
export async function setVaultMembers(names: string[]): Promise<string[] | null> {
  if (!NET) return null
  const id = getSelectedVault()
  if (!id) return null
  return netSetMembers(id, names)
}

/** Rename THIS device's own seat (`old` -> `next`) on the selected /net vault. The helper migrates
 *  the name across every proposal's votes (no ghost approver), and we mirror the change into the
 *  on-device record so "you" keeps pointing at the right seat. Returns the new roster or an error
 *  reason. A device may only rename the seat it holds - never another member's. */
export async function renameSelf(
  old: string,
  next: string,
): Promise<{ members: string[] } | { error: string }> {
  if (!NET) return { error: 'not available' }
  const id = getSelectedVault()
  if (!id) return { error: 'no vault selected' }
  const res = await netRenameMember(id, old, next)
  if ('members' in res) {
    const nm = next.trim()
    try { await updateVaultMeta(id, { myName: nm }) } catch { /* record absent - roster still renamed */ }
    // Keep the IN-SESSION share's name in sync too: the signing panel identifies "you" from the
    // unlocked share's myName, so a stale name there makes it fail to light your seat (and fall back
    // to guessing the first seat). Patch it in place so presence stays correct after a rename.
    try {
      const share = getUnlockedShare(id)
      if (share && share.myName !== nm) setUnlockedShare(id, { ...share, myName: nm })
    } catch { /* nothing unlocked this session - nothing to sync */ }
  }
  return res
}

/** Self-heal for a stale on-device name: adopt an EXISTING roster name as this device's own, WITHOUT
 *  a server rename. Used when a prior rename synced the helper (the roster shows the new name) but not
 *  this device (its record kept the old name) - so the device is "stuck" (the server rejects renaming
 *  a name it no longer has). Just points the on-device record + session share at the name that is
 *  already in the roster. No network call, no vote migration (the server side already happened). */
export async function adoptSelfName(name: string): Promise<{ ok: true } | { error: string }> {
  if (!NET) return { error: 'not available' }
  const id = getSelectedVault()
  if (!id) return { error: 'no vault selected' }
  const nm = name.trim()
  if (!nm) return { error: 'empty name' }
  try { await updateVaultMeta(id, { myName: nm }) } catch { /* record absent */ }
  try {
    const share = getUnlockedShare(id)
    if (share && share.myName !== nm) setUnlockedShare(id, { ...share, myName: nm })
  } catch { /* nothing unlocked */ }
  return { ok: true }
}

/** Every vault known to this device (for the "Meus cofres" home). In browser-native (/net) mode the
 *  vault list comes from the on-device records (listVaults in storage), NOT the blind helper, so we
 *  do not call the helper's /api/vaults here (it returns bare ids, not vaults, and 404'd on older
 *  builds - #136). The Vaults screen already merges the on-device net rows itself. */
export async function getVaults(): Promise<Vault[] | null> {
  if (NET) return null
  const r = await getJson<{ vaults: Vault[] }>('/api/vaults')
  return r?.vaults ?? null
}

/** The full ledger (all proposals, terminal states included) for the Razão screen. */
export async function getLedger(): Promise<Proposal[] | null> {
  if (NET) {
    const id = getSelectedVault()
    if (!id) return null
    const ps = await netListProposals(id)
    return ps ? ps.map(mapNetProposal) : null
  }
  const r = await getJson<{ ledger: Proposal[] }>(withVault('/api/ledger'))
  return r?.ledger ?? null
}

/** URL of the CSV export the browser downloads (handed to the accountant). */
export function ledgerCsvUrl(): string {
  return `${BASE}${withVault('/api/ledger.csv')}`
}

// ---- payroll ----

export type PayrollLine = {
  label?: string | null
  address: string
  value_zat: number
  value_zec: string
  memo: string
  is_public: boolean
}

export type PayrollSummary = {
  count: number
  total_zat: number
  total_zec: string
  fee_zat: number
  fee_zec: string
  total_with_fee_zec: string
}

export type PayrollPreview = {
  lines: PayrollLine[]
  errors: { row: number; reason: string }[]
  summary: PayrollSummary
}

export type NewPayrollLine = { label?: string; address: string; value_zec: string; memo?: string }

/** Parse a CSV into accepted lines + per-row errors + summary (no state change). */
export async function previewPayroll(csv: string): Promise<PayrollPreview | null> {
  try {
    const res = await fetch(`${BASE}/api/payroll/preview`, {
      method: 'POST',
      headers: postHeaders(),
      body: JSON.stringify({ csv }),
    })
    if (!res.ok) return null
    return (await res.json()) as PayrollPreview
  } catch {
    return null
  }
}

/** Create a payroll proposal (N outputs, one envelope). */
export async function createPayroll(
  proposer: string,
  lines: NewPayrollLine[],
  description?: string,
): Promise<CreateResult> {
  if (NET) {
    const id = getSelectedVault()
    if (!id) return { ok: false, error: 'no vault' }
    const mapped: { label?: string; to: string; amount_zat: number; memo?: string }[] = []
    for (const l of lines) {
      const zat = parseZecToZat(l.value_zec)
      if (zat == null || zat <= 0) return { ok: false, error: 'invalid amount' }
      mapped.push({ label: l.label, to: l.address, amount_zat: zat, memo: l.memo })
    }
    const p = await netCreatePayroll({ vault: id, proposer, lines: mapped })
    return p
      ? { ok: true, proposal: mapNetProposal(p) }
      : { ok: false, error: 'invalid address', detail: 'the coordinator rejected a payroll line' }
  }
  try {
    const res = await fetch(`${BASE}${withVault('/api/payroll')}`, {
      method: 'POST',
      headers: postHeaders(),
      body: JSON.stringify({ proposer, description, lines }),
    })
    const data = (await res.json().catch(() => ({}))) as Record<string, unknown>
    if (res.status === 201) return { ok: true, proposal: data.proposal as Proposal }
    return { ok: false, error: (data.error as string) ?? `HTTP ${res.status}`, detail: data.detail as string }
  } catch (e) {
    return { ok: false, error: 'no connection', detail: String(e) }
  }
}

/** Create a vault by DKG (5-F). Long-running: the DKG ceremony takes several seconds. */
export async function createVaultDkg(
  name: string, threshold: number, members: string[],
): Promise<{ ok: true; vault: Vault; passphrase?: string } | { ok: false; error: string; detail?: string }> {
  try {
    const res = await fetch(`${BASE}/api/vault/dkg`, {
      method: 'POST',
      headers: postHeaders(),
      body: JSON.stringify({ name, threshold, members }),
    })
    const data = (await res.json().catch(() => ({}))) as Record<string, unknown>
    if (res.status === 201) return { ok: true, vault: data.vault as Vault, passphrase: data.passphrase as string | undefined }
    return { ok: false, error: (data.error as string) ?? `HTTP ${res.status}`, detail: data.detail as string }
  } catch (e) {
    return { ok: false, error: 'no connection', detail: String(e) }
  }
}

/** Verify the passphrase ("palavra do cofre") for the currently selected vault. */
export async function unlockVault(passphrase: string): Promise<{ ok: boolean; wrong: boolean }> {
  try {
    const res = await fetch(`${BASE}${withVault('/api/vault/unlock')}`, {
      method: 'POST',
      headers: postHeaders(),
      body: JSON.stringify({ passphrase }),
    })
    if (res.ok) return { ok: true, wrong: false }
    return { ok: false, wrong: res.status === 401 }
  } catch {
    return { ok: false, wrong: false }
  }
}

/** Delete the selected vault from THIS device. Locked vaults require the passphrase. */
export async function deleteVault(
  passphrase?: string,
  confirmName?: string,
): Promise<{ ok: boolean; wrong: boolean }> {
  try {
    const res = await fetch(`${BASE}${withVault('/api/vault/delete')}`, {
      method: 'POST',
      headers: postHeaders(),
      body: JSON.stringify({ passphrase, confirm_name: confirmName }),
    })
    if (res.ok) return { ok: true, wrong: false }
    return { ok: false, wrong: res.status === 401 }
  } catch {
    return { ok: false, wrong: false }
  }
}

// ---- beneficiaries (address book) ----

export type Beneficiary = { id: string; name: string; address: string; memo: string; is_public: boolean }

// Browser-native (/net): the payee address-book is a per-vault convenience with NO secrets, so it
// lives ON THIS DEVICE (localStorage keyed by vault id) instead of the blind helper - which does not
// implement /api/beneficiaries (the 404s in #136). This keeps the console clean, works offline, and
// stays local-first. (A vault-shared list would be a helper feature; tracked separately.)
function benefKey(): string | null {
  const id = getSelectedVault()
  return id ? `konclave.benef.${id}` : null
}
function netBenefList(): Beneficiary[] {
  const k = benefKey()
  if (!k) return []
  try { return JSON.parse(localStorage.getItem(k) ?? '[]') as Beneficiary[] } catch { return [] }
}
function netBenefSave(list: Beneficiary[]): void {
  const k = benefKey()
  if (!k) return
  try { localStorage.setItem(k, JSON.stringify(list)) } catch { /* storage blocked/full */ }
}

export async function getBeneficiaries(): Promise<Beneficiary[] | null> {
  if (NET) return netBenefList()
  const r = await getJson<{ beneficiaries: Beneficiary[] }>(withVault('/api/beneficiaries'))
  return r?.beneficiaries ?? null
}

export async function addBeneficiary(
  name: string, address: string, memo?: string,
): Promise<{ ok: true; beneficiary: Beneficiary } | { ok: false; error: string; detail?: string }> {
  if (NET) {
    const addr = address.trim()
    if (!name.trim() || !addr) return { ok: false, error: 'invalidAddress' }
    if (classifyAddress(addr) === 'unknown') return { ok: false, error: 'invalidAddress' }
    const b: Beneficiary = {
      id: crypto.randomUUID(),
      name: name.trim(),
      address: addr,
      memo: memo?.trim() ?? '',
      is_public: classifyAddress(addr) === 'transparent',
    }
    netBenefSave([...netBenefList(), b])
    return { ok: true, beneficiary: b }
  }
  try {
    const res = await fetch(`${BASE}${withVault('/api/beneficiaries')}`, {
      method: 'POST',
      headers: postHeaders(),
      body: JSON.stringify({ name, address, memo }),
    })
    const data = (await res.json().catch(() => ({}))) as Record<string, unknown>
    if (res.status === 201) return { ok: true, beneficiary: data.beneficiary as Beneficiary }
    return { ok: false, error: (data.error as string) ?? `HTTP ${res.status}`, detail: data.detail as string }
  } catch (e) {
    return { ok: false, error: 'no connection', detail: String(e) }
  }
}

export async function deleteBeneficiary(id: string): Promise<boolean> {
  if (NET) {
    netBenefSave(netBenefList().filter((b) => b.id !== id))
    return true
  }
  try {
    const res = await fetch(`${BASE}/api/beneficiaries/${encodeURIComponent(id)}/delete`, { method: 'POST' })
    return res.ok
  } catch {
    return false
  }
}

/** Proposal detail including payroll lines (empty for a single payment). */
export async function getProposalDetail(
  id: string,
): Promise<{ proposal: Proposal; lines: PayrollLine[] } | null> {
  if (NET) {
    const vid = getSelectedVault()
    if (!vid) return null
    const ps = await netListProposals(vid)
    const hp = ps?.find((x) => x.id === id)
    if (!hp) return null
    const lines: PayrollLine[] = (hp.lines ?? []).map((l) => ({
      label: l.label ?? null,
      address: l.to,
      value_zat: l.amount_zat,
      value_zec: zatToZec(l.amount_zat),
      memo: l.memo ?? '',
      is_public: classifyAddress(l.to) !== 'unified',
    }))
    return { proposal: mapNetProposal(hp), lines }
  }
  const r = await getJson<{ proposal: Proposal; lines: PayrollLine[] }>(`/api/proposals/${encodeURIComponent(id)}`)
  if (!r?.proposal) return null
  return { proposal: r.proposal, lines: r.lines ?? [] }
}

export type SendResult =
  | { ok: true; dryRun: boolean; txid?: string; sighash?: string; proposal?: Proposal }
  | { ok: false; error: string; detail?: string }

/**
 * Run the FROST ceremony for a Ready proposal. `dryRun` signs without broadcasting.
 * No client timeout: the ceremony (create→prove→sign→broadcast) can take 30-60s.
 */
export async function sendProposal(id: string, dryRun: boolean): Promise<SendResult> {
  if (NET) {
    // Executing a /net proposal needs the FROST ceremony (the share + a signing session over the
    // relay), which lives on the /net screen. From the PWA we cannot sign, so point the operator
    // there. (Bringing the ceremony into the Dashboard is the next slice.)
    return {
      ok: false,
      error: 'sign in /net',
      detail: 'To send this approved payment, open the vault in /net and sign there with your share.',
    }
  }
  try {
    const res = await fetch(`${BASE}/api/proposals/${encodeURIComponent(id)}/send`, {
      method: 'POST',
      headers: postHeaders(),
      body: JSON.stringify({ dry_run: dryRun }),
    })
    const data = (await res.json().catch(() => ({}))) as Record<string, unknown>
    if (res.ok) {
      return {
        ok: true,
        dryRun: Boolean(data.dry_run),
        txid: data.txid as string | undefined,
        sighash: data.sighash as string | undefined,
        proposal: data.proposal as Proposal | undefined,
      }
    }
    return { ok: false, error: (data.error as string) ?? `HTTP ${res.status}`, detail: data.detail as string }
  } catch (e) {
    // A network drop mid-broadcast must never dump a raw exception at the user. 'send failed'
    // is matched by humanError -> a calm, human message; the raw cause stays in detail for logs.
    return { ok: false, error: 'send failed', detail: String(e) }
  }
}

/** Approve or refuse a proposal on behalf of `member`. */
export async function voteProposal(
  id: string,
  member: string,
  approve: boolean,
): Promise<CreateResult> {
  if (NET) {
    const vid = getSelectedVault()
    if (!vid) return { ok: false, error: 'no vault' }
    const p = await netVote(vid, id, member, approve)
    return p ? { ok: true, proposal: mapNetProposal(p) } : { ok: false, error: 'vote rejected' }
  }
  try {
    const res = await fetch(`${BASE}/api/proposals/${encodeURIComponent(id)}/${approve ? 'approve' : 'refuse'}`, {
      method: 'POST',
      headers: postHeaders(),
      body: JSON.stringify({ member }),
    })
    const data = (await res.json().catch(() => ({}))) as Record<string, unknown>
    if (res.ok) return { ok: true, proposal: data.proposal as Proposal }
    return { ok: false, error: (data.error as string) ?? `HTTP ${res.status}`, detail: data.detail as string }
  } catch (e) {
    return { ok: false, error: 'no connection', detail: String(e) }
  }
}
