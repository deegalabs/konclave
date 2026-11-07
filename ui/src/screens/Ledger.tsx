import { Fragment, useEffect, useRef, useState } from 'react'
import { startVisiblePoll } from '../usePoll'
import { Secret, RevealButton, activateOnKey } from '../components'
import { SkeletonRows } from '../skeleton'
import { PageHeader, PageFooter } from '../page'
import { getBalance, getBeneficiaries, getLedger, ledgerReadFailure, getProposalDetail, getVault, shortAddr, type Beneficiary, type Proposal, type PayrollLine } from '../api'
import { balanceParts, reservedZatOf } from '../balance-parts'
import { itemizeBook, pivotByPayee, pivotCheck, pivotEntries } from '../ledgerPivot'
import { stateGroupOf, SETTLED } from '../ledger-state'
import { explorerTxUrl, fmtDate, fmtZecExact, sumZat, zatToZec } from '../format'
import { exportLedgerXlsx, type LedgerXlsxData, type LedgerXlsxItem } from '../ledgerXlsx'
import { exportLedgerCsv } from '../ledgerCsv'
import { isOpen } from '../desk'
import { periodWindow, periodLabel, inPeriod, offsetFor, type PeriodKind } from '../period'
import { useLoading } from '../loading'
import ReadState from '../ReadState'
import { useT, useI18n } from '../i18n'
import { useVaultReadable } from '../vault-readable'
import { useReveal } from '../reveal'

// Where the difference goes in the reconciliation sentence, so it can be drawn under the bar.
const DIFF_MARK = '\u0000'
// Closed without payment: refused, expired, cancelled, invalidated. Neither settled nor open, so
// outside both totals; shown with its own state and no outflow sign, because the money never left.
const CLOSED = (p: Proposal) => !SETTLED(p.state) && !isOpen(p)
// "Open" (awaiting or ready) is `isOpen` from desk.ts: one rule for the dashboard, this screen's
// total and filter, and the export, so a refused or expired row cannot count as open in one of them.

export default function Ledger({ embedded = false }: { embedded?: boolean }) {
  const t = useT()
  const { locale } = useI18n()
  const { begin, end } = useLoading()
  const readable = useVaultReadable()
  const [rows, setRows] = useState<Proposal[] | null>(null)
  const { revealed } = useReveal()
  // A book that could not be read is said as such, never left on the skeleton (#320). `attempt`
  // counts the retries asked for and re-runs the read; `failed` counts the ones that failed again.
  const [unread, setUnread] = useState(false)
  const [attempt, setAttempt] = useState(0)
  const [failed, setFailed] = useState(0)
  const [retrying, setRetrying] = useState(false)
  // Rows that stopped refreshing: two polls in a row failed after a good read. The compact line's
  // retry is a one-off read, not the first-load path.
  const [stale, setStale] = useState(false)
  const misses = useRef(0)
  const loadRef = useRef<((first: boolean) => Promise<void>) | null>(null)
  const [vaultName, setVaultName] = useState<string | null>(null)
  const [threshold, setThreshold] = useState(2)
  const [open, setOpen] = useState<Set<string>>(new Set())
  const [linesById, setLinesById] = useState<Record<string, PayrollLine[]>>({})
  const [fState, setFState] = useState<'all' | 'settled' | 'openp' | 'closed'>('all')
  const [fKind, setFKind] = useState<'all' | 'payment' | 'payroll'>('all')
  // The period window: by month, quarter or year, walked with an offset; entries placed by creation date.
  const [pKind, setPKind] = useState<PeriodKind>('all')
  const [pOffset, setPOffset] = useState(0)
  const [exporting, setExporting] = useState<null | 'xlsx' | 'csv'>(null)
  // The book by beneficiary (#778): opened on demand, since it reads every payroll's lines.
  const [showPivot, setShowPivot] = useState(false)
  const [benefs, setBenefs] = useState<Beneficiary[]>([])
  const [pivotReading, setPivotReading] = useState(false)

  // Auto-refresh (#123): a payment that settles on-chain, or a new proposal, shows in the book
  // without a manual reload. Poll on the same 12s cadence as the Dashboard/Proposals, in-flight
  // guarded so calls never overlap; only the FIRST load drives the top-progress bar.
  useEffect(() => {
    // Locked: a 401 here reads as an empty book, so nothing is read until the passphrase lands (#439).
    if (!readable) return
    let on = true
    let inFlight = false
    const load = async (first: boolean) => {
      if (inFlight) return
      inFlight = true
      if (first) begin()
      try {
        const [l, v] = await Promise.all([getLedger(), getVault()])
        if (!on) return
        if (l) { setRows(l); setUnread(false); misses.current = 0; setStale(false) }
        else if (first) { setUnread(true); if (attempt > 0) setFailed((f) => f + 1) }
        else { misses.current += 1; if (misses.current >= 2) setStale(true) }
        if (v) { setVaultName(v.name); setThreshold(v.threshold) }
      } finally {
        inFlight = false
        if (first) { end(); setRetrying(false) }
      }
    }
    loadRef.current = load
    void load(true)
    const stop = startVisiblePoll(() => void load(false), 12_000) // pause when hidden, refresh on return (#123)
    return () => { on = false; stop() }
    // `attempt` and `readable` alone: the loading hooks are stable in the app, and listing them re-ran the read on
    // every render where they are not (tests), which took the read state away from under its retry.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [attempt, readable])

  // Ids asked for since the section was opened: one that answered nothing is not asked again on
  // every poll (on the web each detail read is a list read), only when the section is reopened.
  const pivotTried = useRef<Set<string>>(new Set())
  // A read in flight belongs to the screen, not to the render that started it: a poll re-reads the
  // book every 12 s, and tying the read to that render dropped the answer, left "reading" on for
  // good and never asked for the ids still queued. Only leaving the screen stops it.
  const mounted = useRef(true)
  useEffect(() => { mounted.current = true; return () => { mounted.current = false } }, [])
  const pivotInFlight = useRef(0)
  useEffect(() => {
    if (!showPivot) { pivotTried.current = new Set(); return }
    // The registry once per opening, not on every re-read of the book.
    let on = true
    void getBeneficiaries().then((b) => { if (on && b) setBenefs(b) })
    return () => { on = false }
  }, [showPivot])
  useEffect(() => {
    if (!showPivot) return
    const missing = pivotEntries(scoped, linesById, SETTLED, isOpen).missing.filter((id) => !pivotTried.current.has(id))
    if (missing.length === 0) return
    for (const id of missing) pivotTried.current.add(id)
    pivotInFlight.current += 1
    setPivotReading(true)
    void (async () => {
      try {
        for (const id of missing) {
          const detail = await getProposalDetail(id)
          if (!mounted.current) return
          if (detail?.lines?.length) setLinesById((m) => ({ ...m, [id]: detail.lines }))
        }
      } finally {
        pivotInFlight.current -= 1
        if (mounted.current && pivotInFlight.current === 0) setPivotReading(false)
      }
    })()
    // Re-runs when the scope changes (period, kind) or the book is re-read; a run never cancels another.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [showPivot, pKind, pOffset, fKind, rows])

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

  // The rows and labels both exports share (#302, #301): built once, from what the screen shows.
  async function exportData(kind: 'xlsx' | 'csv'): Promise<LedgerXlsxData> {
      // The entry's local date, the one the table shows, not the UTC day (#304).
      const iso = (ts?: number) => {
        if (!ts) return ''
        const d = new Date(ts * 1000)
        return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
      }
      // Itemize: a payment = one row; a payroll = one row per beneficiary (fetch its lines if not
      // already open), mirroring the CSV export. Runs from the ledger data already in memory, and
      // from the rows the screen shows: the export honours the filters (#302). Each row carries its
      // own memo (a payroll line's, not the payroll's) and the txid, shared by a payroll's rows.
      // The rows themselves come from `itemizeBook`, the same rule the book by beneficiary reads.
      const read: Record<string, PayrollLine[]> = { ...linesById }
      for (const p of filtered) {
        if (p.kind !== 'payroll' || read[p.id]) continue
        const detail = await getProposalDetail(p.id)
        const lines = detail?.lines ?? []
        read[p.id] = lines
        setLinesById((m) => ({ ...m, [p.id]: lines }))
      }
      const head = {
        vaultName: vaultName ?? 'Konclave',
        period: win ? winLabel : periodOf(filtered),
        filter: filterLabel,
        generatedAt: new Date(),
        labels: {
          summary: t('ledger.xlsxSummary'), movements: t('ledger.xlsxMovements'), byPayee: t('ledger.byPayee'),
          vault: t('ledger.vault'), period: t('ledger.period'), filter: t('ledger.xlsxFilter'), generated: t('ledger.xlsxGenerated'),
          entries: t('ledger.entries'), settledOut: t('ledger.settledOut'), open: t('ledger.open'),
          colDate: t('ledger.colDate'), colDocument: t('ledger.colDocument'), colKind: t('ledger.colKind'),
          colBeneficiary: t('ledger.colBeneficiary'), colAddress: t('ledger.colAddress'), colMemo: t('ledger.colMemo'),
          colProposedBy: t('ledger.colProposedBy'), colApprovedBy: t('ledger.colApprovedBy'),
          colState: t('ledger.colState'), colSettled: t('ledger.colSettled'), colOpen: t('ledger.open'), colValue: t('ledger.colValue'),
          colTxid: t('ledger.colTxid'), total: t('ledger.total'), yes: t('ledger.yes'), no: t('ledger.no'),
          outPayments: t('ledger.xlsxOutPayments'), outPayrolls: t('ledger.xlsxOutPayrolls'), byState: t('ledger.xlsxByState'),
          kindPayment: t('kind.payment'), kindPayroll: t('kind.payroll'),
          position: t('ledger.xlsxPosition'), committed: t('ledger.xlsxCommitted'), available: t('ledger.xlsxAvailable'), confirming: t('ledger.xlsxConfirming'), asOf: t('ledger.xlsxAsOf'),
          difference: t('ledger.xlsxDifference'), overCommitted: t('ledger.xlsxOverCommitted'), noAddress: t('ledger.xlsxNoAddress'),
          unreadPayrolls: t('ledger.xlsxUnreadPayrolls'), balanceUnread: t('ledger.xlsxBalanceUnread'),
        },
      }
      const items: LedgerXlsxItem[] = itemizeBook(filtered, read).map((it) => {
        const p = it.proposal
        return {
          dateISO: iso(p.created_at),
          document: p.memo || (p.kind === 'payroll' ? t('kind.payroll') : t('kind.payment')),
          state: t('state.' + p.state), settled: SETTLED(p.state), open: isOpen(p),
          proposer: p.proposer, approvers: p.approvals.join(', '), txid: p.txid ?? '',
          kind: p.kind === 'payroll' ? t('kind.payroll') : t('kind.payment'),
          beneficiary: it.label, address: it.address, memo: it.memo, value_zat: it.value_zat, unread: it.unread,
        }
      })
      // The CSV carries the rows only: it does not wait for the balance or the registry.
      if (kind === 'csv') return { ...head, items }
      // The balance as of the export, read once: the position, what open proposals of the WHOLE
      // book hold, what is free, what is confirming. Left out, and said so, when the read brings nothing.
      const bal = await getBalance()
      const reserved = reservedZatOf(ledger)
      const parts = bal && bal.total_zat != null && reserved != null
        ? balanceParts(bal.total_zat, bal.spendable_zat ?? bal.total_zat, reserved)
        : null
      // Committed is the whole book's open proposals, unclamped (the composition clamps it for the
      // bar); the sheet writes the real figure and says when it exceeds what can be spent.
      const balance = parts
        ? { totalZec: Number(zatToZec(parts.totalZat)), reservedZec: Number(zatToZec(reserved ?? 0)), confirmingZec: Number(zatToZec(parts.confirmingZat)), overCommitted: parts.overCommitted }
        : undefined
      const registry = benefs.length ? benefs : (await getBeneficiaries()) ?? []
      return { ...head, items, balance, registry }
  }

  async function exportAs(kind: 'xlsx' | 'csv') {
    if (exporting) return
    setExporting(kind)
    try {
      const data = await exportData(kind)
      if (kind === 'xlsx') await exportLedgerXlsx(data)
      else await exportLedgerCsv(data, locale)
    } finally {
      setExporting(null)
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
  const pivotSrc = pivotEntries(scoped, linesById, SETTLED, isOpen)
  const pivot = pivotByPayee(pivotSrc.entries, benefs)
  const pivotVs = pivotCheck(pivot.totals, sumZat(settled), sumZat(pending))
  const pivotWarn = showPivot && !pivotVs.ok && !pivotReading
  // The difference is an amount like any other: under the bar on screen and absent from paper while
  // hidden, and exact to the zatoshi, like the book's totals.
  const withVeiledDiff = (text: string) => {
    const [before, after = ''] = text.split(DIFF_MARK)
    return <>{before}<Secret sm label={t('ledger.pivotDiff')}><span>{fmtZecExact(Number(zatToZec(pivotVs.diffZat)))}</span></Secret>{after}</>
  }
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
    const stOk = fState === 'all' || (fState === 'settled' ? SETTLED(p.state) : fState === 'closed' ? CLOSED(p) : isOpen(p))
    return stOk && knOk(p)
  })
  // The active filters in the chips' own words, so a filtered export says it is a part of the book.
  const filterLabel = [
    fState === 'settled' ? t('ledger.filterSettled') : fState === 'openp' ? t('ledger.open') : fState === 'closed' ? t('ledger.filterClosed') : '',
    fKind === 'payment' ? t('ledger.filterPayments') : fKind === 'payroll' ? t('ledger.filterPayrolls') : '',
  ].filter(Boolean).join(' · ')

  const exportActions = (
    <>
      {/* Both files are built in the browser from the rows on screen, so they work on every path
          and honour the period and the filters (#301, #302). */}
      <button className="btn ghost sm-btn" disabled={exporting !== null || rows === null} title={t('ledger.csvIncludes')} onClick={() => void exportAs('csv')}>{exporting === 'csv' ? t('ledger.exporting') : t('ledger.exportCsv')}</button>
      <button className="btn ghost sm-btn" disabled={exporting !== null || rows === null} title={t('ledger.xlsxIncludes')} onClick={() => void exportAs('xlsx')}>{exporting === 'xlsx' ? t('ledger.exporting') : t('ledger.exportXlsx')}</button>
      <button className="btn ghost sm-btn" onClick={() => window.print()}>{t('ledger.pdf')}</button>
    </>
  )

  const body = (
    <div className="ledger-doc">
        {embedded && <div className="lg-actions">{exportActions}</div>}
        {/* Document band - the vault's book to hand to the accountant */}
        <div className="doc-band">
          <div className="db-meta">
            <div><span className="klab">{t('ledger.vault')}</span><b>{vaultName ?? '…'}</b></div>
            <div><span className="klab">{t('ledger.period')}</span><b>{period}</b></div>
            <div><span className="klab">{t('ledger.entries')}</span><b>{rows === null ? '—' : inWin.length}</b></div>
          </div>
          <div className="db-totals">
            <div className="db-t"><span className="klab">{t('ledger.settledOut')}</span><Secret sm><b className="out">{rows === null ? '—' : `−${fmtZecExact(Number(totalOut))}`}</b></Secret></div>
            <div className="db-t"><span className="klab">{t('ledger.open')}</span><Secret sm><b className="dim">{rows === null ? '—' : fmtZecExact(Number(totalPending))}</b></Secret></div>
            <span className="db-reveal"><RevealButton /></span>
          </div>
        </div>
        {/* Printed only (#811): the filter chips are not printed, so the paper says which part of the
            book it is; and a page printed with the amounts hidden says how to print them. */}
        <p className="print-only by ledger-print-filter">{t('ledger.xlsxFilter')}: {filterLabel || t('ledger.filterAll')}</p>
        {!revealed && <p className="print-only by ledger-print-hidden">{t('ledger.printHidden')}</p>}
        {/* The period hint is on screen, not visually hidden: a hidden box that clips its text reads as a cropped control at 320px. */}
        <div className="cap">{t('ledger.capLive')}<br /><span id="ledger-period-hint">{t('ledger.periodHint')}</span> <span>{t('ledger.xlsxIncludes')}</span></div>

        {/* Nothing to filter until the book was read: the state sits above the filters, not under them. */}
        {rows === null && unread && (
          <ReadState title={t('ledger.unreadTitle')} failure={ledgerReadFailure()} attempt={failed} busy={retrying} onRetry={() => { setRetrying(true); setAttempt((a) => a + 1) }} />
        )}
        {stale && rows !== null && (
          <ReadState compact title={t('ledger.unreadTitle')} failure={ledgerReadFailure()} onRetry={() => void loadRef.current?.(false)} />
        )}
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
            <button className={'chip' + (fState === 'closed' ? ' on' : '')} aria-pressed={fState === 'closed'} onClick={() => setFState('closed')}>{t('ledger.filterClosed')}</button>
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
          <thead><tr><th>{t('ledger.colDate')}</th><th>{t('ledger.colDocument')}</th><th>{t('ledger.colWho')}</th><th className="num">{t('ledger.colValue')}</th></tr></thead>
          <tbody>
            {rows === null && !unread && (
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
              const closedRow = CLOSED(p)
              const isOpen = open.has(p.id)
              const lines = linesById[p.id]
              return (
                <Fragment key={p.id}>
                  <tr
                    className={[isPayroll ? 'doc-row' : '', closedRow ? 'closed' : ''].filter(Boolean).join(' ')}
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
                    <td className={closedRow ? 'num dim' : 'num out'}>
                      <Secret sm><span>{closedRow ? '' : '−'}{fmtZecExact(p.value_zat / 1e8)}</span></Secret>
                      <div className={'by st st-' + stateGroupOf(p)}>
                        {settledRow && p.txid
                          ? <a className="link" href={explorerTxUrl(p.txid)} target="_blank" rel="noreferrer" onClick={(e) => e.stopPropagation()}>{t('state.' + p.state)} ↗</a>
                          : t('state.' + p.state)}
                        {closedRow && <span className="closed-tag">{t('ledger.closedNoMoney')}</span>}
                      </div>
                    </td>
                  </tr>
                  {isPayroll && isOpen && (lines
                    ? lines.map((l, i) => (
                      <tr key={`${p.id}-${i}`} className="li-sub">
                        <td></td>
                        <td className="mono dim">↳ {l.label || shortAddr(l.address)}<div className="by">{shortAddr(l.address)}{l.is_public ? t('ledger.publicSuffix') : ''}{l.memo ? ` · ${l.memo}` : ''}</div></td>
                        <td></td>
                        <td className={closedRow ? 'num dim' : 'num'}><Secret sm><span>{closedRow ? '' : '−'}{fmtZecExact(l.value_zat / 1e8)}</span></Secret></td>
                      </tr>
                    ))
                    : <tr className="li-sub"><td></td><td className="by" colSpan={3}>{t('ledger.loadingBeneficiaries')}</td></tr>
                  )}
                </Fragment>
              )
            })}
          </tbody>
        </table>

        {/* The book by beneficiary: settled so far and still open per person, over the same scope as
            the totals above, and checked against them (#778). The heading is the disclosure. */}
        <section className="pivot mt" aria-labelledby="pivot-title">
          <h2 className="klab pivot-h" id="pivot-title">
            <button type="button" className="pivot-toggle" aria-expanded={showPivot} aria-controls="pivot-body" onClick={() => setShowPivot((v) => !v)}>
              <span className="caret" aria-hidden="true">{showPivot ? '▾' : '▸'}</span> {t('ledger.byPayee')}
            </button>
          </h2>
          <div id="pivot-body" hidden={!showPivot}>
            <p className="cap">{t('ledger.byPayeeHint')}</p>
            {showPivot && pivot.rows.length > 0 && (
              <div className="tblwrap">
                <table className="tbl pivot-tbl" aria-labelledby="pivot-title">
                  <thead><tr><th scope="col">{t('ledger.colPayee')}</th><th scope="col" className="num">{t('ledger.colPaid')}</th><th scope="col" className="num">{t('ledger.colDue')}</th><th scope="col" className="num">{t('ledger.colLines')}</th></tr></thead>
                  <tbody>
                    {pivot.rows.map((r) => {
                      const who = r.name || shortAddr(r.address)
                      const amt = (zat: number, col: string) => zat
                        ? <Secret sm label={`${col}, ${who}`}><span>{fmtZecExact(Number(zatToZec(zat)))}</span></Secret>
                        : <><span aria-hidden="true">-</span><span className="visually-hidden">{t('ledger.pivotNone')}</span></>
                      return (
                        <tr key={r.address}>
                          <th scope="row">{r.name || <span className="mono">{shortAddr(r.address)}</span>}{r.name && <div className="pivot-sub mono">{shortAddr(r.address)}</div>}</th>
                          <td className="num">{amt(r.paidZat, t('ledger.colPaid'))}</td>
                          <td className="num">{amt(r.dueZat, t('ledger.colDue'))}</td>
                          <td className="num">{r.lines}</td>
                        </tr>
                      )
                    })}
                  </tbody>
                  <tfoot>
                    <tr>
                      <th scope="row">{t('ledger.total')}</th>
                      <th scope="col" className="num"><Secret sm label={`${t('ledger.colPaid')}, ${t('ledger.total')}`}><span>{fmtZecExact(Number(zatToZec(pivot.totals.paidZat)))}</span></Secret></th>
                      <th scope="col" className="num"><Secret sm label={`${t('ledger.colDue')}, ${t('ledger.total')}`}><span>{fmtZecExact(Number(zatToZec(pivot.totals.dueZat)))}</span></Secret></th>
                      <th scope="col" className="num">{pivot.rows.reduce((n, r) => n + r.lines, 0)}</th>
                    </tr>
                  </tfoot>
                </table>
              </div>
            )}
            {/* One live line, mounted with the section. The check against the book comes before the
                empty message: a view whose every payroll is unreadable has no rows and still a total,
                and saying "nothing settled" there would be the silent zero this section exists to stop. */}
            <p className={'hint pivot-check' + (pivotWarn ? ' warn' : '')} role="status" aria-live="polite">
              {!showPivot ? ''
                : pivotReading && !pivotVs.ok ? t('ledger.pivotLoading')
                : !pivotVs.ok ? withVeiledDiff(pivotSrc.missing.length > 0
                  ? t('ledger.pivotMismatch', { diff: DIFF_MARK, n: String(pivotSrc.missing.length) })
                  : t('ledger.pivotMismatchNone', { diff: DIFF_MARK }))
                : pivot.rows.length === 0 ? t('ledger.pivotEmpty')
                : t('ledger.pivotMatches')}
            </p>
          </div>
        </section>
    </div>
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
