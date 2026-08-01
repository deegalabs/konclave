// Client for the hosted BLIND helper (orchestrator/src/helper.rs + helper-server, ADR-0006
// Rung A). The helper turns a browser-DKG group key into an operable vault: it derives the
// vault's Orchard address + UFVK (public material only), keeps a view-only wallet per vault,
// and — over Architecture B — builds/proves/broadcasts a spend while the browsers sign over the
// blind relay. It NEVER receives, derives, or stores a share. So this client only ever sends the
// PUBLIC group key (already shown on `/net`) and public send parameters; no secret crosses it.
//
// `VITE_HELPER_BASE` points at the hosted helper (e.g. https://konclave-helper-production.up.
// railway.app). When unset, every call degrades to `null` and `/net` stays a pure two-device
// ceremony with no hosted vault — the local-first path is unchanged.

const ENV = import.meta.env as Record<string, string | undefined>

/** The hosted helper's base URL, or '' when no helper is configured. */
export const HELPER_BASE: string = ENV.VITE_HELPER_BASE ?? ''

/** True when a hosted helper is configured (so `/net` can offer the full-vault path). */
export function helperConfigured(): boolean {
  return HELPER_BASE !== ''
}

/** A vault's PUBLIC view as the helper returns it (never the UFVK or account). */
export type HelperVault = { vault_id: string; address: string; threshold?: number; total?: number }

async function post(path: string, body: unknown): Promise<Response | null> {
  if (!HELPER_BASE) return null
  try {
    return await fetch(`${HELPER_BASE}${path}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    })
  } catch {
    return null
  }
}

async function get(path: string): Promise<Response | null> {
  if (!HELPER_BASE) return null
  try {
    return await fetch(`${HELPER_BASE}${path}`)
  } catch {
    return null
  }
}

/** Helper liveness: the registered-vault count, or `null` if no/unreachable helper. */
export async function helperHealth(): Promise<{ vaults: number } | null> {
  const res = await get('/api/health')
  if (!res || !res.ok) return null
  try {
    return (await res.json()) as { vaults: number }
  } catch {
    return null
  }
}

/**
 * Register the just-created browser-DKG vault with the helper by its group key. The helper
 * derives the Orchard address + a view-only wallet; it gets NO share. Idempotent: registering a
 * known group key returns the same vault without re-running the tooling. Returns the vault's
 * public view, or `null` if no helper is configured or the call fails.
 */
export async function registerVault(
  groupKeyHex: string,
  name: string,
  threshold = 0,
  total = 0,
): Promise<HelperVault | null> {
  // threshold/total come from the DKG (the browser knows t/n); the helper stores them as the
  // vault's approval quorum so proposals inherit it (a proposer cannot spoof a lower quorum).
  const res = await post('/api/vault', { group_key: groupKeyHex, name, threshold, total })
  if (!res || !res.ok) return null
  try {
    return (await res.json()) as HelperVault
  } catch {
    return null
  }
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
  const res = await post('/api/vault/proposals', {
    vault: args.vault,
    proposer: args.proposer,
    to: args.to,
    amount_zat: args.amountZat,
    memo: args.memo,
    expiry_unix: args.expiryUnix ?? 0,
  })
  if (!res || !res.ok) return null
  try {
    return (await res.json()) as Proposal
  } catch {
    return null
  }
}

/** The vault's member names (seat order), or `null` if no helper / unknown vault. */
export async function listMembers(groupKeyHex: string): Promise<string[] | null> {
  const res = await get(`/api/vault/members?vault=${encodeURIComponent(groupKeyHex)}`)
  if (!res || !res.ok) return null
  try {
    return ((await res.json()) as { members: string[] }).members
  } catch {
    return null
  }
}

/** Set the vault's member names (seat order); overwrites the list. Returns the saved names or null. */
export async function setMembers(groupKeyHex: string, names: string[]): Promise<string[] | null> {
  const res = await post('/api/vault/members', { vault: groupKeyHex, names })
  if (!res || !res.ok) return null
  try {
    return ((await res.json()) as { members: string[] }).members
  } catch {
    return null
  }
}

/** Fetch the vault's ledger (its confirmed, governed payments) as a CSV string, or `null`. */
export async function fetchLedgerCsv(groupKeyHex: string): Promise<string | null> {
  const res = await get(`/api/vault/ledger.csv?vault=${encodeURIComponent(groupKeyHex)}`)
  if (!res || !res.ok) return null
  try {
    return await res.text()
  } catch {
    return null
  }
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
  const res = await post('/api/vault/payroll', {
    vault: args.vault,
    proposer: args.proposer,
    lines: args.lines.map((l) => ({
      label: l.label ?? '',
      to: l.to,
      amount_zat: l.amount_zat,
      memo: l.memo,
    })),
    expiry_unix: args.expiryUnix ?? 0,
  })
  if (!res || !res.ok) return null
  try {
    return (await res.json()) as Proposal
  } catch {
    return null
  }
}

/** List a vault's proposals (newest first), or `null` if no helper / unknown vault. */
export async function listProposals(groupKeyHex: string): Promise<Proposal[] | null> {
  const res = await get(`/api/vault/proposals?vault=${encodeURIComponent(groupKeyHex)}`)
  if (!res || !res.ok) return null
  try {
    return ((await res.json()) as { proposals: Proposal[] }).proposals
  } catch {
    return null
  }
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
  const res = await post(`/api/vault/proposals/${encodeURIComponent(proposalId)}/${action}`, {
    vault: groupKeyHex,
    member,
  })
  if (!res || !res.ok) return null
  try {
    return (await res.json()) as Proposal
  } catch {
    return null
  }
}

/** Fetch a registered vault's public view (address + id), or `null`. */
export async function getVault(groupKeyHex: string): Promise<HelperVault | null> {
  const res = await get(`/api/vault?vault=${encodeURIComponent(groupKeyHex)}`)
  if (!res || !res.ok) return null
  try {
    return ((await res.json()) as { vault: HelperVault }).vault
  } catch {
    return null
  }
}

/** A vault's Orchard balance (zatoshis) as the helper reports it from its view-only wallet. */
export type HelperBalance = { orchard_spendable_zat: number; total_zat: number }

/**
 * Sync + read a registered vault's Orchard balance from the helper's view-only wallet. It is a
 * watcher's read (the helper holds the UFVK, never a share). Slow (the helper syncs against
 * lightwalletd first). Returns `null` if no helper is configured or the vault is unknown.
 */
export async function vaultBalance(groupKeyHex: string): Promise<HelperBalance | null> {
  const res = await get(`/api/vault/balance?vault=${encodeURIComponent(groupKeyHex)}`)
  if (!res || !res.ok) return null
  try {
    return (await res.json()) as HelperBalance
  } catch {
    return null
  }
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
  const res = await get(`/api/vault/ceremonies?vault=${encodeURIComponent(groupKeyHex)}`)
  if (!res || !res.ok) return null
  try {
    return ((await res.json()) as { ceremonies: CeremonyRecord[] }).ceremonies
  } catch {
    return null
  }
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
}): Promise<{ txid: string | null; dry_run: boolean; state: string } | null> {
  const res = await post(`/api/vault/proposals/${encodeURIComponent(args.proposalId)}/send`, {
    vault: args.vault,
    relay_base: args.relayBase,
    room: args.room,
    dry_run: args.dryRun ?? true,
  })
  if (!res || !res.ok) return null
  try {
    return (await res.json()) as { txid: string | null; dry_run: boolean; state: string }
  } catch {
    return null
  }
}

