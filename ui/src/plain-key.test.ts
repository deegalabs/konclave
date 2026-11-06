import 'fake-indexeddb/auto'
import { beforeEach, describe, expect, it } from 'vitest'
import { listVaults, saveVault, type VaultData } from './storage'

// #784, over the REAL store (fake-indexeddb, the same code path the browser runs): listVaults says
// whether a record still carries the viewing key in the clear, as a boolean, and never lists the
// value. A record the app writes today never has the clear field; one an older import wrote does.
const data: VaultData = {
  name: 'Caixa', governance: 'quorum', myName: 'Alice', creatorName: 'Alice',
  groupKey: new Uint8Array(32).fill(7), address: 'u1x', roster: ['Alice', 'Bob'],
  sealedShare: new Uint8Array(Array.from({ length: 32 }, (_, i) => i + 1)),
}

const putField = (id: string, patch: Record<string, unknown>) => new Promise<void>((resolve, reject) => {
  const req = indexedDB.open('konclave')
  req.onerror = () => reject(req.error)
  req.onsuccess = () => {
    const db = req.result
    const tx = db.transaction('vaults', 'readwrite')
    const store = tx.objectStore('vaults')
    const get = store.get(id)
    get.onsuccess = () => { store.put({ ...get.result, ...patch }) }
    tx.oncomplete = () => { db.close(); resolve() }
    tx.onerror = () => reject(tx.error)
  }
})

describe('listVaults reports a viewing key left in the clear (#784)', () => {
  beforeEach(async () => { await new Promise<void>((r) => { const d = indexedDB.deleteDatabase('konclave'); d.onsuccess = () => r(); d.onerror = () => r() }) })

  it('false for a record the app wrote, true once the clear field is there, and the value is never listed', async () => {
    await saveVault('v1', data, 'correct horse battery staple')
    expect((await listVaults()).find((v) => v.id === 'v1')?.plainViewingKey).toBe(false)

    await putField('v1', { ufvk: 'uview1' + 'q'.repeat(40) }) // what an import wrote before #599
    const listed = (await listVaults()).find((v) => v.id === 'v1')!
    expect(listed.plainViewingKey).toBe(true)
    expect('ufvk' in listed).toBe(false)
    expect(JSON.stringify(listed)).not.toContain('uview1')
  })
})
