import { useEffect, useState } from 'react'
import { useLocation, useNavigate } from 'react-router-dom'
import { Letterhead, Secret } from '../components'
import { Identicon } from '../avatar'
import { fmtZec } from '../format'
import { useT, useTr } from '../i18n'
import {
  getProposalDetail, getProposals, getVault, voteProposal, sendProposal, shortAddr, humanError,
  type Proposal, type PayrollLine,
} from '../api'

export default function Proposal() {
  const t = useT()
  const tr = useTr()
  const nav = useNavigate()
  const loc = useLocation() as { state?: { id?: string } }
  const [p, setP] = useState<Proposal | null>(null)
  const [lines, setLines] = useState<PayrollLine[]>([])
  const [threshold, setThreshold] = useState(2)
  const [members, setMembers] = useState<string[]>([])
  const [approveAs, setApproveAs] = useState('')
  const [loading, setLoading] = useState(true)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [sending, setSending] = useState<null | 'dry' | 'real'>(null)
  const [dryOk, setDryOk] = useState<string | null>(null)

  useEffect(() => {
    let on = true
    void (async () => {
      const v = await getVault()
      if (on && v) { setThreshold(v.threshold); setMembers(v.member_list.map((m) => m.name)) }
      let id = loc.state?.id
      if (!id) {
        const list = await getProposals()
        id = (list?.find((x) => x.state === 'awaiting') ?? list?.[0])?.id
      }
      const detail = id ? await getProposalDetail(id) : null
      if (on) {
        setP(detail?.proposal ?? null)
        setLines(detail?.lines ?? [])
        setLoading(false)
      }
    })()
    return () => { on = false }
  }, [loc.state])

  async function vote(approve: boolean) {
    if (!p) return
    const canVote = members.filter((m) => !p.approvals.includes(m) && !p.refusals.includes(m))
    const who = approveAs && canVote.includes(approveAs) ? approveAs : canVote[0]
    if (!who) { setError(t('proposal.errNoVoter')); return }
    setError(null); setBusy(true)
    const res = await voteProposal(p.id, who, approve)
    setBusy(false)
    if (res.ok) { setP(res.proposal); setApproveAs('') }
    else setError(humanError(res.error, res.detail))
  }

  async function send(dryRun: boolean) {
    if (!p) return
    setError(null); setDryOk(null); setSending(dryRun ? 'dry' : 'real')
    const res = await sendProposal(p.id, dryRun)
    setSending(null)
    if (!res.ok) { setError(humanError(res.error, res.detail)); return }
    if (res.dryRun) {
      setDryOk(res.sighash ?? t('proposal.validSignature'))
    } else if (res.proposal) {
      setP(res.proposal) // now Sent, carries the txid
    }
  }

  if (loading) {
    return (<><Letterhead right={<span className="klab back" onClick={() => nav('/dashboard')}>{t('common.backProposals')}</span>} />
      <div className="page narrow"><div className="hint">{t('proposal.loading')}</div></div></>)
  }
  if (!p) {
    return (<><Letterhead right={<span className="klab back" onClick={() => nav('/dashboard')}>{t('common.backProposals')}</span>} />
      <div className="page narrow"><h1 className="h1">{t('proposal.noneTitle')}</h1>
        <div className="hint">{t('proposal.noneBody')} <span className="link" onClick={() => nav('/pay')}>{t('proposal.proposePaymentLink')}</span></div>
      </div></>)
  }

  const val = fmtZec(p.value_zec)
  const dest = p.to_address ? shortAddr(p.to_address) : '—'
  const isPayroll = p.kind === 'payroll'
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

  // State trail: Aprovação → Assinatura → Enviado (null while terminal-negative).
  const trailIdx = isAwaiting ? 0 : isReady ? 1 : isSent ? 2 : null

  // Everyone involved, with their stance — people, not a mono string.
  const everyone = Array.from(new Set([p.proposer, ...members, ...p.approvals, ...p.refusals]))
  const stance = (m: string) => {
    const approved = p.approvals.includes(m)
    if (approved) return { cls: 'ok', label: m === p.proposer ? t('proposal.stanceProposedApproved') : t('proposal.stanceApproved') }
    if (p.refusals.includes(m)) return { cls: 'no', label: t('proposal.stanceRefused') }
    return { cls: '', label: t('proposal.stanceAwaiting') }
  }

  return (
    <>
      <Letterhead right={<span className="klab back" onClick={() => nav('/dashboard')}>{t('common.backPanel')}</span>} />
      <div className="page narrow">
        <div className="prop-head">
          <span className="klab">{eyebrow}</span>
          <span className={'stamp st-' + p.state}>{t('stamp.' + p.state)}</span>
        </div>
        <h1 className="h1 prop-title">{title}</h1>
        <div className="p-meta">{subtitle}{p.is_public && !isPayroll && <span className="hint warn"> {t('proposal.publicDestSuffix')}</span>}</div>

        <div className="steps ptrail">
          {[t('proposal.trailApproval'), t('proposal.trailSignature'), t('proposal.trailSent')].map((label, i) => (
            <span className="st-wrap" key={label}>
              {i > 0 && <span className="seg" />}
              <span className={'st' + (trailIdx !== null && i <= trailIdx ? ' on' : '')}><span className="pip" />{label}</span>
            </span>
          ))}
        </div>

        <div className="p-amt mt"><Secret><span>{val}</span></Secret> <span className="dim small">ZEC</span></div>
        {isPayroll && (
          <table className="tbl folha mt">
            <thead><tr><th>{t('proposal.colLabel')}</th><th>{t('proposal.colDest')}</th><th>{t('proposal.colValue')}</th><th>{t('proposal.colMemo')}</th></tr></thead>
            <tbody>
              {lines.map((l, i) => (
                <tr key={i}>
                  <td>{l.label || '—'}</td>
                  <td className={'mono' + (l.is_public ? ' seal-tx' : '')}>{shortAddr(l.address)}{l.is_public ? ' ⚠' : ''}</td>
                  <td className="num"><Secret sm><span>{fmtZec(l.value_zec)}</span></Secret></td>
                  <td className="mono dim">{l.memo || '—'}</td>
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
          const who = approveAs || pendingApprovers[0] || ''
          const falta = Math.max(0, threshold - p.approvals_count)
          return (
          <>
            <div className="confirm mt">
              {tr('proposal.awaitingIntro', { proposer: p.proposer, count: p.approvals_count, total: threshold })}{' '}
              {falta > 0 ? tr(falta > 1 ? 'proposal.remainingMany' : 'proposal.remainingOne', { falta }) : tr('proposal.quorumReachedShort')}
            </div>
            {pendingApprovers.length > 0 ? (
              <>
                <div className="hint mt">{tr('proposal.demoActNote')}</div>
                <label className="field mt-sm"><span>{t('proposal.approveRefuseAs')}</span>
                  <select className="input" value={who} onChange={(e) => setApproveAs(e.target.value)}>
                    {pendingApprovers.map((m) => <option key={m} value={m}>{m}</option>)}
                  </select>
                </label>
                <div className="btns mt">
                  <button className="btn ok" onClick={() => vote(true)} disabled={busy}>{busy ? '…' : t('proposal.approveAs', { who })}</button>
                  <button className="btn" onClick={() => vote(false)} disabled={busy}>{t('proposal.refuseAs', { who })}</button>
                </div>
              </>
            ) : (
              <div className="hint mt">{t('proposal.allVoted')}</div>
            )}
          </>
          )
        })()}

        {isReady && (
          <>
            <div className="confirm mt ready">
              {isPayroll ? tr('proposal.readyPayroll') : tr('proposal.readyPayment')}
            </div>
            <div className="btns mt">
              <button className="btn ok" onClick={() => send(false)} disabled={sending !== null}>
                {sending === 'real' ? t('proposal.signingSending') : (isPayroll ? t('proposal.signSendPayroll') : t('proposal.signSendPayment'))}
              </button>
              <button className="btn" onClick={() => send(true)} disabled={sending !== null} title={t('proposal.validateTitle')}>
                {sending === 'dry' ? t('proposal.validating') : t('proposal.validateBtn')}
              </button>
            </div>
            {dryOk && <div className="hint mt-sm ready">{t('proposal.dryOkPre')}<code>{dryOk.slice(0, 16)}…</code>{t('proposal.dryOkPost')}</div>}
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

        {error && <div className="hint err mt">✗ {error}</div>}
      </div>
    </>
  )
}
