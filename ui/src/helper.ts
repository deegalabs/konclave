import { asEnvelope, openEnvelope, type Opener } from './envelope'
import { ensureWasm } from './wasm-ready'

/** The `kind` the helper stamps on a sealed viewing-key response (#481), matching
 *  `SEALED_UFVK_KIND` in `helper-server`. */
const SEALED_UFVK_KIND = 'konclave-ufvk-sealed'
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

import { readSecretFor } from './session'
import { deriveReadKey } from './vault-secret'
import { bytesToHex } from './bytes'
import type { WriteProof } from './device-key'

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

/** The #388 read token header for a request whose `?vault=<id>` names a vault this device has
 *  UNLOCKED (its access secret S is in memory). Absent otherwise, so an unmigrated or locked vault
 *  simply reads open - the helper keeps the gate open until a readKey is registered. */
async function readAuthHeaders(path: string): Promise<Record<string, string>> {
  const id = /[?&]vault=([0-9a-fA-F]{64})/.exec(path)?.[1]
  if (!id) return {}
  const s = readSecretFor(id)
  if (!s) return {}
  try {
    return { 'X-Konclave-Read': bytesToHex(await deriveReadKey(s)) }
  } catch {
    return {}
  }
}

async function getJson<T>(path: string): Promise<T | null> {
  const base = helperBase()
  if (!base) return null
  try {
    const res = await fetch(`${base}${path}`, { headers: await readAuthHeaders(path) })
    if (!res.ok) return null
    return (await res.json()) as T
  } catch {
    return null
  }
}

/** The reason the last `postJson` failed, when the helper gave one.
 *
 *  `postJson` collapses every failure to `null`, and the callers then invent a reason for the UI.
 *  That is how a 401 came to be shown as "the proposal already changed state, or there is a
 *  conflicting vote" - a sentence about consensus, for a device that simply could not prove it holds
 *  the seat. Wrong on a money screen is worse than silent: it sends someone to look for a conflict
 *  that does not exist.
 *
 *  Rather than change `postJson`'s signature at forty call sites, the last failure is recorded here
 *  and read by the one caller that needs it. Single-threaded and read immediately after the await,
 *  so there is no interleaving to worry about. */
let lastPostFailure: { status: number; error?: string } | null = null

/** The failure from the most recent `postJson`, or null. Cleared by the next call. */
export function lastHelperPostFailure(): { status: number; error?: string } | null {
  return lastPostFailure
}

async function postJson<T>(path: string, body: unknown): Promise<T | null> {
  const base = helperBase()
  lastPostFailure = null
  if (!base) return null
  try {
    const res = await fetch(`${base}${path}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    })
    if (!res.ok) {
      const j = (await res.json().catch(() => null)) as { error?: string } | null
      lastPostFailure = { status: res.status, error: j?.error }
      return null
    }
    return (await res.json()) as T
  } catch {
    return null
  }
}

async function getText(path: string): Promise<string | null> {
  const base = helperBase()
  if (!base) return null
  try {
    const res = await fetch(`${base}${path}`, { headers: await readAuthHeaders(path) })
    if (!res.ok) return null
    return await res.text()
  } catch {
    return null
  }
}

const q = (v: string) => encodeURIComponent(v)

/** A vault's PUBLIC view as the helper returns it (never the UFVK or account).
 *
 *  `change_receiver` is the vault's INTERNAL address (#281). A signing device cannot derive it -
 *  the viewing key it comes from is minted from a random key `zcash-sign` discards - so without it
 *  the money gate reads the change output of every honest payment as an unrecognised destination.
 *  It is an address, the same class of public material as `address`, and grants no viewing power.
 *  Optional and possibly empty: a registration written before the field existed has none, and that
 *  must be read as UNKNOWN, never as "matches nothing". */
export type HelperVault = {
  vault_id: string
  address: string
  threshold?: number
  total?: number
  change_receiver?: string
}

/** Helper liveness: the registered-vault count, or `null` if no/unreachable helper. */
export async function helperHealth(): Promise<{ status?: string } | null> {
  // Liveness only. Health used to carry a vault count; it told any caller how many vaults the
  // helper holds and no client ever read it, so it is gone (#267).
  return getJson<{ status?: string }>('/api/health')
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
/**
 * How long a proposal stays open on the browser-native path: 72 hours, the same deadline the local
 * bridge already uses (`server.rs`) and the one CLAUDE.md §10 documents. Both call sites here used
 * to send `0`, which the helper reads as "never" - so on the web a proposal nobody acted on stayed
 * open forever, and the lifecycle the product describes was one the product did not run.
 */
const PROPOSAL_TTL_SECONDS = 72 * 60 * 60

export async function createProposal(args: {
  vault: string
  proposer: string
  to: string
  amountZat: number
  memo?: string
  expiryUnix?: number
  /** #288: present when this device can sign. Spread like the vote's, so a vault migrates without a
   *  flag day - the helper ignores it while the vault is still open. */
  proof?: WriteProof
}): Promise<Proposal | null> {
  return postJson<Proposal>('/api/vault/proposals', {
    vault: args.vault,
    proposer: args.proposer,
    to: args.to,
    amount_zat: args.amountZat,
    memo: args.memo,
    expiry_unix: args.expiryUnix ?? Math.floor(Date.now() / 1000) + PROPOSAL_TTL_SECONDS,
    ...(args.proof ?? {}),
  })
}

/** The vault's member names (seat order), or `null` if no helper / unknown vault. */
/** Register this device's persistent comms pubkey so the helper can SEAL a SignRequest to it (#63),
 *  keeping recipient + amount off the relay. Idempotent, so it is safe to call on every unlock.
 *  Best-effort: returns null on any failure (a device still signs even if registration did not land;
 *  an unsealed request is the compat fallback until every device has registered). */
export async function registerDeviceKey(
  groupKeyHex: string,
  devicePubHex: string,
  write?: { seat: number; pub: string },
): Promise<boolean | null> {
  const r = await postJson<{ ok: boolean; added: boolean }>('/api/vault/devicekey', {
    group_key: groupKeyHex,
    device_pub: devicePubHex,
    // #288: the seat and its Ed25519 write key travel together or not at all. Sending them turns
    // the vault's write gate ON - from then on every governance write must be signed - so this is
    // only ever sent by a device that can actually sign, i.e. one holding the share.
    ...(write ? { seat: write.seat, write_pub: write.pub } : {}),
  })
  return r ? r.added : null
}

/** Register the vault's #388 readKey (hex of HKDF(S, "read")) with the helper, turning on the read
 *  gate for this vault. Idempotent (same S -> same readKey). Best-effort: returns false on any
 *  failure (a helper without the endpoint just 404s, and the vault stays open until it lands). */
export async function registerReadKey(groupKeyHex: string, readKeyHex: string): Promise<boolean> {
  const r = await postJson<{ ok: boolean }>('/api/vault/readkey', {
    group_key: groupKeyHex,
    read_key: readKeyHex,
  })
  return r?.ok ?? false
}

export async function listMembers(groupKeyHex: string): Promise<string[] | null> {
  return (await getJson<{ members: string[] }>(`/api/vault/members?vault=${q(groupKeyHex)}`))?.members ?? null
}

/** One on-chain transaction the vault's wallet recorded (mined_height null while unconfirmed). */
export type WalletTx = { txid: string; mined_height: number | null }

/** The vault's full on-chain transaction history (newest first), or `null` if unavailable. */
export async function listTransactions(groupKeyHex: string): Promise<WalletTx[] | null> {
  return (await getJson<{ transactions: WalletTx[] }>(`/api/vault/transactions?vault=${q(groupKeyHex)}`))?.transactions ?? null
}

/** Set the vault's member names (seat order); overwrites the list. Returns the saved names or null.
 *  Used once at DKG completion, where every device writes the same self-declared roster. For later
 *  edits use {@link renameMember}, which changes only one seat and migrates that member's votes. */
export async function setMembers(groupKeyHex: string, names: string[]): Promise<string[] | null> {
  return (await postJson<{ members: string[] }>('/api/vault/members', { vault: groupKeyHex, names }))?.members ?? null
}

/** Rename ONE seat (`old` -> `new`) and migrate that member's votes across every proposal, so a
 *  rename never leaves an orphaned "ghost" approver under the old name. Returns the updated roster,
 *  or a `{ error }` reason (unknown seat / name already taken / empty) the UI can surface. */
export async function renameMember(
  groupKeyHex: string,
  old: string,
  next: string,
): Promise<{ members: string[] } | { error: string }> {
  const base = helperBase()
  if (!base) return { error: 'no helper' }
  try {
    // Read the body even on a 400 (postJson drops it) so the specific reason - name taken / unknown
    // seat / empty - reaches the UI instead of a generic failure.
    const res = await fetch(`${base}/api/vault/members/rename`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ vault: groupKeyHex, old, new: next }),
    })
    const data = (await res.json().catch(() => null)) as { members?: string[]; error?: string } | null
    if (res.ok && data?.members) return { members: data.members }
    return { error: data?.error ?? 'rename failed' }
  } catch {
    return { error: 'rename failed' }
  }
}

/** Fetch the vault's ledger (its confirmed, governed payments) as a CSV string, or `null`. */
export async function fetchLedgerCsv(groupKeyHex: string): Promise<string | null> {
  return getText(`/api/vault/ledger.csv?vault=${q(groupKeyHex)}`)
}

/** A payroll beneficiary line (one private shielded output). */
export type PayrollLine = { label?: string; to: string; amount_zat: number; memo?: string }

/** Create a payroll proposal (N beneficiaries, one tx). The helper validates each line. */
export async function createPayroll(args: {
  vault: string
  proposer: string
  lines: PayrollLine[]
  expiryUnix?: number
  /** #288, as on `createProposal`. */
  proof?: WriteProof
}): Promise<Proposal | null> {
  return postJson<Proposal>('/api/vault/payroll', {
    vault: args.vault,
    proposer: args.proposer,
    lines: args.lines.map((l) => ({ label: l.label ?? '', to: l.to, amount_zat: l.amount_zat, memo: l.memo })),
    expiry_unix: args.expiryUnix ?? Math.floor(Date.now() / 1000) + PROPOSAL_TTL_SECONDS,
    ...(args.proof ?? {}),
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
  proof?: WriteProof,
): Promise<Proposal | null> {
  const action = approve ? 'approve' : 'refuse'
  // #288: `proof` is present when this device holds its share unlocked, and the helper requires it
  // once ANY device on the vault has registered a write key. Sent unconditionally when available so
  // a vault migrates without a flag day: the helper ignores it while the vault is still open.
  return postJson<Proposal>(`/api/vault/proposals/${q(proposalId)}/${action}`, {
    vault: groupKeyHex,
    member,
    ...(proof ?? {}),
  })
}

/** The vault's UFVK, for an export that can actually rebuild the vault (#214/#434).
 *
 *  It is a viewing key: it reads the vault's whole history, memos included, and cannot move a coin.
 *  The helper serves it ONLY on an authenticated read, and refuses outright for a vault with no
 *  readKey - so an unprotected vault cannot hand out its viewing key by id alone. `null` covers
 *  every one of those cases, and the caller exports without it rather than failing. */
export async function getUfvk(
  groupKeyHex: string,
  device?: { key: Opener; pubHex: string },
): Promise<{ ufvk: string; birthday?: number } | null> {
  // The scan floor comes back WITH the key, from the same gated call (#480). Two calls would be two
  // chances for a restore path to make only one - which is how the birthday came to be missing from
  // the export while sitting on the helper the whole time.
  const raw = await getJson<unknown>(`/api/vault/ufvk?vault=${q(groupKeyHex)}`)
  if (!raw) return null

  // #481: once the vault has a registered device the helper seals this, so an extension or a
  // TLS-terminating proxy reading the response learns nothing. `device` is what opens it; without
  // one we can still read the plaintext an UNMIGRATED vault returns, which is the compat path that
  // keeps a vault whose members are all on older builds from losing its own viewing key.
  const env = asEnvelope(raw, SEALED_UFVK_KIND)
  let body: unknown = raw
  if (env) {
    if (!device) return null // sealed, and this caller brought no key to open it
    // Belt and braces with the caller (#483): opening goes through WASM, and this is the async
    // boundary where it is needed - so a future caller that forgets still works.
    await ensureWasm()
    const plain = openEnvelope(env, device.key, device.pubHex)
    if (!plain) return null
    try {
      body = JSON.parse(new TextDecoder().decode(plain))
    } catch {
      return null
    }
  }

  const r = body as { ufvk?: unknown; birthday?: unknown }
  if (typeof r.ufvk !== 'string' || !r.ufvk) return null
  return {
    ufvk: r.ufvk,
    birthday: typeof r.birthday === 'number' ? r.birthday : undefined,
  }
}

/** Fetch a registered vault's public view (address + id), or `null`. */
export async function getVault(groupKeyHex: string): Promise<HelperVault | null> {
  return (await getJson<{ vault: HelperVault }>(`/api/vault?vault=${q(groupKeyHex)}`))?.vault ?? null
}

/** A vault's shielded balance (zatoshis) as the helper reports it from its view-only wallet.
 *  Spendable is the combined Orchard (withdrawal-only) + Ironwood pools since NU6.3. */
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
 * Sync + read a registered vault's shielded balance from the helper's view-only wallet. It is a
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
  /** #288: firing a broadcast is a governance write. Bound to the proposal id. */
  proof?: WriteProof
}): Promise<
  | { txid: string | null; dry_run: boolean; state: string }
  | { error: string }
  /** The coordinator did not answer, or gave a gateway error with no reason. The money may have
   *  moved. The caller MUST resolve it against the vault before saying anything (#280). */
  | { unknown: true }
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
        ...(args.proof ?? {}),
      }),
    })
    const data = (await res.json().catch(() => null)) as
      | { txid: string | null; dry_run: boolean; state: string }
      | { error?: string }
      | null
    if (!res.ok) {
      const raw = data && 'error' in data && typeof data.error === 'string' ? data.error : ''
      // A precise helper error names one of the ~7 send stages and is a real failure report: the
      // helper reached that stage and stopped, so nothing was broadcast.
      if (raw) return { error: raw }
      // A gateway status with NO reason is the dangerous case (#280). The helper persists the
      // proposal as `sent` WITH its txid before it replies, and the reply comes after a blocking
      // build+prove+broadcast that routinely outlives a proxy idle timeout. So a bare 502 is at
      // least as likely to mean "it went out and the answer was lost" as "nothing happened". This
      // used to return the sentence "Nothing was sent. Retry in a moment.", which is the exact
      // claim we cannot make - and the retry it invited is a double-spend attempt.
      if (res.status === 502 || res.status === 503 || res.status === 504) return { unknown: true }
      return { error: `HTTP ${res.status}` }
    }
    return data as { txid: string | null; dry_run: boolean; state: string }
  } catch {
    // No response at all. Same reasoning: the request may have been fully served.
    return { unknown: true }
  }
}
