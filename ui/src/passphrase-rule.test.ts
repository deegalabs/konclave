import 'fake-indexeddb/auto'
import { describe, expect, it, vi } from 'vitest'
// These derive keys at 600k rounds, like storage.test.ts.
vi.setConfig({ testTimeout: 30_000 })

import { generatePassphrase, newPassphraseProblem, scorePassphrase } from './passphrase'
import { changePassphrase, exportVault, importVault, loadVault, saveVault, type VaultData } from './storage'
import { StorageError } from './storage-errors'
import { en } from './i18n/en'
import { codeOf } from './source-scan'

const STRONG = 'correct horse battery staple'
const id = '09'.repeat(32)
const data: VaultData = {
  groupKey: new Uint8Array(32).fill(9), address: 'u1x', roster: ['A'], sealedShare: new Uint8Array(32).fill(1),
}
const code = (p: Promise<unknown>) => p.then(() => 'accepted', (e: StorageError) => e.code)

describe('the rule for a new passphrase', () => {
  it.each([
    ['12345678'], ['senha123'], ['Maria1985!'], ['Konclave2026'], ['Flamengo@1981'],
    ['iloveyou'], ['a'], ['Daniel2026!'], ['brasil2026'], ['P@ssw0rd'],
    ['P@ssw0rd2026'], ['Flamengo@1981!!!'], ['1981Flamengo'], ['F1amengo2026!'], ['MariaSilva1985'],
    ['Maria Silva 1985'], ['minha senha forte'], ['senha123senha123'], ['abcabcabcabc'],
    ['aaaaaaaaaaaaaaaa'], ['123456789012'], ['qwertyuiopas'], ['1q2w3e4r5t6y'], ['Konclave#1a2b'],
    ['password password password password'], ['            '],
    ['Fl4mengo@1981'], ['P4ssw0rd2026'], ['Maria1985Silva'], ['Mariana1985x'], ['abc123def456'],
    ['abcd1234abcd'], ['aaaabbbbccccddddeeee'], ['x9y8x9y8x9y8'], ['ab2cdab2cdab2cd'],
    ['qqqqqqqqqqqqqqqqqqqqqwww'], ['abcdefghijklmnopqrstuvwxyz'],
  ])('refuses %s', (weak) => {
    expect(newPassphraseProblem(weak)).not.toBeNull()
  })

  it.each([
    ['Konclave-2026-Konclave-2026'], ['Konclave2026Konclave2026'], ['password1234password1234'],
    ['aaaaaaaaaaaaaaaaaaaaaaaa'], ['abcabcabcabcabcabcabcabc'], ['aaaabbbbccccddddeeeeffff'],
  ])('from 20 characters still refuses %s', (weak) => {
    expect(newPassphraseProblem(weak)).toBe('guessable')
  })

  it.each([
    ['minha minha minha minha'], ['Cavalo-2026-Cavalo-2026'], ['Cavalo2026Cavalo2026x'], ['Maria1985!!!!!!!!!!!'],
    ['aaaabbbbccccddddeeeeffffgggghhhh'], ['abcde'.repeat(60)], ['Konclave-2026-'.repeat(30)],
  ])('padding does not get past it: %s', (weak) => {
    expect(newPassphraseProblem(weak)).toBe('guessable')
  })

  it('counts what a person sees, however it was typed', () => {
    const nineteen = 'Flamengo-campeão-20'
    expect(newPassphraseProblem(nineteen.normalize('NFC'))).toBe('guessable')
    expect(newPassphraseProblem(nineteen.normalize('NFD'))).toBe('guessable')
    expect(newPassphraseProblem(nineteen + '\u200b')).toBe('guessable')
  })

  it('a listed word beside random digits is not a listed password, from 20 characters', () => {
    expect(newPassphraseProblem('Konclave-9417-3382-5561-0274')).toBeNull()
  })

  it('a word with a year stays refused below 20 characters', () => {
    expect(newPassphraseProblem('Flamengo-campeao-2019')).toBeNull() // 21 characters
    expect(newPassphraseProblem('Flamengo-campeao-201')).toBeNull() // 20
    expect(newPassphraseProblem('Flamengo-campeao-20')).toBe('guessable') // 19
  })

  it('random passwords of 20 or more from a manager pass', () => {
    const pick = (set: string, n: number) => Array.from(crypto.getRandomValues(new Uint32Array(n)), (x) => set[x % set.length]!).join('')
    const lower = 'abcdefghijklmnopqrstuvwxyz'
    for (const set of [lower + lower.toUpperCase() + '0123456789', lower + '0123456789', lower + lower.toUpperCase() + '0123456789!@#$%^&*-_=+?']) {
      for (let i = 0; i < 1000; i++) expect(newPassphraseProblem(pick(set, 20))).toBeNull()
    }
    for (let i = 0; i < 1000; i++) expect(newPassphraseProblem(`${pick(lower, 6)}-${pick(lower, 6)}-${pick(lower, 6)}`)).toBeNull()
  })

  it('random letters in mixed case are not read as words below 20 characters', () => {
    // Shapes a manager generates (Bitwarden's default is 14 characters, all three classes): a run of
    // letters whose case changes mid-run is not how a person types a word.
    for (const p of ['PwbvKHU5G0jd', 'HdCXjVaKOznbutbH']) expect(newPassphraseProblem(p), p).toBeNull()
    // People's word-and-year shapes stay refused.
    for (const p of ['JoaoPedro2010!', 'casa-azul-2024', 'Corinthians1910', 'SaoPaulo#2025', 'Flamengo-campeao-20']) {
      expect(newPassphraseProblem(p), p).toBe('guessable')
    }
  })

  it('a season, month or common name in odd case is still read as a word below 20 characters', () => {
    for (const p of ['SUmmer2024!!', 'JOAOpedro2010', 'DEZembro2023!', 'WINTEr2025#!', 'MARIAsilva99']) {
      expect(newPassphraseProblem(p), p).toBe('guessable')
    }
    // From 20 characters the shape is not judged.
    expect(newPassphraseProblem('JOAOpedro2010xQ7#mZ4!')).toBeNull()
    // Listed tokens making up half of the text are enough; just under half is not.
    expect(newPassphraseProblem('SUmmer#xQ6Wb')).toBe('guessable')
    expect(newPassphraseProblem('SUmmer#xQ6Wbk')).toBeNull()
  })

  it('a random alphanumeric of 12 to 16 from a manager is refused rarely', () => {
    const set = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789'
    const pick = (n: number) => Array.from(crypto.getRandomValues(new Uint32Array(n)), (x) => set[x % set.length]!).join('')
    let refused = 0
    for (let i = 0; i < 2000; i++) if (newPassphraseProblem(pick(14))) refused++
    // Measured about 6-8% with the case rule, about 21% without it; 13% leaves room for chance.
    expect(refused / 2000).toBeLessThan(0.13)
  })

  it('says short for a short one, whatever else is wrong with it', () => {
    expect(newPassphraseProblem('12345678')).toBe('too-short')
    expect(newPassphraseProblem('Konclave2026')).toBe('guessable')
  })

  it('counts characters, so four emoji are not eight', () => {
    expect(newPassphraseProblem('😀🙈🦊🌵🐢🎲')).toBe('too-short')
  })

  it.each([
    [STRONG], ['tavu-keby-3-lomi-daxo'], ['xK9!mQ2$vB7z'], ['mesa azul corre longe devagar'],
    ['correcthorsebatterystaple'],
    // From 20 characters only a listed password or repetition is refused.
    ['Senha-Forte-2026-Agora'], ['Tr0ub4dour-&-3xtra-Long!'], ['aB3dE7gHi9KlmN2pQr5t'], ['hqzkmv-tprlwx-bnfgds'], ['k3jf9sle2mq7xd4vb8nz'],
    ['Flamengo campeao 2019 de novo'],
  ])('accepts %s', (good) => {
    expect(newPassphraseProblem(good)).toBeNull()
  })

  it('the generator always passes', () => {
    for (let i = 0; i < 3000; i++) expect(newPassphraseProblem(generatePassphrase())).toBeNull()
  })

  it('the generator draws again rather than hand over a passphrase the rule refuses', () => {
    // The first draw rates strong on character classes alone.
    const draws = ['Flamengo@1981-Flamengo', 'xK9!mQ2$vB7zTq4#Wn8&']
    expect(generatePassphrase(() => draws.shift()!)).toBe('xK9!mQ2$vB7zTq4#Wn8&')
  })

  it('the meter never praises what the rule refuses', () => {
    for (const weak of ['Konclave2026', 'Maria1985!', 'Flamengo@1981', 'minha senha forte']) {
      expect(scorePassphrase(weak).score, weak).toBeLessThan(2)
    }
  })
})

describe('every path that seals under a NEW passphrase goes through it', () => {
  it('saveVault refuses and stores nothing', async () => {
    expect(await code(saveVault('weak-save', data, 'senha123'))).toBe('weak-passphrase')
    await expect(loadVault('weak-save', 'senha123')).rejects.toThrow(/no saved vault/i)
  })

  it('changePassphrase refuses and the record still opens with the old one', async () => {
    await saveVault(id, data, STRONG)
    for (const weak of ['a', 'Konclave2026']) {
      expect(await code(changePassphrase(id, STRONG, weak))).toBe('weak-passphrase')
    }
    expect(Array.from((await loadVault(id, STRONG)).sealedShare)).toEqual(Array.from(data.sealedShare))
  })

  it('the refusal does not carry the passphrase', async () => {
    const e = await saveVault('weak-msg', data, 'Konclave2026').catch((x: unknown) => x as StorageError)
    expect(String((e as StorageError).message)).not.toContain('Konclave2026')
  })

  it('the storage layer holds the only sealing with today\'s count, and each new-passphrase writer checks', () => {
    const src = codeOf('./storage.ts')
    const fns = src.split(/\n(?=export async function |async function |function |export function )/)
    const sealing = fns.filter((f) => /deriveKey\([^)]*PBKDF2_ITERS\)/.test(f)).map((f) => /function (\w+)/.exec(f)![1])
    // export, import and the upgrade seal under a passphrase they have just proved opens the record or the file:
    // an existing one, never a new one. A new writer has to be placed in one list or the other here.
    expect(sealing.sort()).toEqual(['changePassphrase', 'exportVault', 'importVault', 'saveVault', 'upgradeSeal'])
    for (const name of ['saveVault', 'changePassphrase']) {
      const body = fns.find((f) => new RegExp(`function ${name}\\b`).test(f))!
      const check = body.indexOf('requireNewPassphrase(')
      expect(check, name).toBeGreaterThan(-1)
      expect(check, name).toBeLessThan(body.indexOf('deriveKey('))
    }
    expect(/function exportVault[\s\S]*?await loadVault\(id, passphrase\)[\s\S]*?deriveKey\(passphrase, salt, PBKDF2_ITERS\)/.test(src)).toBe(true)
    expect(/function importVault[\s\S]*?decodeV2\(bundle, passphrase\)[\s\S]*?deriveKey\(passphrase, salt, PBKDF2_ITERS\)/.test(src)).toBe(true)
    // An alias of the count would hide a writer from the list above.
    expect(src.match(/\bPBKDF2_ITERS\b/g)!.length).toBe(13)
  })

  it('no screen keeps its own length check', () => {
    expect(codeOf('./screens/NetVault.tsx')).not.toMatch(/savePass\.length/)
    const settings = codeOf('./screens/Settings.tsx')
    expect(settings).toMatch(/newPassphraseProblem\(rotNew\)/)
    expect(settings).toMatch(/'weak-passphrase' \? t\('storage\.err\.weakPassphrase'\)/)
    expect(settings).not.toMatch(/rotNew\.length/)
    expect(codeOf('./components.tsx')).toMatch(/newPassphraseProblem\(value\)/)
  })
})

describe('an existing passphrase is never refused', () => {
  /** A record and a backup sealed under a weak passphrase, as an earlier build allowed. */
  async function weakBackup(): Promise<Awaited<ReturnType<typeof exportVault>>> {
    const salt = crypto.getRandomValues(new Uint8Array(16))
    const iv = crypto.getRandomValues(new Uint8Array(12))
    const base = await crypto.subtle.importKey('raw', new TextEncoder().encode('senha123'), 'PBKDF2', false, ['deriveKey'])
    const key = await crypto.subtle.deriveKey(
      { name: 'PBKDF2', salt, iterations: 600_000, hash: 'SHA-256' }, base,
      { name: 'AES-GCM', length: 256 }, false, ['encrypt'])
    const hex = (b: Uint8Array) => Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('')
    const payload = { id, groupKey: id, address: 'u1x', roster: ['A'], createdAt: 1, share: hex(data.sealedShare), accessSecret: null, beneficiaries: [] }
    const cipher = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, new TextEncoder().encode(JSON.stringify(payload))))
    return { format: 'konclave-vault-export', version: 2, exportedAt: 1, kdfIters: 600_000, salt: hex(salt), iv: hex(iv), cipher: hex(cipher) }
  }

  it('a backup under a weak passphrase imports, unlocks, exports again, and rotates to a strong one', async () => {
    await importVault(await weakBackup(), 'senha123', { overwrite: true })
    expect(Array.from((await loadVault(id, 'senha123')).sealedShare)).toEqual(Array.from(data.sealedShare))
    await expect(exportVault(id, 'senha123')).resolves.toBeTruthy()
    await changePassphrase(id, 'senha123', STRONG)
    await expect(loadVault(id, STRONG)).resolves.toBeTruthy()
  })
})

describe('the words exist', () => {
  it('in the dictionary the screens read', () => {
    const dict = en as Record<string, string>
    for (const k of ['pass.ruleShort', 'pass.ruleGuessable', 'storage.err.weakPassphrase']) expect(dict[k], k).toBeTruthy()
    expect(dict['net.persist.savePlaceholder']).toContain('12')
  })
})
