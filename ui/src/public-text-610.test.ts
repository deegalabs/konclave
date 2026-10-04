/// <reference types="node" />
// #610 is fixed: no public text may still say that a device does not check what it shows against what
// it signs. The 2026-10 staging cut (#618) wrote those sentences while the fix was open, and a merge
// keeps them silently, so the next merge that does is caught here instead of in a forum post.
import { describe, expect, it } from 'vitest'
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'

const ROOT = join(__dirname, '..', '..')
// The sentences themselves, in the shapes they were written in.
const STALE =
  /not yet check\w* (what it shows )?against what it signs|not yet checked against what it signs|nothing checks it yet \(#610\)|not yet a check on the coordinator|until (both|#567 and #610|two fixes land)|that they cannot yet check that whoever assembles|does not yet check what it shows|ainda não confere se o que mostra|ainda não é conferido com o que ele assina|ainda não serve para conferir o coordenador|ainda não conseguem conferir se quem monta/i

function files(dir: string, ext: RegExp, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    if (name === 'node_modules' || name === 'archive' || name === 'wasm-pkg' || name.startsWith('.')) continue
    const p = join(dir, name)
    if (statSync(p).isDirectory()) files(p, ext, out)
    else if (ext.test(name)) out.push(p)
  }
  return out
}

describe('public text after #610', () => {
  const paths = [
    ...['README.md', 'SECURITY.md', 'CLAUDE.md', 'CONTRIBUTING.md', 'DEPLOY.md'].map((f) => join(ROOT, f)),
    ...files(join(ROOT, 'docs'), /\.md$/),
    ...files(join(ROOT, 'ui', 'src', 'docs'), /\.tsx?$/),
    ...files(join(ROOT, 'ui', 'src', 'i18n'), /\.ts$/),
    join(ROOT, 'ui', 'src', 'proof-record.ts'),
  ]

  it('reads the files it means to read', () => {
    expect(paths.length).toBeGreaterThan(20)
    expect(paths.some((p) => p.endsWith('SECURITY.md'))).toBe(true)
    expect(paths.some((p) => p.endsWith('content.ts'))).toBe(true)
  })

  it('catches the sentences it is written for', () => {
    for (const s of [
      'what it shows is not yet checked against what it signs (#610)',
      'a signing device does not yet check what it shows against what it signs',
      'the address on it is a label the coordinator writes, and nothing checks it yet (#610)',
      'neither is yet a check on the coordinator, not yet a check on the coordinator',
      'until #567 and #610 are fixed, a payment',
      'um aparelho que, ao assinar, ainda não confere se o que mostra é o que assina',
      'o que ele mostra ainda não é conferido com o que ele assina, #610',
    ]) expect(STALE.test(s), s).toBe(true)
  })

  it('no file says that a device does not yet check what it shows against what it signs', () => {
    const hits = paths
      .map((p) => ({ p, text: readFileSync(p, 'utf8') }))
      .filter(({ text }) => STALE.test(text))
      .map(({ p }) => relative(ROOT, p))
    expect(hits).toEqual([])
  })
})
