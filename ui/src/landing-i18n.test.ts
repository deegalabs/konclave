import { describe, expect, it } from 'vitest'
import { en } from './i18n/en'
import { ptBR } from './i18n/pt-BR'
import { codeOf } from './source-scan'

// #318 part B: the landing carried its own bilingual copy (`pt ? '…' : '…'`), outside the
// dictionary, so the parity test never saw it. These pin that the landing and the loading
// placeholders read the dictionary, and that what they read exists in both languages. Source is
// read with comments stripped, so a comment cannot satisfy or trip a pin.
const src = codeOf

describe('the landing and the skeletons read the dictionary (#318)', () => {
  it('Intro.tsx carries no inline bilingual copy and no English-only aria-label', () => {
    const s = src('./screens/Intro.tsx')
    expect(s).not.toMatch(/\bpt \?/)
    expect(s).not.toMatch(/aria-label="[A-Za-z]/)
    expect(s).toContain("useT()")
  })

  it('skeleton.tsx announces loading from the dictionary', () => {
    const s = src('./skeleton.tsx')
    expect(s).not.toMatch(/aria-label="[A-Za-z]/)
    expect(s).toContain("t('skeleton.loading')")
  })

  it('every landing key the screens read exists in both languages, and the two differ', () => {
    const keys = [...src('./screens/Intro.tsx').matchAll(/\bt\w?\('(lv\.[\w]+)'/g)].map((m) => m[1]!)
    expect(keys.length).toBeGreaterThan(25)
    for (const k of new Set([...keys, 'skeleton.loading'])) {
      expect(en[k], k).toBeTruthy()
      expect(ptBR[k], k).toBeTruthy()
    }
    expect(en['lv.h1']).not.toBe(ptBR['lv.h1'])
    expect(en['lv.soonWhy']).toContain('{ver}')
    expect(ptBR['lv.soonWhy']).toContain('{ver}')
  })
})
