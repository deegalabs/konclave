// What the signing panel renders around the device's reading and its refusals (#610), as static
// markup. This repo has no DOM test library and server rendering runs no effects, so only the
// render-time rules are reachable here; that is most of what the review found wrong on this screen.
import { describe, expect, it, vi } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import type { SignPreview } from './signing-machine'

const PAY_UA = 'utest1cx3tarwlxt8vw60ugpddnsjemj3aum5nhkwpdyy0kn0urhhq27lu0q3ajv4whnav4mschgsnum4tvt5l22zs47ccltyfrxqwkcal5m47'
const CHG_RCV = '8dfd0a5e'
const OUTSIDER = 'cacacaca'

const state: { bg: Record<string, unknown>; ours: (r: string | null) => boolean } = {
  bg: {},
  ours: () => false,
}

vi.mock('./VaultSigner', () => ({
  useVaultSigner: () => ({
    bg: state.bg,
    vault: { id: 'vtest000', group_pubkey: 'gp', member_list: [{ name: 'Ana' }, { name: 'Bia' }] },
    threshold: 2,
    myName: 'Ana',
    active: { id: 'p1', kind: 'payment', to_address: PAY_UA, value_zec: '1', state: 'ready' },
    open: () => {}, close: () => {}, reseat: () => {}, armed: false,
    unarmActive: async () => {}, armActive: async () => {}, armedUntil: null,
    isOurReceiver: (r: string | null) => state.ours(r),
  }),
}))
vi.mock('./toast', () => ({ useToast: () => ({ show: () => {}, ok: () => {}, err: () => {}, success: () => {}, error: () => {} }) }))

const { I18nProvider } = await import('./i18n')
const { default: SigningPanel } = await import('./screens/SigningPanel')

// A payment with a label, the vault's change, and an unlabelled output to someone else.
const reading: SignPreview = {
  outputs: [
    { zat: 100_000_000, addr: PAY_UA, recipient: 'eb843eb1' },
    { zat: 99_960_000, addr: null, recipient: CHG_RCV },
    { zat: 12_345_678, addr: null, recipient: OUTSIDER },
  ],
  feeZat: 20_000,
}
const baseBg = { ready: true, phase: 'idle', error: '', what: null, seatCount: 2, armedSeats: [], iSend: false, peerFailure: null, clearPeerFailure: () => {}, signature: null }

function render(bg: Record<string, unknown>, opts: { ours?: (r: string | null) => boolean } = {}): string {
  state.bg = { ...baseBg, ...bg }
  state.ours = opts.ours ?? ((r) => r === CHG_RCV)
  return renderToStaticMarkup(<I18nProvider><SigningPanel /></I18nProvider>)
}

describe('the signing panel (#610)', () => {
  it('words a final refusal as one, shows what was refused with exact amounts, and offers no Try again', () => {
    // The gate refuses after the device read the transaction, so this refusal has a reading.
    const html = render({ error: 'net.err.notApproved', what: reading })
    expect(html).toContain('Refused to sign: this transaction does not pay exactly')
    expect(html).toContain('Do not try again, and tell the other members')
    expect(html).not.toContain('Could not send')
    expect(html).toContain('Read from the refused transaction')
    expect(html).toContain('0.9996')
    expect(html).toContain('0.12345678')
    expect(html).toContain('0.0002')
    expect(html).not.toContain('Try again')
  })

  it('a refusal of a transaction the device could not read has no reading, and no Try again', () => {
    // readPayment refuses before there is a reading (the fee, commitment, label and shape checks).
    const html = render({ error: 'net.err.feeTooHigh', what: null })
    expect(html).toContain('Refused to sign: the network fee')
    expect(html).not.toContain('role="list"')
    expect(html).not.toContain('Try again')
  })

  it('calls only the vault\'s own receiver change, and an unlabelled outsider unnamed', () => {
    const html = render({ error: 'net.err.notApproved', what: reading })
    expect(html.match(/back to the vault \(change\)/g)?.length).toBe(1)
    expect(html.match(/an address this transaction does not name/g)?.length).toBe(1)
    expect(render({ error: 'net.err.notApproved', what: reading }, { ours: () => false })).not.toContain('back to the vault (change)')
  })

  it('says a refusal for an approval it could not load does not by itself show tampering, and that the coordinator can cause it', () => {
    // The machine reports this refusal itself (signing-machine.test.ts); an earlier wording called it
    // "not a sign of tampering", which a coordinator that withholds the approval would want said.
    const html = render({ error: 'net.err.approvalUnknown', what: reading })
    expect(html).toContain('could not load what the group approved')
    expect(html).toContain('the coordinator can cause it')
    expect(html).toContain('tell the other members')
    expect(html).not.toContain('is not a sign of tampering')
    expect(html).not.toContain('does not pay exactly what the group approved')
    expect(html).not.toContain('Try again')
  })

  it('shows an ignored message beside the progress, not in its place, while signing goes on', () => {
    const html = render({ phase: 'signing', error: 'net.err.notCoordinator', what: reading })
    expect(html).toContain('This device ignored a signing message')
    expect(html.split('This device ignored a signing message').length, 'shown once, beside the progress').toBe(2)
    expect(html).not.toContain('Refused to sign')
    expect(html).toMatch(/<span class="confirm" role="status">/) // the progress is still there
    // Before the reading, so a long payroll does not push it out of view.
    expect(html.indexOf('This device ignored a signing message')).toBeLessThan(html.indexOf('Checked on this device'))
  })

  it('drops the ignored-message note once the signature is done', () => {
    const html = render({ phase: 'signed', error: 'net.err.notCoordinator', what: reading })
    expect(html).not.toContain('This device ignored a signing message')
  })

  it('while signing: the stage is the status, the clock is not live, the reading is a list below the clock', () => {
    const html = render({ phase: 'signing', what: reading })
    expect(html).toMatch(/<span class="confirm" role="status">/)
    expect(html).not.toContain('aria-live')
    expect(html).toContain('role="list"')
    expect(html.match(/role="listitem"/g)?.length).toBe(3)
    const list = html.slice(html.indexOf('role="list"'))
    expect(list.match(/<span aria-hidden="true">→<\/span>/g)?.length).toBe(3)
    expect(html.indexOf('This takes a few minutes')).toBeLessThan(html.indexOf('Checked on this device'))
  })
})
