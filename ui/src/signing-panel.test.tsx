// What the signing panel renders around the device's reading and its refusals (#610), as static
// markup. This repo has no DOM test library and server rendering runs no effects, so only the
// render-time rules are reachable here; that is most of what the review found wrong on this screen.
import { describe, expect, it, vi } from 'vitest'
import { readdirSync, readFileSync } from 'node:fs'
import { renderToStaticMarkup } from 'react-dom/server'
import { MemoryRouter } from 'react-router-dom'
import type { SignPreview } from './signing-machine'

const PAY_UA = 'utest1cx3tarwlxt8vw60ugpddnsjemj3aum5nhkwpdyy0kn0urhhq27lu0q3ajv4whnav4mschgsnum4tvt5l22zs47ccltyfrxqwkcal5m47'
const CHG_RCV = '8dfd0a5e'
const OUTSIDER = 'cacacaca'

const state: { bg: Record<string, unknown>; ours: (r: string | null) => boolean; share: unknown; armed: boolean; signedBefore: unknown } = {
  bg: {},
  ours: () => false,
  share: undefined,
  armed: false,
  signedBefore: null,
}

vi.mock('./VaultSigner', () => ({
  useVaultSigner: () => ({
    bg: state.bg,
    vault: { id: 'vtest000', group_pubkey: 'gp', member_list: [{ name: 'Ana' }, { name: 'Bia' }] },
    threshold: 2,
    myName: 'Ana',
    active: { id: 'p1', kind: 'payment', to_address: PAY_UA, value_zec: '1', state: 'ready' },
    open: () => {}, close: () => {}, reseat: () => {}, armed: state.armed,
    unarmActive: async () => {}, armActive: async () => {}, armedUntil: null,
    isOurReceiver: (r: string | null) => state.ours(r),
    signedBefore: state.signedBefore,
  }),
}))
vi.mock('./session', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./session')>()),
  getUnlockedShare: () => state.share,
  // The panel asks `unlockedHere` whether it can sign; the test's share is what answers it.
  unlockedHere: () => !!state.share,
}))
vi.mock('./toast', () => ({ useToast: () => ({ show: () => {}, ok: () => {}, err: () => {}, success: () => {}, error: () => {} }) }))

const { I18nProvider } = await import('./i18n')
const { default: SigningPanel, SignConfirm } = await import('./screens/SigningPanel')
const { signAgainState, againFromPanel } = await import('./sign-again')
const { estimatedFeeZat } = await import('./fee-estimate')
const { codeOf } = await import('./source-scan')

// A payment with a label, the vault's change, and an unlabelled output to someone else.
const reading: SignPreview = {
  outputs: [
    { zat: 100_000_000, addr: PAY_UA, recipient: 'eb843eb1' },
    { zat: 99_960_000, addr: null, recipient: CHG_RCV },
    { zat: 12_345_678, addr: null, recipient: OUTSIDER },
  ],
  feeZat: 20_000,
}
const baseBg = { ready: true, phase: 'idle', error: '', what: null, seatCount: 2, armedSeats: [], iSend: false, peerFailure: null, clearPeerFailure: () => {}, signature: null, wouldComplete: () => false, sendingNamed: () => false, completed: () => null }

function render(bg: Record<string, unknown>, opts: { ours?: (r: string | null) => boolean } = {}): string {
  state.bg = { ...baseBg, ...bg }
  state.ours = opts.ours ?? ((r) => r === CHG_RCV)
  return renderToStaticMarkup(<MemoryRouter><I18nProvider><SigningPanel /></I18nProvider></MemoryRouter>)
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

  it('words the button from the session\'s own answer, not from the count (#626)', () => {
    // The count says one more signature completes it; the session says whether this one would,
    // which is false while a closed quorum holds its window. The button follows the session.
    const counted = { armedSeats: [2], seatCount: 2 }
    state.share = { myName: 'Ana' } // this device holds its share, so it is offered the button
    try {
      expect(render({ ...counted, wouldComplete: () => true })).toContain('Sign and send')
      const notLast = render({ ...counted, wouldComplete: () => false })
      expect(notLast).toContain('Sign with my share')
      expect(notLast).not.toContain('Sign and send')
    } finally {
      state.share = undefined
    }
  })

  it('says someone is sending only while the room named a sender, not whenever the count is full (#626)', () => {
    // A full count with nobody named (the named sender vanished and its window passed) is not a
    // send in progress: the member signed, and signs again when the button returns.
    state.share = { myName: 'Ana' }
    state.armed = true
    try {
      const full = { armedSeats: [1, 2], seatCount: 2 }
      const named = render({ ...full, sendingNamed: () => true })
      expect(named).toContain('Whoever signed last is sending')
      const nobody = render({ ...full, sendingNamed: () => false })
      expect(nobody).not.toContain('is sending')
      expect(nobody).toContain('You signed.')
      expect(nobody).toContain('2 of 2 signed')
    } finally {
      state.share = undefined
      state.armed = false
    }
  })
})

// A device whose signature already covers another transaction for this payment refuses the new one,
// and says why; its signature is spent, so it may sign again, deliberately, after checking the book.
describe('a transaction the signature does not cover', () => {
  it('says so in the words of every refusal, and that nothing was signed this time', () => {
    state.armed = false
    const html = render({ error: 'net.err.signedAnother' })
    expect(html).toContain('Not signed: this device already signed this payment once')
    expect(html).toContain('Nothing was signed this time')
  })
  it('heads what it read as what the vault built, not as a suspect transaction', () => {
    state.armed = false
    const html = render({ error: 'net.err.signedAnother', what: reading })
    expect(html).toContain('What the vault built this time')
    expect(html).not.toContain('Read from the refused transaction')
  })
  it('offers the book first and Sign again second, both as quiet buttons, the second described by the warning', () => {
    state.armed = false
    const html = render({ error: 'net.err.signedAnother' })
    const book = html.indexOf('Open the book')
    const again = html.indexOf('Sign again')
    expect(book).toBeGreaterThan(-1)
    expect(again).toBeGreaterThan(book)
    const button = html.slice(html.lastIndexOf('<button', again), again)
    expect(button).toContain('btn ghost')
    expect(button).not.toContain('btn ok')
    const described = /aria-describedby="([^"]+)"/.exec(button)?.[1]
    expect(described).toBeTruthy()
    expect(html).toContain(`id="${described}"`)
  })
  it('offers no dead Sign again: while the others are away it says so, below the buttons, not beside them', () => {
    state.armed = false
    const html = render({ error: 'net.err.signedAnother', seatCount: 1 })
    expect(html).not.toContain('Sign again')
    expect(html).toContain('Waiting for the other signers')
    expect(html).toMatch(/Open the book<\/a><\/div><div class="hint/)
  })
  it('offers nothing while the signature is still standing', () => {
    state.armed = true
    const html = render({ error: 'net.err.signedAnother' })
    expect(html).not.toContain('Sign again')
    state.armed = false
  })
})

// What may stand in the way of signing again, each with its own reason. The failed send this very
// refusal caused does not: the sending device would otherwise be stuck on it for good.
describe('whether a device may sign again', () => {
  const ok = { refusedAsSigned: true, armed: false, ready: true, quorumHere: true, signing: false, arming: false, shortZat: 0, settled: false }
  it('offers it after the refusal, even when the refusal failed the send', () => {
    expect(signAgainState(ok)).toBe('offer')
  })
  const panel = { refusedAsSigned: true, armed: false, ready: true, quorumHere: true, phase: 'idle' as const, sending: false, arming: false, shortZat: 0, sent: false, unresolved: false, checking: 0 }
  it('offers it while the own send of this device still waits at the coordinator: that send waits for this share', () => {
    // On the device the room named sender, the refusal leaves its send open at the coordinator for
    // minutes, waiting for this very device's share. Counting it as busy hid "Sign again" until the
    // coordinator gave up and the payment read as "outcome unknown" (staging, 14/10).
    expect(againFromPanel({ ...panel, sending: true })).toBe('offer')
    expect(againFromPanel({ ...panel, phase: 'signing' })).toBe('busy')
  })
  it('offers nothing while an outcome is checked or once it is sent or unknown', () => {
    expect(againFromPanel({ ...panel, sending: true, checking: 3 })).toBe('none')
    expect(againFromPanel({ ...panel, unresolved: true })).toBe('none')
    expect(againFromPanel({ ...panel, sent: true })).toBe('none')
  })
  it('the panel asks through againFromPanel, with what it knows', () => {
    const src = codeOf('./screens/SigningPanel.tsx')
    expect(src).toMatch(/againFromPanel\(\{\s*refusedAsSigned: signAgain, armed, ready: bg\.ready, quorumHere, phase: bg\.phase, sending, arming, shortZat,\s*sent: !!sent, unresolved: !!unresolved, checking,\s*\}\)/)
    expect(src).not.toContain('signAgainState(')
  })
  it('says why when it cannot offer it yet', () => {
    const src = codeOf('./screens/SigningPanel.tsx')
    expect(src).toMatch(/againState === 'busy' && <div className="hint">\{t\('signing\.againBusy'\)\}<\/div>/)
  })
  it('names each thing in the way', () => {
    expect(signAgainState({ ...ok, shortZat: 5 })).toBe('short')
    expect(signAgainState({ ...ok, quorumHere: false })).toBe('quorum')
    expect(signAgainState({ ...ok, ready: false })).toBe('busy')
    expect(signAgainState({ ...ok, arming: true })).toBe('busy')
    expect(signAgainState({ ...ok, signing: true })).toBe('busy')
  })
  it('offers nothing without the refusal, while signed, or once the payment went out or may have', () => {
    expect(signAgainState({ ...ok, refusedAsSigned: false })).toBe('none')
    expect(signAgainState({ ...ok, armed: true })).toBe('none')
    expect(signAgainState({ ...ok, settled: true })).toBe('none')
  })
  it('the panel clears the failed send before signing again, and drops a confirm that no longer applies', () => {
    const src = codeOf('./screens/SigningPanel.tsx')
    expect(src).toMatch(/if \(opts\.again\) clearShown\(\)/)
    expect(src).toMatch(/if \(confirming === 'again' && againState !== 'offer'\) setConfirming\(null\)/)
    expect(src).toMatch(/onConfirm=\{\(\) => \{\s*setConfirming\(null\)\s*if \(confirming === 'again' && againState !== 'offer'\) return\s*void doSign\(\{ again: confirming === 'again' \}\)\s*\}\}/)
  })
})

// What the owner confirms when signing again is the risk of paying twice, not the generic spend.
describe('the confirm for signing again', () => {
  const t = (k: string, v?: Record<string, string | number>) => {
    let s = k
    for (const [n, x] of Object.entries(v ?? {})) s += ` ${n}=${x}`
    return s
  }
  const NOW = 1_792_490_400_000 // 2026-10-20 10:00 UTC
  const base = { amt: '1', usd: '', dest: 'u1dest', isPayroll: false, iWouldBeLast: false, t, onCancel: () => {}, onConfirm: () => {}, now: NOW }

  it('names the risk, the amount, and until when (date AND time) the earlier attempt can still go out', () => {
    const html = renderToStaticMarkup(<SignConfirm {...base} again firstUntil={1_792_497_600} locale="en" />)
    expect(html).toContain('signing.againTitle')
    expect(html).toContain('signing.againBody amt=1')
    expect(html).toMatch(/signing\.againUntil when=\d{2}\/\d{2}\/2026,? \d{1,2}:\d{2}/)
    expect(html).toContain('signing.againCta amt=1')
    expect(html).not.toContain('signing.confirmSignTitle')
  })
  it('claims no time that has already passed', () => {
    const html = renderToStaticMarkup(<SignConfirm {...base} again firstUntil={1_792_480_000} locale="en" />)
    expect(html).not.toContain('signing.againUntil')
    expect(html).not.toContain('signing.againPast')
  })
  it('says it sends when this signature completes the quorum', () => {
    const html = renderToStaticMarkup(<SignConfirm {...base} again iWouldBeLast firstUntil={0} locale="en" />)
    expect(html).toContain('signing.againCtaSend amt=1')
    expect(html).toContain('signing.confirmBody')
  })
  it('keeps the CTA off until the owner says they checked the book', () => {
    const html = renderToStaticMarkup(<SignConfirm {...base} again firstUntil={0} locale="en" />)
    expect(html).toContain('type="checkbox"')
    expect(html).toContain('signing.againChecked')
    const cta = html.slice(html.lastIndexOf('<button', html.indexOf('signing.againCta')), html.indexOf('signing.againCta'))
    expect(cta).toContain('disabled')
    // No estimate, no date: nothing invented.
    expect(html).not.toContain('signing.againUntil')
    expect(html).not.toContain('signing.againPast')
  })
  it('opens on the dialog itself, described by the risk, so the warning is heard before the checkbox', () => {
    const html = renderToStaticMarkup(<SignConfirm {...base} again firstUntil={1_792_497_600} locale="en" />)
    const card = html.slice(0, html.indexOf('>', html.indexOf('role="dialog"')))
    expect(card).toContain('tabindex="-1"')
    const ids = /aria-describedby="([^"]+)"/.exec(card)?.[1]?.split(' ') ?? []
    // The risk, until when, and where the payment goes: all heard before the checkbox.
    expect(ids).toEqual(['sign-again-body', 'sign-again-until', 'sign-confirm-what'])
    for (const id of ids) expect(html).toContain(`id="${id}"`)
  })
  it('states the fee and the total, as an estimate, and is described by what it pays', () => {
    const html = renderToStaticMarkup(<SignConfirm {...base} again={false} firstUntil={0} locale="en" fee="0.0001" total="1.0001" />)
    expect(html).toContain('signing.confirmCost fee=0.0001 total=1.0001')
    const card = html.slice(0, html.indexOf('>', html.indexOf('role="dialog"')))
    expect(card).toContain('aria-describedby="sign-confirm-what"')
    expect(html).toContain('id="sign-confirm-what"')
  })
  it('fits a phone: the card never outgrows the screen, its body scrolls and its buttons stay in view', () => {
    // 375 x 667 on staging (14/10): the "sign again" confirm was taller than the screen, did not
    // scroll, and its button sat below the fold.
    const html = renderToStaticMarkup(<SignConfirm {...base} again firstUntil={1_792_497_600} locale="en" />)
    expect(html).toMatch(/class="modal-card danger sign-confirm"/)
    const css = ['lacre.css', 'App.css'].map((f) => readFileSync(new URL(`./${f}`, import.meta.url), 'utf8')).join('\n').replace(/\/\*[\s\S]*?\*\//g, '')
    const rule = (sel: string) => [...css.matchAll(/([^{}]+)\{([^{}]*)\}/g)].filter((m) => m[1]!.trim() === sel).map((m) => m[2]!).join(';')
    const card = rule('.modal-card.sign-confirm')
    expect(card).toMatch(/max-height:\s*calc\(100dvh - \d+px\)/)
    expect(card).toMatch(/overflow-y:\s*auto/)
    const foot = rule('.sign-confirm > .btns')
    expect(foot).toMatch(/position:\s*sticky/)
    // On the card's edge (minus its 26px padding), so it covers no text at the end of the scroll.
    expect(foot).toMatch(/bottom:\s*-26px/)
    // Focus moved by Tab is scrolled clear of the sticky row.
    expect(card).toMatch(/scroll-padding-bottom:\s*\d+px/)
    expect(foot).toMatch(/background:/)
  })
  it('writes the time in the locale of the reader', () => {
    const at = 1_792_497_600 // 2026-10-20 12:00 UTC
    const en = renderToStaticMarkup(<SignConfirm {...base} again firstUntil={at} locale="en" />)
    const pt = renderToStaticMarkup(<SignConfirm {...base} again firstUntil={at} locale="pt-BR" />)
    const when = (h: string) => /signing\.againUntil when=([^<]+)/.exec(h)?.[1] ?? ''
    expect(when(en)).toBe(new Date(at * 1000).toLocaleString('en-US', { day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit' }))
    expect(when(pt)).toBe(new Date(at * 1000).toLocaleString('pt-BR', { day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit' }))
    expect(when(pt)).toMatch(/^\d{2}\/\d{2}\/2026,? \d{2}:\d{2}$/)
  })
  it('is the usual confirm when it is not a second signature', () => {
    const html = renderToStaticMarkup(<SignConfirm {...base} again={false} firstUntil={0} locale="en" />)
    expect(html).toContain('signing.confirmSignTitle')
    expect(html).not.toContain('signing.againTitle')
    expect(html).not.toContain('type="checkbox"')
  })
  it('the panel signs again only from that confirm, and says so to the provider', () => {
    const src = codeOf('./screens/SigningPanel.tsx')
    expect(src).toMatch(/void doSign\(\{ again: confirming === 'again' \}\)/)
    expect(src).toMatch(/await armActive\(\{ again: opts\.again \}\)/)
    expect(src).toMatch(/onClick=\{\(\) => \{ refreshRate\(\); setConfirming\('again'\) \}\}/)
  })
})

// Each outcome is its own element, so moving between them mounts it (and focuses it) again, and the
// sent headline is announced even when it replaces a refusal.
describe('the outcome a panel lands on', () => {
  it('keys each branch and announces the sent headline', () => {
    const src = codeOf('./screens/SigningPanel.tsx')
    for (const k of ['sent', 'checking', 'unresolved', 'error', 'started', 'armed']) expect(src).toContain(`key="${k}"`)
    expect(src).toMatch(/className="confirm quorum" role="status"/)
    // After a confirm the button that opened it is gone; the "you signed" state takes the focus and is heard.
    expect(src).toMatch(/<div key="armed" tabIndex=\{-1\} ref=\{focusOnMount\}>\s*<div className="confirm quorum" role="status">/)
  })
  it('a dialog asked to open on itself takes the focus there, over an autofocused field', () => {
    // No DOM in these tests and the e2e harness cannot reach this confirm: the line is pinned.
    expect(codeOf('./components.tsx')).toMatch(/if \(focusCardRef\.current\) node\?\.focus\(\)\s*else if/)
  })
  it('a dialog opened on itself keeps Shift+Tab inside it', () => {
    expect(codeOf('./components.tsx')).toMatch(/if \(e\.shiftKey && \(active === first \|\| active === node\)\) \{ e\.preventDefault\(\); last\.focus\(\) \}/)
  })
})

// What the member reads before "Sign": the whole destination, not a shortened one, and what the
// network takes on top, from the same estimate the proposal page shows.
describe('what the panel shows before signing', () => {
  it('the full destination address and the fee with the total', () => {
    state.armed = false
    const html = render({})
    expect(html).toContain(PAY_UA)
    expect(html).toContain('Network fee')
    expect(html).toContain('0.0001 ZEC')
    expect(html).toContain('Leaves the vault')
    expect(html).toContain('1.0001 ZEC')
  })
  it('says the fee is an estimate, and why, and names the destination for a screen reader', () => {
    state.armed = false
    const html = render({})
    expect(html).toContain('Network fee (estimate)')
    expect(html).toContain('Leaves the vault (estimate)')
    expect(html).toContain('The exact fee depends on which funds the vault spends')
    expect(html).toMatch(/<span class="visually-hidden">To<\/span>/)
    const sheet = html.slice(html.indexOf('<aside'), html.indexOf('>', html.indexOf('<aside')))
    const ids = /aria-describedby="([^"]+)"/.exec(sheet)?.[1]?.split(' ') ?? []
    expect(ids.length).toBeGreaterThan(0)
    for (const id of ids) expect(html).toContain(`id="${id}"`)
  })
  it('shows the reading of the device with whole addresses too', () => {
    state.armed = false
    const html = render({ error: 'net.err.notApproved', what: reading })
    const read = html.slice(html.indexOf('Read from the refused transaction'))
    expect(read).toContain(PAY_UA)
  })
  it('marks the fee box when the vault is short, and costs a payroll only once its lines are known', () => {
    const src = codeOf('./screens/SigningPanel.tsx')
    expect(src).toMatch(/className=\{'p-cost' \+ \(shortZat > 0 \? ' short' : ''\)\}/)
    expect(src).toMatch(/const feeKnown = !isPayroll \|\| payrollLines !== null/)
  })
  it('one estimate of the fee, used by every screen that shows one', () => {
    expect(estimatedFeeZat(1)).toBe(10_000)
    expect(estimatedFeeZat(0)).toBe(10_000)
    expect(estimatedFeeZat(3)).toBe(20_000)
    for (const f of ['./screens/SigningPanel.tsx', './screens/Proposal.tsx', './screens/NewPayroll.tsx']) {
      const src = codeOf(f)
      expect(src, f).not.toMatch(/5_?000 \* Math\.max/)
      expect(src, f).toContain('estimatedFeeZat(')
    }
  })
})

// The app is a hash router: a plain link to an app path loads the server's /ledger, which is the
// landing page, and throws the member out of the refusal they were asked to check (staging, 14/10).
describe('links to app pages go through the router', () => {
  it('no screen links an app path with a plain href', () => {
    const offenders: string[] = []
    const walk = (sub: string) => {
      for (const e of readdirSync(new URL(sub, new URL('./', import.meta.url)), { withFileTypes: true })) {
        if (e.isDirectory()) { if (e.name !== 'wasm-pkg') walk(`${sub}${e.name}/`) }
        else if (/\.tsx$/.test(e.name) && !/\.test\.tsx$/.test(e.name)) {
          const src = codeOf(`./${sub}${e.name}`)
          if (/href=\{?\s*["'`]\/[a-z]/.test(src)) offenders.push(`${sub}${e.name}`)
        }
      }
    }
    walk('')
    expect(offenders).toEqual([])
  })
  it('the book links in the signing panel close it, so the book is what is seen', () => {
    const src = codeOf('./screens/SigningPanel.tsx')
    expect(src.match(/<Link className="btn ghost sm-btn(?: mt-sm)?" to="\/ledger" onClick=\{close\}>/g)?.length).toBe(2)
  })
})

// SIGNER-SEAT1: the device that completed the quorum runs the send; the panel names it, keeps the
// minutes it waits outside the announced status, and offers the button to a member who has not signed.
describe('the device that is sending, named', () => {
  const full = { armedSeats: [1, 2], seatCount: 2, sendingNamed: () => true }
  const withShare = (f: () => void) => {
    state.share = { myName: 'Ana' }
    state.armed = true
    try { f() } finally { state.share = undefined; state.armed = false }
  }
  it('names the device whose signature completed the quorum', () => withShare(() => {
    const html = render({ ...full, completed: () => ({ seat: 2, at: Date.now(), seats: [1, 2] }) })
    expect(html).toContain('Bia&#x27;s device is sending')
  }))
  it('after a minute with no round, says whose device it waits on, the minutes outside the live status', () => withShare(() => {
    const html = render({ ...full, completed: () => ({ seat: 2, at: Date.now() - 120_000, seats: [1, 2] }) })
    const status = /<div class="confirm quorum" role="status">([^<]*)<\/div>/.exec(html)?.[1] ?? ''
    expect(status).toContain('Waiting for Bia&#x27;s device to send')
    expect(status, 'the countdown is not re-announced every minute').not.toMatch(/\bmin\b/)
    expect(html).toMatch(/If Bia&#x27;s screen is closed, the signatures expire in \d+ min/)
    expect(html, 'one countdown, not two').not.toContain('Your signature counts for')
  }))
  it('a started round whose sender went past its window says to reopen, and nothing contradicts it', () => withShare(() => {
    const html = render({ ...full, phase: 'signing', sendingNamed: () => false, completed: () => ({ seat: 2, at: Date.now() - 700_000, seats: [1, 2] }) })
    expect(html).toContain('has not finished in time')
    expect(codeOf('./screens/SigningPanel.tsx')).toMatch(/elapsed > 180 && !stalled &&/)
  }))
  it('a member who has not signed keeps the button while the others have', () => {
    state.share = { myName: 'Ana' }
    try {
      const html = render({ armedSeats: [2], seatCount: 2, completed: () => null })
      expect(html).toMatch(/<button class="btn ok mt-sm"(?![^>]*disabled)[^>]*>/)
    } finally { state.share = undefined }
  })
  it('once sent, the roster reads who signed from the completed quorum, which does not expire', () => {
    expect(codeOf('./screens/SigningPanel.tsx')).toMatch(/const rosterSigned = sent && done \? done\.seats : signedSeats/)
  })
})
