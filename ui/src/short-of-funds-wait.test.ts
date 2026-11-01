import { describe, expect, it } from 'vitest'
import { en } from './i18n/en'
import { ptBR } from './i18n/pt-BR'

/* (#710): the short-of-funds message says what to expect.
 *
 * A member who has just sent funds to the vault reads "short" and cannot tell whether the money is
 * on the way. Both messages that block on a shortfall say that a deposit counts once it is mined,
 * that it takes a few blocks, and that nothing is lost. No clock time: blocks do not keep one, so a
 * number of minutes would be a promise the network does not make.
 */

const KEYS = ['proposal.costShort', 'signing.blockedShort']
const LOCALES = { en, 'pt-BR': ptBR }

describe('the short-of-funds message carries the wait (#710)', () => {
  for (const [loc, dict] of Object.entries(LOCALES)) {
    for (const k of KEYS) {
      const s = dict[k]!
      it(`${loc} ${k} keeps the shortfall`, () => {
        expect(s).toContain('{short}')
      })
      it(`${loc} ${k} says a few blocks, and names no minutes`, () => {
        expect(s).toMatch(loc === 'en' ? /a few blocks/ : /alguns blocos/)
        expect(s).not.toMatch(/minute|minuto/i)
      })
      it(`${loc} ${k} says the funds count once mined, and that nothing is lost`, () => {
        if (loc === 'en') {
          expect(s).toMatch(/once the network mines them/)
          expect(s).toMatch(/nothing is lost/i)
        } else {
          expect(s).toMatch(/quando a rede o minera/)
          expect(s).toMatch(/nada (se perde|foi perdido)/i)
        }
      })
    }
  }
})
