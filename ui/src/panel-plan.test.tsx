// The panel and the confirm RENDERED with each state of `plan`. The scans in approved-plan.test.ts read
// source text, so `{false && <PlanLines ... />}` and a destructured to_address pass them.
import { describe, expect, it, vi } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import { MemoryRouter } from 'react-router-dom'
const SEEN = 'u1fromthelist'
const PLAN = 'u1fromtheplan'
const state: { plan: unknown; active: Record<string, unknown> } = { plan: undefined, active: {} }
const share = { x: 1 }
vi.mock('./VaultSigner', () => ({
  useVaultSigner: () => ({
    bg: { ready: true, phase: 'idle', error: '', what: null, seatCount: 2, armedSeats: [], iSend: false, peerFailure: null, clearPeerFailure: () => {}, signature: null, wouldComplete: () => false, sendingNamed: () => false, completed: () => null },
    vault: { id: 'vtest000', group_pubkey: 'gp', member_list: [{ name: 'Ana' }, { name: 'Bia' }] },
    threshold: 2, myName: 'Ana', active: state.active, plan: state.plan,
    open: () => {}, close: () => {}, reseat: () => {}, armed: false, unarmActive: async () => {}, armActive: async () => {}, armedUntil: null,
    isOurReceiver: () => false, signedBefore: null,
  }),
}))
vi.mock('./session', async (o) => ({ ...(await o<typeof import('./session')>()), getUnlockedShare: () => share, unlockedHere: () => true }))
vi.mock('./toast', () => ({ useToast: () => ({ show: () => {}, ok: () => {}, err: () => {}, warn: () => {}, success: () => {}, error: () => {} }) }))
const { I18nProvider } = await import('./i18n')
const { default: SigningPanel, SignConfirm } = await import('./screens/SigningPanel')
const panel = (plan: unknown, active: Record<string, unknown>) => {
  state.plan = plan
  state.active = { id: 'p1', kind: 'payment', to_address: SEEN, value_zec: '9', state: 'ready', ...active }
  return renderToStaticMarkup(<MemoryRouter><I18nProvider><SigningPanel /></I18nProvider></MemoryRouter>)
}
const signBtn = (html: string) => /<button[^>]*sign-cta[^>]*>|<button[^>]*disabled[^>]*>/.exec(html)?.[0] ?? ''
const payment = { kind: 'payment', totalZat: 100_000_000, lines: [{ address: PLAN, amountZat: 100_000_000, memo: '', isPublic: false }] }
const payroll = { kind: 'payroll', totalZat: 300, lines: [{ address: 'u1linea', amountZat: 100, memo: '', isPublic: false }, { address: 'u1lineb', amountZat: 200, memo: '', isPublic: false }] }

describe('what the panel renders from the plan', () => {
  it('shows the plan and never the opened address', () => {
    const html = panel(payment, {})
    expect(html).toContain(PLAN)
    expect(html).not.toContain(SEEN)
  })
  it('before the read: nothing to compare, no address, and the button is off', () => {
    const html = panel(undefined, {})
    expect(html).not.toContain(SEEN)
    expect(html.match(/<button/g)?.length, 'only the close button').toBe(1)
    expect(html).not.toContain('$0.00')
  })
  it('refused: says so, shows no address, and the button is off', () => {
    const on = panel(payment, {})
    const off = panel(null, {})
    expect(off).toContain('do not agree')
    expect(on).not.toContain('do not agree')
    expect(off).not.toContain(SEEN)
    expect(off.match(/<button/g)?.length, 'only the close button').toBe(1)
    expect(on.match(/<button/g)?.length).toBeGreaterThan(1)
  })
  it('a payroll lists each line with its amount', () => {
    const html = panel(payroll, { kind: 'payroll', to_address: '' })
    expect(html).toContain('u1linea')
    expect(html).toContain('u1lineb')
    expect(html).toContain('0.000002')
  })
})
describe('what the confirm renders', () => {
  it('a payroll confirm lists each line with its amount', () => {
    const html = renderToStaticMarkup(<I18nProvider><SignConfirm again={false} firstUntil={0} locale="en" amt="0.000003" dest="-" isPayroll payrollLines={payroll.lines as never} iWouldBeLast={false} t={((k: string) => k) as never} onCancel={() => {}} onConfirm={() => {}} /></I18nProvider>)
    expect(html).toContain('u1linea')
    expect(html).toContain('u1lineb')
    expect(html).toContain('0.000001')
  })
})
describe('what the critique asked for', () => {
  it('a transparent line and a transparent destination are marked at the confirm', () => {
    const base = { again: false, firstUntil: 0, locale: 'en' as const, amt: '1', iWouldBeLast: false, t: ((k: string) => k) as never, onCancel: () => {}, onConfirm: () => {} }
    const lines = [{ label: 'Ana', address: 't1pub', amountZat: 100, memo: 'rent', isPublic: true }]
    const list = renderToStaticMarkup(<I18nProvider><SignConfirm {...base} dest="-" isPayroll payrollLines={lines} /></I18nProvider>)
    expect(list).toContain('Ana')
    expect(list).toContain('rent')
    expect(list).toContain('transparent')
    const single = renderToStaticMarkup(<I18nProvider><SignConfirm {...base} dest="t1pub" isPayroll={false} destPublic /></I18nProvider>)
    expect(single).toContain('proposal.publicDestSuffix')
  })
})
void signBtn
