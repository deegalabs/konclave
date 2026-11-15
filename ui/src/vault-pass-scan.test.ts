import { describe, expect, it } from 'vitest'
import { readdirSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'
import { codeAt } from './source-scan'

// #929. Source scans, because the rules are about what code is ABSENT: a raw passphrase input, a
// button with no type in a passphrase form, a second copy of the tag's salt.
const SRC = fileURLToPath(new URL('.', import.meta.url))

function files(dir: string): string[] {
  return readdirSync(dir).flatMap((n) => {
    const p = join(dir, n)
    if (statSync(p).isDirectory()) return n === 'i18n' ? [] : files(p)
    return /\.(ts|tsx)$/.test(n) && !/\.test\./.test(n) ? [p] : []
  })
}
const all = files(SRC).map((p) => ({ rel: relative(SRC, p), text: codeAt(p) }))

// Entry sites that PR 2 of #929 migrates. Exact counts, so an exception cannot quietly grow, and
// the list empties when PR 2 lands.
const PR2_EXCEPTIONS: Record<string, number> = {
  'LockOverlay.tsx': 1,
  'PlainKeyNotice.tsx': 1,
  'screens/BackgroundSignerLab.tsx': 1,
  'screens/NetVault.tsx': 1, // the restore row
  'screens/ReceiversRepair.tsx': 1,
  'screens/SigningPanel.tsx': 1,
  'screens/Vaults.tsx': 4,
}

describe('passphrase fields (#929)', () => {
  it('type="password" lives in components.tsx, apart from the named PR 2 exceptions', () => {
    const found: Record<string, number> = {}
    for (const f of all) {
      if (f.rel === 'components.tsx') continue
      const n = (f.text.match(/type=(?:"password"|'password'|\{[^}]*'password'[^}]*\})/g) ?? []).length
      if (n) found[f.rel] = n
    }
    expect(found).toEqual(PR2_EXCEPTIONS)
  })

  it('the salt of the tag is written in vault-username.ts only', () => {
    const holders = all.filter((f) => f.text.includes('konclave-manager-tag')).map((f) => f.rel)
    expect(holders).toEqual(['vault-username.ts'])
  })

  it('every button inside a VaultPassForm says its type', () => {
    const bad: string[] = []
    for (const f of all) {
      for (const m of f.text.matchAll(/<VaultPassForm\b[\s\S]*?<\/VaultPassForm>/g)) {
        for (const b of m[0].matchAll(/<button\b((?:=>|[^>])*)>/g)) {
          if (!/\btype=/.test(b[1] ?? '')) bad.push(`${f.rel}: ${b[0].slice(0, 60)}`)
        }
      }
    }
    expect(bad).toEqual([])
  })

  it('the migrated sites exist (the scan above would pass on a form that was deleted)', () => {
    const uses = (rel: string) => (all.find((f) => f.rel === rel)!.text.match(/<VaultPassForm\b/g) ?? []).length
    expect(uses('screens/Settings.tsx')).toBe(2)
    expect(uses('screens/NetVault.tsx')).toBe(2)
  })

  it('each migrated field says whether the passphrase is chosen or entered', () => {
    const ac = (rel: string) => Array.from(
      all.find((f) => f.rel === rel)!.text.matchAll(/<(?:PassphraseField|VaultPassInput)\b[\s\S]*?\/>/g),
      (m) => /autoComplete="(new|current)-password"/.exec(m[0])?.[1] ?? 'none')
    // Creation: joiner, creator. Rotation: current, new, repeat. Export: current.
    expect(ac('screens/NetVault.tsx')).toEqual(['new', 'new'])
    expect(ac('screens/Settings.tsx')).toEqual(['current', 'new', 'new', 'current'])
  })
})
