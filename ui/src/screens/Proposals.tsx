import { useCallback, useEffect, useRef, useState } from 'react'
import { startVisiblePoll } from '../usePoll'
import { Link, useNavigate } from 'react-router-dom'
import { Secret, activateOnKey } from '../components'
import { SkeletonRows } from '../skeleton'
import { PageHeader } from '../page'
import { Identicon } from '../avatar'
import { getProposals, getVault, readTransactions, type Proposal, type WalletTx } from '../api'
import { listVaults } from '../storage'
import { rankDesk } from '../desk'
import { settlementOf, isConfirmed } from '../settlement'
import { expiryLabel, fmtZec } from '../format'
import { useLoading } from '../loading'
import { useT, useTr } from '../i18n'

// Closed without payment: shown only on request, so the desk stays about what can still move.
const CLOSED = new Set(['rejected', 'expired', 'cancelled', 'superseded'])

export default function Proposals({ embedded = false }: { embedded?: boolean }) {
  const t = useT()
  const tr = useTr()
  const nav = useNavigate()
  // null until the first read answers; stays null when it could not be read (#292, class 5 of the
  // feedback ruler: a failed read is said, never drawn as an empty desk).
  const [rows, setRows] = useState<Proposal[] | null>(null)
  const [unread, setUnread] = useState(false)
  const [threshold, setThreshold] = useState(2)
  // The member name THIS device holds, from the on-device record; null when unknown (bridge mode),
  // in which case the groups speak of the vault, not of the person.
  const [me, setMe] = useState<string | null>(null)
  const [txs, setTxs] = useState<WalletTx[] | null>(null)
  const [showClosed, setShowClosed] = useState(false)
  const [attempt, setAttempt] = useState(0)
  const unreadRef = useRef<HTMLDivElement>(null)
  const { begin, end } = useLoading()

  // Auto-refresh: a new proposal or an incoming approval shows up without a manual reload. Poll on
  // the same 12s cadence as the Dashboard, guarded so calls never overlap. A refresh that fails
  // keeps the rows already on screen; only the first read can leave the list unread.
  useEffect(() => {
    let on = true
    let inFlight = false
    const load = async (first: boolean) => {
      if (inFlight) return
      inFlight = true
      if (first) begin()
      try {
        const [ps, v, list] = await Promise.all([getProposals(), getVault(), readTransactions()])
        if (!on) return
        if (v) {
          setThreshold(v.threshold)
          try {
            const saved = await listVaults()
            if (on) setMe(saved.find((s) => s.id === v.id)?.myName ?? null)
          } catch { /* local-bridge mode: no on-device record */ }
        }
        if (Array.isArray(list)) setTxs(list)
        if (ps) { setRows(ps); setUnread(false) } else if (first) setUnread(true)
      } finally {
        inFlight = false
        if (first) end()
      }
    }
    void load(true)
    const stop = startVisiblePoll(() => void load(false), 12_000) // pause when hidden, refresh on return (#123)
    return () => { on = false; stop() }
    // `attempt` alone: the loading hooks are stable, and listing them re-ran the first read under a
    // retry button that had just appeared (the read it offered was taken away from under it).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [attempt])

  // Bumped by the retry button: the read runs again from the start, and focus returns to the message
  // if it comes back.
  const retry = useCallback(() => { setUnread(false); setAttempt((a) => a + 1) }, [])
  useEffect(() => { if (unread && attempt > 0) unreadRef.current?.focus() }, [unread, attempt])

  const open = (p: Proposal) => nav('/proposal', { state: { id: p.id } })

  // One ranking for the open proposals, the Dashboard's (desk.ts): what needs this member first
  // (its signature, then its vote), soonest deadline first inside a band; then what is with the
  // others. Sent ones stay until the chain has them in a block (settlement.ts), then leave for
  // the ledger. Closed ones wait behind a toggle.
  const all = rows ?? []
  const desk = rankDesk(all, me, threshold)
  const needsYou = desk.items.filter((i) => i.band === 'sign' || i.band === 'vote').map((i) => i.p)
  const withOthers = desk.items.filter((i) => i.band === 'wait' || i.band === 'voted').map((i) => i.p)
  const sentOpen = all.filter((p) => p.state === 'sent' && !isConfirmed(settlementOf(p, txs)))
  const closed = all.filter((p) => CLOSED.has(p.state))

  const Row = ({ p }: { p: Proposal }) => (
    <div className={'plist-row' + (CLOSED.has(p.state) ? ' closed' : '')} role="button" tabIndex={0} onClick={() => open(p)} onKeyDown={activateOnKey(() => open(p))}>
      <Identicon seed={p.proposer} size={34} />
      <div className="plist-main">
        <div className="plist-title">{p.memo || (p.kind === 'payroll' ? t('kind.payroll') : t('kind.payment'))}</div>
        <div className="plist-sub">
          {tr('proposals.subProposedBy', { kind: p.kind === 'payroll' ? t('kindShort.payroll') : t('kindShort.payment'), proposer: p.proposer })}
          {(() => { const e = p.expiry_unix && !CLOSED.has(p.state) && p.state !== 'sent' ? expiryLabel(p.expiry_unix, t) : ''; return e ? ` · ${e}` : '' })()}
          {(CLOSED.has(p.state) || p.state === 'sent') && ` · ${t('state.' + p.state)}`}
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

  const Group = ({ label, items, count }: { label: string; items: Proposal[]; count?: 'ready' | '' }) => (
    <>
      <div className="plist-head mt"><span className="klab">{label}</span><span className={'plist-count' + (count === 'ready' ? ' ready' : '')}>{items.length}</span></div>
      <div className="plist">{items.map((p) => <Row key={p.id} p={p} />)}</div>
    </>
  )

  const body = (
    <>
      {rows === null && !unread && <SkeletonRows n={4} />}

      {unread && (
        <div className="hint warn mt" role="alert" tabIndex={-1} ref={unreadRef}>
          <div className="who-name mb-sm">{t('proposals.unreadTitle')}</div>
          <p className="dim">{t('proposals.unreadLead')}</p>
          <button className="btn ok sm-btn mt-sm" onClick={retry}>{t('proposals.retry')}</button>
        </div>
      )}

      {rows !== null && (
        <>
          {needsYou.length > 0 && <Group label={desk.personal ? t('proposals.needsYou') : t('proposals.readyToSign')} items={needsYou} count="ready" />}
          {withOthers.length > 0 && <Group label={desk.personal ? t('proposals.withOthers') : t('proposals.awaitingApproval')} items={withOthers} />}
          {needsYou.length === 0 && withOthers.length === 0 && (
            <div className="empty-note mt">{t('proposals.nothingAwaiting')} <Link className="link" to="/pay">{t('proposal.proposePaymentLink')}</Link></div>
          )}
          {sentOpen.length > 0 && <Group label={t('proposals.sentAwaiting')} items={sentOpen} />}
          {closed.length > 0 && (
            <div className="mt">
              <button className="chip" aria-pressed={showClosed} onClick={() => setShowClosed((v) => !v)}>
                {showClosed ? t('proposals.hideClosed') : t('proposals.showClosed', { n: String(closed.length) })}
              </button>
              {showClosed && <div className="plist mt-sm">{closed.map((p) => <Row key={p.id} p={p} />)}</div>}
            </div>
          )}
          <div className="hint mt">{t('proposals.ledgerHint')} <Link className="link" to="/ledger">{t('proposals.viewLedger')}</Link></div>
        </>
      )}
    </>
  )

  if (embedded) return body

  return (
    <>
      <main className="page narrow">
        <PageHeader title={t('proposals.title')} subtitle={t('proposals.cap')} />
        {body}
      </main>
    </>
  )
}
