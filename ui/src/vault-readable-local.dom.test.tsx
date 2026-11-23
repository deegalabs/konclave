// @vitest-environment jsdom
import 'fake-indexeddb/auto'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { codeAt } from './source-scan'

// #1108. Whether this device must unlock a vault is decided from its OWN record, so that an app which
// is opened and not unlocked makes no request that names the vault. The state here is real (a vault
// saved in the real store, the real session); only the storage read that must fail is a switch.
localStorage.setItem('konclave.coord.mode', 'custom')
localStorage.setItem('konclave.coord.url', 'https://coordinator.invalid')
const readFails = vi.hoisted(() => ({ on: false }))
vi.mock('./storage', async (orig) => {
  const real = await orig<typeof import('./storage')>()
  return { ...real, readVaults: async () => { if (readFails.on) throw new Error('storage unreadable'); return real.readVaults() } }
})

const GK = 'ef'.repeat(32)
const { saveVault, deleteVault } = await import('./storage')
const { setReadSecret, clearReadSecret } = await import('./session')
const { localLockNow } = await import('./vault-readable')

const S = new Uint8Array(32).fill(9)
const save = (secret: boolean, cp?: number) => saveVault(GK, {
  name: 'Treasury', governance: 'quorum', myName: 'Ana', creatorName: 'Ana',
  groupKey: new Uint8Array(32).fill(0xef), address: 'u1test', roster: ['Ana', 'Bia'],
  sealedShare: new Uint8Array(32).fill(1), ...(secret ? { accessSecret: S } : {}), ...(cp !== undefined ? { cp } : {}),
}, 'river stone maple lantern')

describe('localLockNow decides from the record, with the rule needsUnlock (#1108 T3)', () => {
  beforeEach(() => { readFails.on = false })
  afterEach(async () => { clearReadSecret(GK); await deleteVault(GK).catch(() => {}) })

  it('a protected record with no S in memory is locked, and carries the record name', async () => {
    await save(true)
    expect(await localLockNow(GK)).toEqual({ locked: true, name: 'Treasury' })
  })
  it('a protected record with S in memory is not locked', async () => {
    await save(true)
    setReadSecret(GK, S)
    expect(await localLockNow(GK)).toEqual({ locked: false, name: 'Treasury' })
  })
  it('an open record is not locked', async () => {
    await save(false)
    expect(await localLockNow(GK)).toEqual({ locked: false, name: 'Treasury' })
  })
  it('no record: undefined, so the bridge/helper path decides', async () => {
    expect(await localLockNow('00'.repeat(32))).toBeUndefined()
  })
  it('a record made under an older creation protocol is decided like any other', async () => {
    await save(true, 1)
    expect(await localLockNow(GK)).toEqual({ locked: true, name: 'Treasury' })
    await deleteVault(GK)
    await save(false, 1)
    expect(await localLockNow(GK)).toEqual({ locked: false, name: 'Treasury' })
  })
  it('a storage that cannot be read is locked, not open and not undefined', async () => {
    await save(true)
    readFails.on = true
    expect((await localLockNow(GK))?.locked).toBe(true)
  })
})

describe('the rule is asked in one place (#1108 T5)', () => {
  it('needsUnlock is called only from vault-readable.ts', () => {
    const files: string[] = []
    const walk = (d: string) => {
      for (const f of readdirSync(d)) {
        const p = join(d, f)
        if (statSync(p).isDirectory()) { if (f !== 'wasm-pkg' && f !== 'node_modules') walk(p) } else if (/\.tsx?$/.test(f) && !/\.test\.tsx?$/.test(f)) files.push(p)
      }
    }
    walk(join(process.cwd(), 'src'))
    const callers = files
      .filter((p) => /\bneedsUnlock\s*\(/.test(codeAt(p)))
      .map((p) => p.slice(join(process.cwd(), 'src').length + 1))
    expect(callers.filter((c) => c !== 'vault-lock.ts')).toEqual(['vault-readable.ts'])
  })
})
