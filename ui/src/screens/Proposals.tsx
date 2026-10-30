import { useCallback, useEffect, useRef, useState } from 'react'
import { startVisiblePoll } from '../usePoll'
import { Link, useNavigate } from 'react-router-dom'
import { Secret } from '../components'
import { SkeletonRows } from '../skeleton'
import { PageHeader } from '../page'
import { Identicon } from '../avatar'
import { getProposals, getVault, readTransactions, type Proposal, type WalletTx } from '../api'
import { listVaults } from '../storage'
import { rankDesk, type Band } from '../desk'
import { settlementOf, isConfirmed } from '../settlement'
import { expiryLabel, fmtZec } from '../format'
import { useLoading } from '../loading'
import { useT, useTr, type TFn, type TRichFn } from '../i18n'

// Closed without payment: shown only on request, so the desk stays about what can still move. An
// awaiting proposal whose clock has run out joins them on this device before the coordinator
// recomputes it, so it never sits under "needs you" as expired.
const CLOSED = new Set(['rejected', 'expired', 'cancelled', 'superseded'])
const expiredByClock = (p: Proposal) => p.state === 'awaiting' && !!p.expiry_unix && p.expiry_unix * 1000 < Date.now()
const isClosed = (p: Proposal) => CLOSED.has(p.state) || expiredByClock(p)

type RowProps = { p: Proposal; band?: Band; last?: boolean; threshold: number; t: TFn; tr: TRichFn; open: (p: Proposal) => void }

// Module-level, so a poll does not remount every row (and drop the focus or hover a member has on
// one). The title is the link; the whole row answers a click as a convenience, nothing more.
function Row({ p, band, last, threshold, t, tr, open }: RowProps) {
  const closed = isClosed(p)
  const sent = p.state === 'sent'
  const stamp = closed ? t('state.' + (expiredByClock(p) ? 'expired' : p.state)) : sent ? '' : band ? t('desk.band.' + band) : ''
  const tail = sent && p.txid ? `tx ${p.txid.slice(0, 8)}…` : closed ? '' : (p.expiry_unix ? expiryLabel(p.expiry_unix, t) : '')
  return (
    <div className={'plist-row' + (closed ? ' closed' : '')} role="listitem" onClick={() => open(p)}>
      <Identicon seed={p.proposer} size={34} />
      <div className="plist-main">
        <div className="plist-title">
          <Link to="/proposal" state={{ id: p.id }} className="plist-link" onClick={(e) => e.stopPropagation()}>
            {p.memo || (p.kind === 'payroll' ? t('kind.payroll') : t('kind.payment'))}
          </Link>
          {stamp && <span className={'plist-stamp' + (band === 'sign' ? ' sign' : '')}>{stamp}</span>}
          {last && <span className="plist-stamp sign">{t('desk.signSends')}</span>}
        </div>
        <div className="plist-sub">
          {tr('proposals.subProposedBy', { kind: p.kind === 'payroll' ? t('kindShort.payroll') : t('kindShort.payment'), proposer: p.proposer })}
          {tail ? ` · ${tail}` : ''}
        </div>
      </div>
      <div className="plist-right">
        <div className="plist-val"><Secret sm><span>{fmtZec(p.value_zec)} ZEC</span></Secret></div>
        {!closed && (
          <div className="plist-prog">
            <span className="prog" aria-hidden="true">{Array.from({ length: threshold }, (_, i) => <i key={i} className={i < p.approvals_count ? 'on' : ''} />)}</span>
            {' '}{t('ledger.approvalsOf', { count: p.approvals_count, total: threshold })}
          </div>
        )}
      </div>
      <span className="plist-go" aria-hidden="true">→</span>
    </div>
  )
}

function Group({ id, label, children, count, ready }: { id: string; label: string; children: React.ReactNode; count: number; ready?: boolean }) {
  return (
    <section aria-labelledby={id} className="mt">
      <div className="plist-head"><h2 className="klab" id={id}>{label}</h2><span className={'plist-count' + (ready ? ' ready' : '')}>{count}</span></div>
      <div className="plist" role="list">{children}</div>
    </section>
  )
}

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

  const open = useCallback((p: Proposal) => nav('/proposal', { state: { id: p.id } }), [nav])

  // One ranking for the open proposals, the Dashboard's (desk.ts): what needs this member first
  // (its signature, then its vote), soonest deadline first inside a band; then what is with the
  // other members. Sent ones stay until the chain has them in a block (settlement.ts), then leave
  // for the ledger. Closed ones wait behind a toggle.
  const all = rows ?? []
  const desk = rankDesk(all.filter((p) => !expiredByClock(p)), me, threshold)
  const needsYou = desk.items.filter((i) => i.band === 'sign' || i.band === 'vote')
  const withOthers = desk.items.filter((i) => i.band === 'wait' || i.band === 'voted')
  const sentOpen = all.filter((p) => p.state === 'sent' && !isConfirmed(settlementOf(p, txs)))
  const closed = all.filter(isClosed)
  const rowProps = { threshold, t, tr, open }

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
          {needsYou.length > 0 && (
            <Group id="pl-needs-you" label={desk.personal ? t('proposals.needsYou') : t('proposals.readyToSign')} count={needsYou.length} ready={needsYou.some((i) => i.band === 'sign')}>
              {needsYou.map((i) => <Row key={i.p.id} p={i.p} band={i.band} last={i.last} {...rowProps} />)}
            </Group>
          )}
          {withOthers.length > 0 && (
            <Group id="pl-with-others" label={desk.personal ? t('proposals.withOthers') : t('proposals.awaitingApproval')} count={withOthers.length}>
              {withOthers.map((i) => <Row key={i.p.id} p={i.p} band={i.band} {...rowProps} />)}
            </Group>
          )}
          {needsYou.length === 0 && withOthers.length === 0 && (
            <div className="empty-note mt">{desk.personal ? t('proposals.nothingForYou') : t('proposals.nothingAwaiting')} <Link className="link" to="/pay">{t('proposal.proposePaymentLink')}</Link></div>
          )}
          {sentOpen.length > 0 && (
            <Group id="pl-sent" label={t('proposals.sentAwaiting')} count={sentOpen.length}>
              {sentOpen.map((p) => <Row key={p.id} p={p} {...rowProps} />)}
            </Group>
          )}
          {closed.length > 0 && (
            <div className="mt">
              <button className={'chip' + (showClosed ? ' on' : '')} aria-expanded={showClosed} aria-controls="pl-closed" onClick={() => setShowClosed((v) => !v)}>
                {t(showClosed ? 'proposals.hideClosed' : 'proposals.showClosed', { n: String(closed.length) })}
              </button>
              {showClosed && (
                <Group id="pl-closed" label={t('proposals.closedGroup')} count={closed.length}>
                  {closed.map((p) => <Row key={p.id} p={p} {...rowProps} />)}
                </Group>
              )}
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
