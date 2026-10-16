// The in-vault signing ceremony surface (K11): a right-side session Sheet that runs the ceremony in
// place, driven by the background signer (VaultSignerProvider). No /net redirect.
//
// EVERY member signs, and whoever signs LAST sends. Being present is no longer consent: each device
// makes its own deliberate click on a screen showing the amount and the destination, and the click
// that completes the quorum is the one that moves the money - so it carries the explicit confirm.
// Who "last" is comes from the signing room's ordered log, identically on every device, so two
// people clicking at the same instant still produce exactly one send.

import { useCallback, useEffect, useRef, useState } from 'react'
import { Link } from 'react-router-dom'
import { Dialog } from '../components'
import { Identicon } from '../avatar'
import { useI18n, useT, type TFn } from '../i18n'
import { useToast } from '../toast'
import { fmtZecExact, parseZecToZat } from '../format'
import { useVaultSigner } from '../VaultSigner'
import { unlockOnDevice } from '../unlock'
import { executeProposal, listProposals } from '../helper'
import { alreadySent, panelStep, resolvedStep, stepResult, unresolvedNoteKey, watchSent, type ShownStep } from '../send-preflight'
import { errorCode, getBalance, getProposalDetail, writeProof } from '../api'
import { relayBase } from '../net'
import { OutcomeBook, peerFailureMayShow, readReply, resolveOutcome, sentTxidOf, RESOLVE_ATTEMPTS, type PanelResult } from '../send-outcome'
import { endSend, newSendAttempt, takeSend } from '../send-attempt'
import { getUnlockedShare } from '../session'
import { usdEnabled, cachedRate, fetchRate, zecToUsd, type Rate } from '../price'
import { describeSigningError } from '../signing-refusal'
import { readingRows } from '../device-reading'
import { againFromPanel } from '../sign-again'
import { estimatedFeeZat } from '../fee-estimate'
import type { SignPreview } from '../signing-machine'
import { ARM_TTL_MS } from '../signing-gate'

/** What this device read from the transaction it is signing, or refused to sign (#610): every
 *  output that moves value and the fee, each checked against what the signature covers. Exact
 *  amounts, because this is what the member compares with the proposal. What an unlabelled output
 *  is called comes from `readingRows`, which calls it change only when it pays the vault itself. */
function DeviceReading({ what, t, isOurs, heading = 'signing.readHeading' }: { what: SignPreview; t: (k: string) => string; isOurs: (r: string | null) => boolean; heading?: string }) {
  return (
    <div className="mt-sm">
      <div className="klab" id="sign-read">{t(heading)}</div>
      <div role="list" aria-labelledby="sign-read">
        {readingRows(what, isOurs).map((r, i) => (
          <div key={i} role="listitem" className="sign-to mono">
            <span aria-hidden="true">→</span>{' '}
            {r.to.kind === 'address' ? <span className="sign-dest">{r.to.addr}</span> : t(r.to.kind === 'vault' ? 'signing.toVault' : 'signing.unnamed')}
            {' '}<span aria-hidden="true">·</span>{' '}
            <span className="num">{fmtZecExact(r.zat / 1e8)}{'\u00a0'}ZEC</span>
          </div>
        ))}
      </div>
      <div className="sign-to mono">
        {t('signing.networkFee')}{' '}<span aria-hidden="true">·</span>{' '}
        <span className="num">{fmtZecExact(what.feeZat / 1e8)}{'\u00a0'}ZEC</span>
      </div>
    </div>
  )
}

/** A unix time (seconds) as a local date AND time: the window it bounds is often under an hour, so a
 *  date alone would read as "all day". */
function fmtWhen(unix: number, locale: 'pt-BR' | 'en'): string {
  return new Date(unix * 1000).toLocaleString(locale === 'en' ? 'en-US' : 'pt-BR', {
    day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit',
  })
}

/** The confirm before this device signs. A second signature on a payment this device already signed
 *  confirms the risk that matters there, paying twice, not the generic spend: it says until when this
 *  device counts the earlier attempt as able to go out (the rule's own turning point;
 *  nothing when unknown or past), and its CTA stays off until the owner says
 *  they checked the book. It opens on the dialog itself, described by that text, so the warning is
 *  heard before the acknowledgement can be pressed. */
export function SignConfirm({ again, firstUntil, locale, amt, usd, dest, isPayroll, iWouldBeLast, t, onCancel, onConfirm, now = Date.now(), fee, total }: {
  again: boolean
  /** When this device stops counting the earlier attempt (unix seconds, `approvalLapsesAt`); 0 when unknown. */
  firstUntil: number
  locale: 'pt-BR' | 'en'
  amt: string
  usd?: string | null
  dest: string
  isPayroll: boolean
  iWouldBeLast: boolean
  t: TFn
  onCancel: () => void
  onConfirm: () => void
  /** The clock, in ms (tests). */
  now?: number
  /** The estimated fee and total, formatted; the line is left out when unknown. */
  fee?: string
  total?: string
}) {
  const [checked, setChecked] = useState(false)
  const title = again ? t('signing.againTitle') : iWouldBeLast ? t('signing.confirmTitle') : t('signing.confirmSignTitle')
  // The rule's own turning point: after it, a new attempt is signed without this confirm. Nothing
  // is said when it is unknown or already past (the confirm then no longer applies).
  const until = firstUntil * 1000 > now ? t('signing.againUntil', { when: fmtWhen(firstUntil, locale) }) : ''
  const cta = again
    ? iWouldBeLast ? t('signing.againCtaSend', { amt }) : t('signing.againCta', { amt })
    : iWouldBeLast ? t('signing.confirmSend', { amt }) : t('signing.confirmSignCta', { amt })
  return (
    <Dialog
      className="modal-overlay"
      cardClassName="modal-card danger sign-confirm"
      labelledBy="sign-confirm-title"
      describedBy={again ? (until ? 'sign-again-body sign-again-until sign-confirm-what' : 'sign-again-body sign-confirm-what') : 'sign-confirm-what'}
      focusCard={again}
      onClose={onCancel}
    >
      <span className="klab danger-lab">{t('proposal.confirmLabel')}</span>
      <h2 id="sign-confirm-title" className="modal-h">{title}</h2>
      <div id="sign-confirm-what" className="send-confirm-what">
        <strong className="scw-amt num">{amt} ZEC</strong>
        {usd && <span className="scw-usd dim small"> {usd}</span>}
        {isPayroll ? <span className="scw-kind"> · {t('kind.payroll')}</span> : <> <span className="visually-hidden">{t('signing.to')}</span><span className="sign-arrow" aria-hidden="true">→</span> <code className="sign-dest">{dest}</code></>}
        {fee && total && <div className="dim small mt-sm">{t('signing.confirmCost', { fee, total })}</div>}
      </div>
      {again ? (
        <>
          <p id="sign-again-body" className="modal-p">
            {t('signing.againBody', { amt })}
            {iWouldBeLast && <> {t('signing.confirmBody')}</>}
          </p>
          {until && <p id="sign-again-until" className="modal-p">{until}</p>}
          <label className="check-row mt-sm">
            <input type="checkbox" checked={checked} onChange={(e) => setChecked(e.target.checked)} />
            <span>{t('signing.againChecked')}</span>
          </label>
        </>
      ) : (
        <p className="modal-p">{iWouldBeLast ? t('signing.confirmBody') : t('signing.confirmSignBody')}</p>
      )}
      <div className="btns right mt">
        <button className="btn ghost" onClick={onCancel}>{t('common.cancel')}</button>
        <button className="btn ok" disabled={again && !checked} onClick={onConfirm}>{cta}</button>
      </div>
    </Dialog>
  )
}

export default function SigningPanel() {
  const t = useT()
  const toast = useToast()
  const { bg, vault, threshold, myName, active, close, reseat, armed, armActive, armedUntil, unarmActive, isOurReceiver, signedBefore } = useVaultSigner()
  const { locale } = useI18n()
  // Which confirm is open: the usual one, or the one for a second signature on this payment.
  const [confirming, setConfirming] = useState<null | 'sign' | 'again'>(null)
  const [sending, setSending] = useState(false)
  // When the ceremony started on THIS device. The run is minutes long and emits no event we can
  // observe, so a clock is the only honest sign that the vault is working rather than stuck - and
  // every device that signed needs it, not just the one that sent. A member who signed first sat
  // in front of a frozen line for the whole build+prove+broadcast leg with nothing moving.
  const [runSince, setRunSince] = useState<number | null>(null)
  const [elapsed, setElapsed] = useState(0)
  // What the send came to (`PanelResult`, send-outcome.ts); only `sentTxidOf` reads it as sent.
  const [result, setResult] = useState<PanelResult>(null)
  // How many checks remain while resolving an unknown outcome; 0 when not resolving.
  const [checking, setChecking] = useState(0)
  const [pass, setPass] = useState('')
  const [unlocking, setUnlocking] = useState(false)
  const [unlockErr, setUnlockErr] = useState('')
  const [arming, setArming] = useState(false)
  // The send fires from an effect (the room names the sender), so guard it: one send per attempt
  // (send-attempt.ts, the rule the who-sends simulator also runs).
  const attempt = useRef(newSendAttempt())
  // Whether this device refused the transaction (#610), for the send's own failure path, which runs
  // later from a closure that cannot see this render's values.
  const refusingRef = useRef(false)
  // True while anything is running here: this device signing, or the send it triggered.
  const started = sending || bg.phase !== 'idle'
  const [rate, setRate] = useState<Rate | null>(cachedRate())
  // The figure people actually judge is the one in their own currency, and this is the screen where
  // they commit. Re-price on open and again at the confirm, rather than showing whatever was cached
  // when the proposal was written - which can be hours or days old by now.
  const [armLeft, setArmLeft] = useState(0)
  // Signing is where a payment the vault cannot pay must stop. Approval is consent and stays open;
  // this is the act that spends, and letting it run cost two people and a full ceremony to learn
  // what one balance read would have said in a second.
  const [spendableZat, setSpendableZat] = useState<number | null>(null)
  const [payrollLines, setPayrollLines] = useState<number | null>(null)

  // A DIFFERENT payment starts from nothing (#354). The panel deliberately keeps its result when it
  // CLOSES, so a stray click on the scrim cannot erase a failure nobody read - but that same
  // persistence meant opening the next payment showed the previous one's "sent", its txid and its
  // error. `boundTo` only ever moves forward to a real payment, so closing and reopening the same
  // one still keeps what is on screen.
  const boundTo = useRef<string | null>(null)
  // What each payment's send came to on this page (OutcomeBook, send-outcome.ts).
  const outcomes = useRef(new OutcomeBook())
  useEffect(() => {
    const id = active?.id ?? null
    if (id === null || id === boundTo.current) return
    boundTo.current = id
    setResult(outcomes.current.restore(id))
    setChecking(0)
    setConfirming(null)
    setSending(false)
    setRunSince(null)
    setElapsed(0)
    setArming(false)
  }, [active?.id])

  // Start the clock when the run starts, stop it when it ends. Keyed on `started`, so it covers a
  // device that only signs just as much as the one that broadcasts.
  useEffect(() => {
    if (!started) { setRunSince(null); setElapsed(0); return }
    setRunSince((cur) => cur ?? Date.now())
  }, [started])

  useEffect(() => {
    if (runSince === null) return
    const tick = () => setElapsed(Math.floor((Date.now() - runSince) / 1000))
    tick()
    const id = window.setInterval(tick, 1000)
    return () => window.clearInterval(id)
  }, [runSince])

  useEffect(() => {
    if (!active || !vault) return
    let on = true
    // The signer's own vault, never the shared selection another tab can switch (#610 review).
    void getBalance(vault.id).then((b) => { if (on && b?.configured) setSpendableZat(b.spendable_zat ?? b.total_zat ?? null) })
    // Another payroll's line count is not this one's.
    setPayrollLines(null)
    if (active.kind === 'payroll') {
      void getProposalDetail(active.id, vault.id).then((d) => { if (on && d) setPayrollLines(Math.max(1, d.lines.length)) })
    }
    return () => { on = false }
  }, [active, vault])

  // A member who signed but did not send learns the outcome here. Only the sending device gets the
  // reply, so this is the ONLY way the rest of the vault finds out the payment is not coming.
  useEffect(() => {
    if (!bg.peerFailure) return
    // This device refused the transaction itself (#610). The coordinator then waits for signatures
    // that will not come, and its timeout reaches every device as a failed send inviting a retry.
    // The refusal is the true account here, so it stays on screen and the retry is not offered.
    if (describeSigningError(bg.error, t).kind === 'refusal') { bg.clearPeerFailure(); return }
    const msg = t('signing.peerFailed.' + bg.peerFailure)
    // Never over a payment that may be on the network, one shown as sent, or this device's own send
    // still running; and announced only when shown.
    if (!active || sending || !peerFailureMayShow(outcomes.current.restore(active.id))) { bg.clearPeerFailure(); return }
    showFor(active.id, { error: msg })
    toast.err(msg)
    bg.clearPeerFailure()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [bg.peerFailure])

  // The room decided this device sends. Its owner already passed the money confirm (that is what
  // `iWouldBeLast` gates). Fire once per attempt (send-attempt.ts).
  useEffect(() => {
    if (!bg.iSend || !active || !armed) return
    if (!takeSend(attempt.current, active.id)) return
    void doSend()
    // Deliberately keyed on the decision, the payment and the signature only: doSend closes over
    // state that changes during the send, and re-running it would be a second broadcast.
  }, [bg.iSend, active?.id, armed]) // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (!active || !usdEnabled()) return
    let on = true
    void fetchRate().then((r) => { if (on && r) setRate(r) })
    return () => { on = false }
  }, [active])

  // Count the arming down, so the screen never claims a signature that has stopped counting.
  useEffect(() => {
    if (armedUntil === null) { setArmLeft(0); return }
    const tick = () => setArmLeft(Math.max(0, Math.ceil((armedUntil - Date.now()) / 60000)))
    tick()
    const id = window.setInterval(tick, 15000)
    return () => window.clearInterval(id)
  }, [armedUntil])

  // Everyone who signed deserves the outcome, not just whoever sent. Only the sending device gets
  // the txid in its reply, so every OTHER device watches the proposal until the vault records it -
  // otherwise a member who signed sits on "sending…" forever with no way to learn it worked.
  // Every OPEN panel watches, not only the devices that signed (#626 review): a member whose device
  // did not take part must see the payment sent, and not be offered to sign it again. One read at a
  // time and none from a hidden tab (`watchSent`): during a send every read waits on the vault.
  // It watches until the payment shows as sent, through a failure or an unknown outcome too: a screen
  // that says nothing went out must learn that it did.
  const sentTxid = sentTxidOf(result)
  useEffect(() => {
    if (!active || !vault || sending || sentTxid) return
    return watchSent(() => listProposals(vault.group_pubkey), active.id, (txid) => showFor(active.id, { txid }))
  }, [active, vault, sending, sentTxid])

  // When the panel lands on an outcome (sent, unknown, refused or failed), what had focus is gone with
  // the state it belonged to. Focus goes to the message, never to a button: Enter on "Sign again"
  // would open a money confirm by reflex. Stable, so React calls it once per mount, not per render.
  const focusOnMount = useCallback((el: HTMLElement | null) => { el?.focus() }, [])

  // Every hook above this line: the panel returns null while no proposal is open, and React
  // requires the same hooks on every render.
  if (!active) return null

  // This device can only sign if its share is unlocked in this session. If not, the ceremony can
  // never seat (0/N forever) - show a clear "unlock" path instead of hanging on "Opening…".
  const loaded = vault ? getUnlockedShare(vault.id) : undefined
  const hasShare = !!loaded
  // Identify "you" from the on-device record first (it reflects a rename immediately); fall back to
  // the session share's name. A stale name here made the panel fail to find your seat and light the
  // first member instead.
  const me = myName ?? loaded?.myName ?? null
  const present = bg.seatCount
  const quorumHere = present >= threshold && threshold > 0

  // Presence by name: THIS device's own seat is the ONLY one we can attribute with certainty (by
  // name, once the signer is seated). The remaining present count fills the OTHER seats in roster
  // order. Crucially, we fill others ONLY once we've identified our own seat (`me` known) - otherwise
  // (e.g. right after a rename, before the session name syncs, or before the share resolves) we would
  // light the WRONG seat (the first in the list) instead of leaving presence to the "N / threshold"
  // count. Never guess a specific seat we cannot attribute.
  const roster = vault?.member_list ?? []
  let othersLeft = me ? Math.max(0, present - (bg.ready ? 1 : 0)) : 0
  const presentFlags = roster.map((m) => {
    if (me && m.name === me) return bg.ready
    if (me && othersLeft > 0) { othersLeft -= 1; return true }
    return false
  })
  // Who has signed. Seats are positional and fixed by the DKG, so seat i+1 IS roster[i]: unlike
  // presence (a bare count), this is attributable - we can name who signed without guessing.
  const signedSeats = bg.armedSeats
  const signedCount = signedSeats.length
  // A full count is a send in progress only while the sender the room named is within its window.
  // After it, the signatures wait for the next one past the window (#626 review): saying someone is
  // sending then told members to wait for a send nobody was making.
  const quorumSigned = threshold > 0 && signedCount >= threshold && bg.sendingNamed()
  // The device that completed the quorum runs the send (SIGNER-SEAT1): named, so the others know whose
  // screen it waits on. After a minute with no round started, the line says the signatures lapse at
  // the end of their window and can be given again. Display only: no timer decides anything here.
  const done = bg.completed()
  const senderName = done && !bg.iSend ? roster[done.seat - 1]?.name ?? null : null
  const senderLapseMin = done ? Math.max(1, Math.ceil((done.at + ARM_TTL_MS - Date.now()) / 60000)) : 0
  const senderLate = done !== null && bg.phase === 'idle' && Date.now() - done.at > 60_000
  // A round that started and whose sender went past its window: the one thing that helps is a fresh
  // panel (#284), and the "keep this open" hint must not stand beside it.
  const stalled = !sending && bg.phase === 'signing' && !bg.sendingNamed()
  // If I sign now, the quorum closes and I am the one who sends. This drives the WORDING only:
  // every signature is confirmed on its own device, whoever you are. Predicting "I am last" and
  // confirming only then would leave a hole - two people clicking in the same instant would both
  // read as not-last, and whichever one closed the quorum would send with no confirm at all.
  // The session answers it with the rule that decides (#626): the bare count disagrees with the
  // decision once expired signatures leave the tally and a closed quorum holds its window.
  const iWouldBeLast = !armed && threshold > 0 && bg.wouldComplete()

  const sent = sentTxidOf(result)
  // Who signed, as the roster shows it. Once the payment is out, from the quorum that completed, which
  // does not expire: the live count drops a signature after its window, and would then call a member
  // who signed "not needed" (a11y review 1).
  const rosterSigned = sent && done ? done.seats : signedSeats
  // A sent payment reopened after another one has no completed quorum in memory: it then says nothing
  // about who was not needed rather than read the count, which drops old signatures.
  const knowsWhoSigned = !sent || done !== null
  // A refusal by this device outranks any later failure of the send (#610): the send fails BECAUSE
  // the device refused, and the failure's wording ("you can sign again") would contradict it.
  const fromSigner = describeSigningError(bg.error, t)
  const refusal = fromSigner.kind === 'refusal' ? bg.error : ''
  refusingRef.current = refusal !== ''
  // A message this device ignored is not the outcome of anything: it is shown beside the progress,
  // never in its place, while the honest round can still be signed.
  const notice = fromSigner.kind === 'notice' && bg.phase !== 'signed' ? fromSigner.text : ''
  const errMsg = refusal || (result && 'error' in result && result.error) || (fromSigner.kind === 'failure' ? bg.error : '') || ''
  const errShown = describeSigningError(errMsg, t)
  // The send's outcome is not known and may never be. This is deliberately NOT an error state: no
  // failure wording, and above all no Retry, because the money may already have moved (#280).
  const unresolved = result && 'unresolved' in result ? result : null
  // What this device can do now is SIGN. The send is not a button any more: it follows from the
  // quorum closing, on the device the room named.
  // The signer is still coming up: has a share but hasn't seated yet. Show a loading line instead of
  // a roster that could momentarily light the wrong seat. (Declared after `started`/`result`.)
  // At the passphrase stage we SHOW the roster (the signers of this vault) - the device just hasn't
  // joined the signing room yet, so nobody reads as present (honest: real presence needs the share).
  // The loader appears only once you SUBMIT the passphrase (unlocking) and while the signer seats;
  // then the roster comes back with its real present/absent flags once THIS device is seated.
  const connecting = !started && !result && (unlocking || (hasShare && !bg.ready))

  // In full, here and in the confirm: the last thing read before a share moves is the whole address.
  const dest = active.to_address ?? '-'
  const amtNum = active.value_zec
  const amt = fmtZecExact(Number(active.value_zec))
  const isPayroll = active.kind === 'payroll'

  // ZIP-317, spends + outputs (see the note in Proposal.tsx): one spend + N destinations + change.
  // The line count is fetched with the proposal; a payroll whose lines have not landed yet is
  // costed as one destination, which under-states rather than over-states, so the block never
  // fires on a guess.
  const feeZat = estimatedFeeZat(isPayroll ? payrollLines ?? 1 : 1)
  // A payroll's fee depends on its lines: shown only once they are known, never costed on a guess.
  const feeKnown = !isPayroll || payrollLines !== null
  const amountZat = parseZecToZat(active.value_zec ?? '')
  const shortZat = spendableZat === null || amountZat === null
    ? 0
    : Math.max(0, amountZat + feeZat - spendableZat)

  // What this device can do now is SIGN - and not at all when the vault cannot pay. Approval is
  // consent and stays open; this is the act that spends.
  const canSign = bg.ready && quorumHere && !started && !result && !armed && !arming && shortZat === 0
  // The one refusal a new signature answers: this device's signature already covered another
  // transaction for this payment, and is spent.
  const signAgain = !armed && refusal.startsWith('net.err.signedAnother')
  // Whether it may, now, or what is in the way (sign-again.ts). Not `canSign`: on the device the room
  // named sender this refusal also failed the send, and that failure must not block its own answer.
  const againState = againFromPanel({
    refusedAsSigned: signAgain, armed, ready: bg.ready, quorumHere, phase: bg.phase, sending, arming, shortZat,
    sent: !!sent, unresolved: !!unresolved, checking,
  })
  // A confirm opened for signing again closes the moment it no longer applies: the payment turned
  // out to have gone out, or the device signed meanwhile. Set during render, as React allows for
  // state derived from the previous render.
  if (confirming === 'again' && againState !== 'offer') setConfirming(null)

  // Priced only if the owner opted in, and never presented as fact: the source and the age of the
  // quote ride along, so nobody reads an estimate as the amount being spent.
  const rateAgeMin = rate ? Math.floor((Date.now() - rate.at) / 60000) : 0
  const usdAmt = usdEnabled() ? zecToUsd(amtNum, rate) : null
  const usd = usdAmt
    ? t('signing.usdNote', {
        usd: usdAmt,
        source: rate?.source ?? '',
        age: rateAgeMin < 1 ? t('signing.rateNow') : rateAgeMin > 30 ? t('signing.rateStale') : t('signing.rateMin', { n: rateAgeMin }),
      })
    : null


  // A send's outcome belongs to its payment: kept for it, and shown only while it is the one on
  // screen. `boundTo` moves only when another payment opens.
  function showFor(pid: string, r: PanelResult) {
    if (outcomes.current.record(pid, r, boundTo.current)) setResult(r)
  }

  // Re-price at the moment of the decision, not at the moment the screen loaded.
  function refreshRate() {
    if (usdEnabled()) void fetchRate().then((r) => { if (r) setRate(r) })
  }

  // "Try again" clears what this payment's send came to, here and in the book.
  function clearShown() {
    if (active) outcomes.current.clear(active.id)
    setResult(null)
  }

  // What a step of the send does on screen (panelStep, resolvedStep). `resolve` is handled by the
  // caller, which asks the record; a failure has its own path, `fail`.
  function apply(pid: string, step: ShownStep) {
    if (step.do === 'fail') return fail(pid, step.text, step.raw)
    // An unknown outcome: the payment may be on the network. Not a failure: no withdrawal and no Try
    // again, and this device keeps the memory of its send (#280).
    if (step.do === 'unknown') endSend(attempt.current, pid, 'unknown')
    showFor(pid, stepResult(step))
    if (step.do === 'sent') toast.ok(t('toast.sent'))
    else toast.warn(t('toast.sendUnresolved'))
  }

  // A failed send keeps its message on the panel - the reader has to act on it - and is announced
  // as well, because the run takes minutes and nobody watches a panel for that long.
  function fail(pid: string, msg: string, raw?: string) {
    showFor(pid, stepResult({ do: 'fail', text: msg }))
    // When this device refused the transaction, the send's failure is a consequence of that refusal,
    // which the panel shows instead; announcing "could not send" over it invites the retry it rules out.
    if (!refusingRef.current) toast.err(msg)
    endSend(attempt.current, pid, 'not-sent')
    // Nothing moved, so the payment goes back to unsigned everywhere. Left standing, the failed
    // attempt's signatures sit in the permanent room and the payment reads as already signed by
    // devices that have gone - with no button to sign it and no one to send it.
    //
    // The reason travels with it, as a code. Only THIS device gets the reply, so without it every
    // other member who signed sits on "sending" and never learns the payment is not coming.
    void unarmActive(errorCode(raw ?? msg))
  }

  async function doSend() {
    // Every exit from here must leave a visible trace. The panel used to close its confirm dialog
    // and then, on some paths, show nothing at all: no error, no progress, no way to tell whether
    // the vault was working, stuck, or done. On a money screen that is the worst possible state,
    // because the honest next move (wait? retry? check the chain?) is unknowable.
    if (!vault) { setResult({ error: t('signing.errNoVault') }); return }
    // The payment this send is for. Its outcome is shown only while it is still the one on screen
    // (`showFor`): a late reply used to land on whatever payment was open by then.
    const pid = active!.id
    const args = {
      vault: vault.group_pubkey,
      proposalId: pid,
      relayBase: relayBase(),
      room: bg.room,
      dryRun: false,
      // #288: firing the broadcast is a governance write, bound to this proposal's id. Undefined on
      // a locked device, which the helper still accepts while the vault has no write keys.
      proof: await writeProof(vault.group_pubkey, 'send', active!.id),
    }
    // Breadcrumbs for a failure a user reports later: what we asked for, and what came back. No
    // secret is logged (the group key and the proposal id are public vault material).
    console.info('[konclave] send: start', { proposal: args.proposalId, room: args.room, phase: bg.phase })
    setConfirming(null)
    let asked = false
    setSending(true)
    outcomes.current.clear(pid)
    setResult(null)
    try {
      // The coordinator's record is the last word on whether this payment went out (send-preflight):
      // a sender named after a vanished one's window must not send it twice (#626, #334).
      const sentAs = alreadySent(await listProposals(vault.group_pubkey), args.proposalId)
      if (sentAs) {
        console.info('[konclave] send: already sent', { proposal: args.proposalId, txid: sentAs })
        showFor(pid, { txid: sentAs })
        return
      }
      asked = true // from here the request may have been served, broadcast included
      const r = await executeProposal(args)
      console.info('[konclave] send: reply', r)
      // What each ending means for the screen is one tested rule (panelStep, send-preflight.ts).
      const step = panelStep(readReply(r), t)
      if (step.do === 'resolve') await resolveUnknown(vault.group_pubkey, pid)
      else apply(pid, step)
    } catch (e) {
      // A throw here previously escaped as an unhandled rejection: `sending` stayed true forever and
      // the panel sat on a progress line that would never resolve.
      console.error('[konclave] send: threw', e)
      // A throw after the request went out may follow a broadcast: unknown, never a failure.
      if (asked) apply(pid, { do: 'unknown', why: 'lost' })
      else fail(pid, e instanceof Error ? e.message : String(e))
    } finally {
      setSending(false)
    }
  }

  /**
   * The send's outcome is unknown. Ask the vault, repeatedly, instead of guessing (#280).
   *
   * Two endings, and each one says exactly what it knows. `sent` is a normal success found the
   * slow way. Anything else stays unresolved: no failure, no Retry, and a line telling the person
   * where to look. A record that still reads ready with no txid is not "nothing was sent".
   */
  async function resolveUnknown(groupKey: string, proposalId: string): Promise<void> {
    // The countdown is this payment's: another payment opened meanwhile does not show it.
    const count = (n: number) => { if (boundTo.current === proposalId) setChecking(n) }
    count(RESOLVE_ATTEMPTS)
    try {
      const r = await resolveOutcome(proposalId, {
        list: () => listProposals(groupKey),
        wait: (ms) => new Promise((res) => window.setTimeout(res, ms)),
        onAttempt: count,
      })
      console.info('[konclave] send: resolved', r)
      // Sent, or still unknown: never a failure, and no withdrawal (resolvedStep).
      apply(proposalId, resolvedStep(r))
    } finally {
      setChecking(0)
    }
  }

  // Sign from this device: arm the gate, then tell the room. If this arming completes the quorum,
  // the room names this device the sender and the effect below fires the broadcast.
  async function doSign(opts: { again: boolean } = { again: false }) {
    // The failed send this device's refusal caused is answered by signing again: clear it here and
    // in the book, as Try again does for any other failure.
    if (opts.again) clearShown()
    setArming(true)
    try {
      await armActive({ again: opts.again })
    } finally {
      setArming(false)
    }
  }

  // Unlock this device's share right here in the panel (no trip to the vault picker), then re-seat.
  async function doUnlock() {
    if (!vault || pass.length < 1) return
    setUnlocking(true)
    setUnlockErr('')
    try {
      // The same `unlockOnDevice` the picker and the lock overlay call. This was a THIRD copy of
      // loadVault -> setUnlockedShare -> markVaultUnlocked; #467 folded the first two together and
      // missed this one, which is how one rule ends up with three implementations.
      const r = await unlockOnDevice(vault.id, 'net', pass)
      if (!r.ok) { setUnlockErr(t('vaults.unlockWrong')); return }
      setPass('')
      reseat() // the signer re-runs now that the share is in session
    } finally {
      setUnlocking(false)
    }
  }

  function onClose() {
    // Closing stops the background signer (`VaultSigner` passes it no vault without an open
    // proposal), so reopening starts a new session that reads the room back, like a reload (#334).
    // The result is NOT cleared: wiping it here meant a stray click on the scrim could erase a
    // failure the user never read.
    setConfirming(null)
    close()
  }

  return (
    <>
      <div className="sign-scrim" onClick={onClose} aria-hidden="true" />
      <aside className="sign-sheet" role="dialog" aria-modal="true" aria-labelledby="sign-title" aria-describedby="sign-amount">
        <div className="sign-head">
          <span className="klab">{isPayroll ? t('kind.payroll') : t('kind.payment')}</span>
          <button className="sign-x" onClick={onClose} aria-label={t('signing.close')}>×</button>
        </div>
        <h2 id="sign-title" className="sign-title">{t('signing.title')}</h2>

        <div className="sign-what">
          <span id="sign-amount" className="sign-amt num">{amt} <span className="dim small">ZEC</span></span>
          {usd && <span className="sign-usd dim small">{usd}</span>}
          {/* The whole address, not a shortened one: what the member compares with the proposal
              before signing has to be all of it (a shortened address matches a look-alike). */}
          <span className="sign-to sign-dest mono">{isPayroll ? t('kind.payroll') : <><span className="visually-hidden">{t('signing.to')}</span><span className="sign-arrow" aria-hidden="true">→</span> {dest}</>}</span>
          {/* What the network takes on top, from the same estimate the proposal page shows; the
              device checks the real fee against the transaction itself before its share moves. */}
          {/* An estimate, and labelled one: the exact fee depends on the notes the vault spends, and
              the device signs any fee that follows ZIP 317 for the transaction it reads. */}
          {amountZat !== null && feeKnown && (
            <div id="sign-cost" className={'p-cost' + (shortZat > 0 ? ' short' : '')}>
              <span className="p-cost-line">
                <span className="p-cost-k">{t('signing.costFee')}</span>
                <span className="p-cost-v num"><span className="visually-hidden">: </span>+ {fmtZecExact(feeZat / 1e8)} ZEC</span>
              </span>
              <span className="p-cost-line">
                <span className="p-cost-k">{t('signing.costTotal')}</span>
                <span className="p-cost-v num"><span className="visually-hidden">: </span><b>{fmtZecExact((amountZat + feeZat) / 1e8)} ZEC</b></span>
              </span>
              <span className="p-cost-note dim small">{t('signing.costNote')}</span>
            </div>
          )}
        </div>

        {/* Presence: how many devices are on the vault's signing room now. */}
        <div className="sign-presence">
          <div className="sign-presence-head">
            <span className="klab">{t('signing.presence')}</span>
            <span className="mono"><b>{present}</b> / {threshold}</span>
          </div>
          {connecting ? (
            <div className="sign-roster-loading">
              <span className="loader-ring sm" aria-hidden="true" />
              <span>{unlocking ? t('signing.loadingUnlock') : t('signing.connecting')}</span>
            </div>
          ) : (
            <div className="sign-roster">
              {roster.map((m, i) => (
                <span
                  className={'sign-seat' + (presentFlags[i] ? ' on' : '') + (rosterSigned.includes(i + 1) ? ' signed' : '')}
                  key={m.pubkey || m.name}
                >
                  <Identicon seed={m.pubkey || m.name} size={22} />
                  <span className="sign-seat-name">{m.name}{me && m.name === me && <span className="klab"> {t('members.youShort')}</span>}</span>
                  {rosterSigned.includes(i + 1) && (
                    <>
                      {/* The tick reads at a glance; the label makes it readable at all. */}
                      <span className="visually-hidden">, {t('signing.seatSigned')}</span>
                      <span className="sign-seat-tick" aria-hidden="true">✓</span>
                    </>
                  )}
                  {sent && knowsWhoSigned && !rosterSigned.includes(i + 1) && <span className="sign-seat-nn"><span className="visually-hidden">, </span>{t('signing.seatNotNeeded')}</span>}
                </span>
              ))}
            </div>
          )}
        </div>

        {/* State */}
        <div className="sign-state">
          {sent ? (
            <div key="sent" className="sign-ok" tabIndex={-1} ref={focusOnMount}>
              <div className="confirm quorum" role="status">{t('signing.sentTitle')}</div>
              {sent && (
                <div className="p-meta mt-sm">
                  <div className="sign-txid mono"><code>{sent}</code></div>
                  <a className="link" href={`https://mainnet.zcashexplorer.app/transactions/${sent}`} target="_blank" rel="noreferrer">{t('proposal.viewExplorer')}</a>
                </div>
              )}
            </div>
          ) : checking > 0 ? (
            <div key="checking" className="sign-run">
              <div className="sign-run-head">
                <span className="loader-ring sm" aria-hidden="true" />
                <span>{t('signing.checking')}</span>
              </div>
              <div className="note">{t('signing.checkingNote', { n: checking })}</div>
            </div>
          ) : unresolved ? (
            // One alert for the block: the instruction that keeps a payment from going out twice is
            // in the note, and a screen reader has to hear it with the headline.
            <div key="unresolved" className="sign-err" role="alert" tabIndex={-1} ref={focusOnMount}>
              <div className="hint warn">{t('signing.unresolved')}</div>
              <div className="note">{t(unresolvedNoteKey(unresolved.unresolved))}</div>
              {unresolved.txid && <div className="note mono sign-txid">{unresolved.txid}</div>}
              <Link className="btn ghost sm-btn mt-sm" to="/ledger" onClick={close}>{t('signing.openLedger')}</Link>
            </div>
          ) : errMsg ? (
            <div key="error" className="sign-err" tabIndex={-1} ref={focusOnMount}>
              <div className="hint err" role="alert" id="sign-err-text">{errShown.text}</div>
              {/* A refusal shows what the device read, so the member can compare it with the
                  proposal as the message asks; and no Try again, because a refusal is not a failed send. */}
              {errShown.kind === 'refusal' && bg.what && <DeviceReading what={bg.what} t={t} isOurs={isOurReceiver} heading={signAgain ? 'signing.readAgainHeading' : 'signing.readRefusedHeading'} />}
              {errShown.kind !== 'refusal' && (
                // The failure released this device's send memory and withdrew its signature, so
                // "Try again" returns to signing: the next quorum names its sender.
                <button className="btn ghost sm-btn mt-sm" onClick={clearShown}>{t('signing.tryAgain')}</button>
              )}
              {/* This device's signature covered another transaction for this payment and is spent:
                  the book first, then its owner may sign again, deliberately, through a confirm that
                  names the risk of paying twice. Both quiet: the green weight is in that confirm. No
                  dead button: while the device cannot sign, it says why. */}
              {signAgain && (
                <>
                  <div className="btns mt-sm">
                    {/* Through the router, and the panel closes so the book is what is seen. Reopening
                        this payment brings the refusal and "Sign again" back; closing ends this
                        device's signing session, so signing again then joins the vault's next
                        attempt rather than the send that was open. */}
                    <Link className="btn ghost sm-btn" to="/ledger" onClick={close}>{t('signing.openLedger')}</Link>
                    {againState === 'offer' && (
                      <button className="btn ghost sm-btn" aria-describedby="sign-err-text" onClick={() => { refreshRate(); setConfirming('again') }}>{t('signing.signAgain')}</button>
                    )}
                  </div>
                  {againState === 'short' && <div className="hint">{t('signing.blockedShort', { short: fmtZecExact(shortZat / 1e8) })}</div>}
                  {againState === 'quorum' && <div className="hint">{t('signing.waiting')}</div>}
                  {againState === 'busy' && <div className="hint">{t('signing.againBusy')}</div>}
                </>
              )}
            </div>
          ) : started ? (
            <div key="started" className="sign-run" tabIndex={-1} ref={focusOnMount}>
              <div className="sign-run-head">
                <span className="loader-ring sm" aria-hidden="true" />
                {/* Three real stages, in order, instead of one label that claims the wrong one: the
                    coordinator builds and proves before any share is asked for, so "signed,
                    sending" was a lie for the whole first minute on the sending device. */}
                {/* The stage is what changes meaningfully, so it is the status a screen reader
                    announces; the clock below ticks every second and is not announced. */}
                <span className="confirm" role="status">
                  {bg.phase === 'signed' ? t('signing.sending')
                    : bg.phase === 'signing' ? t('signing.signing')
                    : t('signing.building')}
                </span>
              </div>
              <div className="hint mt-sm">
                {t('signing.takesMinutes')} <span aria-hidden="true">·</span> <span className="num">{Math.floor(elapsed / 60)}:{String(elapsed % 60).padStart(2, '0')}</span>
              </div>
              {elapsed > 180 && !stalled && <div className="hint err mt-sm" role="alert">{t('signing.slowHint')}</div>}
              {/* The device running the send has not finished within its window after the round began: a
                  started round has no abort yet (#284), so the one thing that helps is a fresh panel. */}
              <div role="status">{stalled && <div className="hint warn mt-sm">{t('signing.stalledReopen')}</div>}</div>
              {/* An ignored message, before the reading, so a long payroll does not push it out of view. */}
              {notice && <div className="hint warn mt-sm" role="status">{notice}</div>}
              {/* Below the clock, so a long payroll does not push the progress off a phone screen. */}
              {bg.what && <DeviceReading what={bg.what} t={t} isOurs={isOurReceiver} />}
            </div>
          ) : !hasShare ? (
            <div className="sign-unlock">
              <div className="hint">{t('signing.needUnlock')}</div>
              <input
                className="input mono mt-sm"
                type="password"
                autoFocus
                placeholder={t('vaults.wordPlaceholder')}
                value={pass}
                onChange={(e) => setPass(e.target.value)}
                onKeyDown={(e) => { if (e.key === 'Enter') void doUnlock() }}
              />
              {unlockErr && <div className="hint err mt-sm" role="alert">{unlockErr}</div>}
              <button className="btn ok mt-sm" disabled={unlocking || pass.length < 1} onClick={() => void doUnlock()}>
                {unlocking ? t('vaults.verifying') : t('signing.needUnlockCta')}
              </button>
            </div>
          ) : !bg.ready ? (
            <div className="confirm">{t('signing.opening')}</div>
          ) : !quorumHere ? (
            <>
              <div className="confirm">{t('signing.waiting')}</div>
              <div className="hint mt-sm">{t('signing.signedCount', { n: signedCount, t: threshold })}</div>
            </>
          ) : armed ? (
            // Reached from a confirm whose opener is gone: this state takes the focus and is heard.
            <div key="armed" tabIndex={-1} ref={focusOnMount}>
              <div className="confirm quorum" role="status">
                {!quorumSigned
                  ? t('signing.youSigned')
                  : senderName
                    ? t(senderLate ? 'signing.senderWaiting' : 'signing.senderSending', { name: senderName })
                    : t('signing.othersSending')}
              </div>
              {/* The minutes change every minute, so they sit outside the announced status. */}
              {quorumSigned && senderName && senderLate && (
                <div className="hint mt-sm">{t('signing.senderLapse', { name: senderName, mins: senderLapseMin })}</div>
              )}
              <div className="hint mt-sm">{t('signing.signedCount', { n: signedCount, t: threshold })}</div>
              {armLeft > 0 && !quorumSigned && <div className="hint mt-sm dim">{t('signing.armExpires', { mins: armLeft })}</div>}
            </div>
          ) : (
            // A device that has NOT signed in this session always gets the button, whatever the room
            // says the tally is. Its own signature is the only thing it can contribute, and without
            // it a stale tally leaves the payment frozen: signed by nobody present, sendable by
            // nobody at all. Signing again is safe - the tally is keyed by seat, and a seat that
            // re-announces provably does not fire the send a second time.
            <>
              <div className="confirm quorum">{t('signing.readyToSend')}</div>
              <div className="hint mt-sm">{t('signing.signedCount', { n: signedCount, t: threshold })}</div>
              {shortZat > 0
                ? <div className="hint warn mt-sm" role="status">{t('signing.blockedShort', { short: fmtZecExact(shortZat / 1e8) })}</div>
                : <div className="hint mt-sm">{iWouldBeLast ? t('signing.lastSigner') : t('signing.notLastYet')}</div>}
              <button
                className="btn ok mt-sm"
                disabled={!canSign}
                onClick={() => {
                  refreshRate()
                  setConfirming('sign')
                }}
              >
                {arming ? t('signing.arming') : iWouldBeLast ? t('signing.signAndSend') : t('signing.signAct')}
              </button>
            </>
          )}
          {notice && !started && !errMsg && !sent && <div className="hint warn mt-sm" role="status">{notice}</div>}
        </div>

        <div className="sign-reassure dim">{t('signing.reassure')}</div>
      </aside>

      {confirming && (
        <SignConfirm
          again={confirming === 'again'}
          firstUntil={signedBefore?.firstUntil ?? 0}
          fee={amountZat !== null && feeKnown ? fmtZecExact(feeZat / 1e8) : undefined}
          total={amountZat !== null && feeKnown ? fmtZecExact((amountZat + feeZat) / 1e8) : undefined}
          locale={locale}
          amt={amt}
          usd={usd}
          dest={dest}
          isPayroll={isPayroll}
          iWouldBeLast={iWouldBeLast}
          t={t}
          onCancel={() => setConfirming(null)}
          onConfirm={() => {
            setConfirming(null)
            if (confirming === 'again' && againState !== 'offer') return
            void doSign({ again: confirming === 'again' })
          }}
        />
      )}
    </>
  )
}
