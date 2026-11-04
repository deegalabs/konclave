import { describe, expect, it } from 'vitest'
import { humanError, tooLargeText } from './api'
import { tooLargeOf } from './helper'
import { readReply } from './send-outcome'
import { panelStep } from './send-preflight'
import { codeOf } from './source-scan'
import { en } from './i18n/en'
import { ptBR } from './i18n/pt-BR'

// #821. A payment or payroll whose signing request does not fit the relay used to be approved and
// then die at the send. The coordinator now refuses it with `422 too many actions` and the two
// counts the message is made of, at creation and at the send's last gate. These pin that the counts
// reach the screen, and that the screen offers the remedy for the plan it is.

// The key and its variables, so a test sees which message was picked and with what.
const t = (k: string, vars?: Record<string, string | number>) => (vars ? `${k} ${JSON.stringify(vars)}` : k)

// The coordinator's answer, as `helper-server` writes it (`too_many_actions_resp`).
const answer = (plan: string) => ({
  error: 'too many actions',
  actions: 7,
  max_actions: 5,
  plan,
  detail: `this ${plan} needs 7 parts and one payment can carry at most 5`,
})

describe('the coordinator’s refusal is read with its counts', () => {
  it('a payroll and a payment', () => {
    expect(tooLargeOf(answer('payroll'))).toEqual({ actions: 7, max: 5, plan: 'payroll' })
    expect(tooLargeOf(answer('payment'))).toEqual({ actions: 7, max: 5, plan: 'payment' })
  })

  it('and nothing that lacks a count or a known plan is one', () => {
    for (const bad of [
      null,
      'too many actions',
      { ...answer('payroll'), error: 'insufficient funds' },
      { ...answer('payroll'), actions: '7' },
      { ...answer('payroll'), actions: 7.5 },
      { ...answer('payroll'), max_actions: 0 },
      { ...answer('payroll'), max_actions: undefined },
      { ...answer('payroll'), plan: 'sweep' },
      { ...answer('payroll'), plan: undefined },
    ]) expect(tooLargeOf(bad), JSON.stringify(bad)).toBeUndefined()
  })
})

describe('the message names the counts and the remedy for the plan', () => {
  it('a payroll is told to use fewer lines, a payment a smaller amount', () => {
    expect(tooLargeText(t, { actions: 7, max: 5, plan: 'payroll' })).toBe('error.tooLargePayroll {"actions":7,"max":5}')
    expect(tooLargeText(t, { actions: 7, max: 5, plan: 'payment' })).toBe('error.tooLargePayment {"actions":7,"max":5}')
  })

  it('humanError takes the counts ahead of every rule that reads text', () => {
    const a = answer('payroll')
    expect(humanError(t, a.error, a.detail, { actions: 7, max: 5, plan: 'payroll' })).toBe('error.tooLargePayroll {"actions":7,"max":5}')
  })

  it('without the counts it still says what happened, not the detail or a generic error', () => {
    const a = answer('payment')
    expect(humanError(t, a.error, a.detail)).toBe('error.tooLarge')
    expect(humanError(t, 'Too Many Actions')).toBe('error.tooLarge')
  })
})

describe('at the send, the refusal ends as a failure worded from the counts', () => {
  it('readReply keeps the counts and the panel words them', () => {
    const tl = { actions: 7, max: 5, plan: 'payroll' as const }
    const end = readReply({ error: 'too many actions', tooLarge: tl })
    expect(end).toEqual({ kind: 'not-sent', why: 'error', raw: 'too many actions', tooLarge: tl })
    expect(panelStep(end, t)).toEqual({ do: 'fail', text: 'error.tooLargePayroll {"actions":7,"max":5}', raw: 'too many actions' })
  })
})

describe('the counts are carried on every path that meets the refusal', () => {
  it('the helper records them on a failed write and on a refused send', () => {
    const helper = codeOf('helper.ts')
    expect(helper).toMatch(/tooLarge: tooLargeOf\(answer\)/)
    expect(helper).toMatch(/const tooLarge = tooLargeOf\(data\)/)
  })

  it('both create calls hand them to the screen, and both screens pass them to humanError', () => {
    const api = codeOf('api.ts')
    for (const fn of ['createProposal', 'createPayroll']) {
      const body = api.split(`export async function ${fn}`)[1]?.split('\nexport ')[0] ?? ''
      expect(body, fn).toMatch(/if \(f\?\.tooLarge\) return \{ ok: false, error: f\.error \?\? 'too many actions', tooLarge: f\.tooLarge \}/)
    }
    for (const screen of ['screens/NewPayment.tsx', 'screens/NewPayroll.tsx']) {
      expect(codeOf(screen), screen).toMatch(/humanError\(t, res\.error, res\.detail, res\.tooLarge\)/)
    }
  })
})

describe('the copy', () => {
  const keys = ['error.tooLargePayment', 'error.tooLargePayroll', 'error.tooLarge']
  const dicts = { en: en as Record<string, string>, ptBR: ptBR as Record<string, string> }

  it('exists in both languages, and the counted ones carry both counts', () => {
    for (const [name, d] of Object.entries(dicts)) {
      for (const k of keys) expect(d[k], `${name} ${k}`).toBeTruthy()
      for (const k of ['error.tooLargePayment', 'error.tooLargePayroll']) {
        expect(d[k], `${name} ${k}`).toContain('{actions}')
        expect(d[k], `${name} ${k}`).toContain('{max}')
      }
    }
  })

  it('promises no line count, names no engine word and no action the app has no button for', () => {
    for (const [name, d] of Object.entries(dicts)) {
      for (const k of keys) {
        // What the member reads: the placeholders are filled with the counts.
        const s = (d[k] ?? '').replace(/\{actions\}|\{max\}/g, '')
        expect(s, `${name} ${k}`).not.toMatch(/\d/)
        expect(s, `${name} ${k}`).not.toMatch(/action|pool|note|consolid|coordinat|coordenad|relay/i)
      }
    }
  })
})
