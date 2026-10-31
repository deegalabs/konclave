import { Fragment, useEffect, useState } from 'react'
import { startVisiblePoll } from '../usePoll'
import { Secret, RevealButton, activateOnKey, Soon } from '../components'
import { SkeletonRows } from '../skeleton'
import { PageHeader, PageFooter } from '../page'
import { getLedger, getProposalDetail, getVault, ledgerCsvUrl, shortAddr, IS_NET, type Proposal, type PayrollLine } from '../api'
import { explorerTxUrl, fmtDate, fmtZecExact, sumZat, zatToZec } from '../format'
import { exportLedgerXlsx, type LedgerXlsxItem } from '../ledgerXlsx'
import { isOpen } from '../desk'
import { periodWindow, periodLabel, inPeriod, offsetFor, type PeriodKind } from '../period'
import { useLoading } from '../loading'
import { useT, useI18n } from '../i18n'

const SETTLED = (s: string) => s === 'sent' || s === 'confirmed'
// "Open" (awaiting or ready) is `isOpen` from desk.ts: one rule for the dashboard, this screen's
// total and filter, and the export, so a refused or expired row cannot count as open in one of them.

export default function Ledger({ embedded = false }: { embedded?: boolean }) {
  const t = useT()
  const { locale } = useI18n()
  const { begin, end } = useLoading()
  const [rows, setRows] = useState<Proposal[] | null>(null)
  const [vaultName, setVaultName] = useState<string | null>(null)
  const [threshold, setThreshold] = useState(2)
  const [open, setOpen] = useState<Set<string>>(new Set())
  const [linesById, setLinesById] = useState<Record<string, PayrollLine[]>>({})
  const [fState, setFState] = useState<'all' | 'settled' | 'openp'>('all')
  const [fKind, setFKind] = useState<'all' | 'payment' | 'payroll'>('all')
  // The period window: by month, quarter or year, walked with an offset; entries placed by creation date.
  const [pKind, setPKind] = useState<PeriodKind>('all')
  const [pOffset, setPOffset] = useState(0)
  const [xlsxBusy, setXlsxBusy] = useState(false)

  // Auto-refresh (#123): a payment that settles on-chain, or a new proposal, shows in the book
  // without a manual reload. Poll on the same 12s cadence as the Dashboard/Proposals, in-flight
  // guarded so calls never overlap; only the FIRST load drives the top-progress bar.
  useEffect(() => {
    let on = true
    let inFlight = false
    const load = async (first: boolean) => {
      if (inFlight) return
      inFlight = true
      if (first) begin()
      try {
        const [l, v] = await Promise.all([getLedger(), getVault()])
        if (!on) return
        if (l) setRows(l)
        if (v) { setVaultName(v.name); setThreshold(v.threshold) }
      } finally {
        inFlight = false
        if (first) end()
      }
    }
    void load(true)
    const stop = startVisiblePoll(() => void load(false), 12_000) // pause when hidden, refresh on return (#123)
    return () => { on = false; stop() }
  }, [begin, end])

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

  async function exportXlsx() {
    if (xlsxBusy) return
    setXlsxBusy(true)
    try {
      const iso = (ts?: number) => (ts ? new Date(ts * 1000).toISOString().slice(0, 10) : '')
      const items: LedgerXlsxItem[] = []
      // Itemize: a payment = one row; a payroll = one row per beneficiary (fetch its lines if not
      // already open), mirroring the CSV export. Runs from the ledger data already in memory, and
      // from the rows the screen shows: the export honours the filters (#302). Each row carries its
      // own memo (a payroll line's, not the payroll's) and the txid, shared by a payroll's rows.
      for (const p of filtered) {
        const stLabel = t('state.' + p.state)
        const isSettled = SETTLED(p.state)
        const doc = p.memo || (p.kind === 'payroll' ? t('kind.payroll') : t('kind.payment'))
        const base = { dateISO: iso(p.created_at), document: doc, state: stLabel, settled: isSettled, open: isOpen(p), proposer: p.proposer, approvers: p.approvals.join(', '), txid: p.txid ?? '' }
        if (p.kind === 'payroll') {
          let lines = linesById[p.id]
          if (!lines) {
            const detail = await getProposalDetail(p.id)
            lines = detail?.lines ?? []
            setLinesById((m) => ({ ...m, [p.id]: lines! }))
          }
          if (lines.length === 0) {
            items.push({ ...base, kind: t('kind.payroll'), beneficiary: '', address: '', memo: p.memo ?? '', zec: Number(zatToZec(p.value_zat)) })
          } else {
            for (const l of lines) {
              items.push({ ...base, kind: t('kind.payroll'), beneficiary: l.label || '', address: l.address, memo: l.memo ?? '', zec: Number(zatToZec(l.value_zat)) })
            }
          }
        } else {
          items.push({ ...base, kind: t('kind.payment'), beneficiary: '', address: p.to_address ?? '', memo: p.memo ?? '', zec: Number(zatToZec(p.value_zat)) })
        }
      }
      await exportLedgerXlsx({
        vaultName: vaultName ?? 'Konclave',
        period: win ? winLabel : periodOf(filtered),
        filter: filterLabel,
        generatedAt: new Date(),
        items,
        labels: {
          summary: t('ledger.xlsxSummary'), movements: t('ledger.xlsxMovements'),
          vault: t('ledger.vault'), period: t('ledger.period'), filter: t('ledger.xlsxFilter'), generated: t('ledger.xlsxGenerated'),
          entries: t('ledger.entries'), settledOut: t('ledger.settledOut'), open: t('ledger.open'),
          colDate: t('ledger.colDate'), colDocument: t('ledger.colDocument'), colKind: t('ledger.colKind'),
          colBeneficiary: t('ledger.colBeneficiary'), colAddress: t('ledger.colAddress'), colMemo: t('ledger.colMemo'),
          colProposedBy: t('ledger.colProposedBy'), colApprovedBy: t('ledger.colApprovedBy'),
          colState: t('ledger.colState'), colSettled: t('ledger.colSettled'), colOpen: t('ledger.open'), colValue: t('ledger.colValue'),
          colTxid: t('ledger.colTxid'), total: t('ledger.total'), yes: t('ledger.yes'), no: t('ledger.no'),
        },
      })
    } finally {
      setXlsxBusy(false)
    }
  }

  const ledger = rows ?? []
  const win = periodWindow(pKind, pOffset)
  const winLabel = periodLabel(pKind, pOffset, new Date(), locale, (q, y) => t('ledger.periodQuarterLabel', { q: String(q), y: String(y) }))
  const inWin = ledger.filter((p) => inPeriod(win, p.created_at))
  // Changing the kind keeps the date in view: the offset is recomputed from the window's start.
  const setKind = (k: PeriodKind) => {
    const anchor = win ? new Date(win.from * 1000) : new Date()
    setPKind(k)
    setPOffset(offsetFor(k, anchor))
  }
  const knOk = (p: Proposal) => fKind === 'all' || p.kind === fKind
  // The headline totals follow the period and the kind filter, never the state filter (a state is
  // what each total already selects).
  const scoped = inWin.filter(knOk)
  const settled = scoped.filter((p) => SETTLED(p.state))
  const pending = scoped.filter(isOpen)
  // Totals in integer zatoshi, formatted once: a float sum of the decimal strings drifts (#303).
  const totalOut = zatToZec(sumZat(settled))
  const totalPending = zatToZec(sumZat(pending))
  // Period from the entries' real creation dates: the screen's from the whole book, the export's
  // from the rows it carries (#302).
  const periodOf = (list: Proposal[]) => {
    const dates = list.map((p) => p.created_at).filter(Boolean) as number[]
    if (!dates.length) return '-'
    const lo = Math.min(...dates)
    const hi = Math.max(...dates)
    return lo === hi ? fmtDate(lo, locale) : `${fmtDate(lo, locale)} - ${fmtDate(hi, locale)}`
  }
  const period = win ? winLabel : periodOf(ledger)
  const filtered = inWin.filter((p) => {
    const stOk = fState === 'all' || (fState === 'settled' ? SETTLED(p.state) : isOpen(p))
    return stOk && knOk(p)
  })
  // The active filters in the chips' own words, so a filtered export says it is a part of the book.
  const filterLabel = [
    fState === 'settled' ? t('ledger.filterSettled') : fState === 'openp' ? t('ledger.open') : '',
    fKind === 'payment' ? t('ledger.filterPayments') : fKind === 'payroll' ? t('ledger.filterPayrolls') : '',
  ].filter(Boolean).join(' · ')

  const exportActions = (
    <>
      {/* The CSV comes from the bridge's endpoint and is dead on the primary path (#301), and that
          endpoint does not know the screen's filters, so the CSV is always the whole book (#302).
          The XLSX and the print view are built in the browser and work everywhere. */}
      {IS_NET ? (
        <Soon reason={t('ledger.exportSoonWhy')}>
          <span className="btn ghost sm-btn">{t('ledger.exportCsv')}</span>
        </Soon>
      ) : (
        <a className="btn ghost sm-btn" href={ledgerCsvUrl()} download="konclave-ledger.csv" title={win ? t('ledger.csvWholeBook') : undefined}>{t('ledger.exportCsv')}</a>
      )}
      <button className="btn ghost sm-btn" disabled={xlsxBusy} title={t('ledger.xlsxIncludes')} onClick={() => void exportXlsx()}>{xlsxBusy ? t('ledger.exporting') : t('ledger.exportXlsx')}</button>
      <button className="btn ghost sm-btn" onClick={() => window.print()}>{t('ledger.pdf')}</button>
    </>
  )

  const body = (
    <>
        {embedded && <div className="lg-actions">{exportActions}</div>}
        {/* Document band - the vault's book to hand to the accountant */}
        <div className="doc-band">
          <div className="db-meta">
            <div><span className="klab">{t('ledger.vault')}</span><b>{vaultName ?? '…'}</b></div>
            <div><span className="klab">{t('ledger.period')}</span><b className="mono">{period}</b></div>
            <div><span className="klab">{t('ledger.entries')}</span><b>{inWin.length}</b></div>
          </div>
          <div className="db-totals">
            <div className="db-t"><span className="klab">{t('ledger.settledOut')}</span><Secret sm><b className="out">−{fmtZecExact(Number(totalOut))}</b></Secret></div>
            <div className="db-t"><span className="klab">{t('ledger.open')}</span><Secret sm><b className="dim">{fmtZecExact(Number(totalPending))}</b></Secret></div>
            <span className="db-reveal"><RevealButton /></span>
          </div>
        </div>
        {/* The period hint is on screen, not visually hidden: a hidden box that clips its text reads as a cropped control at 320px. */}
        <div className="cap">{t('ledger.capLive')}<br /><span id="ledger-period-hint">{t('ledger.periodHint')}</span> <span>{t('ledger.xlsxIncludes')}</span></div>

        <div className="filters">
          <span className="chip-group" role="group" aria-labelledby="ledger-period-label" aria-describedby="ledger-period-hint">
            <span className="chip-glabel" id="ledger-period-label" title={t('ledger.periodHint')}>{t('ledger.periodLabel')}</span>
            {(['all', 'month', 'quarter', 'year'] as const).map((k) => (
              <button key={k} className={'chip' + (pKind === k ? ' on' : '')} aria-pressed={pKind === k} onClick={() => setKind(k)}>
                {t({ all: 'ledger.periodAll', month: 'ledger.periodMonth', quarter: 'ledger.periodQuarter', year: 'ledger.periodYear' }[k])}
              </button>
            ))}
            {win && <button className="chip" aria-label={t('ledger.periodPrev')} title={t('ledger.periodPrev')} onClick={() => setPOffset((o) => o - 1)}>‹</button>}
            {/* Always mounted, so a change of window is announced (a live region must exist before its text changes). */}
            <span className="chip-label" role="status" title={t('ledger.periodHint')}>{win ? winLabel : ''}</span>
            {win && (
              <button className="chip" aria-label={t('ledger.periodNext')} title={t('ledger.periodNext')} aria-disabled={pOffset >= 0}
                onClick={() => { if (pOffset < 0) setPOffset((o) => o + 1) }}>›</button>
            )}
          </span>
          <span className="chip-group" role="group" aria-labelledby="ledger-state-label">
            <span className="chip-glabel" id="ledger-state-label">{t('ledger.filterStateLabel')}</span>
            <button className={'chip' + (fState === 'all' ? ' on' : '')} aria-pressed={fState === 'all'} onClick={() => setFState('all')}>{t('ledger.filterAll')}</button>
            <button className={'chip' + (fState === 'settled' ? ' on' : '')} aria-pressed={fState === 'settled'} onClick={() => setFState('settled')}>{t('ledger.filterSettled')}</button>
            <button className={'chip' + (fState === 'openp' ? ' on' : '')} aria-pressed={fState === 'openp'} onClick={() => setFState('openp')}>{t('ledger.open')}</button>
          </span>
          <span className="chip-group" role="group" aria-labelledby="ledger-kind-label">
            <span className="chip-glabel" id="ledger-kind-label">{t('ledger.filterKindLabel')}</span>
            <button className={'chip' + (fKind === 'all' ? ' on' : '')} aria-pressed={fKind === 'all'} onClick={() => setFKind('all')}>{t('ledger.filterEverything')}</button>
            <button className={'chip' + (fKind === 'payment' ? ' on' : '')} aria-pressed={fKind === 'payment'} onClick={() => setFKind('payment')}>{t('ledger.filterPayments')}</button>
            <button className={'chip' + (fKind === 'payroll' ? ' on' : '')} aria-pressed={fKind === 'payroll'} onClick={() => setFKind('payroll')}>{t('ledger.filterPayrolls')}</button>
          </span>
          {/* The note's base is the period in view, the same base as the band's count. */}
          {filtered.length !== inWin.length && <span className="chip-note">{t('ledger.showingOf', { shown: filtered.length, total: inWin.length })}</span>}
        </div>

        <table className="tbl razao mt">
          <thead><tr><th>{t('ledger.colDate')}</th><th>{t('ledger.colDocument')}</th><th>{t('ledger.colWho')}</th><th>{t('ledger.colValue')}</th></tr></thead>
          <tbody>
            {rows === null && (
              <tr><td colSpan={4}><SkeletonRows n={5} /></td></tr>
            )}
            {rows !== null && ledger.length === 0 && (
              <tr><td colSpan={4} className="by">{t('ledger.emptyNone')}</td></tr>
            )}
            {ledger.length > 0 && win && inWin.length === 0 && (
              <tr><td colSpan={4} className="by">{t('ledger.emptyPeriod', { period: winLabel })} <button className="chip" onClick={() => setKind('all')}>{t('ledger.periodAll')}</button></td></tr>
            )}
            {inWin.length > 0 && filtered.length === 0 && (
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
                    <td className="mono">{fmtDate(p.created_at, locale)}</td>
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
                      <Secret sm><span>−{fmtZecExact(p.value_zat / 1e8)}</span></Secret>
                      <div className="by">
                        {settledRow && p.txid
                          ? <a className="link" href={explorerTxUrl(p.txid)} target="_blank" rel="noreferrer" onClick={(e) => e.stopPropagation()}>{t('state.' + p.state)} ↗</a>
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
                        <td className="num"><Secret sm><span>−{fmtZecExact(l.value_zat / 1e8)}</span></Secret></td>
                      </tr>
                    ))
                    : <tr className="li-sub"><td></td><td className="by" colSpan={3}>{t('ledger.loadingBeneficiaries')}</td></tr>
                  )}
                </Fragment>
              )
            })}
          </tbody>
        </table>

    </>
  )

  if (embedded) return body

  return (
    <>
      <main className="page">
        <PageHeader title={t('ledger.title')} actions={exportActions} />
        {body}
        <PageFooter>
          <span className="dim pushr">{t('ledger.foot')}</span>
        </PageFooter>
      </main>
    </>
  )
}
