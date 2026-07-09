import { describe, expect, it } from 'vitest'
import { en } from './en'
import { ptBR } from './pt-BR'
import { interpolate } from './index'

describe('locale dictionaries', () => {
  it('are symmetric: EN and PT-BR define exactly the same keys', () => {
    const enKeys = Object.keys(en).sort()
    const ptKeys = Object.keys(ptBR).sort()
    const missingInPt = enKeys.filter((k) => !(k in ptBR))
    const missingInEn = ptKeys.filter((k) => !(k in en))
    expect(missingInPt, `keys missing in pt-BR: ${missingInPt.join(', ')}`).toEqual([])
    expect(missingInEn, `keys missing in en: ${missingInEn.join(', ')}`).toEqual([])
  })

  it('have no empty values', () => {
    for (const [k, v] of Object.entries(en)) expect(v.length, `en.${k} is empty`).toBeGreaterThan(0)
    for (const [k, v] of Object.entries(ptBR)) expect(v.length, `pt-BR.${k} is empty`).toBeGreaterThan(0)
  })

  it('keep the same {placeholder} set per key across locales', () => {
    const vars = (s: string | undefined) => ((s ?? '').match(/\{(\w+)\}/g) ?? []).sort().join(',')
    for (const k of Object.keys(en)) {
      if (k in ptBR) expect(vars(ptBR[k]), `placeholders differ for "${k}"`).toBe(vars(en[k]))
    }
  })
})

describe('interpolate', () => {
  it('substitutes named placeholders', () => {
    expect(interpolate('{n} of {total}', { n: 2, total: 3 })).toBe('2 of 3')
    expect(interpolate('hi {who}', { who: 'Alice' })).toBe('hi Alice')
  })
  it('replaces every occurrence of a placeholder', () => {
    expect(interpolate('{x}-{x}', { x: 'a' })).toBe('a-a')
  })
  it('leaves the string untouched when there are no vars or no match', () => {
    expect(interpolate('plain')).toBe('plain')
    expect(interpolate('{unknown}', { other: 1 })).toBe('{unknown}')
  })
})
