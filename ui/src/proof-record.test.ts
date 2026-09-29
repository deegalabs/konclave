import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
// @ts-expect-error - a plain .mjs script, deliberately not part of the app's TS build
import { proofRows, statedCounts, COUNT_DOCS } from '../../scripts/proof-table.mjs'
import { PROOF_TXS, proofOriginCounts } from './proof-record'

// The table in docs/PROOF.md is the record. Everything else describes it.
//
// On 2026-09-29, the day before a grant application quoting "19 mainnet transactions", the table
// held nineteen rows and the repository said four other things about it: seventeen in the sentence
// right above the table, fifteen and eight in docs/CLAIMS.md, twelve and eight in docs/ROADMAP.md,
// and eight on the /proof screen and in the in-app docs, which listed eight transactions and
// nothing after them.
//
// None of it was a lie when it was written. Each number was true on the day someone typed it, and
// nothing connected it to the table afterwards. `scripts/verify-proof.mjs` already warned about
// this, for three documents and for digits only, and only to whoever ran it.
//
// So this runs in CI, with no network, and reads the table with the parser the verifier uses
// (`scripts/proof-table.mjs`). A row added to the record fails here until the screen lists it, the
// attribution table names its key origin, and every document that states the count agrees.

const ROOT = join(new URL('.', import.meta.url).pathname, '..', '..')
const read = (path: string) => readFileSync(join(ROOT, path), 'utf8')

type Row = { txid: string; label: string; block: string }
const record: Row[] = proofRows(read('docs/PROOF.md'))

describe('the proof screen is a copy of the record, and is held to it', () => {
  it('the record can be read at all', () => {
    // Without this, a change to the table's format would empty `record` and every comparison
    // below would pass by comparing a list against nothing.
    expect(record.length).toBeGreaterThan(0)
    for (const row of record) expect(row.txid).toMatch(/^[0-9a-f]{64}$/)
  })

  it('lists every row of the record, no other, in the same order', () => {
    expect(PROOF_TXS.map((t) => t.txid)).toEqual(record.map((r) => r.txid))
  })

  it('gives each transaction the block the record gives it', () => {
    for (const [i, row] of record.entries()) {
      const height = Number(row.block.replace(/,/g, ''))
      // The first row of the record says "mined" where the others give a height. That row is the
      // one case with nothing to compare against, so it is skipped by what the cell holds and not
      // by its position.
      if (!Number.isInteger(height)) continue
      expect(PROOF_TXS[i]?.block, `${row.txid.slice(0, 8)} is at block ${row.block} in docs/PROOF.md`).toBe(height)
    }
  })

  it('says what each one is in both languages', () => {
    for (const t of PROOF_TXS) {
      expect(t.label.en.trim(), `${t.txid.slice(0, 8)} has no English label`).not.toBe('')
      expect(t.label['pt-BR'].trim(), `${t.txid.slice(0, 8)} has no Portuguese label`).not.toBe('')
    }
  })
})

describe('how each key was made agrees with docs/CLAIMS.md', () => {
  // The attribution table: `| what (`<8 hex>…`) | proven on-chain | trusted-dealer or DKG |`.
  const attributed = new Map<string, 'dealer' | 'dkg'>()
  for (const line of read('docs/CLAIMS.md').split('\n')) {
    const m = /^\|.*`([0-9a-f]{8})…`.*\|\s*proven on-chain\s*\|\s*(.+?)\s*\|\s*$/.exec(line)
    if (!m) continue
    attributed.set(m[1]!, /trusted-dealer/i.test(m[2]!) ? 'dealer' : 'dkg')
  }

  it('every row of the record has a row in the attribution table', () => {
    // This table stopped at fifteen rows while the record held nineteen.
    const missing = record.map((r) => r.txid.slice(0, 8)).filter((id) => !attributed.has(id))
    expect(missing, 'docs/CLAIMS.md does not say how these vaults got their key').toEqual([])
  })

  it('and the screen says the same thing about each', () => {
    for (const t of PROOF_TXS) {
      expect(t.origin, `${t.txid.slice(0, 8)}: the screen and docs/CLAIMS.md disagree`).toBe(
        attributed.get(t.txid.slice(0, 8)),
      )
    }
  })

  it('so the two counts add up to the record', () => {
    const { dealer, dkg } = proofOriginCounts()
    expect(dealer + dkg).toBe(record.length)
  })
})

describe('reading a count out of prose', () => {
  it('reads digits, words, and a number set in bold', () => {
    expect(statedCounts('**19 verifiable mainnet transactions**, each signed').map((c: { n: number }) => c.n)).toEqual([19])
    expect(statedCounts('As of this writing, fifteen verifiable mainnet txids.').map((c: { n: number }) => c.n)).toEqual([15])
    expect(statedCounts('**eight** verifiable mainnet txids incl. a DKG-vault send').map((c: { n: number }) => c.n)).toEqual([8])
    expect(statedCounts('(12 verifiable txids, see docs/PROOF.md)').map((c: { n: number }) => c.n)).toEqual([12])
    expect(statedCounts('Konclave claims 17 real Zcash **mainnet** transactions.').map((c: { n: number }) => c.n)).toEqual([17])
  })

  it('leaves alone a true sentence about some of the rows', () => {
    // These are about seven or eight of the transactions, not a count of the set. A check that
    // flagged them would be switched off within the week.
    expect(statedCounts('The first **seven** mainnet sends were signed on a single machine')).toEqual([])
    expect(statedCounts('The first eight mainnet sends were signed on a single machine')).toEqual([])
    expect(statedCounts('two real, mined, V6/NU6.3 mainnet transactions, each a FROST 2-of-3 ceremony')).toEqual([])
  })
})

describe('no document states a count the record does not hold', () => {
  for (const doc of COUNT_DOCS as string[]) {
    it(doc, () => {
      const wrong = statedCounts(read(doc))
        .filter((c: { n: number }) => c.n !== record.length)
        .map((c: { said: string }) => c.said)
      expect(wrong, `${doc} states a count of mainnet transactions that is not the ${record.length} rows of docs/PROOF.md`).toEqual([])
    })
  }

  it('the app writes no count of its own', () => {
    // The screen renders the list and the in-app docs read its length. A number typed into either
    // is a second place for the count to live, which is what this whole file exists to prevent.
    // Comments are left out: they are prose about the code, and this one mentions numbers.
    for (const file of ['ui/src/screens/Proof.tsx', 'ui/src/docs/content.ts']) {
      const code = read(file)
        .split('\n')
        .filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l))
        .join('\n')
      expect(statedCounts(code), `${file} states a count in English`).toEqual([])
      expect(code.match(/\b\d+\s+txids\s+verific\S*/gi) ?? [], `${file} states a count in Portuguese`).toEqual([])
    }
  })
})
