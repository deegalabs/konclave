import { describe, expect, it } from 'vitest'
import { en } from './i18n/en'
import { ptBR } from './i18n/pt-BR'

// The book has one name. The side menu, the screen it opens and the activity tab all point at the
// same ledger, and a member who reads one word in the menu and another on the screen has to work
// out that they are one thing. The rule is per language: whatever the word, the three agree.
describe('the ledger has one name per language', () => {
  for (const [name, dict] of [['en', en], ['pt-BR', ptBR]] as const) {
    it(`${name}: the menu entry, the screen title and the activity tab say the same word`, () => {
      expect(dict['nav.ledger']).toBe(dict['ledger.title'])
      expect(dict['activity.tab.ledger']).toBe(dict['ledger.title'])
    })
  }
})

// The word, not only the three labels: a Portuguese text elsewhere that still says "razão" (or sends a
// member to "o registro" for the book) gives the book a second name back.
describe('the book is "Livro" in every Portuguese text', () => {
  it('no Portuguese string or in-app doc calls the book "razão"', async () => {
    const { SECTIONS } = await import('./docs/content')
    const docs = JSON.stringify(SECTIONS)
    const hits = Object.entries(ptBR).filter(([, v]) => /raz[ãa]o/i.test(v)).map(([k]) => k)
    expect(hits).toEqual([])
    expect(docs.match(/[^"]{0,30}raz[ãa]o[^"]{0,30}/gi) ?? []).toEqual([])
  })
  it('the crash screen sends the member to the book by its name', () => {
    expect(en['crash.lead']).toMatch(/ledger/)
    expect(ptBR['crash.lead']).toMatch(/livro/)
  })
})
