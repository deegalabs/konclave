import { useEffect, useState } from 'react'
import { usePoll } from '../usePoll'
import { Link, useLocation, useNavigate } from 'react-router-dom'
import { Secret, Dialog, Loading } from '../components'
import { PageHeader } from '../page'
import { Identicon } from '../avatar'
import { fmtZec, parseZecToZat, zatToZec } from '../format'
import { useT, useTr } from '../i18n'
import { useToast } from '../toast'
import {
  getProposalDetail, getProposals, getVault, voteProposal, sendProposal, shortAddr, humanError, getBalance,
  IS_NET, type Proposal, type PayrollLine,
} from '../api'
import { listVaults } from '../storage'
import { useVaultSigner } from '../VaultSigner'

export default function Proposal() {
  const t = useT()
  const toast = useToast()
  // What the vault actually holds, so the cost of this proposal can be stated against it. Approval
  // is consent, not spending, so a short balance never blocks the vote - but it must be visible:
  // the fee on a small payroll was five times the payment and appeared nowhere on this screen.
  const [spendableZat, setSpendableZat] = useState<number | null>(null)
  const tr = useTr()
  const loc = useLocation() as { state?: { id?: string } }
  const nav = useNavigate()
  const { open: openSigning } = useVaultSigner()
  const [p, setP] = useState<Proposal | null>(null)
  const [pid, setPid] = useState<string | null>(null)
  const [lines, setLines] = useState<PayrollLine[]>([])
  const [threshold, setThreshold] = useState(2)
  const [members, setMembers] = useState<string[]>([])
  // The member name THIS device holds (the seat it can sign/vote for). Loaded from the on-device
  // vault record. A device may only ever cast its OWN vote (never another member's).
  const [me, setMe] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [sending, setSending] = useState<null | 'dry' | 'real'>(null)
  const [dryOk, setDryOk] = useState<string | null>(null)
  const [confirmSend, setConfirmSend] = useState(false)

  useEffect(() => {
    let on = true
    void (async () => {
      const v = await getVault()
      if (on && v) {
        setThreshold(v.threshold)
        setMembers(v.member_list.map((m) => m.name))
        try {
          const saved = await listVaults()
          const rec = saved.find((s) => s.id === v.id)
          if (on) setMe(rec?.myName ?? null)
        } catch { /* local-bridge mode: no on-device record - stays null (read-only vote) */ }
      }
      let id = loc.state?.id
      if (!id) {
        const list = await getProposals()
        id = (list?.find((x) => x.state === 'awaiting') ?? list?.[0])?.id
      }
      const detail = id ? await getProposalDetail(id) : null
      if (on) {
        setPid(id ?? null)
        setP(detail?.proposal ?? null)
        setLines(detail?.lines ?? [])
        setLoading(false)
      }
    })()
    return () => { on = false }
  }, [loc.state])

  // Live refresh: re-fetch the proposal so approvals/refusals from other members appear on their own
  // (and a Sent proposal flips to Confirmed) without a manual reload. Paused while the tab is hidden;
  // suspended for a terminal proposal and while THIS device is mid-action (voting/sending). (#123)
  const terminal = !!p && ['confirmed', 'rejected', 'expired', 'cancelled', 'superseded'].includes(p.state)
  usePoll(() => {
    if (busy || sending) return
    void (async () => {
      const detail = pid ? await getProposalDetail(pid) : null
      if (detail?.proposal) { setP(detail.proposal); setLines(detail.lines ?? []) }
    })()
  }, 8000, !!pid && !terminal)

  useEffect(() => {
    let on = true
    void getBalance().then((b) => { if (on && b?.configured) setSpendableZat(b.spendable_zat ?? b.total_zat ?? null) })
    return () => { on = false }
  }, [])

  async function vote(approve: boolean) {
    if (!p) return
    const canVote = members.filter((m) => !p.approvals.includes(m) && !p.refusals.includes(m))
    // A device casts ONLY its own vote (`me`). Never let a proposer/device vote as another member.
    const who = me && canVote.includes(me) ? me : ''
    if (!who) { setError(t('proposal.errNoVoter')); return }
    setError(null); setBusy(true)
    const res = await voteProposal(p.id, who, approve)
    setBusy(false)
    if (res.ok) {
      setP(res.proposal)
      // The row updates in place, so the change is easy to miss; the toast says it was recorded.
      toast.ok(approve ? t('toast.approved') : t('toast.refused'))
    } else {
      const msg = humanError(t, res.error, res.detail)
      setError(msg)   // stays on screen: this is the money path
      toast.err(msg)  // and is announced, in case the eye is elsewhere
    }
  }

  async function send(dryRun: boolean) {
    if (!p) return
    // Browser-native vault: signing happens in /net, where this device's share lives. Instead of a
    // server-side ceremony, take the operator to the signing screen (the approved proposal shows up
    // there under "Proposals ready to sign").
    if (IS_NET) { nav('/net'); return }
    setError(null); setDryOk(null); setSending(dryRun ? 'dry' : 'real')
    const res = await sendProposal(p.id, dryRun)
    setSending(null)
    if (!res.ok) { setError(humanError(t, res.error, res.detail)); return }
    if (res.dryRun) {
      setDryOk(res.sighash ?? t('proposal.validSignature'))
    } else if (res.proposal) {
      setP(res.proposal) // now Sent, carries the txid
    }
  }

  if (loading) {
    return (<><main className="page narrow"><Loading /></main></>)
  }
  if (!p) {
    return (<><main className="page narrow"><PageHeader title={t('proposal.noneTitle')} />
        <div className="hint">{t('proposal.noneBody')} <Link className="link" to="/pay">{t('proposal.proposePaymentLink')}</Link></div>
      </main></>)
  }

  const val = fmtZec(p.value_zec)
  const dest = p.to_address ? shortAddr(p.to_address) : '-'
  const isPayroll = p.kind === 'payroll'
  // ZIP-317: 5000 zat per logical action. For a bundle with cross-address transfers disabled the
  // count is spends + outputs (orchard's builder pairs each with a fabricated zero-valued
  // counterpart), so one spend + N destinations + change. Measured against a real refusal: a 2-line
  // payroll of 4000 zat was charged 20000, exactly four actions.
  const cost = (() => {
    const amountZat = parseZecToZat(p.value_zec ?? '')
    if (amountZat === null) return null
    const dests = isPayroll ? Math.max(1, lines.length) : 1
    const feeZat = 5000 * Math.max(2, 1 + dests + 1)
    const totalZat = amountZat + feeZat
    const short = spendableZat === null ? 0 : Math.max(0, totalZat - spendableZat)
    return { feeZat, totalZat, short }
  })()

  const isAwaiting = p.state === 'awaiting'
  const isReady = p.state === 'ready'
  const isRejected = p.state === 'rejected'
  const isExpired = p.state === 'expired'
  const isSent = p.state === 'sent' || p.state === 'confirmed'
  const isTerminalBad = isRejected || isExpired || p.state === 'cancelled'
  const pendingApprovers = members.filter((m) => !p.approvals.includes(m) && !p.refusals.includes(m))

  // Title carries meaning (what/referente), not just a stamp.
  const eyebrow = isPayroll ? t('kind.payroll') : t('kind.payment')
  const title = p.memo?.trim() || (isPayroll ? t('kind.payroll') : t('proposal.paymentTo', { dest }))
  const subtitle = isPayroll ? t('proposal.payrollSubtitle', { n: lines.length }) : t('proposal.paymentSubtitle', { dest })

  // State trail: Approval → Signature → Sent (null while terminal-negative).
  const trailIdx = isAwaiting ? 0 : isReady ? 1 : isSent ? 2 : null

  // Everyone involved, with their stance - people, not a mono string.
  const everyone = Array.from(new Set([p.proposer, ...members, ...p.approvals, ...p.refusals]))
  const stance = (m: string) => {
    const approved = p.approvals.includes(m)
    if (approved) return { cls: 'ok', label: m === p.proposer ? t('proposal.stanceProposedApproved') : t('proposal.stanceApproved') }
    if (p.refusals.includes(m)) return { cls: 'no', label: t('proposal.stanceRefused') }
    return { cls: '', label: t('proposal.stanceAwaiting') }
  }

  return (
    <>
      <main className="page narrow">
        <PageHeader
          back={{ to: '/proposals', label: t('proposals.title') }}
          eyebrow={eyebrow}
          title={title}
          subtitle={<>{subtitle}{p.is_public && !isPayroll && <span className="hint warn"> {t('proposal.publicDestSuffix')}</span>}</>}
          actions={<span className={'stamp st-' + p.state}>{t('stamp.' + p.state)}</span>}
        />

        <div className="steps ptrail">
          {[t('proposal.trailApproval'), t('proposal.trailSignature'), t('proposal.trailSent')].map((label, i) => (
            <span className="st-wrap" key={label}>
              {i > 0 && <span className="seg" />}
              <span className={'st' + (trailIdx !== null && i <= trailIdx ? ' on' : '')}><span className="pip" />{label}</span>
            </span>
          ))}
        </div>

        <div className="p-amt mt"><Secret><span>{val}</span></Secret> <span className="dim small">ZEC</span></div>

        {/* What this actually costs the vault. The amount alone is not the cost: on a small payroll
            the network fee was five times the payment and appeared nowhere, so people approved
            something the vault could not pay and only found out after everyone had signed. */}
        {cost && (
          <div className={'p-cost' + (cost.short > 0 ? ' short' : '')}>
            <span className="p-cost-line">
              <span className="p-cost-k">{t('proposal.costFee')}</span>
              <span className="p-cost-v num">+ {fmtZec(zatToZec(cost.feeZat))} ZEC</span>
            </span>
            <span className="p-cost-line">
              <span className="p-cost-k">{t('proposal.costTotal')}</span>
              <span className="p-cost-v num"><b>{fmtZec(zatToZec(cost.totalZat))} ZEC</b></span>
            </span>
            {cost.short > 0 && (
              <div className="hint warn mt-sm" role="status">
                {tr('proposal.costShort', { short: fmtZec(zatToZec(cost.short)) })}
              </div>
            )}
          </div>
        )}
        {isPayroll && (
          <table className="tbl folha-read mt">
            <thead><tr><th>{t('proposal.colLabel')}</th><th>{t('proposal.colDest')}</th><th>{t('proposal.colValue')}</th><th>{t('proposal.colMemo')}</th></tr></thead>
            <tbody>
              {lines.map((l, i) => (
                <tr key={i}>
                  <td>{l.label || '-'}</td>
                  <td className={'mono' + (l.is_public ? ' seal-tx' : '')}>{shortAddr(l.address)}{l.is_public ? ` · ${t('proposal.linePublic')}` : ''}</td>
                  <td className="num"><Secret sm><span>{fmtZec(l.value_zec)}</span></Secret></td>
                  <td className="mono dim">{l.memo || '-'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}

        <div className="who-head">
          <span className="klab">{t('proposal.approvals')}</span>
          <span className="who-prog"><span className="prog">{Array.from({ length: threshold }, (_, i) => <i key={i} className={i < p.approvals_count ? 'on' : ''} />)}</span> <b>{t('proposal.ofN', { count: p.approvals_count, total: threshold })}</b></span>
        </div>
        <div className="people">
          {everyone.map((m) => {
            const s = stance(m)
            return (
              <div className="who-row" key={m}>
                <Identicon seed={m} size={30} />
                <span className="who-name">{m}</span>
                <span className={'who-st ' + s.cls}>{s.label}</span>
              </div>
            )
          })}
        </div>

        {isTerminalBad && (
          <div className="confirm mt">
            {isRejected && tr('proposal.terminalRejected')}
            {isExpired && tr('proposal.terminalExpired')}
            {p.state === 'cancelled' && tr('proposal.terminalCancelled')}
          </div>
        )}

        {isAwaiting && (() => {
          const falta = Math.max(0, threshold - p.approvals_count)
          // Authorization: this device may vote only for its own seat, and only while that seat is
          // still pending. The proposer already counts as an approval, so they are never pending
          // here (their approve control does not render).
          const iAmPending = !!me && pendingApprovers.includes(me)
          const iAlreadyVoted = !!me && (p.approvals.includes(me) || p.refusals.includes(me))
          return (
          <>
            <div className="confirm mt">
              {tr('proposal.awaitingIntro', { proposer: p.proposer, count: p.approvals_count, total: threshold })}{' '}
              {falta > 0 ? tr(falta > 1 ? 'proposal.remainingMany' : 'proposal.remainingOne', { falta }) : tr('proposal.quorumReachedShort')}
            </div>
            {iAmPending ? (
              <div className="btns mt">
                <button className="btn ok" onClick={() => vote(true)} disabled={busy}>{busy ? '…' : t('proposal.approve')}</button>
                <button className="btn" onClick={() => vote(false)} disabled={busy}>{t('proposal.refuse')}</button>
              </div>
            ) : (
              <div className="hint mt">{iAlreadyVoted ? t('proposal.alreadyVoted') : t('proposal.waitingMembers')}</div>
            )}
          </>
          )
        })()}

        {isReady && (
          <>
            <div className="confirm mt ready">
              {isPayroll ? tr('proposal.readyPayroll') : tr('proposal.readyPayment')}
            </div>
            {IS_NET ? (
              <>
                <div className="btns mt">
                  <button className="btn ok" onClick={() => openSigning(p)}>
                    {t('signing.title')}
                  </button>
                </div>
                <div className="hint mt-sm">{t('proposal.ceremonyNote')}</div>
              </>
            ) : (
              <>
                <div className="btns mt">
                  <button className="btn ok" onClick={() => setConfirmSend(true)} disabled={sending !== null}>
                    {sending === 'real' ? t('proposal.signingSending') : (isPayroll ? t('proposal.signSendPayroll') : t('proposal.signSendPayment'))}
                  </button>
                  <button className="btn" onClick={() => send(true)} disabled={sending !== null} title={t('proposal.validateTitle')}>
                    {sending === 'dry' ? t('proposal.validating') : t('proposal.validateBtn')}
                  </button>
                </div>
                {dryOk && <div className="hint mt-sm ready">{t('proposal.dryOkPre')}{t('proposal.dryOkPost')}</div>}
              </>
            )}
            <div className="hint mt-sm">{t('proposal.signNeverReassembles')}</div>
          </>
        )}

        {isSent && (
          <>
            <div className="confirm mt ready">{tr('proposal.sentConfirm')}</div>
            {p.txid && (
              <div className="p-meta mt">
                <div>{t('proposal.txid')}</div>
                <div className="mt-xs"><code>{p.txid}</code></div>
                <div className="mt-xs"><a className="link" href={`https://mainnet.zcashexplorer.app/transactions/${p.txid}`} target="_blank" rel="noreferrer">{t('proposal.viewExplorer')}</a></div>
              </div>
            )}
          </>
        )}

        {error && <div className="hint err mt" role="alert">{error}</div>}
      </main>

      {confirmSend && (
        <Dialog className="modal-overlay" cardClassName="modal-card danger" labelledBy="send-confirm-title" onClose={() => setConfirmSend(false)}>
          <span className="klab danger-lab">{t('proposal.confirmLabel')}</span>
          <h2 id="send-confirm-title" className="modal-h">{t('proposal.confirmTitle')}</h2>
          <div className="send-confirm-what">
            <strong className="scw-amt">{val} ZEC</strong>
            {isPayroll
              ? <span className="scw-kind"> · {t('kind.payroll')}</span>
              : <> <span aria-hidden="true">→</span> <code>{dest}</code></>}
          </div>
          <p className="modal-p">{t('proposal.confirmBody')}</p>
          <div className="btns right mt">
            <button className="btn ghost" onClick={() => setConfirmSend(false)}>{t('common.cancel')}</button>
            <button className="btn ok" onClick={() => { setConfirmSend(false); void send(false) }}>
              {t('proposal.confirmSend')}
            </button>
          </div>
        </Dialog>
      )}
    </>
  )
}
