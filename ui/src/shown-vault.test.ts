/// <reference types="node" />
import { afterEach, describe, expect, it, vi } from 'vitest'
import { readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { codeAt } from './source-scan'

// T1: the truth table of the guard, web and bridge. The selection is real localStorage.
const mem = new Map<string, string>()
vi.stubGlobal('localStorage', {
  getItem: (k: string) => mem.get(k) ?? null,
  setItem: (k: string, v: string) => void mem.set(k, String(v)),
  removeItem: (k: string) => void mem.delete(k),
  clear: () => mem.clear(),
})

describe('shownVault', () => {
  afterEach(() => { vi.resetModules(); mem.clear() })
  async function load(web: boolean) {
    vi.resetModules()
    if (web) { mem.set('konclave.coord.mode', 'custom'); mem.set('konclave.coord.url', 'https://coordinator.invalid') }
    return import('./shown-vault')
  }

  it('web: the same selection is ok, another is refused, none says the vault is gone', async () => {
    const m = await load(true)
    m.setSelectedVault('X')
    expect(m.shownVault('X')).toEqual({ ok: true, id: 'X' })
    m.setSelectedVault('Y')
    expect(m.shownVault('X')).toEqual({ ok: false })
    m.clearSelectedVault()
    expect(m.shownVault('X')).toEqual({ ok: false, gone: true })
  })

  it('bridge: no selection is fine, a different one is refused', async () => {
    const m = await load(false)
    expect(m.shownVault('X')).toEqual({ ok: true, id: 'X' })
    m.setSelectedVault('X')
    expect(m.shownVault('X')).toEqual({ ok: true, id: 'X' })
    m.setSelectedVault('Y')
    expect(m.shownVault('X')).toEqual({ ok: false })
  })

  it('no shown id is never ok', async () => {
    const m = await load(false)
    expect(m.shownVault('')).toEqual({ ok: false })
    expect(m.shownVault(null)).toEqual({ ok: false })
    expect(m.shownVault(undefined)).toEqual({ ok: false })
  })

  it('vaultQuery names the id and escapes it', async () => {
    const m = await load(false)
    expect(m.vaultQuery('/api/x', 'a b')).toBe('/api/x?vault=a%20b')
  })
})

describe('the guard has one implementation', () => {
  const SRC = fileURLToPath(new URL('.', import.meta.url))
  const walk = (d: string): string[] => readdirSync(d).flatMap((f) => {
    const p = join(d, f)
    if (statSync(p).isDirectory()) return f === 'wasm-pkg' || f === 'node_modules' ? [] : walk(p)
    return /\.(ts|tsx)$/.test(f) && !/\.test\.tsx?$/.test(f) ? [p] : []
  })
  it('`function shownVault` is defined in exactly one file, outside tests', () => {
    const hits = walk(SRC).filter((p) => /\bfunction shownVault\b/.test(codeAt(p)))
    expect(hits.map((p) => p.slice(SRC.length))).toEqual(['shown-vault.ts'])
  })
  it('api.ts re-exports it instead of defining it', () => {
    expect(codeAt(join(SRC, 'api.ts'))).toMatch(/export \{[^}]*shownVault[^}]*\} from '\.\/shown-vault'/)
  })
})
