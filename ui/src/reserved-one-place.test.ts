import { readdirSync, statSync } from 'node:fs'
import { join, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { codeAt, stripComments } from './source-scan'

// #1017: "reserved" summed only each open proposal's value in a second place, and a fee added in the
// first place left the second one wrong. The fee is now part of ONE sum (`reservedZatOf`, over
// `proposalCostZat`), and a typed contract is not enough on its own: `sumZat` takes any `{ value_zat }`
// and a `for` loop takes anything. So this reads the code. Outside the two files that own the rule, a
// line that accumulates `value_zat`, or calls `sumZat`, must be one of the listed exceptions, each
// with the reason it is a different figure and not a reservation.
//
// The scan is LINE-BASED: it sees one line of comment-free code at a time, so it catches the usual
// shapes (a reduce, `+=`, a `+`, `sumZat(`, or the amounts mapped out for an alias) and not a sum
// split so that no one line names `value_zat` and an addition together. It is a net, not a proof.
const SRC = fileURLToPath(new URL('.', import.meta.url))
const OWNERS = new Set(['balance-parts.ts', 'proposal-cost.ts'])

/** A line that adds `value_zat` up, or calls the generic sum. */
export const ACCUMULATES = [
  /value_zat[^\n]*(reduce\(|\+=)|(reduce\(|\+=)[^\n]*value_zat/,
  /(?<![\w.])\+\s*[\w.?!(]*value_zat\b|\bvalue_zat\)?\s*\+(?!\+)/,
  // The amounts pulled out on their own, to be added up on a later line through an alias.
  /\.map\(\s*\(?\w+\)?\s*=>\s*[\w.?!]*value_zat\s*\)/,
  /\bsumZat\(/,
]

/** Where a sum of `value_zat` is not a reservation, and why. Matched per file against the code line. */
export const EXCEPTIONS: { file: string; line: RegExp; why: string }[] = [
  { file: 'format.ts', line: /sumZat|items\.reduce\(\(acc, i\) =>/, why: 'the generic helper itself' },
  { file: 'approved-payment.ts', line: /lines\.reduce\(\(sum, l\) => sum \+ l\.value_zat/, why: 'checks the lines add up to the proposal total' },
  { file: 'unusual.ts', line: /\(m\.get\(a\) \?\? 0\) \+ r\.value_zat/, why: 'total per address, for the unusual-payment check' },
  { file: 'screens/Dashboard.tsx', line: /settled\.reduce\(\(a, p\) => a \+ p\.value_zat/, why: 'Paid: settled outflow' },
  { file: 'screens/Dashboard.tsx', line: /cur\.zec = .*p\.value_zat/, why: 'spend by month, settled' },
  { file: 'ledgerXlsx.ts', line: /sumZat\(data\.items\.filter\(keep\)\)/, why: 'the sheet\'s totals by state' },
  { file: 'ledgerPivot.ts', line: /sumZat\((g\.paid|g\.due|live\.filter\(.*\))\)/, why: 'the pivot\'s paid and due totals' },
  { file: 'treasury-metrics.ts', line: /sumZat\(out\.filter/, why: 'spend per month, settled' },
  { file: 'screens/Ledger.tsx', line: /sumZat\((settled|pending)\)/, why: 'the ledger\'s Paid and Open totals' },
]

/** The offending lines of one file's code (comments already removed). */
export function offenders(file: string, code: string): string[] {
  return code.split('\n').filter((l) =>
    ACCUMULATES.some((re) => re.test(l)) &&
    !EXCEPTIONS.some((e) => e.file === file && e.line.test(l)))
}

function productionFiles(): string[] {
  const out: string[] = []
  const walk = (d: string) => {
    for (const n of readdirSync(d)) {
      const p = join(d, n)
      if (statSync(p).isDirectory()) { if (n !== 'wasm-pkg') walk(p) }
      else if (/\.tsx?$/.test(n) && !/\.test\.tsx?$/.test(n) && n !== 'source-scan.ts') out.push(p.split(sep).join('/'))
    }
  }
  walk(SRC)
  return out
}

describe('what open proposals hold is summed in one place (#1017)', () => {
  it('no production file outside balance-parts.ts and proposal-cost.ts adds up value_zat unlisted', () => {
    const base = SRC.split(sep).join('/')
    const hits: string[] = []
    for (const f of productionFiles()) {
      const rel = f.slice(base.length)
      if (OWNERS.has(rel)) continue
      for (const l of offenders(rel, codeAt(f))) hits.push(`${rel}: ${l.trim()}`)
    }
    expect(hits, 'a second sum of value_zat: use reservedZatOf (or list the exception with its reason)').toEqual([])
  })

  it('every listed exception still matches a line, so the list cannot rot', () => {
    const base = SRC.split(sep).join('/')
    for (const e of EXCEPTIONS) {
      const f = productionFiles().find((x) => x.slice(base.length) === e.file)
      expect(f, `${e.file} is gone`).toBeTruthy()
      expect(codeAt(f!).split('\n').some((l) => e.line.test(l)), `${e.file}: ${e.why} no longer matches`).toBe(true)
    }
  })

  it('and would find one', () => {
    for (const planted of [
      // The Dashboard's two sums as they were on staging before #1017.
      'const reservedZec = open.reduce((a, p) => a + p.value_zat, 0) / 1e8',
      'const reservedZat = open.reduce((a, p) => a + p.value_zat, 0)',
      'let held = 0; for (const p of open) held += p.value_zat',
      'held = held + p.value_zat',
      'const held = sumZat(proposals.filter(isOpen))',
      'total += proposal.value_zat ?? 0',
      // the second line of a two-line reduce
      '  (a, p) => a + Number(p.value_zat), 0)',
      'const amounts = open.map((p) => p.value_zat)',
    ]) {
      expect(offenders('screens/Somewhere.tsx', planted), planted).toHaveLength(1)
    }
  })

  it('and does not take a plain read, a comparison or a comment for a sum', () => {
    for (const fine of ['const v = p.value_zat', 'if (a.value_zat > b.value_zat) return 1', 'x.value_zat++', "// open.reduce((a, p) => a + p.value_zat, 0)"]) {
      const code = stripComments('x.ts', fine)
      expect(offenders('screens/Somewhere.tsx', code), fine).toEqual([])
    }
  })

  it('a listed exception does not excuse the same line in another file', () => {
    expect(offenders('screens/Somewhere.tsx', 'const paidZec = settled.reduce((a, p) => a + p.value_zat, 0) / 1e8')).toHaveLength(1)
    expect(offenders('screens/Dashboard.tsx', 'const reservedZat = open.reduce((a, p) => a + p.value_zat, 0)')).toHaveLength(1)
  })

  it('the Ledger sheet writes no "0" for a reservation it does not know', () => {
    // `parts` is null unless the reservation is known, so a `reserved ?? 0` there was dead code that
    // would turn "unknown" into "nothing held" the day the guard above it changed.
    expect(codeAt(join(SRC, 'screens/Ledger.tsx'))).not.toMatch(/reserved \?\? 0/)
  })
})
