import { describe, expect, it } from 'vitest'
import { SECTIONS } from './content'
import { REF_TITLES, ROADMAP_LATER, ROADMAP_STEPS, refKey, refUrl } from './roadmap'

const ALL = [...ROADMAP_STEPS, ...ROADMAP_LATER]
const roadmapSection = () => SECTIONS.find((s) => s.id === 'roadmap')

describe('the public roadmap', () => {
  it('is a docs section that shows the steps and the later work', () => {
    const section = roadmapSection()
    expect(section).toBeDefined()
    expect(section!.blocks.filter((b) => b.k === 'stages')).toHaveLength(2)
  })

  it('numbers the steps in order, from 0', () => {
    expect(ROADMAP_STEPS.map((s) => s.n)).toEqual(ROADMAP_STEPS.map((_, i) => i))
    expect(ROADMAP_LATER.every((s) => s.n === undefined)).toBe(true)
  })

  it('points every step at the work that tracks it, and knows each title', () => {
    for (const s of ALL) {
      expect(s.refs.length, s.id).toBeGreaterThan(0)
      for (const r of s.refs) expect(REF_TITLES[refKey(r)], `${s.id} -> ${refKey(r)}`).toBeTruthy()
    }
  })

  it('keeps no title that no step points to', () => {
    const used = new Set(ALL.flatMap((s) => s.refs.map(refKey)))
    expect(Object.keys(REF_TITLES).filter((k) => !used.has(k))).toEqual([])
  })

  it('says every step in both languages, under a unique id', () => {
    for (const s of ALL) {
      for (const loc of ['pt-BR', 'en'] as const) {
        expect(s.title[loc].trim(), `${s.id} title ${loc}`).not.toBe('')
        expect(s.body[loc].trim(), `${s.id} body ${loc}`).not.toBe('')
      }
    }
    expect(new Set(ALL.map((s) => s.id)).size).toBe(ALL.length)
  })

  // The roadmap is public; amounts and hour estimates are the founders' working notes, not a promise
  // to anyone. A guard rather than a reminder, because the obvious copy-paste from those notes would
  // carry them over.
  it('carries no amounts or hour estimates', () => {
    const text = JSON.stringify(roadmapSection()) + JSON.stringify(REF_TITLES)
    expect(text).not.toMatch(/\$|\bUSD\b|\bhours?\b|\bhoras?\b/i)
  })

  it('links to the issue or pull request on GitHub', () => {
    expect(refUrl({ kind: 'issue', n: 599 })).toBe('https://github.com/deegalabs/konclave/issues/599')
    expect(refUrl({ kind: 'pull', n: 259 })).toBe('https://github.com/deegalabs/konclave/pull/259')
  })
})
