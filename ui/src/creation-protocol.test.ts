import { describe, expect, it, vi } from 'vitest'
import { codeOf } from './source-scan'

// An outdated cached app still runs the pre-v0.12.0 creation flow. The coordinator will refuse a
// registration that does not name the creation protocol it was made with; this is the client half:
// every registration carries it, the number exists once, and a client the coordinator calls outdated
// says so instead of sitting on "Registering the vault...".
const sent: { url: string; body: unknown }[] = []
let healthBody: unknown = { status: 'ok' }
let registerAnswer: () => Response = () => new Response(JSON.stringify({ vault: { id: 'x', address: 'u1x', threshold: 2, total: 2 } }), { status: 200 })

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
vi.stubGlobal('fetch', async (url: string, init?: { body?: string }) => {
  sent.push({ url: String(url), body: init?.body ? JSON.parse(init.body) : null })
  if (String(url).endsWith('/api/health')) return new Response(JSON.stringify(healthBody), { status: 200 })
  if (String(url).endsWith('/api/vault')) return registerAnswer()
  return new Response(JSON.stringify({ vault: { id: 'x', address: 'u1x' } }), { status: 200 })
})
const helper = await import('./helper')
const { CREATION_PROTOCOL, creationAllowed, isUpdateRequired, protocolOfRecord } = await import('./creation-protocol')
const { DKG_VERSION } = await import('./dkg-ceremony')

describe('every registration names its creation protocol', () => {
  it('the number is 2, the v0.12.0 creation core, and the ceremony speaks the same one', () => {
    expect(CREATION_PROTOCOL).toBe(2)
    expect(DKG_VERSION).toBe(CREATION_PROTOCOL)
    expect(codeOf('./dkg-ceremony.ts')).toMatch(/export const DKG_VERSION = CREATION_PROTOCOL/)
    expect(codeOf('./net.ts')).toMatch(/`konclave-room-v\$\{CREATION_PROTOCOL\}\\u0000\$\{code\}\\u0000\$\{p\}`/)
  })
  it('registerVault sends cp itself', async () => {
    sent.length = 0
    await helper.registerVault('aa'.repeat(32), 'v', 2, 2, 2)
    const reg = sent.find((s) => s.url.endsWith('/api/vault'))
    expect(reg?.body).toMatchObject({ cp: CREATION_PROTOCOL })
    expect(reg?.body).not.toHaveProperty('cv')
  })
  it('the vault read names the protocol the VAULT was made with, never the app\'s', async () => {
    sent.length = 0
    await helper.getVault('aa'.repeat(32), 2)
    expect(sent[0]?.url).toMatch(/\/api\/vault\?vault=a+&cp=2$/)
    sent.length = 0
    await helper.getVault('aa'.repeat(32))
    expect(sent[0]?.url).toMatch(/\/api\/vault\?vault=a+$/)
    // The app passes the device's record of the vault, read before asking the coordinator.
    const api = codeOf('./api.ts')
    expect(api).toMatch(/rec = \(await listVaults\(\)\)\.find\(\(s\) => s\.id === id\)[\s\S]{0,200}const v = await netGetVault\(id, rec \? protocolOfRecord\(rec\) : undefined\)/)
    // And a creation records it when it saves the vault.
    expect(codeOf('./screens/NetVault.tsx')).toMatch(/saveVault\(vaultId, \{[^}]*cp: CREATION_PROTOCOL[^}]*\}, savePass\)/)
  })
  // The single-caller pin moved to conclude-registration.test.ts, where the one caller now lives.
  it('registerVault sends the protocol it is GIVEN, not the app\'s', async () => {
    sent.length = 0
    await helper.registerVault('dd'.repeat(32), 'v', 2, 2, 1)
    expect(sent.find((s) => s.url.endsWith('/api/vault'))?.body).toMatchObject({ cp: 1 })
  })
})

describe('the protocol a vault was made with, from the device record', () => {
  it('the recorded one, or 2 for a record that keeps the confirmed quorum (v0.12.0 made those and spoke 2)', () => {
    expect(protocolOfRecord({ cp: 2 })).toBe(2)
    expect(protocolOfRecord({ threshold: 2, total: 3 })).toBe(2)
    // The old flow kept no quorum and no protocol: it reads as before, with none.
    expect(protocolOfRecord({})).toBeUndefined()
  })
  it('the vault read uses it', () => {
    expect(codeOf('./api.ts')).toMatch(/const v = await netGetVault\(id, rec \? protocolOfRecord\(rec\) : undefined\)/)
  })
  it('an imported backup cannot claim a protocol this app does not know', () => {
    expect(codeOf('./storage.ts')).toMatch(/p\.cp > 0 && p\.cp <= CREATION_PROTOCOL \? p\.cp : undefined/)
  })
})

describe('an outdated client says so, before it starts and if it is refused', () => {
  it('creation is allowed when the coordinator asks for no more than this client speaks, or says nothing', () => {
    expect(creationAllowed(2, null)).toBe(true)
    expect(creationAllowed(2, 2)).toBe(true)
    expect(creationAllowed(2, 1)).toBe(true)
    expect(creationAllowed(2, 3)).toBe(false)
  })
  it('a coordinator that does not answer health in time does not hold a creation up', () => {
    expect(codeOf('./helper.ts')).toMatch(/coordinatorCreationMin[\s\S]{0,600}AbortSignal\.timeout\(\d+\)/)
  })
  it('the coordinator minimum is read from health as an integer, and anything else is no minimum', async () => {
    healthBody = { status: 'ok', client: { creation: 3 } }
    expect(await helper.coordinatorCreationMin()).toBe(3)
    healthBody = { status: 'ok' }
    expect(await helper.coordinatorCreationMin()).toBeNull()
    healthBody = { status: 'ok', client: { creation: '3' } }
    expect(await helper.coordinatorCreationMin()).toBeNull()
    healthBody = { status: 'ok', client: { creation: 2.5 } }
    expect(await helper.coordinatorCreationMin()).toBeNull()
  })
  it('a refusal that asks for an update is told apart from any other failure', () => {
    expect(isUpdateRequired({ status: 409, updateRequired: true })).toBe(true)
    expect(isUpdateRequired({ status: 409 })).toBe(false)
    expect(isUpdateRequired(null)).toBe(false)
  })
  it('the registration failure keeps the update flag', async () => {
    registerAnswer = () => new Response(JSON.stringify({ error: 'update the app', update_required: true, min_creation: 3 }), { status: 409 })
    expect(await helper.registerVault('bb'.repeat(32), 'v', 2, 2, 2)).toBeNull()
    expect(helper.lastHelperPostFailure()).toMatchObject({ status: 409, updateRequired: true })
    // Only a real `true` asks for an update; anything else is an ordinary failure.
    registerAnswer = () => new Response(JSON.stringify({ error: 'no', update_required: 'yes' }), { status: 409 })
    await helper.registerVault('cc'.repeat(32), 'v', 2, 2, 2)
    expect(helper.lastHelperPostFailure()?.updateRequired).toBe(false)
  })
  it('creating and joining ask before starting, and a refused registration says update instead of hanging', () => {
    const src = codeOf('./screens/NetVault.tsx')
    // Before anything starts: the member stays on the screen they were on, with the message and no
    // counters of a ceremony that never began, and can try again after updating.
    expect(src).toMatch(/startGuardRef\.current = true\s*try \{\s*if \(!creationAllowed\(CREATION_PROTOCOL, await coordinatorCreationMin\(\)\)\) \{\s*setError\(tt\('net\.err\.updateRequired'\)\)\s*startGuardRef\.current = false\s*return\s*\}/)
    // The refusal itself is read where the registration happens (conclude-registration.ts), once.
    expect(codeOf('./conclude-registration.ts')).toMatch(/isUpdateRequired\(failure\)/)
  })
})

describe('resumable: a record by fact, in one place', () => {
  it('reads the record, with or without pending, and needs a coordinator', async () => {
    const { resumable } = await import('./creation-protocol')
    localStorage.setItem('konclave.coord.mode', 'custom')
    localStorage.setItem('konclave.coord.url', 'https://coordinator.invalid')
    // A v2 record still pending, no address.
    expect(resumable({ cp: 2, threshold: 2, total: 2, pending: true, address: '' })).toBe(true)
    // Finished from the card with no address (the old "yes" flipped it locally): still resumable.
    expect(resumable({ cp: 2, threshold: 2, total: 2, pending: false, address: '' })).toBe(true)
    expect(resumable({ threshold: 2, total: 2, address: '' })).toBe(true) // v0.12.0 shape
    // It has an address: nothing to finish.
    expect(resumable({ cp: 2, threshold: 2, total: 2, address: 'u1abc' })).toBe(false)
    // Old flow: never.
    expect(resumable({ pending: true, address: '' })).toBe(false)
    // No coordinator configured: nothing to register with.
    localStorage.setItem('konclave.coord.mode', 'local')
    expect(resumable({ cp: 2, threshold: 2, total: 2, pending: true, address: '' })).toBe(false)
    localStorage.setItem('konclave.coord.mode', 'custom')
  })
})
