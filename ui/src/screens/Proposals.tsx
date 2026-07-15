import { useEffect, useState } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import { Secret, activateOnKey } from '../components'
import { PageHeader } from '../page'
import { Identicon } from '../avatar'
import { getProposals, getVault, health, type Proposal } from '../api'
import { expiryLabel, fmtZec } from '../format'
import { useT, useTr } from '../i18n'

export default function Proposals() {
  const t = useT()
  const tr = useTr()
  const nav = useNavigate()
  const [rows, setRows] = useState<Proposal[]>([])
  const [threshold, setThreshold] = useState(2)
  const [live, setLive] = useState(false)
  const [loaded, setLoaded] = useState(false)

  useEffect(() => {
    let on = true
    void (async () => {
      const ok = await health()
      if (!on) return
      setLive(ok)
      const [ps, v] = await Promise.all([getProposals(), getVault()])
      if (!on) return
      if (v) setThreshold(v.threshold)
      setRows(ps ?? [])
      setLoaded(true)
    })()
    return () => { on = false }
  }, [])

  const awaiting = rows.filter((p) => p.state === 'awaiting')
  const ready = rows.filter((p) => p.state === 'ready')

  const open = (p: Proposal) => nav('/proposal', { state: { id: p.id } })

  const Row = ({ p }: { p: Proposal }) => (
    <div className="plist-row" role="button" tabIndex={0} onClick={() => open(p)} onKeyDown={activateOnKey(() => open(p))}>
      <Identicon seed={p.proposer} size={34} />
      <div className="plist-main">
        <div className="plist-title">{p.memo || (p.kind === 'payroll' ? t('kind.payroll') : t('kind.payment'))}</div>
        <div className="plist-sub">
          {tr('proposals.subProposedBy', { kind: p.kind === 'payroll' ? t('kindShort.payroll') : t('kindShort.payment'), proposer: p.proposer })}
          {(() => { const e = p.expiry_unix ? expiryLabel(p.expiry_unix, t) : ''; return e ? ` · ${e}` : '' })()}
        </div>
      </div>
      <div className="plist-right">
        <div className="plist-val"><Secret sm><span>{fmtZec(p.value_zec)} ZEC</span></Secret></div>
        <div className="plist-prog">
          <span className="prog">{Array.from({ length: threshold }, (_, i) => <i key={i} className={i < p.approvals_count ? 'on' : ''} />)}</span>
          {' '}{t('proposal.ofN', { count: p.approvals_count, total: threshold })}
        </div>
      </div>
      <span className="plist-go">→</span>
    </div>
  )

  return (
    <>
      <main className="page narrow">
        <PageHeader title={t('proposals.title')} subtitle={<>{t('proposals.cap')} {live ? '' : t('proposals.demoMode')}</>} />

        {ready.length > 0 && (
          <>
            <div className="plist-head"><span className="klab">{t('proposals.readyToSign')}</span><span className="plist-count ready">{ready.length}</span></div>
            <div className="plist">{ready.map((p) => <Row key={p.id} p={p} />)}</div>
          </>
        )}

        <div className="plist-head mt"><span className="klab">{t('proposals.awaitingApproval')}</span><span className="plist-count">{awaiting.length}</span></div>
        {awaiting.length > 0 ? (
          <div className="plist">{awaiting.map((p) => <Row key={p.id} p={p} />)}</div>
        ) : (
          <div className="empty-note">{t('proposals.nothingAwaiting')} <Link className="link" to="/pay">{t('proposal.proposePaymentLink')}</Link></div>
        )}

        {loaded && rows.length === 0 && ready.length === 0 && (
          <div className="hint mt">{t('proposals.ledgerHint')} <Link className="link" to="/ledger">{t('proposals.viewLedger')}</Link></div>
        )}
      </main>
    </>
  )
}
