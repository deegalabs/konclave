// The fee a screen shows and reserves comes from ONE rule, in konclave_seal, read through the wasm
// with the device's clock (#847, #692). These tests run the real wasm, so the figures are the rule's
// and not a copy of it; and a source scan fails if a screen does fee arithmetic of its own again.
import { fileURLToPath } from 'node:url'
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join, sep } from 'node:path'
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import init, { estimatedFeeZat, feeFrom } from './wasm-pkg/konclave_wasm.js'
import { readFeeEstimator } from './fee-estimate'
import { codeAt, codeOf } from './source-scan'
import { en as enDict } from './i18n/en'
import { ptBR as ptDict } from './i18n/pt-BR'

beforeAll(async () => {
  await init({ module_or_path: readFileSync(new URL('./wasm-pkg/konclave_wasm_bg.wasm', import.meta.url)) })
})
afterEach(() => {
  vi.useRealTimers()
})
const at = (iso: string) => {
  vi.useFakeTimers({ toFake: ['Date'] })
  vi.setSystemTime(new Date(iso))
}

describe('the fee estimate is the rule in konclave_seal', () => {
  it('one payee is three actions, more payees one action each, at the reserve rate', () => {
    at('2026-11-06T12:00:00Z')
    expect(estimatedFeeZat(1)).toBe(15_000)
    expect(estimatedFeeZat(2)).toBe(15_000)
    expect(estimatedFeeZat(3)).toBe(20_000)
    expect(estimatedFeeZat(10)).toBe(55_000)
  })

  it('still reserves 5,000 a action after block 3,590,000, because the device still accepts 5,000', () => {
    at('2027-01-15T12:00:00Z')
    expect(estimatedFeeZat(1)).toBe(15_000)
  })

  it('a clock before the network this app signs for gives no estimate, never a default', () => {
    at('2020-01-01T00:00:00Z')
    expect(estimatedFeeZat(1)).toBe(0)
    expect(readFeeEstimator()).toBeNull()
  })

  it('the estimator reads the clock on each call and refuses an unusable answer', () => {
    at('2026-11-06T12:00:00Z')
    const est = readFeeEstimator()
    expect(est?.(1)).toBe(15_000)
    expect(est?.(0)).toBe(15_000)
    expect(readFeeEstimator(() => 0)).toBeNull()
    expect(readFeeEstimator(() => 1.5)).toBeNull()
    expect(readFeeEstimator(() => Number.NaN)).toBeNull()
    // An estimator that stops answering later gives null, never NaN.
    let n = 15_000
    const later = readFeeEstimator(() => n)
    n = 0
    expect(later?.(1)).toBeNull()
  })
})

// The clock refusal must never invite moving the clock forward: a member who sets it ahead to make
// the device sign gets a payment below the fee in force signed (security review of #855).
describe('the clock refusal warns against setting the clock ahead', () => {
  it('in both languages', () => {
    expect(enDict['net.err.feeClock']).toMatch(/never set it ahead of the real time/)
    expect(ptDict['net.err.feeClock']).toMatch(/nunca adiante além da hora real/)
    expect(enDict['net.err.feeClock']).not.toMatch(/usually/)
    expect(ptDict['net.err.feeClock']).not.toMatch(/Em geral/)
  })
})

describe('every screen that shows or gates a fee reads the one estimate', () => {
  for (const f of ['./screens/NewPayment.tsx', './screens/NewPayroll.tsx', './screens/Proposal.tsx', './screens/SigningPanel.tsx']) {
    it(f, () => {
      const src = codeOf(f)
      expect(src).toContain('useFeeEstimate()')
      expect(src).toMatch(/feeEstimator\(/)
    })
  }
})

// A second copy of the fee rule in TypeScript is how one payment came to show two fees (#692).
// Production code only: tests keep their own oracle numbers so they do not check the rule against
// itself, and the generated wasm package is the rule.
describe('no fee arithmetic outside the rule', () => {
  const SRC = fileURLToPath(new URL('.', import.meta.url))
  const files: string[] = []
  const walk = (d: string) => {
    for (const n of readdirSync(d)) {
      const p = join(d, n)
      if (statSync(p).isDirectory()) {
        if (n !== 'wasm-pkg') walk(p)
      } else if (/\.tsx?$/.test(n) && !/\.test\.tsx?$/.test(n) && n !== 'source-scan.ts') files.push(p.split(sep).join('/'))
    }
  }
  walk(SRC)
  walk(join(SRC, '../../sdk/src'))

  // A marginal fee times something, a fee assigned a number, a line about a fee carrying one of the
  // two rates, or the old constants. (`* 1000` alone is milliseconds everywhere in this app.)
  const PATTERNS = [
    /\b5_?000\s*\*|\*\s*5_?000\b/,
    /\bfee\w*\s*[=:]\s*\d[\d_]{3,}/i,
    // (a ZIP number is a name, not an amount: "ZIP 2009")
    /(fee|marginal)[^\n]*(?<![\w.])(?<!ZIP )\d{1,3}_?\d{3}(?![\w.])/i,
    /SINGLE_PAYMENT_FEE_ZAT|GRACE_ACTIONS|MARGINAL_FEE/,
    // The height ZIP 2009 switches on (#847): a seat reports it from the table, through the wasm.
    /(?<![\w.])3_?590_?000(?![\w.])/,
  ]

  it('scans the screens and the sdk', () => {
    expect(files.some((f) => f.endsWith('screens/NewPayroll.tsx'))).toBe(true)
    expect(files.some((f) => f.includes('/sdk/src/'))).toBe(true)
  })

  it('finds none', () => {
    const hits: string[] = []
    for (const f of files) {
      codeAt(f)
        .split('\n')
        .forEach((line, i) => {
          if (PATTERNS.some((p) => p.test(line))) hits.push(`${f}:${i + 1}: ${line.trim()}`)
        })
    }
    expect(hits, 'a fee rule is written here; it lives in konclave_seal (read it through fee-estimate.ts)').toEqual([])
  })

  it('and does not take a ZIP number for a fee', () => {
    expect(PATTERNS.some((p) => p.test('the fee drops under ZIP 2009 at a later height'))).toBe(false)
  })

  it('and does not take a longer number or a property for the height', () => {
    for (const fine of ['const id = 35900001', 'x.3590000', 'const n = 13590000']) {
      expect(PATTERNS.some((p) => p.test(fine)), fine).toBe(false)
    }
  })

  it('and would find one', () => {
    for (const planted of [
      'const soloFeeZat = count * 5000 * 2',
      'const feeZat = 15000',
      'const feeZat = 15_000',
      'const feeZat = feeEstimator ? feeEstimator(1) : 15000',
      'const feeZat = est(1) ?? 10_000',
      'const marginalFee = 1_000',
      'return 5000 * Math.max(2, n)',
      'return 3590000',
      '}, proof, 3_590_000)',
      "const h = typeof f === 'function' ? f() : 3590000",
    ]) {
      expect(PATTERNS.some((p) => p.test(planted)), planted).toBe(true)
    }
  })
})

describe('the fee era this build accepts, reported to the coordinator', () => {
  it('feeFrom is the height ZIP 2009 switches on, read from the table in the wasm', () => {
    // A literal on purpose: the number is the table's, and this fails the day it moves alone.
    expect(feeFrom()).toBe(3_590_000)
  })
})
