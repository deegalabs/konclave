/// <reference types="node" />
// What the screen makes of a refusal a network upgrade is behind (#638), from the wire to the words.
// The screen decides by the coordinator's structured `reason` and `held_until`, never by its English
// text: the text is a draft and will change, and a screen that matched it would fall back to a raw
// sentence the day it did. Each test sends text the code has never seen, so only the reason can carry it.
import { readFileSync } from 'node:fs'
import { describe, expect, it, vi } from 'vitest'
import { en } from './i18n/en'
import { ptBR } from './i18n/pt-BR'

const mem = new Map<string, string>()
if (typeof globalThis.localStorage === 'undefined' || !globalThis.localStorage?.setItem) {
  vi.stubGlobal('localStorage', {
    getItem: (k: string) => mem.get(k) ?? null,
    setItem: (k: string, v: string) => void mem.set(k, String(v)),
    removeItem: (k: string) => void mem.delete(k),
    clear: () => mem.clear(),
  })
}
localStorage.setItem('konclave.coord.mode', 'custom')
localStorage.setItem('konclave.coord.url', 'https://coordinator.invalid')
let answer: { status: number; body: unknown } = { status: 409, body: {} }
vi.stubGlobal('fetch', async () => new Response(JSON.stringify(answer.body), { status: answer.status }))

const { executeProposal } = await import('./helper')
const { readReply, EPOCH_REASONS } = await import('./send-outcome')
const { panelStep, netReplyText } = await import('./send-preflight')

const send = () => executeProposal({ vault: 'gp', proposalId: 'p1', relayBase: 'https://relay.invalid', room: 'r', dryRun: false })
const t = (k: string, v?: Record<string, string | number>) => (v ? `${k} ${JSON.stringify(v)}` : k)
const TEXT = 'zzz coordinator wording nobody has matched before'

describe('an upgrade refusal is decided by its reason', () => {
  const cases: Array<[string, string]> = [
    ['hold', 'error.upgradeHold'],
    ['crossing_hold', 'error.upgradeHoldCrossing'],
    ['not_updated', 'error.coordinatorNotUpdated'],
    ['needs_new_signature', 'error.needsNewSignature'],
  ]
  for (const [reason, key] of cases) {
    it(`${reason} reaches ${key} whatever the text says`, async () => {
      answer = { status: 409, body: { error: TEXT, reason } }
      const end = readReply(await send())
      expect(end).toMatchObject({ kind: 'not-sent', why: 'error', epoch: { reason } })
      expect(panelStep(end, t)).toEqual({ do: 'fail', text: key, raw: TEXT })
    })
  }

  it('the block the funds are held until comes from held_until, not from the text', async () => {
    answer = { status: 409, body: { error: TEXT, reason: 'needs_new_signature', held_until: 3534560 } }
    const end = readReply(await send())
    expect(panelStep(end, t)).toEqual({ do: 'fail', text: 'error.fundsHeldUntil {"height":3534560}', raw: TEXT })
  })

  it('with the reason dropped, the screen does NOT read the English text as an upgrade ending', async () => {
    for (const text of [
      'this payment needs a new signature: the network upgraded before it was mined',
      'the network is upgrading; this payment can be sent once the upgrade block is mined',
    ]) {
      answer = { status: 409, body: { error: text } }
      const end = readReply(await send())
      expect(end).toEqual({ kind: 'not-sent', why: 'error', raw: text })
      const step = panelStep(end, t)
      expect(step.do === 'fail' && step.text.startsWith('error.upgrade'), text).toBe(false)
      expect(step.do === 'fail' && step.text === 'error.needsNewSignature', text).toBe(false)
    }
  })

  it('an unknown reason is an ordinary failure, not an upgrade ending', async () => {
    answer = { status: 409, body: { error: TEXT, reason: 'something_new' } }
    expect(readReply(await send())).toEqual({ kind: 'not-sent', why: 'error', raw: TEXT })
  })

  it('/net words each in both languages from the dictionaries, never the raw English', async () => {
    for (const [reason, key] of cases) {
      answer = { status: 409, body: { error: TEXT, reason } }
      const said = netReplyText(readReply(await send()))
      expect(said.en, reason).toBe(en[key])
      expect(said.pt, reason).toBe(ptBR[key])
      expect(said.en + said.pt).not.toContain(TEXT)
      expect(said.stop).toBe(true)
    }
    answer = { status: 409, body: { error: TEXT, reason: 'needs_new_signature', held_until: 3534560 } }
    const said = netReplyText(readReply(await send()))
    expect(said.en).toContain('3534560')
    expect(said.pt).toContain('3534560')
  })
})

// The four values are the coordinator's: written in orchestrator/src/epoch.rs. Read from there, so a
// reason renamed on one side and not the other fails here and not in front of a member.
describe('the reasons are the coordinator\'s', () => {
  const rust = readFileSync(new URL('../../orchestrator/src/epoch.rs', import.meta.url), 'utf8')
  it('are exactly the ones epoch.rs sends', () => {
    const reasonFn = rust.slice(rust.indexOf('pub fn reason(self)'), rust.indexOf('pub fn text(self)'))
    const refusals = [...reasonFn.matchAll(/=> "(\w+)"/g)].map((m) => m[1])
    const needs = /NEEDS_NEW_SIGNATURE_REASON: &str = "(\w+)"/.exec(rust)?.[1]
    expect(refusals.length).toBe(3)
    expect([...refusals, needs].sort()).toEqual([...EPOCH_REASONS].sort())
  })
})
