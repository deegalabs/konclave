/// <reference types="node" />
// SIGNER-SEAT1 on screen. The device that completed the quorum runs the send, so the panel names it;
// a seat whose signature was not needed reads "not needed" once the payment went out, in the signing
// panel and on the proposal (Daniel, 14/10: both); and a send whose running device went quiet after
// the round started says the one thing that helps (close and reopen), since a started round has no
// abort yet (#284). Source pins: these screens have no render harness.
import { describe, expect, it } from 'vitest'
import { codeOf } from './source-scan'
import { en } from './i18n/en'
import { ptBR } from './i18n/pt-BR'

const panel = codeOf('./screens/SigningPanel.tsx')

describe('the panel names the device that is sending', () => {
  it('uses the seat whose signature completed the quorum, from the session', () => {
    expect(panel).toMatch(/const done = bg\.completed\(\)/)
    expect(panel).toMatch(/roster\[done\.seat - 1\]\?\.name/)
    expect(panel).toMatch(/t\(senderLate \? 'signing\.senderWaiting' : 'signing\.senderSending', \{ name: senderName, mins: senderLapseMin \}\)/)
  })
  it('says close and reopen when the round started and the sender went quiet', () => {
    expect(panel).toMatch(/bg\.phase === 'signing' && !bg\.sendingNamed\(\) && \(\s*<div className="hint warn mt-sm" role="status">\{t\('signing\.stalledReopen'\)\}<\/div>/)
  })
})

describe('a seat that was not needed is said as such once sent', () => {
  it('in the signing panel roster', () => {
    expect(panel).toMatch(/sent && !signedSeats\.includes\(i \+ 1\) && <span className="sign-seat-nn">\{t\('signing\.seatNotNeeded'\)\}<\/span>/)
  })
  it('on the proposal, for a member who neither approved nor refused', () => {
    expect(codeOf('./screens/Proposal.tsx')).toMatch(/if \(p\.state === 'sent' \|\| p\.state === 'confirmed'\) return \{ cls: '', label: t\('proposal\.stanceNotNeeded'\) \}/)
  })
})

describe('a withdrawal ends this device\'s standing decision to send', () => {
  it('the hook clears iSend when the tally empties', () => {
    expect(codeOf('./useBackgroundSigner.ts')).toMatch(/else if \(seats\.length === 0\) setISend\(false\)/)
  })
})

describe('copy', () => {
  for (const key of ['signing.senderSending', 'signing.senderWaiting', 'signing.stalledReopen', 'signing.seatNotNeeded', 'proposal.stanceNotNeeded']) {
    it(`${key} exists in both languages, without em dashes`, () => {
      expect(en[key], key).toBeTruthy()
      expect(ptBR[key], key).toBeTruthy()
      expect(en[key]).not.toMatch(/—/)
      expect(ptBR[key]).not.toMatch(/—/)
    })
  }
})
