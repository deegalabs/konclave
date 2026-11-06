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
    expect(src).toMatch(/setConfirming\(false\); setXpErr\(null\); setXpOpen\(true\)/)
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
