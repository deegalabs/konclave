import { afterEach, describe, expect, it, vi } from 'vitest'
import { copyText } from './clipboard'
import { codeOf } from './source-scan'

// #313: Add funds (the vault's address and the payment link) and the proof page (txids) said
// "Copied" whatever the clipboard did. They now say it only when the write resolved, and say so
// when it did not.
describe('copyText says what the clipboard did', () => {
  const original = Object.getOwnPropertyDescriptor(globalThis, 'navigator')
  afterEach(() => { if (original) Object.defineProperty(globalThis, 'navigator', original); else delete (globalThis as { navigator?: unknown }).navigator })
  const withClipboard = (writeText: unknown) =>
    Object.defineProperty(globalThis, 'navigator', { value: { clipboard: writeText ? { writeText } : undefined }, configurable: true })

  it('is true when the browser confirmed the write', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined)
    withClipboard(writeText)
    expect(await copyText('u1x')).toBe(true)
    expect(writeText).toHaveBeenCalledWith('u1x')
  })
  it('is false when the write was refused, and the rejection does not escape', async () => {
    withClipboard(vi.fn().mockRejectedValue(new DOMException('denied', 'NotAllowedError')))
    expect(await copyText('u1x')).toBe(false)
  })
  it('is false when there is no clipboard at all (an insecure context)', async () => {
    withClipboard(undefined)
    expect(await copyText('u1x')).toBe(false)
  })
})

describe('the two screens go through it and claim nothing on their own', () => {
  for (const f of ['screens/Receive.tsx', 'screens/Proof.tsx']) {
    it(`${f} awaits the write and says when it failed`, () => {
      const src = codeOf(f)
      expect(src).not.toMatch(/void navigator\.clipboard/)
      expect(src).not.toMatch(/navigator\.clipboard/)
      expect(src).toMatch(/await copyText\(/)
      expect(src).toMatch(/copyErr|copyFailed/)
    })
  }
})

// #313, the rest: the /net page copied the vault's address and the signing-session code without
// waiting for the clipboard, and said nothing either way. Every write there is now awaited (the
// address through copyText, the session code through the shared CopyButton, the backup's own copy
// directly), and the address says whether it was copied.
describe('the /net page claims nothing about a copy it did not wait for', () => {
  it('every clipboard write in NetVault.tsx is awaited', () => {
    const src = codeOf('screens/NetVault.tsx')
    const writes = [...src.matchAll(/navigator\.clipboard\??\.writeText\(/g)]
    for (const w of writes) expect(src.slice(Math.max(0, w.index! - 6), w.index)).toBe('await ')
    // "Copied" only from the answer, and the refusal said: the one form that cannot claim success.
    expect(src).toMatch(/setAddrCopy\(\(await copyText\(hostedAddress\)\) \? 'copied' : 'failed'\)/)
    expect(src).toMatch(/addrCopy === 'failed' && <p[^>]*role="alert">\{tt\('toast\.copyFailed'\)\}/)
    // No other way round it: an alias of the clipboard, or a copy nobody waits for.
    expect(src).not.toMatch(/=\s*navigator\.clipboard\b/)
    expect(src).not.toMatch(/void copyText\(/)
  })
})

// #978: one implementation. Every copy in the app goes through copyText, so what "Copied" means is
// decided once; and a screen whose copy can be refused says so (CopyButton excepted: a public code
// on screen, where it stays silent by design, #474, and never claims a copy it did not make).
describe('the app copies through one function', () => {
  it('only clipboard.ts touches navigator.clipboard, tests aside', async () => {
    const { readdirSync } = await import('node:fs')
    const { fileURLToPath } = await import('node:url')
    const here = fileURLToPath(new URL('.', import.meta.url))
    const found: string[] = []
    const walk = (dir: string) => {
      for (const e of readdirSync(dir, { withFileTypes: true })) {
        const path = `${dir}/${e.name}`
        if (e.isDirectory()) { if (!['wasm-pkg', 'node_modules'].includes(e.name)) walk(path); continue }
        if (!/\.(ts|tsx)$/.test(e.name) || /\.test\.tsx?$/.test(e.name)) continue
        const rel = path.slice(here.length).replace(/^\//, '')
        if (/navigator\s*\??\.\s*clipboard|\bclipboard\s*\??\.\s*writeText|\{\s*clipboard\b[^}]*\}\s*=\s*(window\.|globalThis\.)?navigator|\[\s*['"`]clipboard['"`]\s*\]|execCommand\s*\(\s*['"`]copy/.test(codeOf(rel))) found.push(rel)
      }
    }
    walk(here.replace(/\/$/, ''))
    expect(found).toEqual(['clipboard.ts'])
  }, 30_000)

  // Each site's own form, pinned: "Copied" and the refusal both come from the ONE answer, and the
  // refusal is shown where the member is. A looser pin (the call and the key somewhere in the file)
  // stayed green with "Copied" set before the answer.
  const SITES: ReadonlyArray<[string, RegExp[]]> = [
    ['screens/Ceremony.tsx', [
      /const ok = await copyText\(passphrase\); setWordCopied\(ok\); setWordCopyFailed\(!ok\)/,
      /\{wordCopyFailed && <p className="hint err" role="alert">\{t\('toast\.copyFailed'\)\}<\/p>\}/,
    ]],
    ['screens/NetVault.tsx', [
      /const ok = await copyText\(backup\.json\)\s*setBackupCopyFailed\(!ok\); setBackupCopied\(ok\)\s*if \(!ok\) return/,
      /\{backupCopyFailed && <p className="net-tip" role="alert">\{tt\('copy\.failedUseDownload'\)\}<\/p>\}/,
    ]],
    ['screens/Vaults.tsx', [
      /const ok = await copyText\(resumeDone\[v\.id\]!\.json\)\s*setResumeCopyFailed\(!ok\); setResumeCopied\(ok\)/,
      /\{resumeCopyFailed && <p className="hint err" role="alert">\{t\('copy\.failedUseDownload'\)\}<\/p>\}/,
    ]],
    ['screens/Settings.tsx', [/if \(!\(await copyText\(out\.json\)\)\) \{ setXpErr\(t\('export\.errClipboard'\)\); return \}/]],
    ['CopyButton.tsx', [/if \(!\(await copyText\(value\)\)\) return\s*setDone\(true\)/]],
  ]
  for (const [f, pins] of SITES) {
    it(`${f} says "Copied" only from the answer, and says a refusal`, () => {
      const src = codeOf(f)
      for (const p of pins) expect(src, f).toMatch(p)
    })
  }
})
