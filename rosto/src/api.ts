// Client for the local bridge (`konclave serve`, ADR-0004). Same-origin `/api/*` in
// production (the bridge serves this bundle); proxied to :4762 in `npm run dev`.
//
// Every call degrades gracefully: on any failure it returns `null` so screens fall back
// to their static placeholder and still render (useful in dev without the backend, and
// resilient if the local daemon is momentarily down).

export type Vault = {
  id: string
  name: string
  threshold: number
  total: number
  members: number
  group_pubkey: string
  orchard_address: string
  ufvk: string
  server_url?: string
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
  expiry_unix?: number
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
  const r = await getJson<{ vault: Vault | null }>('/api/vault')
  return r?.vault ?? null
}

export async function getProposals(): Promise<Proposal[] | null> {
  const r = await getJson<{ proposals: Proposal[] }>('/api/proposals')
  return r?.proposals ?? null
}

export async function getBalance(): Promise<Balance | null> {
  return getJson<Balance>('/api/balance')
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
  try {
    const res = await fetch(`${BASE}/api/proposals`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(input),
    })
    const data = (await res.json().catch(() => ({}))) as Record<string, unknown>
    if (res.status === 201) return { ok: true, proposal: data as unknown as Proposal }
    return { ok: false, error: (data.error as string) ?? `HTTP ${res.status}`, detail: data.detail as string }
  } catch (e) {
    return { ok: false, error: 'sem conexão com o cofre local', detail: String(e) }
  }
}

/** Classify a destination the same way the backend does (for the "público" warning). */
export function isTransparent(addr: string): boolean {
  return addr.startsWith('t1') || addr.startsWith('t3')
}
