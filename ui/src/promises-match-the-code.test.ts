import { describe, expect, it } from 'vitest'
import { en } from './i18n/en'
import { ptBR } from './i18n/pt-BR'

/* Six sentences promised more than the code does, on the landing pages, in Settings and on the
 * signing panel. A member's key share does leave the device: sealed under the passphrase, inside the
 * backup the member exports (#214). And the relay does not see only public material: a signing
 * request is sealed to the vault's devices only once every seat has registered its device key, and
 * until then it crosses the relay unsealed, for a send a seat signed (`request_recipients` in
 * orchestrator/src/helper.rs, #63). The sentences now say what the code does. */

const KEYS = ['landing.env', 'landing.finalDesc', 'lv.trust1', 'lv.getSub', 'settings.relayHint', 'signing.reassure'] as const
const OVERCLAIM = /never leaves|only public material|\bblind\b|nunca sai|só vê material|\bcego\b/i

describe('the sentences promise only what the code does', () => {
  for (const k of KEYS) {
    it(`${k} no longer says the share never leaves the device, or that the relay sees only public material`, () => {
      expect(en[k], k).toBeTruthy()
      expect(ptBR[k], k).toBeTruthy()
      expect(en[k]).not.toMatch(OVERCLAIM)
      expect(ptBR[k]).not.toMatch(OVERCLAIM)
    })
  }

  it('the relay hint says when a signing request crosses it unsealed', () => {
    expect(en['settings.relayHint']).toMatch(/until then the signing request crosses it unsealed/)
    expect(ptBR['settings.relayHint']).toMatch(/até lá, o pedido de assinatura cruza aberto/)
    expect(en['settings.relayHint']).toMatch(/never sees a key share/)
  })

  it('the landing names the one way a share leaves: inside the encrypted backup', () => {
    expect(en['landing.finalDesc']).toMatch(/encrypted backup/)
    expect(ptBR['landing.finalDesc']).toMatch(/backup criptografado/)
  })
})
