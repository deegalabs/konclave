// #285: one background signer per vault seat across the tabs of a browser, with a Web Lock
// (navigator.locks) around the in-process guard. Two tabs are two fresh copies of the module (each
// has its own in-process Set, as two tabs do) over ONE real LockManager: Node's own implementation of
// the Web Locks API, so a request the browser would refuse is refused here too. (A hand-written
// stand-in accepted `ifAvailable` with `signal`, which the API refuses, and hid that no lock was
// ever taken.) Each test uses its own vault id: the manager is shared by the whole process.
import { afterEach, describe, expect, it, vi } from 'vitest'

import { locks as nodeLocks } from 'node:worker_threads'

const realLocks = () => nodeLocks as unknown as LockManager
let n = 0
const vid = () => `t285-${process.pid}-${Date.now()}-${n++}`

async function tab() {
  vi.resetModules()
  return await import('./background-signer')
}
const settle = () => new Promise((r) => setTimeout(r, 20))

describe('the background signer holds a cross-tab lock per vault seat (#285)', () => {
  afterEach(() => { vi.resetModules() })

  it('a second tab waits, is told the vault signs elsewhere, and takes over when the first lets go', async () => {
    const locks = realLocks()
    const a = await tab()
    const b = await tab()
    const id = vid()
    const la = a.acquireSignerAcrossTabs(id.toUpperCase(), 1, { locks })!
    expect(await la.granted).toBe(true)
    let busy = 0
    const lb = b.acquireSignerAcrossTabs(id, 1, { locks, onBusy: () => { busy++ } })!
    let bGranted: boolean | undefined
    void lb.granted.then((g) => { bGranted = g })
    await settle()
    expect(busy).toBe(1)
    expect(bGranted).toBeUndefined() // still waiting: never two signers on one seat
    la.release()
    await settle()
    expect(bGranted).toBe(true)
    lb.release()
  })

  it('another seat of the same vault is a different lock', async () => {
    const locks = realLocks()
    const id = vid()
    const a = await tab()
    const b = await tab()
    const la = a.acquireSignerAcrossTabs(id, 1, { locks })!
    let busy = 0
    const lb = b.acquireSignerAcrossTabs(id, 2, { locks, onBusy: () => { busy++ } })!
    expect(await la.granted).toBe(true)
    expect(await lb.granted).toBe(true)
    expect(busy).toBe(0) // seat 2 never waited for seat 1
    la.release(); lb.release()
  })

  it('a waiting tab that stops never becomes the signer, and the lock is free after', async () => {
    const locks = realLocks()
    const id = vid()
    const a = await tab()
    const b = await tab()
    const la = a.acquireSignerAcrossTabs(id, 1, { locks })!
    await la.granted
    const lb = b.acquireSignerAcrossTabs(id, 1, { locks })!
    await settle()
    lb.release()
    expect(await lb.granted).toBe(false)
    la.release()
    await settle()
    const c = await tab()
    let busy = 0
    const lc = c.acquireSignerAcrossTabs(id, 1, { locks, onBusy: () => { busy++ } })!
    expect(await lc.granted).toBe(true)
    expect(busy).toBe(0)
    lc.release()
  })

  it('the same tab re-seats at once: release frees the in-process guard in the same call', async () => {
    const locks = realLocks()
    const id = vid()
    const a = await tab()
    const first = a.acquireSignerAcrossTabs(id, 1, { locks })!
    // Released while its request is still pending, as an effect's cleanup does on a re-seat.
    first.release()
    const second = a.acquireSignerAcrossTabs(id, 1, { locks })
    expect(second).not.toBeNull()
    expect(await first.granted).toBe(false)
    expect(await second!.granted).toBe(true)
    second!.release()
    second!.release() // idempotent
  })

  it('one tab still refuses a second signer for the seat it already runs', async () => {
    const locks = realLocks()
    const id = vid()
    const a = await tab()
    const l = a.acquireSignerAcrossTabs(id, 1, { locks })!
    expect(a.acquireSignerAcrossTabs(id, 1, { locks })).toBeNull()
    l.release()
  })

  it('with no lock manager, or one that fails, the in-process guard alone decides (as before)', async () => {
    const id = vid()
    const a = await tab()
    const none = a.acquireSignerAcrossTabs(id, 1, { locks: null })!
    expect(await none.granted).toBe(true)
    expect(a.acquireSignerAcrossTabs(id, 1, { locks: null })).toBeNull()
    none.release()
    const failing = { request: async () => { throw Object.assign(new Error('insecure'), { name: 'SecurityError' }) } } as unknown as LockManager
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const f = a.acquireSignerAcrossTabs(id, 1, { locks: failing })!
    expect(await f.granted).toBe(true)
    // Said, never silent, and without the lock's name (it carries the vault id).
    expect(warn).toHaveBeenCalledTimes(1)
    expect(JSON.stringify(warn.mock.calls)).not.toContain(id)
    warn.mockRestore()
    f.release()
    // But once another tab was seen holding the seat, a failure afterwards never starts a second one.
    let calls = 0
    const busyThenFails = {
      request: async (_n: string, _o: unknown, cb: (l: null) => unknown) => {
        if (calls++ === 0) return cb(null)
        throw Object.assign(new Error('gone'), { name: 'InvalidStateError' })
      },
    } as unknown as LockManager
    const g = a.acquireSignerAcrossTabs(id, 1, { locks: busyThenFails })!
    expect(await g.granted).toBe(false)
    g.release()
  })
})

describe('one place asks the browser for the signer lock (#285)', () => {
  // Walks every source file: given room under load, as source-scan.test.ts does (#669).
  it('only background-signer.ts calls the Web Locks API, tests aside', { timeout: 30_000 }, async () => {
    const { readdirSync, readFileSync } = await import('node:fs')
    const { fileURLToPath } = await import('node:url')
    const { stripComments } = await import('./source-scan')
    const here = fileURLToPath(new URL('.', import.meta.url))
    const callers: string[] = []
    const walk = (dir: string) => {
      for (const e of readdirSync(dir, { withFileTypes: true })) {
        const path = `${dir}/${e.name}`
        if (e.isDirectory()) { if (!['wasm-pkg', 'node_modules'].includes(e.name)) walk(path); continue }
        if (!/\.(ts|tsx)$/.test(e.name) || /\.test\.tsx?$/.test(e.name) ) continue
        const src = stripComments(e.name, readFileSync(path, 'utf8'))
        if (/navigator\s*\??\.\s*locks|\.locks\s*\??\.\s*request/.test(src)) callers.push(path.slice(here.length))
      }
    }
    walk(here.replace(/\/$/, ''))
    expect(callers).toEqual(['background-signer.ts'])
  })
})
