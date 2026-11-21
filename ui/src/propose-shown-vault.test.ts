import { beforeEach, describe, expect, it, vi } from 'vitest'

// A proposal goes to the vault the screen showed, or nowhere. The selection is shared by every tab
// of the browser and read afresh; the screen's own id is the only one a write may use.
const mem = new Map<string, string>()
if (typeof globalThis.localStorage === 'undefined' || !globalThis.localStorage?.setItem) {
  vi.stubGlobal('localStorage', {
    getItem: (k: string) => mem.get(k) ?? null,
    setItem: (k: string, v: string) => void mem.set(k, String(v)),
    removeItem: (k: string) => void mem.delete(k),
    clear: () => mem.clear(),
  })
}
const X = 'a'.repeat(64)
const Y = 'b'.repeat(64)
localStorage.setItem('konclave.coord.mode', 'custom')
localStorage.setItem('konclave.coord.url', 'https://coordinator.invalid')

const signed: { vault: string; target: string; seat: number }[] = []
vi.mock('./device-key', async (orig) => ({
  ...(await orig<typeof import('./device-key')>()),
  signGovernanceWrite: (_kp: Uint8Array, vault: string, _a: string, target: string, seat: number) => {
    signed.push({ vault, target, seat })
    return { proof_seat: seat } as never
  },
}))
vi.mock('./wasm-ready', () => ({ ensureWasm: async () => {} }))

const calls: { url: string; body?: Record<string, unknown> }[] = []
let onMembersRead: (() => void) | null = null
const made = {
  id: 'p1', vault_id: X, kind: 'payment', to: 'u1x', amount_zat: 1000000, memo: null,
  proposer: 'x', state: 'pending', approvals: [], refusals: [], threshold: 2, total: 2,
  created_at_unix: 1, expiry_unix: 0, txid: null,
}
vi.stubGlobal('fetch', async (url: string, init?: RequestInit) => {
  calls.push({ url: String(url), body: init?.body ? JSON.parse(String(init.body)) : undefined })
  if (init?.body) return new Response(JSON.stringify(made), { status: 200 })
  if (String(url).includes('/api/vault/members')) {
    onMembersRead?.()
    return new Response(JSON.stringify({ members: String(url).includes(X) ? ['Ana', 'Bia'] : ['Yara', 'Yuri'] }), { status: 200 })
  }
  return new Response('{}', { status: 404 })
})

const { createProposal, createPayroll, shownVault, setSelectedVault, clearSelectedVault, humanError } = await import('./api')
const { unlockSeatForTest } = await import('./acting-test-support')
const { en } = await import('./i18n/en')
const pay = { proposer: 'Alice', to_address: 'u1x', value_zec: '0.01' }
const lines = [{ address: 'u1x', value_zec: '0.01' }]
const posts = () => calls.filter((c) => c.body)

describe('a proposal goes to the vault the screen showed (T1-T4)', () => {
  beforeEach(() => { calls.length = 0; signed.length = 0; onMembersRead = null; setSelectedVault(X); unlockSeatForTest(X, 2); unlockSeatForTest(Y, 1) })

  it('T1 the selection moved to another vault: nothing is read or sent, and the reason is said', async () => {
    setSelectedVault(Y)
    const a = await createProposal(X, pay)
    const b = await createPayroll(X, 'Alice', lines)
    expect(a).toMatchObject({ ok: false, error: 'vault changed' })
    expect(b).toMatchObject({ ok: false, error: 'vault changed' })
    expect(calls).toHaveLength(0)
    expect(humanError((k) => (en as Record<string, string>)[k] ?? k, 'vault changed')).toBe(en['payment.vaultChanged'])
  })

  it('T2 the pair: with the selection on the shown vault, one POST goes to it', async () => {
    expect(await createProposal(X, pay)).toMatchObject({ ok: true })
    expect(await createPayroll(X, 'Alice', lines)).toMatchObject({ ok: true })
    expect(posts().map((p) => p.body!.vault)).toEqual([X, X])
    expect(posts().map((p) => p.body!.proposer)).toEqual(['Bia', 'Bia'])
  })

  it('T3 a switch DURING the send does not move it: the POST, the name and the proof are the shown vault\'s', async () => {
    for (const make of [() => createProposal(X, pay), () => createPayroll(X, 'Alice', lines)]) {
      calls.length = 0; signed.length = 0
      onMembersRead = () => setSelectedVault(Y)
      setSelectedVault(X)
      expect(await make()).toMatchObject({ ok: true })
      expect(posts()).toHaveLength(1)
      expect(posts()[0]!.body).toMatchObject({ vault: X, proposer: 'Bia' })
      expect(calls.every((c) => !c.url.includes(Y))).toBe(true)
      expect(signed).toEqual([{ vault: X, target: 'Bia', seat: 2 }])
    }
  })

  it('T4 on the web a cleared selection (the vault was removed here) says it is gone; an empty id refuses', async () => {
    clearSelectedVault()
    expect(await createProposal(X, pay)).toMatchObject({ ok: false, error: 'vault gone' })
    expect(await createPayroll(X, 'Alice', lines)).toMatchObject({ ok: false, error: 'vault gone' })
    expect(humanError((k) => (en as Record<string, string>)[k] ?? k, 'vault gone')).toBe(en['payment.vaultGone'])
    expect(en['payment.vaultGone']).not.toBe(en['payment.vaultChanged'])
    setSelectedVault(X)
    expect(await createProposal('', pay)).toMatchObject({ ok: false })
    expect(calls).toHaveLength(0)
  })

  it('shownVault: same, different, none', () => {
    expect(shownVault(X)).toEqual({ ok: true, id: X })
    setSelectedVault(Y)
    expect(shownVault(X)).toEqual({ ok: false })
    clearSelectedVault()
    expect(shownVault(X)).toEqual({ ok: false, gone: true })
    expect(shownVault(null)).toEqual({ ok: false })
  })
})
