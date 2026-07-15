import { Fragment, useEffect, useState } from 'react'
import { Secret, RevealButton, activateOnKey } from '../components'
import { PageHeader, PageFooter } from '../page'
import { getLedger, getProposalDetail, getVault, ledgerCsvUrl, health, shortAddr, type Proposal, type PayrollLine } from '../api'
import { fmtDate, fmtZec } from '../format'
import { useT } from '../i18n'

const SETTLED = (s: string) => s === 'sent' || s === 'confirmed'

export default function Ledger() {
  const t = useT()
  const [rows, setRows] = useState<Proposal[] | null>(null)
  const [live, setLive] = useState(false)
  const [vaultName, setVaultName] = useState<string | null>(null)
  const [threshold, setThreshold] = useState(2)
  const [open, setOpen] = useState<Set<string>>(new Set())
  const [linesById, setLinesById] = useState<Record<string, PayrollLine[]>>({})
  const [fState, setFState] = useState<'all' | 'settled' | 'openp'>('all')
  const [fKind, setFKind] = useState<'all' | 'payment' | 'payroll'>('all')

  useEffect(() => {
    let on = true
    void (async () => {
      const ok = await health()
      if (!on) return
      setLive(ok)
      const [l, v] = await Promise.all([getLedger(), getVault()])
      if (!on) return
      if (l) setRows(l)
      if (v) { setVaultName(v.name); setThreshold(v.threshold) }
    })()
    return () => { on = false }
  }, [])

  async function toggle(p: Proposal) {
    if (p.kind !== 'payroll') return
    const next = new Set(open)
    if (next.has(p.id)) { next.delete(p.id); setOpen(next); return }
    next.add(p.id); setOpen(next)
    if (!linesById[p.id]) {
      const detail = await getProposalDetail(p.id)
      if (detail?.lines) setLinesById((m) => ({ ...m, [p.id]: detail.lines }))
    }
  }

  const ledger = rows ?? []
  const settled = ledger.filter((p) => SETTLED(p.state))
  const pending = ledger.filter((p) => p.state === 'awaiting' || p.state === 'ready')
  const totalOut = settled.reduce((acc, p) => acc + Number(p.value_zec), 0)
  const totalPending = pending.reduce((acc, p) => acc + Number(p.value_zec), 0)
  // Period from the entries' real creation dates.
  const dates = ledger.map((p) => p.created_at).filter(Boolean) as number[]
  const lo = dates.length ? Math.min(...dates) : 0
  const hi = dates.length ? Math.max(...dates) : 0
  const period = !dates.length ? '—' : lo === hi ? fmtDate(lo) : `${fmtDate(lo)} - ${fmtDate(hi)}`
  const filtered = ledger.filter((p) => {
    const stOk = fState === 'all' || (fState === 'settled' ? SETTLED(p.state) : p.state === 'awaiting' || p.state === 'ready')
    const knOk = fKind === 'all' || p.kind === fKind
    return stOk && knOk
  })

  return (
    <>
      <main className="page">
        <PageHeader
          title={t('ledger.title')}
          actions={<>
            <a className="btn ghost sm-btn" href={ledgerCsvUrl()} download="konclave-razao.csv">{t('ledger.exportCsv')}</a>
            <button className="btn ghost sm-btn" onClick={() => window.print()}>{t('ledger.pdf')}</button>
          </>}
        />

        {/* Banda de documento — o livro do cofre para entregar ao contador */}
        <div className="doc-band">
          <div className="db-meta">
            <div><span className="klab">{t('ledger.vault')}</span><b>{vaultName ?? 'Tesouraria Comum'}</b></div>
            <div><span className="klab">{t('ledger.period')}</span><b className="mono">{period}</b></div>
            <div><span className="klab">{t('ledger.entries')}</span><b>{ledger.length}</b></div>
          </div>
          <div className="db-totals">
            <div className="db-t"><span className="klab">{t('ledger.settledOut')}</span><Secret sm><b className="out">−{fmtZec(totalOut)}</b></Secret></div>
            <div className="db-t"><span className="klab">{t('ledger.open')}</span><Secret sm><b className="dim">{fmtZec(totalPending)}</b></Secret></div>
            <span className="db-reveal"><RevealButton /></span>
          </div>
        </div>
        <div className="cap">{live ? t('ledger.capLive') : t('ledger.capDemo')}</div>

        <div className="filters">
          <span className="chip-group">
            <span className="chip-glabel">{t('ledger.filterStateLabel')}</span>
            <button className={'chip' + (fState === 'all' ? ' on' : '')} onClick={() => setFState('all')}>{t('ledger.filterAll')}</button>
            <button className={'chip' + (fState === 'settled' ? ' on' : '')} onClick={() => setFState('settled')}>{t('ledger.filterSettled')}</button>
            <button className={'chip' + (fState === 'openp' ? ' on' : '')} onClick={() => setFState('openp')}>{t('ledger.open')}</button>
          </span>
          <span className="chip-group">
            <span className="chip-glabel">{t('ledger.filterKindLabel')}</span>
            <button className={'chip' + (fKind === 'all' ? ' on' : '')} onClick={() => setFKind('all')}>{t('ledger.filterEverything')}</button>
            <button className={'chip' + (fKind === 'payment' ? ' on' : '')} onClick={() => setFKind('payment')}>{t('ledger.filterPayments')}</button>
            <button className={'chip' + (fKind === 'payroll' ? ' on' : '')} onClick={() => setFKind('payroll')}>{t('ledger.filterPayrolls')}</button>
          </span>
          {filtered.length !== ledger.length && <span className="chip-note">{t('ledger.showingOf', { shown: filtered.length, total: ledger.length })}</span>}
        </div>

        <table className="tbl razao mt">
          <thead><tr><th>{t('ledger.colDate')}</th><th>{t('ledger.colDocument')}</th><th>{t('ledger.colWho')}</th><th>{t('ledger.colValue')}</th></tr></thead>
          <tbody>
            {ledger.length === 0 && (
              <tr><td colSpan={4} className="by">{t('ledger.emptyNone')}</td></tr>
            )}
            {ledger.length > 0 && filtered.length === 0 && (
              <tr><td colSpan={4} className="by">{t('ledger.emptyFilter')}</td></tr>
            )}
            {filtered.map((p) => {
              const isPayroll = p.kind === 'payroll'
              const selfOnly = p.approvals.length === 1 && p.approvals[0] === p.proposer
              const who = t('ledger.whoProposed', { proposer: p.proposer })
                + (p.approvals.length ? t('ledger.whoApproved', { who: p.approvals.join(', ') }) : '')
                + ' · ' + t('ledger.approvalsOf', { count: p.approvals.length, total: threshold })
                + (selfOnly ? ' · ' + t('ledger.selfApproved') : '')
              const settledRow = SETTLED(p.state)
              const isOpen = open.has(p.id)
              const lines = linesById[p.id]
              return (
                <Fragment key={p.id}>
                  <tr
                    className={isPayroll ? 'doc-row' : ''}
                    onClick={() => toggle(p)}
                    style={isPayroll ? { cursor: 'pointer' } : undefined}
                    {...(isPayroll ? { role: 'button' as const, tabIndex: 0, 'aria-expanded': isOpen, onKeyDown: activateOnKey(() => toggle(p)) } : {})}
                  >
                    <td className="mono">{fmtDate(p.created_at)}</td>
                    <td>
                      {isPayroll && <span className="caret">{isOpen ? '▾' : '▸'} </span>}
                      {p.memo || (isPayroll ? t('kind.payroll') : t('kind.payment'))}
                      <div className="by">
                        {isPayroll ? t('kindShort.payroll') : t('kindShort.payment')}
                        {isPayroll ? t('ledger.opensPerBeneficiary') : (p.to_address ? t('ledger.toAddress', { addr: shortAddr(p.to_address) }) : '')}
                      </div>
                    </td>
                    <td className="by">{who}</td>
                    <td className="num out">
                      <Secret sm><span>−{fmtZec(p.value_zec)}</span></Secret>
                      <div className="by">
                        {settledRow && p.txid
                          ? <a className="link" href={`https://mainnet.zcashexplorer.app/transactions/${p.txid}`} target="_blank" rel="noreferrer" onClick={(e) => e.stopPropagation()}>{t('state.' + p.state)} ↗</a>
                          : t('state.' + p.state)}
                      </div>
                    </td>
                  </tr>
                  {isPayroll && isOpen && (lines
                    ? lines.map((l, i) => (
                      <tr key={`${p.id}-${i}`} className="li-sub">
                        <td></td>
                        <td className="mono dim">↳ {l.label || shortAddr(l.address)}<div className="by">{shortAddr(l.address)}{l.is_public ? t('ledger.publicSuffix') : ''}{l.memo ? ` · ${l.memo}` : ''}</div></td>
                        <td></td>
                        <td className="num"><Secret sm><span>−{fmtZec(l.value_zec)}</span></Secret></td>
                      </tr>
                    ))
                    : <tr className="li-sub"><td></td><td className="by" colSpan={3}>{t('ledger.loadingBeneficiaries')}</td></tr>
                  )}
                </Fragment>
              )
            })}
          </tbody>
        </table>

        <PageFooter>
          <span className="dim pushr">{t('ledger.foot')}</span>
        </PageFooter>
      </main>
    </>
  )
}
