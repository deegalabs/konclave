import { describe, expect, it } from 'vitest'
import { codeOf } from './source-scan'
import { en } from './i18n/en'
import { ptBR } from './i18n/pt-BR'

// #318: /net's words move from inline pt/en pairs (`pe(pt, en)`) into the dictionary, in slices, so
// the parity test sees them and a copy fix lands once. This is a ratchet: the count only goes down,
// and the last slice removes `pe` altogether.
describe('/net reads its words from the dictionary (#318)', () => {
  it('has no more inline pt/en pairs than the slices so far have left', () => {
    const calls = codeOf('screens/NetVault.tsx').match(/(?<![A-Za-z0-9_.])pe\(/g) ?? []
    expect(calls.length).toBeLessThanOrEqual(92)
  })
  it('the joining and creating words are in both languages', () => {
    for (const k of Object.keys(en).filter((k) => k.startsWith('net.join.') || k.startsWith('net.create.') || k === 'net.yourNameLabel')) {
      expect(ptBR[k], k).toBeTruthy()
    }
    expect(en['net.join.joinWithAnInvite']).toBe('Join with an invite')
    expect(ptBR['net.join.joinWithAnInvite']).toBe('Entrar com um convite')
  })
})
