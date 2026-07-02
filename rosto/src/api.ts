// Client for the local bridge (`konclave serve`, ADR-0004). Same-origin `/api/*` in
// production (the bridge serves this bundle); proxied to :4762 in `npm run dev`.
//
// Every call degrades gracefully: on any failure it returns `null` so screens fall back
// to their static placeholder and still render (useful in dev without the backend, and
// resilient if the local daemon is momentarily down).

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
  to_address?: string
  is_public: boolean
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
 * Turn a backend error (code + technical detail) into a clear, actionable message in
 * Portuguese (§6.11 "erros legíveis ao humano"). Keeps the raw detail only as a last resort.
 */
export function humanError(error?: string, detail?: string): string {
  const e = (error ?? '').toLowerCase()
  const d = (detail ?? '').toLowerCase()
  const has = (s: string) => e.includes(s) || d.includes(s)

  if (has('insufficient') || has('saldo')) return 'Saldo insuficiente no cofre para este valor (somando a taxa de rede).'
  if (e === 'send failed' || has('connection') || has('frostd') || has('transport') || has('refused') || has('timed out'))
    return 'Não foi possível concluir a cerimônia de assinatura. Verifique se o servidor de coordenação (frostd) está no ar e tente de novo.'
  if (has('signature') || has('apply_signature') || has('share'))
    return 'Uma das partes da chave falhou ao assinar. Confira se os membros do quórum estão disponíveis.'
  if (has('expiry') || has('expired') || e === 'expired') return 'A proposta expirou. Crie uma nova.'
  if (e === 'vote rejected') return 'Este voto não vale agora — a proposta já mudou de estado, ou há um voto conflitante.'
  if (e === 'not ready') return 'A proposta ainda não atingiu o quórum necessário para ser enviada.'
  if (e === 'invalid address' || has('endereço não reconhecido')) return 'Endereço de destino não reconhecido. Confira o endereço Zcash.'
  if (e === 'invalid memo' || has('transparent')) return 'Memo inválido: endereços transparentes (públicos) não aceitam memo.'
  if (e === 'invalid amount') return 'Valor inválido. Use um número em ZEC maior que zero.'
  if (e === 'no vault') return 'Nenhum cofre neste dispositivo ainda.'
  if (e === 'no destination') return 'A proposta está sem endereço de destino.'
  if (e === 'empty payroll' || has('folha sem linhas')) return 'A folha não tem nenhuma linha válida.'
  if (has('sem conexão') || has('failed to fetch')) return 'Sem conexão com o cofre local. O servidor está rodando?'

  // Fallback: a short detail is probably already readable; otherwise a generic message.
  if (detail && detail.length > 0 && detail.length < 140) return detail
  return error && error.length < 140 ? error : 'Ocorreu um erro inesperado.'
}

/** Every vault known to this device (for the "Meus cofres" home). */
export async function getVaults(): Promise<Vault[] | null> {
  const r = await getJson<{ vaults: Vault[] }>('/api/vaults')
  return r?.vaults ?? null
}

/** The full ledger (all proposals, terminal states included) for the Razão screen. */
export async function getLedger(): Promise<Proposal[] | null> {
  const r = await getJson<{ ledger: Proposal[] }>('/api/ledger')
  return r?.ledger ?? null
}

/** URL of the CSV export the browser downloads (handed to the accountant). */
export function ledgerCsvUrl(): string {
  return `${BASE}/api/ledger.csv`
}

/** A single proposal by id (proposal detail screen). */
export async function getProposal(id: string): Promise<Proposal | null> {
  const r = await getJson<{ proposal: Proposal }>(`/api/proposals/${encodeURIComponent(id)}`)
  return r?.proposal ?? null
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
      headers: { 'Content-Type': 'application/json' },
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
    const res = await fetch(`${BASE}/api/payroll`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ proposer, description, lines }),
    })
    const data = (await res.json().catch(() => ({}))) as Record<string, unknown>
    if (res.status === 201) return { ok: true, proposal: data.proposal as Proposal }
    return { ok: false, error: (data.error as string) ?? `HTTP ${res.status}`, detail: data.detail as string }
  } catch (e) {
    return { ok: false, error: 'sem conexão com o cofre local', detail: String(e) }
  }
}

/** Create a vault by DKG (5-F). Long-running: the DKG ceremony takes several seconds. */
export async function createVaultDkg(
  name: string, threshold: number, members: string[],
): Promise<{ ok: true; vault: Vault } | { ok: false; error: string; detail?: string }> {
  try {
    const res = await fetch(`${BASE}/api/vault/dkg`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name, threshold, members }),
    })
    const data = (await res.json().catch(() => ({}))) as Record<string, unknown>
    if (res.status === 201) return { ok: true, vault: data.vault as Vault }
    return { ok: false, error: (data.error as string) ?? `HTTP ${res.status}`, detail: data.detail as string }
  } catch (e) {
    return { ok: false, error: 'sem conexão com o cofre local', detail: String(e) }
  }
}

// ---- beneficiaries (address book) ----

export type Beneficiary = { id: string; name: string; address: string; memo: string; is_public: boolean }

export async function getBeneficiaries(): Promise<Beneficiary[] | null> {
  const r = await getJson<{ beneficiaries: Beneficiary[] }>('/api/beneficiaries')
  return r?.beneficiaries ?? null
}

export async function addBeneficiary(
  name: string, address: string, memo?: string,
): Promise<{ ok: true; beneficiary: Beneficiary } | { ok: false; error: string; detail?: string }> {
  try {
    const res = await fetch(`${BASE}/api/beneficiaries`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name, address, memo }),
    })
    const data = (await res.json().catch(() => ({}))) as Record<string, unknown>
    if (res.status === 201) return { ok: true, beneficiary: data.beneficiary as Beneficiary }
    return { ok: false, error: (data.error as string) ?? `HTTP ${res.status}`, detail: data.detail as string }
  } catch (e) {
    return { ok: false, error: 'sem conexão com o cofre local', detail: String(e) }
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
  if (!r?.proposal) return null
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
      headers: { 'Content-Type': 'application/json' },
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
  try {
    const res = await fetch(`${BASE}/api/proposals/${encodeURIComponent(id)}/${approve ? 'approve' : 'refuse'}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ member }),
    })
    const data = (await res.json().catch(() => ({}))) as Record<string, unknown>
    if (res.ok) return { ok: true, proposal: data.proposal as Proposal }
    return { ok: false, error: (data.error as string) ?? `HTTP ${res.status}`, detail: data.detail as string }
  } catch (e) {
    return { ok: false, error: 'sem conexão com o cofre local', detail: String(e) }
  }
}
