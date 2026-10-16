import { afterEach, describe, expect, it } from 'vitest'
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { backupFileName } from './storage'
import { codeOf } from './source-scan'

// Daniel (16/10): every backup of a vault downloaded under the same name, so a second copy replaced
// or shadowed the first and nothing said which was newer. The name now carries the vault and the
// date and time it was made, and nothing about who made it (a member's name in a file name lands in
// download folders and cloud drives; decided by Daniel the same day).
describe('the backup file name', () => {
  const at = new Date(2026, 9, 16, 13, 5, 42)

  it('is the vault name and the local date and time', () => {
    expect(backupFileName('TestC', at)).toBe('testc-2026-10-16-1305.konclave.json')
  })

  it('keeps only safe characters, as before', () => {
    expect(backupFileName('Família Silva / 2026', at)).toBe('fam-lia-silva-2026-2026-10-16-1305.konclave.json')
  })

  it('names a vault with no name', () => {
    expect(backupFileName(undefined, at)).toBe('konclave-vault-2026-10-16-1305.konclave.json')
    expect(backupFileName('', at)).toBe('konclave-vault-2026-10-16-1305.konclave.json')
  })

  it('pads single digits', () => {
    expect(backupFileName('v', new Date(2026, 0, 2, 3, 4))).toBe('v-2026-01-02-0304.konclave.json')
  })

  describe('in the member’s own time zone, not UTC', () => {
    const before = process.env.TZ
    afterEach(() => {
      if (before === undefined) delete process.env.TZ
      else process.env.TZ = before
    })
    it('16:05 UTC is 13:05 in São Paulo', () => {
      // CI runs in UTC, where local and UTC agree and a UTC slip would pass; pin a zone that differs.
      process.env.TZ = 'America/Sao_Paulo'
      expect(backupFileName('v', new Date(Date.UTC(2026, 9, 16, 16, 5)))).toBe('v-2026-10-16-1305.konclave.json')
    })
  })

  it('takes the vault name and the time, and nothing that could name a member', () => {
    expect(backupFileName.length).toBe(2)
    for (const f of ['./screens/Settings.tsx', './screens/NetVault.tsx']) {
      expect(codeOf(f), f).toMatch(/backupFileName\([^,()]+(\([^)]*\))?[^,()]*, new Date\(\)\)/)
    }
  })

  it('is built in one place: no other source writes a .konclave.json name', () => {
    const root = fileURLToPath(new URL('.', import.meta.url))
    const hits: string[] = []
    const walk = (dir: string) => {
      for (const name of readdirSync(dir)) {
        const p = join(dir, name)
        if (statSync(p).isDirectory()) {
          if (name !== 'wasm-pkg' && name !== 'docs') walk(p)
        } else if (/\.(ts|tsx)$/.test(name) && !/\.test\.tsx?$/.test(name)) {
          if (/\.konclave\.json`/.test(readFileSync(p, 'utf8'))) hits.push(p.slice(root.length))
        }
      }
    }
    walk(root)
    expect(hits).toEqual(['storage.ts'])
  })
})
