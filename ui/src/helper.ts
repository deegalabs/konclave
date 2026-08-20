// Client for the hosted BLIND helper (orchestrator/src/helper.rs + helper-server, ADR-0006
// Rung A). The helper turns a browser-DKG group key into an operable vault: it derives the
// vault's Orchard address + UFVK (public material only), keeps a view-only wallet per vault,
// and - over Architecture B - builds/proves/broadcasts a spend while the browsers sign over the
// blind relay. It NEVER receives, derives, or stores a share. So this client only ever sends the
// PUBLIC group key (already shown on `/net`) and public send parameters; no secret crosses it.
//
// `VITE_HELPER_BASE` points at the hosted helper (e.g. https://konclave-helper-production.up.
// railway.app). When unset, every call degrades to `null` and `/net` stays a pure two-device
// ceremony with no hosted vault - the local-first path is unchanged.

const ENV = import.meta.env as Record<string, string | undefined>

/** The BUILT-IN hosted helper's base URL ("our helper"), or '' when none is baked in. */
export const HELPER_BASE: string = ENV.VITE_HELPER_BASE ?? ''

// Coordination mode - the user's runtime choice of WHERE the blind helper lives (desktop):
//   'ours'   → the built-in HELPER_BASE (default when one is baked in)
//   'custom' → a self-hosted helper URL the user provides
//   'local'  → no helper at all (pure local orchestrator/bridge)
// Persisted per device. The helper stays BLIND in every mode - it never sees a share; switching
// modes only changes which blind coordinator (or none) the browser talks to.
export type CoordMode = 'ours' | 'custom' | 'local'
const MODE_KEY = 'konclave.coord.mode'
const URL_KEY = 'konclave.coord.url'

function ls(key: string): string | null {
  try { return localStorage.getItem(key) } catch { return null }
}

/** The chosen coordination mode; defaults to 'ours' when a helper is baked in, else 'local'. */
export function getCoordMode(): CoordMode {
  const m = ls(MODE_KEY)
  if (m === 'ours' || m === 'custom' || m === 'local') return m
  return HELPER_BASE ? 'ours' : 'local'
}

/** The user-provided self-hosted helper URL (for 'custom' mode), trailing slash trimmed. */
export function getCustomHelper(): string {
  return (ls(URL_KEY) ?? '').trim().replace(/\/+$/, '')
}

/** Persist the coordination choice. Callers reload so `netMode` recomputes app-wide. */
export function setCoordMode(mode: CoordMode, url?: string): void {
  try {
    localStorage.setItem(MODE_KEY, mode)
    if (url !== undefined) localStorage.setItem(URL_KEY, url.trim().replace(/\/+$/, ''))
  } catch { /* storage unavailable - the choice won't persist, but applies this session */ }
}

/** The EFFECTIVE helper base for the current mode, or '' when local / unset. */
export function helperBase(): string {
  const mode = getCoordMode()
  if (mode === 'local') return ''
  if (mode === 'custom') return getCustomHelper()
  return HELPER_BASE
}

/** True when a hosted helper is in effect (so `/net` can offer the full-vault path). */
export function helperConfigured(): boolean {
  return helperBase() !== ''
}

// ---- request helpers (one place for fetch + ok-check + parse, degrading to null) ----

async function getJson<T>(path: string): Promise<T | null> {
  const base = helperBase()
  if (!base) return null
  try {
    const res = await fetch(`${base}${path}`)
    if (!res.ok) return null
    return (await res.json()) as T
  } catch {
    return null
  }
}

async function postJson<T>(path: string, body: unknown): Promise<T | null> {
  const base = helperBase()
  if (!base) return null
  try {
    const res = await fetch(`${base}${path}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    })
    if (!res.ok) return null
    return (await res.json()) as T
  } catch {
    return null
  }
}

async function getText(path: string): Promise<string | null> {
  const base = helperBase()
  if (!base) return null
  try {
    const res = await fetch(`${base}${path}`)
    if (!res.ok) return null
    return await res.text()
  } catch {
    return null
  }
}

const q = (v: string) => encodeURIComponent(v)

/** A vault's PUBLIC view as the helper returns it (never the UFVK or account). */
export type HelperVault = { vault_id: string; address: string; threshold?: number; total?: number }

/** Helper liveness: the registered-vault count, or `null` if no/unreachable helper. */
export async function helperHealth(): Promise<{ vaults: number } | null> {
  return getJson<{ vaults: number }>('/api/health')
}

/**
 * Register the just-created browser-DKG vault with the helper by its group key. The helper
 * derives the Orchard address + a view-only wallet; it gets NO share. Idempotent: registering a
 * known group key returns the same vault without re-running the tooling. Returns the vault's
 * public view, or `null` if no helper is configured or the call fails. threshold/total come from
 * the DKG so proposals inherit the quorum (a proposer cannot spoof a lower one).
 */
export async function registerVault(
  groupKeyHex: string,
  name: string,
  threshold = 0,
  total = 0,
): Promise<HelperVault | null> {
  return postJson<HelperVault>('/api/vault', { group_key: groupKeyHex, name, threshold, total })
}

/** A payment proposal on a browser-native vault, as the helper stores it. All public. */
export type Proposal = {
  id: string
  vault_id: string
  kind?: string // payment | payroll
  to: string
  amount_zat: number
  memo?: string | null
  lines?: { label?: string; to: string; amount_zat: number; memo?: string | null }[]
  proposer: string
  state: string // pending | ready | sent | refused | expired
  approvals: string[]
  refusals: string[]
  threshold: number
  total: number
  created_at_unix: number
  expiry_unix: number
  txid?: string | null
}

/** Create a payment proposal. The helper validates the destination + amount authoritatively. */
export async function createProposal(args: {
  vault: string
  proposer: string
  to: string
  amountZat: number
  memo?: string
  expiryUnix?: number
}): Promise<Proposal | null> {
  return postJson<Proposal>('/api/vault/proposals', {
    vault: args.vault,
    proposer: args.proposer,
    to: args.to,
    amount_zat: args.amountZat,
    memo: args.memo,
    expiry_unix: args.expiryUnix ?? 0,
  })
}

/** The vault's member names (seat order), or `null` if no helper / unknown vault. */
export async function listMembers(groupKeyHex: string): Promise<string[] | null> {
  return (await getJson<{ members: string[] }>(`/api/vault/members?vault=${q(groupKeyHex)}`))?.members ?? null
}

/** Set the vault's member names (seat order); overwrites the list. Returns the saved names or null. */
export async function setMembers(groupKeyHex: string, names: string[]): Promise<string[] | null> {
  return (await postJson<{ members: string[] }>('/api/vault/members', { vault: groupKeyHex, names }))?.members ?? null
}

/** Fetch the vault's ledger (its confirmed, governed payments) as a CSV string, or `null`. */
export async function fetchLedgerCsv(groupKeyHex: string): Promise<string | null> {
  return getText(`/api/vault/ledger.csv?vault=${q(groupKeyHex)}`)
}

/** A payroll beneficiary line (one private Orchard output). */
export type PayrollLine = { label?: string; to: string; amount_zat: number; memo?: string }

/** Create a payroll proposal (N beneficiaries, one tx). The helper validates each line. */
export async function createPayroll(args: {
  vault: string
  proposer: string
  lines: PayrollLine[]
  expiryUnix?: number
}): Promise<Proposal | null> {
  return postJson<Proposal>('/api/vault/payroll', {
    vault: args.vault,
    proposer: args.proposer,
    lines: args.lines.map((l) => ({ label: l.label ?? '', to: l.to, amount_zat: l.amount_zat, memo: l.memo })),
    expiry_unix: args.expiryUnix ?? 0,
  })
}

/** List a vault's proposals (newest first), or `null` if no helper / unknown vault. */
export async function listProposals(groupKeyHex: string): Promise<Proposal[] | null> {
  return (await getJson<{ proposals: Proposal[] }>(`/api/vault/proposals?vault=${q(groupKeyHex)}`))?.proposals ?? null
}

/**
 * Record an approve/refuse vote. This is SOCIAL coordination on the public helper (unauthenticated
 * in this iteration); the real money gate stays the FROST ceremony, which needs `threshold` real
 * browser shares. Returns the updated proposal, or `null` on failure (e.g. 409 if already terminal).
 */
export async function voteProposal(
  groupKeyHex: string,
  proposalId: string,
  member: string,
  approve: boolean,
): Promise<Proposal | null> {
  const action = approve ? 'approve' : 'refuse'
  return postJson<Proposal>(`/api/vault/proposals/${q(proposalId)}/${action}`, { vault: groupKeyHex, member })
}

/** Fetch a registered vault's public view (address + id), or `null`. */
export async function getVault(groupKeyHex: string): Promise<HelperVault | null> {
  return (await getJson<{ vault: HelperVault }>(`/api/vault?vault=${q(groupKeyHex)}`))?.vault ?? null
}

/** A vault's Orchard balance (zatoshis) as the helper reports it from its view-only wallet. */
export type HelperBalance = {
  orchard_spendable_zat: number
  // Since NU6.3 the spendable funds live in the Ironwood pool; the helper reports both and the
  // combined shielded_spendable_zat. Optional so an older helper (orchard + total only) still parses.
  ironwood_spendable_zat?: number
  shielded_spendable_zat?: number
  chain_tip_height?: number
  total_zat: number
}

/**
 * Sync + read a registered vault's Orchard balance from the helper's view-only wallet. It is a
 * watcher's read (the helper holds the UFVK, never a share). Slow (the helper syncs against
 * lightwalletd first). Returns `null` if no helper is configured or the vault is unknown.
 */
export async function vaultBalance(groupKeyHex: string): Promise<HelperBalance | null> {
  return getJson<HelperBalance>(`/api/vault/balance?vault=${q(groupKeyHex)}`)
}

/** One recorded signing ceremony (ZecSafe-inspired reproducible evidence). All public. */
export type CeremonyRecord = {
  vault_id: string
  sighash: string
  signatures: string[]
  txid: string | null
  dry_run: boolean
  created_at_unix: number
}

/** The vault's ceremony trail (oldest first), or `null` if no helper / unknown vault. */
export async function vaultCeremonies(groupKeyHex: string): Promise<CeremonyRecord[] | null> {
  return (await getJson<{ ceremonies: CeremonyRecord[] }>(`/api/vault/ceremonies?vault=${q(groupKeyHex)}`))?.ceremonies ?? null
}

/**
 * Execute a READY proposal: the helper builds the PCZT for the proposal's payment, the browsers in
 * `room` sign over the relay, and (unless `dryRun`) the helper broadcasts and marks the proposal
 * `sent` with its txid. `dryRun` defaults TRUE so a broadcast is always an explicit choice. Returns
 * the outcome (with the proposal's new `state`), or `null` on failure (e.g. 409 if not ready).
 */
export async function executeProposal(args: {
  vault: string
  proposalId: string
  relayBase: string
  room: string
  dryRun?: boolean
}): Promise<
  | { txid: string | null; dry_run: boolean; state: string }
  | { error: string }
  | null
> {
  // A send can fail at any of ~7 stages (build/prove/sign/inject/broadcast); the helper returns a
  // precise `{error}` with an accurate status. We read that body instead of collapsing every
  // failure to null, so the UI can show WHY (CLAUDE.md §6.11, §11) instead of a generic guess.
  const base = helperBase()
  if (!base) return null
  try {
    const res = await fetch(`${base}/api/vault/proposals/${q(args.proposalId)}/send`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        vault: args.vault,
        relay_base: args.relayBase,
        room: args.room,
        dry_run: args.dryRun ?? true,
      }),
    })
    const data = (await res.json().catch(() => null)) as
      | { txid: string | null; dry_run: boolean; state: string }
      | { error?: string }
      | null
    if (!res.ok) {
      const msg =
        data && 'error' in data && typeof data.error === 'string' ? data.error : `HTTP ${res.status}`
      return { error: msg }
    }
    return data as { txid: string | null; dry_run: boolean; state: string }
  } catch {
    return null // could not reach the coordinator at all
  }
}
