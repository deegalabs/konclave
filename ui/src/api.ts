// Client for the local bridge (`konclave serve`, ADR-0004). Same-origin `/api/*` in
// production (the bridge serves this bundle); proxied to :4762 in `npm run dev`.
//
// Every call degrades gracefully: on any failure it returns `null` so screens fall back
// to their static placeholder and still render (useful in dev without the backend, and
// resilient if the local daemon is momentarily down).

import type { TFn } from './i18n'
import { MOCK } from './mock'

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

// Hosted-demo mode (Vercel, no backend). When set, reads that fail (they all do without a
// bridge) fall back to a coherent mock dataset so every screen renders fully populated.
// `health()` is deliberately NOT affected, so the "demo/offline" pill still shows.
const DEMO = ENV.VITE_DEMO === '1'
/** True in the hosted demo build: screens should load api data (which falls back to
 *  the coherent mock) even though `health()` is false. */
export const IS_DEMO = DEMO

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
// passphrase is asked again on every fresh entry — that is the intended behaviour).
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
  const h = await getJson<{ status?: string }>('/api/health')
  return h?.status === 'ok'
}

export async function getVault(): Promise<Vault | null> {
  const r = await getJson<{ vault: Vault | null }>(withVault('/api/vault'))
  return r?.vault ?? (DEMO ? MOCK.vault : null)
}

export async function getProposals(): Promise<Proposal[] | null> {
  const r = await getJson<{ proposals: Proposal[] }>(withVault('/api/proposals'))
  return r?.proposals ?? (DEMO ? MOCK.proposals : null)
}

export async function getBalance(): Promise<Balance | null> {
  return (await getJson<Balance>(withVault('/api/balance'))) ?? (DEMO ? MOCK.balance : null)
}

/** Shorten an address for display: `u1vjgx…d406dr`. */
export function shortAddr(addr: string, head = 6, tail = 6): string {
  if (addr.length <= head + tail + 1) return addr
  return `${addr.slice(0, head)}…${addr.slice(-tail)}`
}

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
  if (DEMO) {
    const proposal: Proposal = {
      id: `demo-${Date.now()}`,
      vault_id: 'demo',
      kind: 'payment',
      state: 'awaiting',
      proposer: input.proposer,
      value_zat: Math.round((parseFloat(input.value_zec) || 0) * 1e8),
      value_zec: input.value_zec,
      memo: input.memo,
      to_address: input.to_address,
      is_public: classifyAddress(input.to_address) !== 'unified',
      created_at: Math.floor(Date.now() / 1000),
      approvals: [input.proposer],
      refusals: [],
      approvals_count: 1,
    }
    return { ok: true, proposal }
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
export function isTransparent(addr: string): boolean {
  return classifyAddress(addr) === 'transparent'
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

  if (has('insufficient') || has('saldo')) return t('error.insufficient')
  // A client-side fetch failure surfaces as 'no connection' — match it BEFORE the ceremony
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

/** Every vault known to this device (for the "Meus cofres" home). */
export async function getVaults(): Promise<Vault[] | null> {
  const r = await getJson<{ vaults: Vault[] }>('/api/vaults')
  return r?.vaults ?? (DEMO ? MOCK.vaults : null)
}

/** The full ledger (all proposals, terminal states included) for the Razão screen. */
export async function getLedger(): Promise<Proposal[] | null> {
  const r = await getJson<{ ledger: Proposal[] }>(withVault('/api/ledger'))
  return r?.ledger ?? (DEMO ? MOCK.ledger : null)
}

/** URL of the CSV export the browser downloads (handed to the accountant). */
export function ledgerCsvUrl(): string {
  return `${BASE}${withVault('/api/ledger.csv')}`
}

/** A single proposal by id (proposal detail screen). */
export async function getProposal(id: string): Promise<Proposal | null> {
  const r = await getJson<{ proposal: Proposal }>(`/api/proposals/${encodeURIComponent(id)}`)
  return r?.proposal ?? (DEMO ? MOCK.proposalById(id) : null)
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

export async function getBeneficiaries(): Promise<Beneficiary[] | null> {
  const r = await getJson<{ beneficiaries: Beneficiary[] }>(withVault('/api/beneficiaries'))
  return r?.beneficiaries ?? (DEMO ? MOCK.beneficiaries : null)
}

export async function addBeneficiary(
  name: string, address: string, memo?: string,
): Promise<{ ok: true; beneficiary: Beneficiary } | { ok: false; error: string; detail?: string }> {
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
  const r = await getJson<{ proposal: Proposal; lines: PayrollLine[] }>(`/api/proposals/${encodeURIComponent(id)}`)
  if (!r?.proposal) return DEMO ? MOCK.proposalDetail(id) : null
  return { proposal: r.proposal, lines: r.lines ?? [] }
}

export type SendResult =
  | { ok: true; dryRun: boolean; txid?: string; sighash?: string; proposal?: Proposal }
  | { ok: false; error: string; detail?: string }

/**
 * Run the FROST ceremony for a Ready proposal. `dryRun` signs without broadcasting.
 * No client timeout: the ceremony (create→prove→sign→broadcast) can take 30–60s.
 */
export async function sendProposal(id: string, dryRun: boolean): Promise<SendResult> {
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
    return { ok: false, error: 'falha no envio', detail: String(e) }
  }
}

/** Approve or refuse a proposal on behalf of `member`. */
export async function voteProposal(
  id: string,
  member: string,
  approve: boolean,
): Promise<CreateResult> {
  if (DEMO) {
    const base = MOCK.proposalById(id)
    if (!base) return { ok: false, error: 'not found' }
    const approvals = approve && !base.approvals.includes(member) ? [...base.approvals, member] : base.approvals
    const refusals = !approve && !base.refusals.includes(member) ? [...base.refusals, member] : base.refusals
    const approvals_count = approvals.length
    const state = approve && approvals_count >= MOCK.vault.threshold ? 'ready' : base.state
    return { ok: true, proposal: { ...base, approvals, refusals, approvals_count, state } }
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
