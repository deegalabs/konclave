// "What changed" (#151, #125): the Approvals tab that lists what changed state since this device
// last looked. The snapshot lives on this device only (`seen-store.ts`, per vault); the comparison
// is `since-last.ts`; the coordinator is asked for nothing it does not already serve.
import { useEffect, useRef, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { Secret } from '../components'
import { SkeletonRows } from '../skeleton'
import ReadState from '../ReadState'
import { lastReadFailure } from '../read-failure'
import { startVisiblePoll } from '../usePoll'
import { Identicon } from '../avatar'
import { getProposals, getSelectedVault, type Proposal } from '../api'
import { proposalName } from '../proposal-name'
import { listVaults } from '../storage'
import { fmtDateTime, fmtZec } from '../format'
import { useI18n, useT, useTr } from '../i18n'
import { changeLabelKey, changesSince, snapshotOf, type Change } from '../since-last'
import { readSeen, writeSeen, type Seen } from '../seen-store'

export default function SinceLast() {
  const t = useT()
  const tr = useTr()
  const { locale } = useI18n()
  const nav = useNavigate()
  const vault = getSelectedVault()
  const [rows, setRows] = useState<Proposal[] | null>(null)
  const [loaded, setLoaded] = useState(false)
  const [me, setMe] = useState<string | null>(null)
  const [seen, setSeen] = useState<Seen | null>(() => (vault ? readSeen(vault) : null))
  // True while the snapshot is the automatic one of a first look: nothing was compared and nobody
  // marked anything, and the screen says so instead of "nothing changed since <now>".
  const [first, setFirst] = useState(false)
  const [attempt, setAttempt] = useState(0)
  const [retrying, setRetrying] = useState(false)
  // Two reads in a row failed after a good one: the list on screen is no longer current, and says so.
  const [stale, setStale] = useState(false)
  const misses = useRef(0)
  const loadRef = useRef<(() => Promise<void>) | null>(null)
  const heading = useRef<HTMLHeadingElement>(null)

  // Who this device is in the vault, read once: it does not change between two reads of the list.
  useEffect(() => {
    if (!vault) return
    let on = true
    listVaults().then((vs) => { if (on) setMe(vs.find((s) => s.id === vault)?.myName ?? null) }).catch(() => { /* no record: neutral wording */ })
    return () => { on = false }
  }, [vault])

  // Read, and keep reading on the shared cadence, so a change that lands while the tab is open shows.
  useEffect(() => {
    let on = true
    let inFlight = false
    let good = false
    const load = async () => {
      if (inFlight) return
      inFlight = true
      try {
        const ps = await getProposals()
        if (!on) return
        if (ps) { setRows(ps); good = true; misses.current = 0; setStale(false) }
        else if (good) { misses.current += 1; if (misses.current >= 2) setStale(true) }
      } finally {
        inFlight = false
        if (on) { setLoaded(true); setRetrying(false) }
      }
    }
    loadRef.current = load
    void load()
    const stop = startVisiblePoll(() => void load(), 12_000)
    return () => { on = false; stop() }
  }, [attempt])

  const unread = loaded && rows === null ? (lastReadFailure('/api/vault/proposals') ?? lastReadFailure('/api/proposals')) : null
  const changes: Change[] | null = rows ? changesSince(seen?.states ?? null, rows, me) : null
  const hasChanges = !!changes && changes.length > 0
  // The first-look sentence stands only while nothing has changed since that snapshot: a change that
  // arrives on a later read is shown, so what "Mark as seen" records is always what is on screen.
  const firstLook = first && !hasChanges
  const canMark = hasChanges

  // "Seen": the snapshot becomes the list as it is now. On a first look there is nothing to compare,
  // so the snapshot is taken at once and said so; from then on the member decides when the list
  // was read, with the button, instead of it clearing itself the moment the tab opens.
  function snapshot(now: Proposal[]) {
    if (!vault) return
    const next = { at: Math.floor(Date.now() / 1000), states: snapshotOf(now) }
    writeSeen(vault, next)
    setSeen(next)
  }
  function markSeen() {
    if (!canMark || !rows) return
    snapshot(rows)
    setFirst(false)
    heading.current?.focus()
  }
  useEffect(() => {
    if (vault && rows && seen === null) { snapshot(rows); setFirst(true) }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rows])

  const open = (p: Proposal) => nav('/proposal', { state: { id: p.id } })
  const title = (p: Proposal) => proposalName(p, p.kind === 'payroll' ? t('kind.payroll') : t('kind.payment'))

  // What a screen reader hears when the list settles: the count, the first-look sentence, or nothing changed.
  const status = !loaded || !rows ? ''
    : firstLook ? t('since.firstTime')
    : hasChanges ? t('since.changes', { n: String(changes!.length) })
    : t('since.nothing')

  return (
    <section className="since" aria-labelledby="since-title">
      <div className="since-head">
        <h2 id="since-title" className="since-h" ref={heading} tabIndex={-1}>{t('since.title')}</h2>
        {seen && !first && <span className="since-at">{tr('since.seenAt', { when: fmtDateTime(seen.at, locale) })}</span>}
      </div>
      <p className="visually-hidden" role="status" aria-live="polite">{status}</p>

      {!loaded && <SkeletonRows n={3} />}
      {unread && (
        <ReadState title={t('since.unreadTitle')} failure={unread} attempt={attempt} busy={retrying}
          onRetry={() => { setRetrying(true); setLoaded(false); setAttempt((a) => a + 1) }} />
      )}
      {stale && rows !== null && (
        <ReadState compact title={t('since.unreadTitle')} failure={lastReadFailure('/api/vault/proposals') ?? lastReadFailure('/api/proposals')} onRetry={() => void loadRef.current?.()} />
      )}
      {loaded && rows && firstLook && <p className="hint" id="since-hint" aria-hidden="true">{t('since.firstTime')}</p>}
      {loaded && rows && !first && !hasChanges && <p className="hint" id="since-hint" aria-hidden="true">{t('since.nothing')}</p>}

      {hasChanges && (
        <ul className="since-list">
          {changes!.map((c) => {
            const what = t(changeLabelKey(c))
            return (
              <li key={c.id} className={'since-row kind-' + c.kind}>
                <Identicon seed={c.proposal.proposer} size={30} />
                <span className="since-main">
                  <span className="since-kind">{what}</span>
                  {/* The title is the button; the amount below stays under its bar, outside it, so the
                      bar is never a button inside a button and its name never carries the figure. */}
                  <button type="button" className="since-btn" onClick={() => open(c.proposal)} aria-label={`${title(c.proposal)}, ${what}`}>
                    <span className="since-title">{title(c.proposal)}</span>
                    <span className="since-go" aria-hidden="true"> →</span>
                  </button>
                  <span className="since-sub">
                    {c.proposal.proposer} · <Secret sm><span>{fmtZec(c.proposal.value_zec)} ZEC</span></Secret>
                    {c.kind === 'changed' && c.from && <> · {t('since.fromTo', { from: t('stamp.' + c.from), to: t('stamp.' + c.to) })}</>}
                  </span>
                </span>
              </li>
            )
          })}
        </ul>
      )}

      {loaded && rows && (
        <div className="since-actions">
          <button type="button" className="btn ghost sm-btn" onClick={markSeen} aria-disabled={!canMark} aria-describedby={canMark ? undefined : 'since-hint'}>
            {t('since.markSeen')}
          </button>
        </div>
      )}
    </section>
  )
}
