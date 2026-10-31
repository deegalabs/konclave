import { describe, expect, it } from 'vitest'
import { en } from './i18n/en'
import { ptBR } from './i18n/pt-BR'

// A refusal that a network upgrade is behind ends the send as `not-sent`, and `not-sent` withdraws the
// signatures (`applyPlan` calls `unarmActive`): the vote on the proposal stays, but each member has to
// give their signature again. "Your approval stands" said only half of that, so a member read it as
// "nothing to do". The strings that say it about signing keep the two halves together, in both languages.
// (The busy answer is different: there the signatures DO stand, and its own texts say so.)
const KEYS = ['error.upgradeHold', 'error.coordinatorNotUpdated', 'error.needsNewSignature'] as const

describe('the upgrade refusals say the vote stands and the signature is asked again', () => {
  it.each(KEYS)('%s, in English', (k) => {
    const s = en[k]
    expect(s, `${k} lost its English text`).toBeTruthy()
    expect(s, `${k} still says only that the approval stands`).not.toMatch(/approvals? (stands?|stay valid)/i)
    expect(s, `${k} must say the vote stands`).toMatch(/\bvote\b/i)
    expect(s, `${k} must say the signature is asked again`).toMatch(/\bsign\b.*\bagain\b|\bagain\b.*\bsign\b/i)
  })

  it.each(KEYS)('%s, in Portuguese', (k) => {
    const s = ptBR[k]
    expect(s, `${k} lost its Portuguese text`).toBeTruthy()
    expect(s, `${k} still says only that the approval stands`).not.toMatch(/aprova[çc][ãa]o (continua|valem)|aprova[çc][õo]es (continuam|valem)/i)
    expect(s, `${k} must say the vote stands`).toMatch(/\bvoto\b/i)
    expect(s, `${k} must say the signature is asked again`).toMatch(/assin\w+ de novo|nova assinatura/i)
  })

  it('the hold text is the founder\'s sentence', () => {
    expect(en['error.upgradeHold']).toContain('Your vote stands; you will be asked to sign again after the upgrade.')
    expect(ptBR['error.upgradeHold']).toContain('Seu voto continua valendo; você vai precisar assinar de novo depois da atualização.')
  })
})
