import { describe, expect, it } from 'vitest'
import { trustRows } from './trust-facts'
import { codeOf } from './source-scan'
import { en } from './i18n/en'
import { ptBR } from './i18n/pt-BR'

/* The trust panel (#244, #308): who sees what and who can do what, for this vault, in Settings.
 * The cells come from the product's own rules and from the one fact this device knows about the
 * vault (private or open). What it cannot see (the write gate, every seat's registration) is said
 * as such. It states limits as limits: the coordinator holds the
 * viewing key and builds what the quorum signs; the relay carries a payment sealed only once every
 * seat registered its device key, which this device cannot tell. Nothing is promised that the code
 * does not keep. */

const cell = (rows: ReturnType<typeof trustRows>, what: string, party: 'members' | 'server' | 'relay' | 'link') => rows.find((r) => r.what === what)!.cells[party]

describe('who sees what, from the vault’s facts', () => {
  const priv = trustRows({ secured: true, threshold: 2, total: 3 })
  const open = trustRows({ secured: false, threshold: 2, total: 3 })
  it('a leaked link reads an open vault’s books, memos and payments; of a private one only the metadata that stays open by design', () => {
    expect(cell(open, 'books', 'link')).toBe('yes')
    expect(cell(open, 'memos', 'link')).toBe('yes')
    expect(cell(open, 'payment', 'link')).toBe('yes')
    expect(cell(priv, 'books', 'link')).toBe('metadata')
    expect(cell(priv, 'memos', 'link')).toBe('no')
    expect(cell(priv, 'payment', 'link')).toBe('no')
  })
  it('the vault’s server reads the books and the memos, since it holds the viewing key, on both', () => {
    for (const rows of [priv, open]) { expect(cell(rows, 'books', 'server')).toBe('yes'); expect(cell(rows, 'memos', 'server')).toBe('yes') }
  })
  it('moving money is a quorum of members; the server builds what they sign and holds no share', () => {
    expect(cell(priv, 'move', 'members')).toBe('quorum')
    expect(cell(priv, 'move', 'server')).toBe('builds')
    expect(cell(priv, 'move', 'relay')).toBe('no')
    expect(cell(priv, 'move', 'link')).toBe('no')
  })
  it('the relay sees a payment’s content sealed only once every seat registered, which is said as such', () => {
    expect(cell(priv, 'payment', 'relay')).toBe('sealedWhenRegistered')
  })
  it('proposing and voting: the link may write until the first unlock, which this device cannot see, on both', () => {
    expect(cell(open, 'propose', 'link')).toBe('untilUnlock')
    expect(cell(priv, 'propose', 'link')).toBe('untilUnlock')
    expect(cell(priv, 'propose', 'server')).toBe('keeps')
  })
})

describe('Settings shows it, in both languages', () => {
  it('the section, the cells’ words and the limits', () => {
    const src = codeOf('screens/Settings.tsx')
    expect(src).toMatch(/trustRows\(/)
    expect(src).toMatch(/hasLocal && secured !== undefined/) // no record, no panel: unknown is never printed as private
    expect(src).not.toMatch(/gated:/) // the write gate is a coordinator-side fact this device does not hold
    expect(src).toMatch(/t\('set\.secTrust'\)/)
    expect(src).toMatch(/to="\/docs\/security"/)
    const keys = ['set.secTrust', 'trust.intro', 'trust.what', 'trust.party.members', 'trust.party.server', 'trust.party.relay', 'trust.party.link',
      'trust.row.books', 'trust.row.memos', 'trust.row.payment', 'trust.row.move', 'trust.row.propose',
      'trust.cell.yes', 'trust.cell.no', 'trust.cell.metadata', 'trust.cell.quorum', 'trust.cell.builds', 'trust.cell.keeps', 'trust.cell.sealedWhenRegistered', 'trust.cell.untilUnlock',
      'trust.limits', 'trust.limit.builds', 'trust.limit.viewingKey', 'trust.limit.relay', 'trust.limit.gate', 'trust.limit.metadata', 'trust.limit.product', 'trust.limit.audit', 'trust.more']
    for (const k of keys) { expect(en[k], k).toBeTruthy(); expect(ptBR[k], k).toBeTruthy() }
    expect(en['trust.cell.quorum']).toContain('{t}')
    // no issue number in Settings copy; the docs page is where numbers live
    for (const k of Object.keys(en).filter((x) => x.startsWith('trust.'))) expect(en[k], k).not.toMatch(/#\d/)
  })
})
