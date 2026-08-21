// The in-vault signing ceremony surface (K11): a right-side session Sheet that runs the ceremony in
// place, driven by the always-on background signer (VaultSignerProvider). No /net redirect. The
// money gate is the initiator's explicit broadcast confirm; present devices contribute their share
// automatically (their approval was the consent). Echoes the members-popover visual language.

import { useState } from 'react'
import { Dialog } from '../components'
import { Identicon } from '../avatar'
import { useT } from '../i18n'
import { fmtZec, shortAddr } from '../format'
import { useVaultSigner } from '../VaultSigner'
import { executeProposal } from '../helper'
import { markVaultUnlocked } from '../api'
import { RELAY_BASE } from '../net'
import { getUnlockedShare, setUnlockedShare } from '../session'
import { loadVault } from '../storage'

export default function SigningPanel() {
  const t = useT()
  const { bg, vault, threshold, active, close, reseat } = useVaultSigner()
  const [confirming, setConfirming] = useState(false)
  const [sending, setSending] = useState(false)
  const [result, setResult] = useState<{ txid: string | null } | { error: string } | null>(null)
  const [pass, setPass] = useState('')
  const [unlocking, setUnlocking] = useState(false)
  const [unlockErr, setUnlockErr] = useState('')

  if (!active) return null

  // This device can only sign if its share is unlocked in this session. If not, the ceremony can
  // never seat (0/N forever) - show a clear "unlock" path instead of hanging on "Opening…".
  const loaded = vault ? getUnlockedShare(vault.id) : undefined
  const hasShare = !!loaded
  const me = loaded?.myName ?? null
  const present = bg.seatCount
  const quorumHere = present >= threshold && threshold > 0

  // Presence by name: THIS device's own seat is the ONLY one we can attribute with certainty (by
  // name, once the signer is seated). The remaining present count fills the OTHER seats in roster
  // order. Crucially, we fill others ONLY once we've identified our own seat (`me` known) - otherwise
  // (e.g. right after a rename, before the session name syncs, or before the share resolves) we would
  // light the WRONG seat (the first in the list) instead of leaving presence to the "N / threshold"
  // count. Never guess a specific seat we cannot attribute.
  const roster = vault?.member_list ?? []
  // The signer is still coming up: has a share but hasn't seated yet. Show a loading line instead of
  // a roster that could momentarily light the wrong seat.
  const connecting = hasShare && !bg.ready && present === 0 && !started && !result
  let othersLeft = me ? Math.max(0, present - (bg.ready ? 1 : 0)) : 0
  const presentFlags = roster.map((m) => {
    if (me && m.name === me) return bg.ready
    if (me && othersLeft > 0) { othersLeft -= 1; return true }
    return false
  })
  const started = sending || bg.phase !== 'idle'
  const sent = result && 'txid' in result && result.txid
  const errMsg = (result && 'error' in result && result.error) || bg.error || ''
  const canSend = bg.ready && quorumHere && !started && !result

  const dest = active.to_address ? shortAddr(active.to_address) : '-'
  const amt = fmtZec(active.value_zec)
  const isPayroll = active.kind === 'payroll'

  async function doSend() {
    if (!vault) return
    setConfirming(false)
    setSending(true)
    setResult(null)
    const r = await executeProposal({
      vault: vault.group_pubkey,
      proposalId: active!.id,
      relayBase: RELAY_BASE,
      room: bg.room,
      dryRun: false,
    })
    setSending(false)
    if (!r) setResult({ error: t('signing.errUnreachable') })
    else if ('error' in r) setResult({ error: r.error })
    else setResult({ txid: r.txid })
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
    // The background signer keeps running; closing only hides the panel.
    setConfirming(false)
    setResult(null)
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
          <span className="sign-amt">{amt} <span className="dim small">ZEC</span></span>
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
              <span>{t('signing.connecting')}</span>
            </div>
          ) : (
            <div className="sign-roster">
              {roster.map((m, i) => (
                <span className={'sign-seat' + (presentFlags[i] ? ' on' : '')} key={m.pubkey || m.name}>
                  <Identicon seed={m.pubkey || m.name} size={22} />
                  <span className="sign-seat-name">{m.name}{me && m.name === me && <span className="klab"> {t('members.youShort')}</span>}</span>
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
              <button className="btn ghost sm-btn mt-sm" onClick={() => setResult(null)}>{t('signing.tryAgain')}</button>
            </div>
          ) : started ? (
            <div className="sign-run">
              <div className="confirm">{sending || bg.phase === 'signed' ? t('signing.sending') : t('signing.signing')}</div>
              {bg.what && <div className="hint mt-sm mono">→ {shortAddr(bg.what.addr)} · {bg.what.zec} ZEC</div>}
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
            <div className="confirm">{t('signing.waiting')}</div>
          ) : (
            <>
              <div className="confirm ready">{t('signing.readyToSend')}</div>
              <button className="btn ok mt-sm" disabled={!canSend} onClick={() => setConfirming(true)}>
                {t('signing.send')}
              </button>
            </>
          )}
        </div>

        <div className="sign-reassure dim">{t('signing.reassure')}</div>
      </aside>

      {confirming && (
        <Dialog className="modal-overlay" cardClassName="modal-card danger" labelledBy="sign-confirm-title" onClose={() => setConfirming(false)}>
          <span className="klab danger-lab">{t('proposal.confirmLabel')}</span>
          <h2 id="sign-confirm-title" className="modal-h">{t('signing.confirmTitle')}</h2>
          <div className="send-confirm-what">
            <strong className="scw-amt">{amt} ZEC</strong>
            {isPayroll ? <span className="scw-kind"> · {t('kind.payroll')}</span> : <> <span aria-hidden="true">→</span> <code>{dest}</code></>}
          </div>
          <p className="modal-p">{t('signing.confirmBody')}</p>
          <div className="btns right mt">
            <button className="btn ghost" onClick={() => setConfirming(false)}>{t('common.cancel')}</button>
            <button className="btn ok" onClick={() => void doSend()}>{t('signing.confirmSend', { amt })}</button>
          </div>
        </Dialog>
      )}
    </>
  )
}
