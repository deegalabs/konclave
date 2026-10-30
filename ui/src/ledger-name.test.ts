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
