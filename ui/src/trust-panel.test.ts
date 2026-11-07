import { describe, expect, it } from 'vitest'
import { trustRows } from './trust-facts'
import { codeOf } from './source-scan'
import { en } from './i18n/en'
import { ptBR } from './i18n/pt-BR'

/* The trust panel (#244, #308): who sees what and who can do what, for this vault, in Settings.
 * The cells come from the product's own rules and from the one fact this device knows about the
 * vault (private or open). What it cannot see (the write gate, every seat's registration) is said
 * as such. The tables below are written out by hand, cell by cell, so a change to the rules shows
 * here as a change, not as a rule that agrees with itself. */

const table = (secured: boolean) => Object.fromEntries(trustRows({ secured, threshold: 2, total: 3 }).map((r) => [r.what, r.cells]))

describe('who sees what, from the vault’s facts', () => {
  it('a private vault', () => {
    expect(table(true)).toEqual({
      books: { members: 'yes', server: 'yes', relay: 'sealedWhenRegistered', link: 'metadata' },
      memos: { members: 'yes', server: 'yes', relay: 'sealedWhenRegistered', link: 'no' },
      payment: { members: 'yes', server: 'yes', relay: 'sealedWhenRegistered', link: 'no' },
      move: { members: 'quorum', server: 'builds', relay: 'no', link: 'no' },
      propose: { members: 'yes', server: 'keeps', relay: 'no', link: 'untilUnlock' },
    })
  })
  it('an open vault', () => {
    expect(table(false)).toEqual({
      books: { members: 'yes', server: 'yes', relay: 'sealedWhenRegistered', link: 'yes' },
      memos: { members: 'yes', server: 'yes', relay: 'sealedWhenRegistered', link: 'yes' },
      payment: { members: 'yes', server: 'yes', relay: 'sealedWhenRegistered', link: 'yes' },
      move: { members: 'quorum', server: 'builds', relay: 'no', link: 'no' },
      propose: { members: 'yes', server: 'keeps', relay: 'no', link: 'writes' },
    })
  })
})

describe('the limits, word for word', () => {
  const expected: Record<string, [string, string]> = {
    'trust.limit.private': [
      'This device holds the vault’s secret. Whether the server already requires it for every read is a fact of the server, which this screen does not check.',
      'Este aparelho guarda o segredo do cofre. Se o servidor já o exige em toda leitura é um fato do servidor, que esta tela não confere.',
    ],
    'trust.limit.relay': [
      'The messages service carries a payment’s content, its memos included, sealed only once every member’s device has registered its key; this device cannot tell whether every one has.',
      'O serviço de mensagens carrega o conteúdo de um pagamento, memos incluídos, lacrado só quando todo aparelho de membro tiver registrado sua chave; este aparelho não sabe dizer se todos registraram.',
    ],
    'trust.limit.gate': [
      'On a private vault, proposing, voting, renaming and sending are refused to anyone without a seat once a member has unlocked it on an updated app; until then the link can write, and this device cannot tell which it is. A member can still act in the name of a colleague who has not unlocked yet. On an open vault, the link may write at any time.',
      'Num cofre privado, propor, votar, renomear e enviar passam a ser recusados a quem não tem assento depois que um membro destravar o cofre num app atualizado; até lá o link escreve, e este aparelho não sabe dizer qual é o caso. Um membro ainda pode agir em nome de um colega que não destravou. Num cofre aberto, o link pode escrever a qualquer momento.',
    ],
    'trust.limit.builds': [
      'The vault’s server builds every transaction the quorum signs. A device checks what it signs against its own reading of the payment, but the approved lines it compares with come from that same server, and the old /net page does not check. So a payment the quorum signs is only as safe as the server. Tracked, not fixed.',
      'O servidor do cofre monta toda transação que o quórum assina. O aparelho confere o que assina contra a própria leitura do pagamento, mas as linhas aprovadas com que compara vêm desse mesmo servidor, e a página antiga /net não confere. Então um pagamento que o quórum assina é tão seguro quanto o servidor. Registrado, não resolvido.',
    ],
    'trust.limitsNotAll': ['These are the main limits, not all of them.', 'Estes são os principais limites, não todos.'],
  }
  for (const [k, [e, p]] of Object.entries(expected)) {
    it(k, () => { expect(en[k]).toBe(e); expect(ptBR[k]).toBe(p) })
  }
  it('the link on a private vault reads the addresses, receive and change, not one address', () => {
    expect(en['trust.cell.metadata']).toBe('only the addresses (receive and change), how many members, how many approve')
    expect(ptBR['trust.cell.metadata']).toBe('só os endereços (de recebimento e de troco), quantos membros, quantos aprovam')
  })
})

describe('Settings shows it, in both languages', () => {
  const src = codeOf('screens/Settings.tsx')
  it('the section, the cells’ words and the limits', () => {
    expect(src).toMatch(/trustRows\(/)
    expect(src).toMatch(/hasLocal && secured !== undefined && \(/) // no record, no panel: unknown is never printed as private
    expect(src).toMatch(/t\('set\.secTrust'\)/)
    expect(src).toMatch(/to="\/docs\/security"/)
    const keys = ['set.secTrust', 'trust.intro', 'trust.what', 'trust.party.members', 'trust.party.server', 'trust.party.relay', 'trust.party.link',
      'trust.row.books', 'trust.row.memos', 'trust.row.payment', 'trust.row.move', 'trust.row.propose',
      'trust.cell.yes', 'trust.cell.no', 'trust.cell.metadata', 'trust.cell.quorum', 'trust.cell.builds', 'trust.cell.keeps', 'trust.cell.sealedWhenRegistered', 'trust.cell.untilUnlock', 'trust.cell.writes',
      'trust.limits', 'trust.limit.builds', 'trust.limit.viewingKey', 'trust.limit.relay', 'trust.limit.gate', 'trust.limit.metadata', 'trust.limit.private', 'trust.limit.product', 'trust.limit.audit', 'trust.limitsNotAll', 'trust.more']
    for (const k of keys) { expect(en[k], k).toBeTruthy(); expect(ptBR[k], k).toBeTruthy() }
    expect(en['trust.cell.quorum']).toContain('{t}')
    // no issue number in Settings copy; the docs page is where numbers live
    for (const k of Object.keys(en).filter((x) => x.startsWith('trust.'))) expect(en[k], k).not.toMatch(/#\d/)
  })
  it('the private limit is shown only for a private vault, and the list says it is not all of them', () => {
    expect(src).toMatch(/\{secured && <li>\{t\('trust\.limit\.private'\)\}<\/li>\}/)
    expect(src).toMatch(/t\('trust\.limitsNotAll'\)/)
  })
  it('the index links to the section only when the section is there', () => {
    expect(src).toMatch(/\{hasLocal && secured !== undefined && <a href="#s-trust">/)
    expect(src).not.toMatch(/\{gov && <a href="#s-trust">/)
  })
  it('the quorum comes from this device’s own record first, the server’s answer only without one', () => {
    expect(src).toMatch(/const thr = localQuorum\?\.threshold \?\? vault\?\.threshold \?\? 2/)
    expect(src).toMatch(/const n = localQuorum\?\.total \?\? vault\?\.total \?\? 3/)
  })
})
