// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, render, screen } from '@testing-library/react'
import { MemoryRouter, Route, Routes } from 'react-router-dom'
import Docs from './screens/Docs'
import { REF_STATE_WORDS, wordFor } from './docs/ref-state'
import { I18nProvider } from './i18n'
import { ROADMAP_AS_OF, ROADMAP_LISTS, refKey, refUrl } from './docs/roadmap'
import { REF_INFO, REFS_AS_OF, type RefState } from './docs/roadmap-refs'

vi.mock('virtual:konclave-releases', () => ({ default: [] }))
// jsdom has no layout; the docs nav scrolls the current section into view.
Element.prototype.scrollIntoView = () => {}

// The roadmap as a reader meets it: every number it cites says its GitHub state in words, inside the
// link, so the state is part of the link's name and never colour alone.
const open = (locale: 'pt-BR' | 'en') => {
  localStorage.setItem('konclave.locale', locale)
  return render(
    <MemoryRouter initialEntries={['/docs/roadmap']}>
      <I18nProvider>
        <Routes>
          <Route path="/docs/:section" element={<Docs />} />
        </Routes>
      </I18nProvider>
    </MemoryRouter>,
  )
}

// Written out here, not imported from the screen, so a wrong label in the screen shows up.
const WORDS = {
  'pt-BR': { 'issue:open': 'Aberta', 'issue:closed': 'Fechada', 'issue:not-planned': 'Não planejada', 'pull:open': 'Aberto', 'pull:draft': 'Rascunho', 'pull:merged': 'Mesclado', 'pull:closed-unmerged': 'Fechado sem mesclar' },
  en: { 'issue:open': 'Open', 'issue:closed': 'Closed', 'issue:not-planned': 'Not planned', 'pull:open': 'Open', 'pull:draft': 'Draft', 'pull:merged': 'Merged', 'pull:closed-unmerged': 'Closed unmerged' },
} as const

afterEach(cleanup)

describe('the roadmap page', () => {
  for (const locale of ['pt-BR', 'en'] as const) {
    it(`says each ref's GitHub state in words, in the link's name (${locale})`, async () => {
      open(locale)
      await screen.findByRole('heading', { level: 1 })
      const refs = ROADMAP_LISTS.flat().flatMap((s) => s.refs)
      expect(refs.length).toBeGreaterThan(0)
      for (const r of refs) {
        const info = REF_INFO[refKey(r)]!
        const word = (WORDS[locale] as Record<string, string>)[`${r.kind}:${info.state}`]!
        const links = [...document.querySelectorAll(`a.docs-ref-chip[href="${refUrl(r)}"]`)]
        expect(links.length, refKey(r)).toBeGreaterThan(0)
        for (const a of links) {
          const state = a.querySelector('.docs-ref-state')!
          expect(state.textContent, refKey(r)).toBe(word)
          expect(state.getAttribute('data-state')).toBe(info.state)
          // Number, then state, then title: the name starts with what the eye reads first (WCAG 2.5.3).
          expect(a.textContent!.startsWith(`#${r.n}, `), refKey(r)).toBe(true)
          expect(a.textContent).toContain(`${word}: ${info.title}`)
          // The state word is not inside the English title's language span.
          const lang = state.closest('[lang="en"]')
          expect(lang !== null && a.contains(lang), refKey(r)).toBe(false)
        }
      }
    })
  }

  // Two dates: the step texts' (set by hand, at the top) and the GitHub read (the script, in the sentence).
  for (const [locale, gh, notLive, texts] of [
    ['en', `what GitHub showed on ${REFS_AS_OF.en}`, 'an issue closed or a pull request merged there does not mean the change is live', `As of ${ROADMAP_AS_OF.en}.`],
    ['pt-BR', `o que o GitHub mostrava em ${REFS_AS_OF['pt-BR']}`, 'uma issue fechada ou um pull request mesclado lá não quer dizer que a mudança já está no ar', `Situação em ${ROADMAP_AS_OF['pt-BR']}.`],
  ] as const) {
    it(`dates the states by the GitHub read and the texts by their review, and says closed is not live (${locale})`, async () => {
      open(locale)
      await screen.findByRole('heading', { level: 1 })
      const text = document.querySelector('article')!.textContent!
      expect(text).toContain(gh)
      expect(text).toContain(notLive)
      expect(text).toContain(texts)
    })
  }

  for (const [locale, start] of [['pt-BR', `No GitHub em ${REFS_AS_OF['pt-BR']}: `], ['en', `On GitHub on ${REFS_AS_OF.en}: `]] as const) {
    it(`dates the hover card by the GitHub read too (${locale})`, async () => {
      open(locale)
      await screen.findByRole('heading', { level: 1 })
      const cards = [...document.querySelectorAll('.docs-ref-card .docs-ref-asof')]
      expect(cards.length).toBeGreaterThan(0)
      const words = Object.values(WORDS[locale]).map((w) => w.toLowerCase())
      for (const c of cards) {
        expect(c.textContent!.startsWith(start), c.textContent!).toBe(true)
        expect(words).toContain(c.textContent!.slice(start.length, -1))
      }
    })
  }

  // The snapshot holds only some states today; every word the page can show is checked here, by kind.
  it('has the right word for every state GitHub can give each kind, in both languages', () => {
    for (const locale of ['pt-BR', 'en'] as const) {
      for (const [key, word] of Object.entries(WORDS[locale])) {
        const [kind, state] = key.split(':') as ['issue' | 'pull', RefState]
        expect(wordFor(kind, state, REF_STATE_WORDS[locale]), `${locale} ${key}`).toBe(word)
      }
      // A pairing GitHub cannot give has no word.
      expect(wordFor('issue', 'merged', REF_STATE_WORDS[locale])).toBeUndefined()
      expect(wordFor('pull', 'not-planned', REF_STATE_WORDS[locale])).toBeUndefined()
    }
  })
})
