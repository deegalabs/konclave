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
  lastHelperPostFailure,
  voteProposal as netVote,
  listMembers as netListMembers,
  setMembers as netSetMembers,
  renameMember as netRenameMember,
  listTransactions as netListTransactions,
  type WalletTx,
  type Proposal as NetProposal,
} from './helper'
import { fmtZecExact, zatToZec, parseZecToZat } from './format'
import type { FailureCode } from './background-session'
import { listVaults, updateVaultMeta } from './storage'
import { getUnlockedShare, setUnlockedShare } from './session'
import { signGovernanceWrite, type WriteProof } from './device-key'
import { ensureWasm } from './wasm-ready'
import { decodeBundle } from './signing'

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
  // #388: whether this vault holds the per-vault secret S (reads + signing room gated). undefined
  // when unknown (e.g. a bridge/local vault); false = a legacy/open vault a leaked id can read.
  secured?: boolean
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

/** Write the helper's address into a local record that has none. Idempotent and silent.
 *
 *  Separate from `getVault` so the condition is testable without a network: the bug it repairs was
 *  a literal `address: ''` that nothing ever revisited, and the repair must not become the same
 *  kind of thing - a branch nobody can exercise. */
export async function backfillAddress(id: string, address: string): Promise<boolean> {
  try {
    const rec = (await listVaults()).find((v) => v.id === id)
    if (!rec || (rec.address ?? '').trim()) return false
    await updateVaultMeta(id, { address })
    return true
  } catch {
    return false
  }
}

export async function getVault(): Promise<Vault | null> {
  if (NET) {
    const id = getSelectedVault()
    if (!id) return null
    const v = await netGetVault(id)
    if (!v) return null
    const total = v.total ?? 0
    // The device's own record, read once: it carries both the vault's name and its roster.
    let rec: { name?: string; roster?: string[] } | undefined
    try {
      rec = (await listVaults()).find((s) => s.id === id)
    } catch { /* local-bridge mode / no on-device record */ }

    // Members, in seat order. THREE sources, and the order matters: the helper's list, then this
    // device's own roster, then a placeholder.
    //
    // The roster used to be skipped, so any failure to read the helper's list - a 401 before the
    // vault is unlocked, an offline moment - turned every signer in the ceremony drawer into
    // "member 1", "member 2". The device knew their names the whole time: identity in this product
    // IS the name, seats are positional, and that roster is what the create/join ceremony agreed on.
    // Showing a placeholder while holding the answer is worse than a stale name.
    const names = (await netListMembers(id)) ?? []
    const local = rec?.roster ?? []
    const member_list = Array.from({ length: total }, (_, i) => {
      const name =
        (names[i] && names[i].trim()) ||
        (local[i] && local[i].trim()) ||
        `member ${i + 1}`
      return { name, pubkey: name }
    })
    // The vault's real name is the one the operator chose at create/join, kept on this device.
    // Use it instead of a generic 'Networked vault' label; fall back only when there is no record.
    const vaultName = rec?.name && rec.name.trim() ? rec.name : 'Vault'
    // Heal a record written before the create screen recorded the address (#501). Those hold `''`
    // forever: `saveVault` runs only at creation, so nothing revisits them, and the device cannot
    // re-derive an address - `zcash-sign` mints it from a random `sk` it discards. The helper is the
    // only other place it exists, and this call already has it in hand.
    //
    // Fire-and-forget on purpose: it is one IndexedDB write, once, on a screen that must not wait
    // for it, and a vault that never opens a screen loses nothing it had.
    if (v.address) void backfillAddress(id, v.address)
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
      chain_tip_height: b.chain_tip_height,
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
/** The #288 proof for a governance write, when this device can make one.
 *
 *  Signing must never take away the ability to act: a locked device, or one that does not hold this
 *  vault's share, returns `undefined` and the write goes unsigned. The helper still accepts that
 *  while the vault has no registered write key (ADR-0011 D5), so nobody is blocked by this arriving
 *  - only by their vault having migrated while their device has not unlocked.
 *
 *  One function rather than the same twelve lines at each call site: there are four writes now
 *  (vote, rename, propose, send), and this repo's dominant defect is one rule written several times
 *  with only some copies updated.
 */
export async function writeProof(
  vaultId: string,
  action: 'approve' | 'refuse' | 'rename' | 'propose' | 'send',
  target: string,
): Promise<WriteProof | undefined> {
  const share = getUnlockedShare(vaultId)
  if (!share) return undefined
  try {
    // `signGovernanceWrite` calls into WASM, and nothing on a proposal screen had loaded it. The
    // call threw, the catch below swallowed it, the vote went out unsigned, and the helper answered
    // "this vault requires a signed vote" - which is true and tells the member nothing they can act
    // on. #483 put loading in one place for exactly this reason; signing was the path that still
    // had none.
    await ensureWasm()
    const b = decodeBundle(share)
    return signGovernanceWrite(b.keyPackage, vaultId, action, target, b.seat)
  } catch (e) {
    // Still non-fatal - an unsigned write is refused by a migrated vault and accepted by an open
    // one, which is the right shape - but no longer INVISIBLE. A silent catch here cost a live
    // vault an afternoon, because the failure was indistinguishable from a locked device.
    console.error('[konclave] could not sign a governance write', { action, vaultId, error: e })
    return undefined
  }
}

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
      // Bound to the proposer's name, which the helper checks against the signing seat (#288).
      proof: await writeProof(id, 'propose', input.proposer.trim()),
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
/**
 * A coarse reason a failure can be told to the OTHER devices. Never the message: that names the
 * vault's balance, and the relay reads every body it carries. This says enough for each device to
 * write its own sentence, and tells the relay nothing the silence after a failed ceremony would not.
 */
export function errorCode(error?: string, detail?: string): FailureCode {
  const s = `${error ?? ''} ${detail ?? ''}`.toLowerCase()
  if (s.includes('insufficient') || s.includes('funds')) return 'funds'
  if (s.includes('over capacity') || s.includes('restarting') || s.includes('http 5')) return 'coordinator'
  if (s.includes('timed out') || s.includes('signature') || s.includes('share') || s.includes('relay')) return 'ceremony'
  return 'unknown'
}

/**
 * How many confirmations a note needs before the wallet will spend it. Not our choice: it is
 * `ConfirmationsPolicy::default()` in zcash_client_backend (data_api/wallet.rs:450-461), and we
 * never pass `--min-confirmations`, so the default is what every vault gets.
 *
 * There are two numbers, and the difference is worth showing: money that arrived from OUTSIDE is
 * untrusted and waits 10; the change from the vault's own payment is trusted and waits 3.
 */
export const CONFIRMATIONS_UNTRUSTED = 10
export const CONFIRMATIONS_TRUSTED = 3

export function humanError(t: TFn, error?: string, detail?: string): string {
  const e = (error ?? '').toLowerCase()
  const d = (detail ?? '').toLowerCase()
  const has = (s: string) => e.includes(s) || d.includes(s)

  // The engine reports the two figures that decide it. Pass them through: "the vault has X and this
  // needs Y" is actionable, where a generic "insufficient funds" leaves you guessing by how much -
  // and the gap is usually the fee, which is exactly the part nobody can compute in their head.
  // The helper now refuses an unfundable proposal up front (422) with the figures already parsed,
  // so prefer those; the regex below still reads them out of a raw engine error further down the
  // path, where nobody has parsed anything yet.
  const funds = /available_zat"?\s*[:=]\s*(\d+)[\s\S]*?required_zat"?\s*[:=]\s*(\d+)/i.exec(`${error ?? ''} ${detail ?? ''}`)
    ?? /available:\s*Zatoshis\((\d+)\)[\s\S]*?required:\s*Zatoshis\((\d+)\)/i.exec(`${error ?? ''} ${detail ?? ''}`)
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
  if (e === 'write not authorized') return t('error.writeNotAuthorized')
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
    const p = await netCreatePayroll({ vault: id, proposer, lines: mapped, proof: await writeProof(id, 'propose', proposer.trim()) })
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
    // #288: sign the vote when this device holds its share unlocked. Absent (locked, or a vault
    // whose share is not on this device) the vote goes unsigned, which the helper still accepts
    // while the vault has no registered write key. So a member is never blocked by this arriving;
    // they are blocked only if their vault HAS migrated and their device has not unlocked.
    // One signer for every governance write (#288): it ensures the WASM, signs, and returns
    // undefined only when this device genuinely cannot - locked, or holding no share for this
    // vault. The old version wrapped a bare `signGovernanceWrite` in a silent catch, so a WASM
    // module that had never been loaded looked exactly like a locked device.
    const proof = await writeProof(vid, approve ? 'approve' : 'refuse', id)
    const p = await netVote(vid, id, member, approve, proof)
    if (p) return { ok: true, proposal: mapNetProposal(p) }
    // Not every failure is a conflict, and saying so when it is not sends the member looking for a
    // vote that does not exist. A 401 here means this device could not prove it holds the seat:
    // it is locked, or it never registered a write key for its seat on this vault (#288).
    const f = lastHelperPostFailure()
    if (f?.status === 401) return { ok: false, error: 'write not authorized' }
    return { ok: false, error: 'vote rejected' }
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
