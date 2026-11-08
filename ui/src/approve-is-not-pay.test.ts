import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { codeOf } from './source-scan'
import { en } from './i18n/en'
import { ptBR } from './i18n/pt-BR'

/* "Approving is not paying" (#309, #308): the two moments that move money are two sentences, where
 * the buttons are. Approving is your yes to this payment; signing is your part of the key at work,
 * and the last signature sends. And on the one screen this file owns of the four #309 names, the
 * remove gate offers the cheaper fix first: export, if you might want the vault back; the export is
 * the only spare key, and the docs page says what to do on the day the device is lost. */

describe('the proposal says what approving and signing do, where the buttons are', () => {
  const src = codeOf('screens/Proposal.tsx')
  it('the vote buttons are described by the approving sentence', () => {
    expect(src).toMatch(/id="vote-means"/)
    expect(src).toMatch(/t\('proposal\.approveMeans'\)/)
    expect(src).toMatch(/aria-describedby="vote-means"/)
    // the words come before the decision
    expect(src.indexOf('id="vote-means"')).toBeLessThan(src.indexOf('aria-describedby="vote-means"'))
  })
  it('each sign button is described by the sentence true of its own flow', () => {
    // the live path: the last signature sends; the bridge: one confirm gathers the parts and sends
    expect(src.match(/aria-describedby="sign-means"/g)?.length).toBe(2)
    expect(src).toMatch(/openSigning\(p\)\} aria-describedby="sign-means"/)
    expect(src).toMatch(/t\('proposal\.signMeans'\)/)
    expect(src).toMatch(/t\('proposal\.signBridgeMeans'\)/)
  })
})

describe('Settings offers the export before the removal, and points at the day the device is lost', () => {
  const src = codeOf('screens/Settings.tsx')
  it('the remove gate links to the export block and the docs page', () => {
    expect(src).toMatch(/t\('set\.removeExportFirst'\)/)
    // a button, not a hash link: the app routes by hash, so "#s-keys" would be a route
    expect(src).toMatch(/setConfirming\(false\); setConfirmName\(''\); setErr\(null\); setXpErr\(null\); setXpOpen\(true\)/)
    expect(src).toMatch(/to="\/docs\/recovery"/)
    expect(src).toMatch(/t\('set\.loseDevice'\)/)
  })
})

describe('the words exist in both languages and say "backup file", never "recovery"', () => {
  it('keys', () => {
    for (const k of ['proposal.approveMeans', 'proposal.signMeans', 'proposal.signBridgeMeans', 'set.removeExportFirst', 'set.loseDevice']) {
      expect(en[k], k).toBeTruthy(); expect(ptBR[k], k).toBeTruthy()
      expect(en[k], k).not.toMatch(/recover/i)
      expect(ptBR[k], k).not.toMatch(/recupera/i)
    }
    expect(en['proposal.signMeans']).toMatch(/last signature sends/)
    expect(ptBR['proposal.signMeans']).toMatch(/última assinatura envia/)
  })
})

describe('approving says who signs as the code decides it today', () => {
  it('any member of the vault can sign once enough approved, in both languages', () => {
    expect(en['proposal.approveMeans']).toBe('Approving is your yes to this payment. It moves no money. Once enough members approve, any member of the vault can sign on their own device, and the payment goes out when the quorum has signed.')
    expect(ptBR['proposal.approveMeans']).toBe('Ao aprovar, você diz sim a este pagamento. Nenhum dinheiro sai. Quando houver aprovações suficientes, qualquer membro do cofre pode assinar no seu aparelho, e o pagamento sai quando o quórum assinou.')
  })
  it('the sentence rests on the signer accepting any member: when that rule changes, this goes red and the sentence is rewritten', () => {
    expect(codeOf('VaultSigner.tsx')).toMatch(/isApproved: \(\) => true,/)
  })
  it('the changelog says the same', () => {
    const cl = readFileSync(new URL('../CHANGELOG.md', import.meta.url), 'utf8').replace(/\s+/g, ' ')
    expect(cl).toContain('once enough members approve, any member can sign, and the last signature sends')
    expect(cl).not.toContain('those who approved sign next')
  })
})

describe('a ready proposal says it is ready to sign, not the old one-step story', () => {
  it('payment and payroll, in both languages', () => {
    expect(en['proposal.readyPayment']).toBe('**Approved by enough members.** The proposal is **ready to sign**.')
    expect(en['proposal.readyPayroll']).toBe('**Approved by enough members.** The payroll is **ready to sign**, its N outputs in a single transaction.')
    expect(ptBR['proposal.readyPayment']).toBe('**Aprovações suficientes.** A proposta está **pronta para assinar**.')
    expect(ptBR['proposal.readyPayroll']).toBe('**Aprovações suficientes.** A folha está **pronta para assinar**, com as N saídas numa transação só.')
    // The vote block says it the same way: one sentence for "enough approved" on the screen.
    expect(en['proposal.quorumReachedShort']).toBe('Enough approvals.')
    expect(ptBR['proposal.quorumReachedShort']).toBe('Aprovações suficientes.')
    for (const k of ['proposal.readyPayment', 'proposal.readyPayroll', 'proposal.quorumReachedShort']) {
      expect(en[k], k).not.toMatch(/quorum reached/i)
      expect(ptBR[k], k).not.toMatch(/quórum atingido/i)
    }
  })
})

describe('the words a member meets say "part", not "seat" or "share"', () => {
  it('removal cost and the ceremony note', () => {
    expect(en['set.removeCost']).toBe('The other members keep their parts. But if this is the only device holding your part and you have no backup file, you can no longer approve or sign for this vault.')
    expect(ptBR['set.removeCost']).toBe('Os outros membros continuam com as partes deles. Mas se este for o único aparelho com a sua parte e você não tiver o arquivo de backup, você não poderá mais aprovar nem assinar por este cofre.')
    expect(en['proposal.ceremonyNote']).toBe('You sign there, on your device, with your own part of the key. Once the quorum signs, the proposal returns as Sent.')
    expect(ptBR['proposal.ceremonyNote']).toBe('Você assina lá, no seu aparelho, com a sua parte da chave. Quando o quórum assina, a proposta volta como Enviada.')
    for (const k of ['set.removeCost', 'proposal.ceremonyNote']) {
      expect(en[k], k).not.toMatch(/seat|share/i)
      expect(ptBR[k], k).not.toMatch(/assento|pedaço/i)
    }
  })
})
