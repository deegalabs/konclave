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
export type HelperVault = { vault_id: string; address: string }

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
export async function registerVault(groupKeyHex: string, name: string): Promise<HelperVault | null> {
  const res = await post('/api/vault', { group_key: groupKeyHex, name })
  if (!res || !res.ok) return null
  try {
    return (await res.json()) as HelperVault
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

/** The result of a helper-driven send: a broadcast txid, or `null` txid on a dry-run. */
export type HelperSendResult = { txid: string | null; dry_run: boolean; sighash: string }

/**
 * Ask the helper to drive a spend for `vault`. The helper builds + proves the PCZT and publishes
 * a signing request into `room`; the browsers in that room sign over the relay; the helper injects
 * the aggregate signature and (unless `dryRun`) broadcasts. `dryRun` defaults to TRUE — the caller
 * must pass `false` to actually broadcast, so a single call never fires funds. Returns the outcome,
 * or `null` if no helper is configured or the request is rejected (the helper validates the
 * destination + amount authoritatively before anything runs).
 */
export async function helperSend(args: {
  vault: string
  to: string
  amountZat: number
  memo?: string
  relayBase: string
  room: string
  dryRun?: boolean
}): Promise<HelperSendResult | null> {
  const res = await post('/api/vault/send', {
    vault: args.vault,
    to: args.to,
    amount_zat: args.amountZat,
    memo: args.memo,
    relay_base: args.relayBase,
    room: args.room,
    dry_run: args.dryRun ?? true,
  })
  if (!res || !res.ok) return null
  try {
    return (await res.json()) as HelperSendResult
  } catch {
    return null
  }
}
