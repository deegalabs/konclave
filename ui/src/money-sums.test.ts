import { readdirSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { sumZat, zatToZec } from './format'
import { codeOf } from './source-scan'

// #303: the ledger added decimal strings as floating-point numbers, so over dozens of 8-place
// entries the printed total could drift from the sum of the rows. Money is summed in integer
// zatoshi and formatted once. The scan covers the Ledger: the Dashboard still sums with
// `parseFloat` (Dashboard.tsx, not this PR's file) and joins the list when that changes.

describe('money is summed in integer zatoshi (#303)', () => {
  it('sumZat adds value_zat exactly, where the float sum of the decimals drifts', () => {
    const rows = [{ value_zat: 10_000_000 }, { value_zat: 20_000_000 }, { value_zat: 1 }]
    expect(sumZat(rows)).toBe(30_000_001)
    expect(zatToZec(sumZat(rows))).toBe('0.30000001')
    expect(0.1 + 0.2 + 0.00000001).not.toBe(0.30000001) // what the screen used to do
  })

  // Every way a decimal amount becomes a float in a sum: `+ Number(x)`, `Number(x) +`, `+= Number(x)`,
  // `parseFloat(x)` in any position, and `+ x.value_zec` with no wrapper at all.
  const FLOAT_SUM = [/\+=?\s*Number\(/, /Number\([^)]*\)\s*\+/, /parseFloat\(/, /\+=?\s*\w+\.value_zec\b/]
  const SCANNED = ['Ledger.tsx']

  it('the Ledger adds no amount as floating point', () => {
    const dir = fileURLToPath(new URL('./screens/', import.meta.url))
    expect(readdirSync(dir)).toEqual(expect.arrayContaining(SCANNED)) // the list names real files
    const offenders: string[] = []
    for (const f of SCANNED) {
      const src = codeOf(`screens/${f}`) // comments stripped, so a commented-out sum cannot hide
      src.split('\n').forEach((line, i) => {
        if (FLOAT_SUM.some((re) => re.test(line))) offenders.push(`${f}:${i + 1}: ${line.trim()}`)
      })
    }
    expect(offenders).toEqual([])
  })

  it('the patterns catch what the old scan let through', () => {
    for (const bad of ['acc += Number(p.value_zec)', 'parseFloat(p.value_zec) + acc', 'acc + p.value_zec', 'x = 1 + Number(p.value_zec)']) {
      expect(FLOAT_SUM.some((re) => re.test(bad)), bad).toBe(true)
    }
    for (const ok of ['acc + p.value_zat', 'fmtZecExact(Number(totalOut))', 'zatToZec(sumZat(settled))']) {
      expect(FLOAT_SUM.some((re) => re.test(ok)), ok).toBe(false)
    }
  })
})
