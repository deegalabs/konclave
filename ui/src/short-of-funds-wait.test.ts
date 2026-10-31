import { describe, expect, it } from 'vitest'
import { CONFIRMATIONS_UNTRUSTED } from './api'
import { en } from './i18n/en'
import { ptBR } from './i18n/pt-BR'

/* (#710): the short-of-funds message says what to expect.
 *
 * A member who has just sent funds to the vault reads "short" and cannot tell whether the money is
 * on the way. Both messages that block on a shortfall say that a deposit counts once it is mined,
 * how many confirmations it needs, and that nothing is lost. The number is the wallet's, not ours,
 * so the copy is checked against the constant: a sentence that says 10 while the wallet waits for
 * something else would be a promise the code does not keep. */

const KEYS = ['proposal.costShort', 'signing.blockedShort']
const LOCALES = { en, 'pt-BR': ptBR }

describe('the short-of-funds message carries the wait (#710)', () => {
  for (const [loc, dict] of Object.entries(LOCALES)) {
    for (const k of KEYS) {
      const s = dict[k]!
      it(`${loc} ${k} keeps the shortfall`, () => {
        expect(s).toContain('{short}')
      })
      it(`${loc} ${k} names the wallet's confirmation count`, () => {
        expect(s).toContain(`${CONFIRMATIONS_UNTRUSTED} confirma`)
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
