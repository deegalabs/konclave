import { describe, expect, it, vi } from 'vitest'
import { codeOf } from './source-scan'

// T11: on the bridge, removing a vault names the shown vault in the URL, not whatever the selection
// says at that moment. The bridge compares the typed name against the vault it is told to delete.
const mem = new Map<string, string>()
vi.stubGlobal('localStorage', {
  getItem: (k: string) => mem.get(k) ?? null,
  setItem: (k: string, v: string) => void mem.set(k, String(v)),
  removeItem: (k: string) => void mem.delete(k),
  clear: () => mem.clear(),
})
const urls: string[] = []
vi.stubGlobal('fetch', async (url: string) => { urls.push(String(url)); return new Response('{}', { status: 200 }) })
const { deleteVault, setSelectedVault } = await import('./api')

describe('deleteVault names the vault it was given (T11)', () => {
  it('with another vault selected, the URL still says the shown one', async () => {
    setSelectedVault('Y')
    const r = await deleteVault('X', undefined, 'Treasury X')
    expect(r.ok).toBe(true)
    expect(urls.at(-1)).toContain('/api/vault/delete?vault=X')
    expect(urls.at(-1)).not.toContain('vault=Y')
  })
  it('the source has no withVault in it', () => {
    const body = codeOf('api.ts').split('export async function deleteVault')[1]?.split('\nexport ')[0] ?? ''
    expect(body).toBeTruthy()
    expect(body).not.toMatch(/withVault\(/)
    expect(body).toMatch(/vaultQuery\(/)
  })
})
