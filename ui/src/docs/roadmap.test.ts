import { describe, expect, it } from 'vitest'
import { SECTIONS } from './content'
import { ROADMAP_AS_OF, ROADMAP_LATER, ROADMAP_LISTS, ROADMAP_NOW, ROADMAP_STEPS, refKey, refUrl } from './roadmap'
import { REF_INFO, REFS_AS_OF } from './roadmap-refs'

const ALL = ROADMAP_LISTS.flat()
const roadmapSection = () => SECTIONS.find((s) => s.id === 'roadmap')

describe('the public roadmap', () => {
  it('is a docs section that shows the work outside the order, the steps and the later work', () => {
    const section = roadmapSection()
    expect(section).toBeDefined()
    const stages = section!.blocks.filter((b) => b.k === 'stages')
    expect(stages).toHaveLength(3)
    // The work outside the order comes first, before the numbered steps.
    expect(stages.map((b) => b.k === 'stages' && b.items)).toEqual(ROADMAP_LISTS)
    expect(ROADMAP_LISTS).toEqual([ROADMAP_NOW, ROADMAP_STEPS, ROADMAP_LATER])
  })

  it('keeps the network upgrade outside the order, as current work with no number', () => {
    expect(ROADMAP_NOW.length).toBeGreaterThan(0)
    for (const s of ROADMAP_NOW) {
      expect(s.n, s.id).toBeUndefined()
      expect(s.status, s.id).toBe('now')
    }
    expect(ROADMAP_NOW.flatMap((s) => s.refs.map(refKey))).toEqual(expect.arrayContaining(['issue:638', 'pull:701']))
  })

  it('does not say a step waits for the one before it to be done', () => {
    // The order is the intended order; a step can start before the one before it closes (step 1 did).
    const text = JSON.stringify(roadmapSection())
    expect(text).not.toMatch(/starts once the one before it is done|começa quando a anterior termina/)
  })

  it('numbers the steps in order, from 0', () => {
    expect(ROADMAP_STEPS.map((s) => s.n)).toEqual(ROADMAP_STEPS.map((_, i) => i))
    expect(ROADMAP_LATER.every((s) => s.n === undefined)).toBe(true)
    expect(ROADMAP_NOW.every((s) => s.n === undefined)).toBe(true)
  })

  it('points every step at the work that tracks it, and knows each title and GitHub state', () => {
    for (const s of ALL) {
      expect(s.refs.length, s.id).toBeGreaterThan(0)
      for (const r of s.refs) {
        const info = REF_INFO[refKey(r)]
        expect(info?.title, `${s.id} -> ${refKey(r)} title`).toBeTruthy()
        expect(info?.state, `${s.id} -> ${refKey(r)} state`).toBeTruthy()
      }
    }
  })

  it('keeps no title or state that no step points to', () => {
    const used = new Set(ALL.flatMap((s) => s.refs.map(refKey)))
    expect(Object.keys(REF_INFO).filter((k) => !used.has(k))).toEqual([])
  })

  // GitHub's own states, by kind: an issue is never merged or a draft, a pull request is never "not planned".
  it('gives each ref a state GitHub can give that kind of ref', () => {
    const ISSUE = ['open', 'closed', 'not-planned']
    const PULL = ['open', 'draft', 'merged', 'closed-unmerged']
    for (const [key, info] of Object.entries(REF_INFO)) {
      expect(key.startsWith('pull:') ? PULL : ISSUE, key).toContain(info.state)
    }
  })

  // Two dates on purpose: ROADMAP_AS_OF is when a person last re-read the step texts, REFS_AS_OF when the
  // script last read GitHub. A text newer than the states beside it would show states nobody checked
  // against it.
  it('reads GitHub no earlier than the step texts were last re-read, and never in the future', () => {
    const day = /^\d{4}-\d{2}-\d{2}$/
    expect(REFS_AS_OF.iso).toMatch(day)
    expect(ROADMAP_AS_OF.iso).toMatch(day)
    expect(REFS_AS_OF.iso >= ROADMAP_AS_OF.iso).toBe(true)
    expect(REFS_AS_OF.iso <= new Date().toISOString().slice(0, 10)).toBe(true)
    const [y, , d] = REFS_AS_OF.iso.split('-')
    expect(REFS_AS_OF['pt-BR']).toMatch(new RegExp(`^${Number(d)} de [a-zç]+ de ${y}$`))
    expect(REFS_AS_OF.en).toMatch(new RegExp(`^${Number(d)} [A-Z][a-z]+ ${y}$`))
  })

  // A number written in a step's text is a promise that the step tracks it: it must be among the step's
  // issue refs, so it carries a title and a state like the others. Issues only: the page renders "#N" in
  // a text as an issue link, so a pull request cited that way would link to the wrong place.
  it('cites in a step text only the numbers the step points to', () => {
    for (const s of ALL) {
      const own = new Set(s.refs.filter((r) => r.kind === 'issue').map((r) => r.n))
      for (const loc of ['pt-BR', 'en'] as const) {
        for (const m of s.body[loc].matchAll(/(?<![\w/])#(\d+)\b/g)) {
          expect(own.has(Number(m[1])), `${s.id} ${loc} cites #${m[1]}`).toBe(true)
        }
      }
    }
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
    const text = JSON.stringify(roadmapSection()) + JSON.stringify(REF_INFO)
    expect(text).not.toMatch(/\$|\bUSD\b|\bhours?\b|\bhoras?\b/i)
  })

  it('links to the issue or pull request on GitHub', () => {
    expect(refUrl({ kind: 'issue', n: 599 })).toBe('https://github.com/deegalabs/konclave/issues/599')
    expect(refUrl({ kind: 'pull', n: 259 })).toBe('https://github.com/deegalabs/konclave/pull/259')
  })
})
