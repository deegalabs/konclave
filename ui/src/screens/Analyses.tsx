// Analyses: arithmetic over the vault's book, one reading at a time. Linked from the Ledger only,
// not from the menu, until the menu is reworked.
//
// It adds no number of its own. The balance band is `balanceParts`, the same split the payment
// screen gates on, and the balance is read the way the Dashboard reads it (`readBalance`, with
// `nextBalanceView` keeping the last one through a busy read).
import { useEffect, useState } from 'react'
import { getLedger, ledgerReadFailure, readBalance, type Balance, type Proposal } from '../api'
import { balanceParts, reservedZatOf } from '../balance-parts'
import { RevealButton, Secret } from '../components'
import { fmtZatExact } from '../format'
import { useI18n, type TFn } from '../i18n'
import { useLoading } from '../loading'
import { PageFooter, PageHeader } from '../page'
import ReadState from '../ReadState'
import { nextBalanceView, type BalanceView } from '../useVaultBalance'
import { startVisiblePoll } from '../usePoll'
import { useVaultReadable } from '../vault-readable'

const zec = (zat: number) => `${fmtZatExact(zat)} ZEC`

/** The vault's balance in its parts. Nothing is drawn from a balance that was not read, and what
 *  stopped the read is named: the vault busy with a send, no wallet connected, or a failed read. */
export function BalanceBand({ bal, busy = false, unwired = false, rows, t }: {
  bal: Balance | null; busy?: boolean; unwired?: boolean; rows: readonly Proposal[] | null; t: TFn
}) {
  if (!bal || bal.total_zat == null) {
    const why = busy ? 'wallet.busyFirst' : unwired ? 'dashboard.walletNotConnected' : 'analyses.balanceUnread'
    return <p className="hint" role="status">{t(why)}</p>
  }
  // The book was not read: the page's ReadState names it, so the band does not blame the balance.
  const reserved = reservedZatOf(rows)
  if (reserved === null) return null
  const parts = balanceParts(bal.total_zat, bal.spendable_zat ?? bal.total_zat, reserved)
  const cell = (label: string, zat: number) => (
    <div className="db-t"><dt className="klab">{label}</dt><dd><Secret sm label={label}><b className="mono">{zec(zat)}</b></Secret></dd></div>
  )
  return (
    <div className="doc-band an-band">
      <div className="db-totals">
        <dl className="an-cells">
          {cell(t('analyses.inVault'), parts.totalZat)}
          {cell(t('analyses.free'), parts.freeZat)}
          {cell(t('analyses.reserved'), parts.reservedZat)}
          {cell(t('analyses.confirming'), parts.confirmingZat)}
        </dl>
        <span className="db-reveal"><RevealButton /></span>
      </div>
      {/* The held amount is capped at what can be spent; when proposals hold more, say so. */}
      {parts.overCommitted && <p className="hint warn sm" role="status">{t('dashboard.overCommitted')}</p>}
      {busy && <p className="hint sm" role="status">{t('wallet.busyKept')}</p>}
    </div>
  )
}

export default function Analyses() {
  const { t } = useI18n()
  const { begin, end } = useLoading()
  const readable = useVaultReadable()
  const [rows, setRows] = useState<Proposal[] | null>(null)
  const [view, setView] = useState<BalanceView>({ bal: null, busy: false })
  const [unwired, setUnwired] = useState(false)
  const [unread, setUnread] = useState(false)
  const [attempt, setAttempt] = useState(0)
  // Nothing is said about the balance or the book until the first read answers: before it, both
  // are null, and "could not be read" would report a failure that has not happened.
  const [loaded, setLoaded] = useState(false)

  useEffect(() => {
    // Locked: a 401 would read as an empty book, so nothing is read until the vault is unlocked.
    if (!readable) return
    let on = true
    let inFlight = false
    const load = async (first: boolean) => {
      if (inFlight) return
      inFlight = true
      if (first) begin()
      try {
        const [l, b] = await Promise.all([getLedger(), readBalance()])
        if (!on) return
        if (l) { setRows(l); setUnread(false) } else if (first) setUnread(true)
        setView((v) => nextBalanceView(v, b))
        if (b && typeof b === 'object') setUnwired(!b.configured)
      } finally {
        inFlight = false
        if (first) { end(); if (on) setLoaded(true) }
      }
    }
    void load(true)
    const stop = startVisiblePoll(() => void load(false), 30_000)
    return () => { on = false; stop() }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [attempt, readable])

  return (
    <main className="page">
      <PageHeader title={t('analyses.title')} subtitle={t('analyses.sub')} back={{ to: '/ledger', label: t('ledger.title') }} />
      {rows === null && unread && (
        <ReadState title={t('ledger.unreadTitle')} failure={ledgerReadFailure()} onRetry={() => setAttempt((a) => a + 1)} />
      )}
      {loaded && <BalanceBand bal={view.bal} busy={view.busy} unwired={unwired} rows={rows} t={t} />}
      <PageFooter>
        <span className="dim pushr">{t('analyses.foot')}</span>
      </PageFooter>
    </main>
  )
}
