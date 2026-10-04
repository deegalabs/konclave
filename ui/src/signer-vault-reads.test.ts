import { describe, expect, it, vi } from 'vitest'

// #610 review. The signer reads the approved lines of its OWN vault, and its panel that vault's
// balance, passing the vault to `getProposalDetail` and `getBalance`; the shared selection is what
// another tab may have switched. signer-per-vault pins that the callers pass their vault, and this
// pins that the callees read from it: with the vault ignored, or with the selection preferred over
// it (`getSelectedVault() ?? vaultId`), the signer compared its payment with another vault's proposal
// (or judged its balance by another vault's) and every other test stayed green.
const opened = 'aa'.repeat(32)
const other = 'bb'.repeat(32)
const asked: string[] = []

const mem = new Map<string, string>()
if (typeof globalThis.localStorage === 'undefined' || !globalThis.localStorage?.setItem) {
  vi.stubGlobal('localStorage', {
    getItem: (k: string) => mem.get(k) ?? null,
    setItem: (k: string, v: string) => void mem.set(k, String(v)),
    removeItem: (k: string) => void mem.delete(k),
    clear: () => mem.clear(),
  })
}
localStorage.setItem('konclave.coord.mode', 'custom')
localStorage.setItem('konclave.coord.url', 'https://coordinator.invalid')
localStorage.setItem('konclave.selectedVault', other) // another tab switched
vi.stubGlobal('fetch', async (url: string) => {
  asked.push(String(url))
  if (String(url).includes('/api/vault/proposals?')) {
    return new Response(JSON.stringify({ proposals: [{ id: 'p1', to: 'u1x', amount_zat: 5, state: 'approved', lines: [], approvals: [], refusals: [] }] }), { status: 200 })
  }
  if (String(url).includes('/api/vault/balance?')) {
    return new Response(JSON.stringify({ total_zat: 7, orchard_spendable_zat: 7, shielded_spendable_zat: 7 }), { status: 200 })
  }
  return new Response('{}', { status: 404 })
})
const api = await import('./api')
const proposalReads = () => asked.filter((u) => u.includes('/api/vault/proposals?'))
const balanceReads = () => asked.filter((u) => u.includes('/api/vault/balance?'))

describe('getProposalDetail reads the vault it is given', () => {
  it('exercises the hosted path', () => {
    expect(api.IS_NET).toBe(true)
  })

  it('reads the named vault even when the selection names another', async () => {
    asked.length = 0
    const d = await api.getProposalDetail('p1', opened)
    expect(proposalReads().length).toBeGreaterThan(0)
    expect(proposalReads().every((u) => u.includes(`vault=${opened}`))).toBe(true)
    expect(d?.proposal.id).toBe('p1')
  })

  it('reads the selection when no vault is named', async () => {
    asked.length = 0
    await api.getProposalDetail('p1')
    expect(proposalReads().length).toBeGreaterThan(0)
    expect(proposalReads().every((u) => u.includes(`vault=${other}`))).toBe(true)
  })
})

describe('getBalance reads the vault it is given', () => {
  it('reads the named vault even when the selection names another', async () => {
    asked.length = 0
    const b = await api.getBalance(opened)
    expect(balanceReads().length).toBe(1)
    expect(balanceReads()[0]).toContain(`vault=${opened}`)
    expect(b?.spendable_zat).toBe(7)
  })

  it('reads the selection when no vault is named', async () => {
    asked.length = 0
    await api.getBalance()
    expect(balanceReads().length).toBe(1)
    expect(balanceReads()[0]).toContain(`vault=${other}`)
  })
})
