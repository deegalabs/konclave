// The in-vault signing ceremony surface (K11): a right-side session Sheet that runs the ceremony in
// place, driven by the background signer (VaultSignerProvider). No /net redirect.
//
// EVERY member signs, and whoever signs LAST sends. Being present is no longer consent: each device
// makes its own deliberate click on a screen showing the amount and the destination, and the click
// that completes the quorum is the one that moves the money - so it carries the explicit confirm.
// Who "last" is comes from the signing room's ordered log, identically on every device, so two
// people clicking at the same instant still produce exactly one send.

import { useEffect, useRef, useState } from 'react'
import { Dialog } from '../components'
import { Identicon } from '../avatar'
import { useT } from '../i18n'
import { fmtZec, shortAddr } from '../format'
import { useVaultSigner } from '../VaultSigner'
import { executeProposal, listProposals } from '../helper'
import { markVaultUnlocked } from '../api'
import { relayBase } from '../net'
import { getUnlockedShare, setUnlockedShare } from '../session'
import { loadVault } from '../storage'
import { usdEnabled, cachedRate, fetchRate, zecToUsd, type Rate } from '../price'

export default function SigningPanel() {
  const t = useT()
  const { bg, vault, threshold, myName, active, close, reseat, armed, armActive, armedUntil } = useVaultSigner()
  const [confirming, setConfirming] = useState(false)
  const [sending, setSending] = useState(false)
  // When the ceremony started on THIS device. The run is minutes long and emits no event we can
  // observe, so a clock is the only honest sign that the vault is working rather than stuck - and
  // every device that signed needs it, not just the one that sent. A member who signed first sat
  // in front of a frozen line for the whole build+prove+broadcast leg with nothing moving.
  const [runSince, setRunSince] = useState<number | null>(null)
  const [elapsed, setElapsed] = useState(0)
  const [result, setResult] = useState<{ txid: string | null } | { error: string } | null>(null)
  const [pass, setPass] = useState('')
  const [unlocking, setUnlocking] = useState(false)
  const [unlockErr, setUnlockErr] = useState('')
  const [arming, setArming] = useState(false)
  // The send fires from an effect (the room names the sender), so guard it: one send per proposal.
  const sentOnce = useRef<string | null>(null)
  // True while anything is running here: this device signing, or the send it triggered.
  const started = sending || bg.phase !== 'idle'
  const [rate, setRate] = useState<Rate | null>(cachedRate())
  // The figure people actually judge is the one in their own currency, and this is the screen where
  // they commit. Re-price on open and again at the confirm, rather than showing whatever was cached
  // when the proposal was written - which can be hours or days old by now.
  const [armLeft, setArmLeft] = useState(0)

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

  // The room decided this device sends. It already passed the money confirm (that is what
  // `iWouldBeLast` gates), so fire once - and only once - per proposal.
  useEffect(() => {
    if (!bg.iSend || !active) return
    if (sentOnce.current === active.id) return
    sentOnce.current = active.id
    void doSend()
    // Deliberately keyed on the decision and the payment only: doSend closes over state that
    // changes during the send, and re-running it would be a second broadcast.
  }, [bg.iSend, active?.id]) // eslint-disable-line react-hooks/exhaustive-deps

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
  useEffect(() => {
    if (!active || !vault || sending || result) return
    if (bg.phase !== 'signed') return
    let on = true
    const id = window.setInterval(async () => {
      const list = await listProposals(vault.group_pubkey)
      const p = list?.find((x) => x.id === active.id)
      if (on && p?.state === 'sent' && p.txid) setResult({ txid: p.txid })
    }, 4000)
    return () => { on = false; window.clearInterval(id) }
  }, [active, vault, sending, result, bg.phase])

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
  const quorumSigned = threshold > 0 && signedCount >= threshold
  // If I sign now, the quorum closes and I am the one who sends. This drives the WORDING only:
  // every signature is confirmed on its own device, whoever you are. Predicting "I am last" and
  // confirming only then would leave a hole - two people clicking in the same instant would both
  // read as not-last, and whichever one closed the quorum would send with no confirm at all.
  const iWouldBeLast = !armed && threshold > 0 && signedCount === threshold - 1

  const sent = result && 'txid' in result && result.txid
  const errMsg = (result && 'error' in result && result.error) || bg.error || ''
  // What this device can do now is SIGN. The send is not a button any more: it follows from the
  // quorum closing, on the device the room named.
  const canSign = bg.ready && quorumHere && !started && !result && !armed && !arming
  // The signer is still coming up: has a share but hasn't seated yet. Show a loading line instead of
  // a roster that could momentarily light the wrong seat. (Declared after `started`/`result`.)
  // At the passphrase stage we SHOW the roster (the signers of this vault) - the device just hasn't
  // joined the signing room yet, so nobody reads as present (honest: real presence needs the share).
  // The loader appears only once you SUBMIT the passphrase (unlocking) and while the signer seats;
  // then the roster comes back with its real present/absent flags once THIS device is seated.
  const connecting = !started && !result && (unlocking || (hasShare && !bg.ready))

  const dest = active.to_address ? shortAddr(active.to_address) : '-'
  const amtNum = active.value_zec
  const amt = fmtZec(active.value_zec)
  const isPayroll = active.kind === 'payroll'

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


  async function doSend() {
    // Every exit from here must leave a visible trace. The panel used to close its confirm dialog
    // and then, on some paths, show nothing at all: no error, no progress, no way to tell whether
    // the vault was working, stuck, or done. On a money screen that is the worst possible state,
    // because the honest next move (wait? retry? check the chain?) is unknowable.
    if (!vault) { setResult({ error: t('signing.errNoVault') }); return }
    const args = {
      vault: vault.group_pubkey,
      proposalId: active!.id,
      relayBase: relayBase(),
      room: bg.room,
      dryRun: false,
    }
    // Breadcrumbs for a failure a user reports later: what we asked for, and what came back. No
    // secret is logged (the group key and the proposal id are public vault material).
    console.info('[konclave] send: start', { proposal: args.proposalId, room: args.room, phase: bg.phase })
    setConfirming(false)
    setSending(true)
    setResult(null)
    try {
      const r = await executeProposal(args)
      console.info('[konclave] send: reply', r)
      if (!r) setResult({ error: t('signing.errUnreachable') })
      else if ('error' in r) setResult({ error: r.error })
      else if (!r.txid) setResult({ error: t('signing.errNoTxid') }) // a reply with no txid is NOT a send
      else setResult({ txid: r.txid })
    } catch (e) {
      // A throw here previously escaped as an unhandled rejection: `sending` stayed true forever and
      // the panel sat on a progress line that would never resolve.
      console.error('[konclave] send: threw', e)
      setResult({ error: e instanceof Error ? e.message : String(e) })
    } finally {
      setSending(false)
    }
  }

  // Sign from this device: arm the gate, then tell the room. If this arming completes the quorum,
  // the room names this device the sender and the effect below fires the broadcast.
  async function doSign() {
    setArming(true)
    try {
      await armActive()
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
      const share = await loadVault(vault.id, pass)
      setUnlockedShare(vault.id, share)
      markVaultUnlocked(vault.id)
      setPass('')
      reseat() // the signer re-runs now that the share is in session
    } catch {
      setUnlockErr(t('vaults.unlockWrong'))
    } finally {
      setUnlocking(false)
    }
  }

  function onClose() {
    // The background signer keeps running; closing only hides the panel. The result is NOT cleared:
    // wiping it here meant a stray click on the scrim could erase a failure the user never read.
    setConfirming(false)
    close()
  }

  return (
    <>
      <div className="sign-scrim" onClick={onClose} aria-hidden="true" />
      <aside className="sign-sheet" role="dialog" aria-modal="true" aria-labelledby="sign-title">
        <div className="sign-head">
          <span className="klab">{isPayroll ? t('kind.payroll') : t('kind.payment')}</span>
          <button className="sign-x" onClick={onClose} aria-label={t('signing.close')}>×</button>
        </div>
        <h2 id="sign-title" className="sign-title">{t('signing.title')}</h2>

        <div className="sign-what">
          <span className="sign-amt num">{amt} <span className="dim small">ZEC</span></span>
          {usd && <span className="sign-usd dim small">{usd}</span>}
          <span className="sign-to mono">{isPayroll ? t('kind.payroll') : <>→ {dest}</>}</span>
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
                  className={'sign-seat' + (presentFlags[i] ? ' on' : '') + (signedSeats.includes(i + 1) ? ' signed' : '')}
                  key={m.pubkey || m.name}
                >
                  <Identicon seed={m.pubkey || m.name} size={22} />
                  <span className="sign-seat-name">{m.name}{me && m.name === me && <span className="klab"> {t('members.youShort')}</span>}</span>
                  {signedSeats.includes(i + 1) && (
                    <>
                      {/* The tick reads at a glance; the label makes it readable at all. */}
                      <span className="visually-hidden">{t('signing.seatSigned')}</span>
                      <span className="sign-seat-tick" aria-hidden="true">✓</span>
                    </>
                  )}
                </span>
              ))}
            </div>
          )}
        </div>

        {/* State */}
        <div className="sign-state">
          {sent ? (
            <div className="sign-ok">
              <div className="confirm ready">{t('signing.sentTitle')}</div>
              {(result as { txid: string }).txid && (
                <div className="p-meta mt-sm">
                  <div className="mono"><code>{(result as { txid: string }).txid}</code></div>
                  <a className="link" href={`https://mainnet.zcashexplorer.app/transactions/${(result as { txid: string }).txid}`} target="_blank" rel="noreferrer">{t('proposal.viewExplorer')}</a>
                </div>
              )}
            </div>
          ) : errMsg ? (
            <div className="sign-err">
              <div className="hint err" role="alert">{t('signing.failed', { reason: errMsg })}</div>
              <button
                className="btn ghost sm-btn mt-sm"
                onClick={() => {
                  // Clearing the message is not enough on the sending device: without releasing the
                  // once-guard, "try again" would look like a button that does nothing.
                  setResult(null)
                  if (bg.iSend && active && sentOnce.current === active.id) { sentOnce.current = null; void doSend() }
                }}
              >{t('signing.tryAgain')}</button>
            </div>
          ) : started ? (
            <div className="sign-run">
              <div className="sign-run-head">
                <span className="loader-ring sm" aria-hidden="true" />
                {/* Three real stages, in order, instead of one label that claims the wrong one: the
                    coordinator builds and proves before any share is asked for, so "signed,
                    sending" was a lie for the whole first minute on the sending device. */}
                <span className="confirm">
                  {bg.phase === 'signed' ? t('signing.sending')
                    : bg.phase === 'signing' ? t('signing.signing')
                    : t('signing.building')}
                </span>
              </div>
              {bg.what && <div className="hint mt-sm mono">→ {shortAddr(bg.what.addr)} · {bg.what.zec} ZEC</div>}
              <div className="hint mt-sm" aria-live="polite">
                {t('signing.takesMinutes')} · <span className="num">{Math.floor(elapsed / 60)}:{String(elapsed % 60).padStart(2, '0')}</span>
              </div>
              {elapsed > 180 && <div className="hint err mt-sm">{t('signing.slowHint')}</div>}
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
            <>
              <div className="confirm ready">{quorumSigned ? t('signing.othersSending') : t('signing.youSigned')}</div>
              <div className="hint mt-sm">{t('signing.signedCount', { n: signedCount, t: threshold })}</div>
              {armLeft > 0 && <div className="hint mt-sm dim">{t('signing.armExpires', { mins: armLeft })}</div>}
            </>
          ) : quorumSigned ? (
            <>
              <div className="confirm ready">{t('signing.othersSending')}</div>
              <div className="hint mt-sm">{t('signing.signedCount', { n: signedCount, t: threshold })}</div>
            </>
          ) : (
            <>
              <div className="confirm ready">{t('signing.readyToSend')}</div>
              <div className="hint mt-sm">{t('signing.signedCount', { n: signedCount, t: threshold })}</div>
              <div className="hint mt-sm">{iWouldBeLast ? t('signing.lastSigner') : t('signing.notLastYet')}</div>
              <button
                className="btn ok mt-sm"
                disabled={!canSign}
                onClick={() => {
                  // Re-price at the moment of the decision, not at the moment the screen loaded.
                  if (usdEnabled()) void fetchRate().then((r) => { if (r) setRate(r) })
                  setConfirming(true)
                }}
              >
                {arming ? t('signing.arming') : iWouldBeLast ? t('signing.signAndSend') : t('signing.signAct')}
              </button>
            </>
          )}
        </div>

        <div className="sign-reassure dim">{t('signing.reassure')}</div>
      </aside>

      {confirming && (
        <Dialog className="modal-overlay" cardClassName="modal-card danger" labelledBy="sign-confirm-title" onClose={() => setConfirming(false)}>
          <span className="klab danger-lab">{t('proposal.confirmLabel')}</span>
          <h2 id="sign-confirm-title" className="modal-h">
            {iWouldBeLast ? t('signing.confirmTitle') : t('signing.confirmSignTitle')}
          </h2>
          <div className="send-confirm-what">
            <strong className="scw-amt num">{amt} ZEC</strong>
            {usd && <span className="scw-usd dim small"> {usd}</span>}
            {isPayroll ? <span className="scw-kind"> · {t('kind.payroll')}</span> : <> <span aria-hidden="true">→</span> <code>{dest}</code></>}
          </div>
          <p className="modal-p">{iWouldBeLast ? t('signing.confirmBody') : t('signing.confirmSignBody')}</p>
          <div className="btns right mt">
            <button className="btn ghost" onClick={() => setConfirming(false)}>{t('common.cancel')}</button>
            <button className="btn ok" onClick={() => { setConfirming(false); void doSign() }}>
              {iWouldBeLast ? t('signing.confirmSend', { amt }) : t('signing.confirmSignCta', { amt })}
            </button>
          </div>
        </Dialog>
      )}
    </>
  )
}
