import { afterEach, describe, expect, it } from 'vitest'
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { backupFileName } from './storage'
import { codeOf } from './source-scan'

// Daniel (16/10): every backup of a vault downloaded under the same name, so a second copy replaced
// or shadowed the first and nothing said which was newer. The name carries the date and time it was
// made, and nothing about who made it (a member's name in a file name lands in download folders and
// cloud drives). #587: nor the vault's name. The file's contents reveal nothing without the
// passphrase, not even which vault it belongs to; a name that said it broke that promise in every
// downloads folder, synced drive and mail attachment. The name is neutral; the date tells copies apart.
describe('the backup file name', () => {
  const at = new Date(2026, 9, 16, 13, 5, 42)

  it('is neutral: konclave-backup and the local date and time', () => {
    expect(backupFileName(at)).toBe('konclave-backup-2026-10-16-1305.konclave.json')
  })

  it('carries nothing from the vault record, whatever it is called (#587)', () => {
    const name = backupFileName(at)
    for (const word of ['testc', 'silva', 'treasury', 'caixa']) expect(name).not.toContain(word)
    expect(name).toMatch(/^konclave-backup-\d{4}-\d{2}-\d{2}-\d{4}\.konclave\.json$/)
  })

  it('pads single digits', () => {
    expect(backupFileName(new Date(2026, 0, 2, 3, 4))).toBe('konclave-backup-2026-01-02-0304.konclave.json')
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
      expect(backupFileName(new Date(Date.UTC(2026, 9, 16, 16, 5)))).toBe('konclave-backup-2026-10-16-1305.konclave.json')
    })
  })

  it('takes the time alone: nothing that could name a member or the vault', () => {
    expect(backupFileName.length).toBe(1)
    // The one backup builder names the file; the screens go through it (#682).
    expect(codeOf('./build-backup.ts')).toMatch(/name: backupFileName\(new Date\(\)\)/)
    for (const f of ['./screens/Settings.tsx', './screens/NetVault.tsx']) {
      expect(codeOf(f), f).toMatch(/buildVaultBackup\(/)
      expect(codeOf(f), f).not.toMatch(/backupFileName\(/)
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
