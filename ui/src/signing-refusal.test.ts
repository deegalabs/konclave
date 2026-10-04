/// <reference types="node" />
import { describe, expect, it } from 'vitest'
import { describeSigningError, NOTICES, REFUSALS } from './signing-refusal'
import { en } from './i18n/en'
import { ptBR } from './i18n/pt-BR'
import { codeOf } from './source-scan'

// The background signer reports a refusal as an i18n KEY (its `tt` is the identity), and the panel
// used to print it inside "Could not send: {reason}". A member whose device refused a tampered
// payment read "Could not send: net.err.notApproved", with a Try again button under a message whose
// own text says not to retry.
const t = (k: string, p?: Record<string, string | number>) => (p ? `${k}(${JSON.stringify(p)})` : `T:${k}`)

describe('describeSigningError', () => {
  it('translates a refusal key and presents it as a refusal, not a failed send', () => {
    expect(describeSigningError('net.err.feeTooHigh', t)).toEqual({ text: 'T:net.err.feeTooHigh', kind: 'refusal' })
  })

  it('keeps the engine sentence that follows a refusal key', () => {
    expect(describeSigningError('net.err.unreadableSpends Error: mixed pools', t)).toEqual({
      text: 'T:net.err.unreadableSpends Error: mixed pools',
      kind: 'refusal',
    })
  })

  it('leaves any other error as a failed send', () => {
    expect(describeSigningError('helper unreachable', t)).toEqual({
      text: 'signing.failed({"reason":"helper unreachable"})',
      kind: 'failure',
    })
  })

  it('presents a rejected message as a notice, never as the end of the transaction', () => {
    // A package from the wrong seat, or one over another message, is ignored, and the honest round
    // can still follow and be signed. Shown as a refusal ("nothing was signed", no way back), it was
    // false the moment the honest round completed, and it took the progress off the screen.
    expect(describeSigningError('net.err.notCoordinator', t)).toEqual({ text: 'T:net.err.notCoordinator', kind: 'notice' })
    expect(describeSigningError('net.err.sighashMismatch Error: x', t)).toEqual({ text: 'T:net.err.sighashMismatch Error: x', kind: 'notice' })
  })

  it('words a notice as something ignored, in both languages', () => {
    for (const k of NOTICES) {
      for (const [lang, dict] of [['en', en], ['pt-BR', ptBR]] as const) {
        const text = dict[k] ?? ''
        expect(text, `${k} in ${lang}`).toBeTruthy()
        expect(text, `${k} in ${lang} must not read as a refusal`).not.toMatch(/Refused to sign|Nothing was signed|Recusei assinar|Assinatura recusada|Nada foi assinado/)
        // Nor promise an honest round the device cannot know is coming (#610 review).
        expect(text, `${k} in ${lang} must not promise what comes next`).not.toMatch(/waiting|esperando|Keep this screen open|Mantenha esta tela aberta/)
      }
    }
  })

  it('knows every refusal in both languages', () => {
    for (const k of REFUSALS) {
      expect(en[k], `${k} in en`).toBeTruthy()
      expect(ptBR[k], `${k} in pt-BR`).toBeTruthy()
    }
  })

  it('an approval it could not load is not called innocent, in either language', () => {
    // An earlier wording said it was "not a sign of tampering", which a coordinator that withholds
    // the approval would want said (#610 review).
    expect(en['net.err.approvalUnknown']).toMatch(/the coordinator can cause it/)
    expect(en['net.err.approvalUnknown']).not.toMatch(/not a sign of tampering/)
    expect(ptBR['net.err.approvalUnknown']).toMatch(/o coordenador pode provocá-lo/)
    expect(ptBR['net.err.approvalUnknown']).not.toMatch(/não indica adulteração/)
  })

  it('an output mismatch also covers a payment its recipient could not open', () => {
    // `[undecryptable]` maps here (refusalKey), so the message has to name that case too.
    expect(en['net.err.outputMismatch']).toMatch(/could not open/)
    expect(ptBR['net.err.outputMismatch']).toMatch(/não conseguiria abri-lo/)
  })
})

// REFUSALS is a hand-kept list, and a list compared with a copy of itself passes whenever both change
// together. The rule it encodes lives in the machine: a key is a refusal exactly when the machine
// reports it after taking the transaction up (`this.started = true` in onSreq) and before clearing
// it, which `cleared` makes final. So the list is checked against the machine's source.
describe('REFUSALS is what the machine reports after taking a transaction up', () => {
  const src = codeOf('./signing-machine.ts')
  const keysIn = (s: string) => [...s.matchAll(/'(net\.err\.\w+)'/g)].map((m) => m[1]!)
  const onSreq = src.slice(src.indexOf('private async onSreq('), src.indexOf('this.cleared = true'))
  const taken = onSreq.indexOf('this.started = true')
  const refusalKeyFn = src.slice(src.indexOf('export function refusalKey('), src.indexOf('export function refusalKey(') + 800)

  it('every key reported after the transaction is taken up, or returned by refusalKey, is a refusal', () => {
    expect(taken, 'onSreq marks the transaction taken up').toBeGreaterThan(-1)
    const final = new Set([...keysIn(onSreq.slice(taken)), ...keysIn(refusalKeyFn.slice(0, refusalKeyFn.indexOf('\n}')))])
    expect([...final].sort()).toEqual([...REFUSALS].sort())
  })

  it('every key reported anywhere else is a notice, and only those are', () => {
    // The complement of the rule above: a key the machine reports where the transaction is not final
    // must be worded as something ignored, so NOTICES is pinned to the source the same way.
    const elsewhere = new Set(keysIn(src.replace(onSreq.slice(taken), '').replace(refusalKeyFn.slice(0, refusalKeyFn.indexOf('\n}')), '')))
    for (const k of elsewhere) expect(REFUSALS.has(k), `${k} is reported where it is not final`).toBe(false)
    expect([...elsewhere].sort()).toEqual([...NOTICES].sort())
  })
})
