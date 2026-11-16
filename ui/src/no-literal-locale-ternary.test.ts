import { describe, expect, it } from 'vitest'
import { codeOf } from './source-scan'

// A string chosen by `pt ? 'a' : 'b'` bypasses the dictionaries, so the two languages drift and the
// symmetry test never sees it (#228). These shell screens say everything through t().
const FILES = ['screens/Vaults.tsx', 'Layout.tsx']
const LITERAL = /(\bpt|locale\s*===\s*'pt-BR')\s*\?(?!\.)/g

describe('no literal locale ternary', () => {
  for (const f of FILES) {
    it(`${f} has none`, () => {
      // Whole file, not line by line: the ternary can break after `pt`.
      const src = codeOf(f)
      const hits = [...src.matchAll(LITERAL)].map((m) => `${f}:${src.slice(0, m.index).split('\n').length}`)
      expect(hits).toEqual([])
    })
  }
})
