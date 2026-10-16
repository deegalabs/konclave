import { describe, expect, it } from 'vitest'
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

  it('is built in one place: both screens that offer a backup use it', () => {
    for (const f of ['./screens/Settings.tsx', './screens/NetVault.tsx']) {
      const src = codeOf(f)
      expect(src, f).toMatch(/backupFileName\(/)
      expect(src, f).not.toMatch(/\.konclave\.json`/)
    }
  })
})
