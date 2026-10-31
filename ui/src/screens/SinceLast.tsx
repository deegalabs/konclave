// "What changed" (#151, #125): the Approvals tab that lists what changed state since this device
// last looked. The snapshot lives on this device only (localStorage, per vault); the comparison is
// `since-last.ts`; the coordinator is asked for nothing it does not already serve.
import { useEffect, useRef, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { Secret } from '../components'
import { SkeletonRows } from '../skeleton'
import ReadState from '../ReadState'
import { lastReadFailure } from '../read-failure'
import { startVisiblePoll } from '../usePoll'
import { Identicon } from '../avatar'
import { getProposals, getSelectedVault, getVault, type Proposal } from '../api'
import { listVaults } from '../storage'
import { fmtDateTime, fmtZec } from '../format'
import { useI18n, useT, useTr } from '../i18n'
import { changesSince, snapshotOf, type Change, type Snapshot } from '../since-last'

type Seen = { at: number; states: Snapshot }
const key = (vault: string) => `konclave.seen.${vault}`
function readSeen(vault: string): Seen | null {
  try {
    const raw = localStorage.getItem(key(vault))
    if (!raw) return null
    const d = JSON.parse(raw) as Partial<Seen>
    return typeof d.at === 'number' && d.states && typeof d.states === 'object' ? { at: d.at, states: d.states } : null
  } catch { return null }
}
function writeSeen(vault: string, seen: Seen) {
  try { localStorage.setItem(key(vault), JSON.stringify(seen)) } catch { /* a device that cannot keep it compares nothing */ }
}

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
  const heading = useRef<HTMLHeadingElement>(null)

  // Read, and keep reading on the shared cadence, so a change that lands while the tab is open shows.
  useEffect(() => {
    let on = true
    let inFlight = false
    const load = async () => {
      if (inFlight) return
      inFlight = true
      try {
        const [ps, v] = await Promise.all([getProposals(), getVault()])
        if (!on) return
        if (ps) setRows(ps)
        else if (rows === null) setRows(null)
        if (v) {
          try { setMe((await listVaults()).find((s) => s.id === v.id)?.myName ?? null) } catch { /* no record: neutral wording */ }
        }
      } finally {
        inFlight = false
        if (on) { setLoaded(true); setRetrying(false) }
      }
    }
    void load()
    const stop = startVisiblePoll(() => void load(), 12_000)
    return () => { on = false; stop() }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [attempt])

  const unread = loaded && rows === null ? (lastReadFailure('/api/vault/proposals') ?? lastReadFailure('/api/proposals')) : null
  const changes: Change[] | null = rows ? changesSince(seen?.states ?? null, rows, me) : null
  const canMark = !!changes && changes.length > 0

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
  const title = (p: Proposal) => p.memo || (p.kind === 'payroll' ? t('kind.payroll') : t('kind.payment'))

  // What a screen reader hears when the list settles: the count, the first-look sentence, or nothing changed.
  const status = !loaded || !rows ? ''
    : first ? t('since.firstTime')
    : changes && changes.length > 0 ? t('since.changes', { n: String(changes.length) })
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
      {loaded && rows && first && <p className="hint" id="since-hint" aria-hidden="true">{t('since.firstTime')}</p>}
      {loaded && rows && !first && changes && changes.length === 0 && <p className="hint" id="since-hint" aria-hidden="true">{t('since.nothing')}</p>}

      {!first && changes && changes.length > 0 && (
        <ul className="since-list">
          {changes.map((c) => {
            const sub = `${c.proposal.proposer} · ${fmtZec(c.proposal.value_zec)} ZEC`
            return (
              <li key={c.id} className={'since-row kind-' + c.kind}>
                <button type="button" className="since-btn" onClick={() => open(c.proposal)}
                  aria-label={`${title(c.proposal)}, ${t('since.kind.' + c.kind)}, ${sub}`}>
                  <Identicon seed={c.proposal.proposer} size={30} />
                  <span className="since-main">
                    <span className="since-kind">{t('since.kind.' + c.kind)}</span>
                    <span className="since-title">{title(c.proposal)}</span>
                    <span className="since-sub">
                      {c.proposal.proposer} · <Secret sm><span>{fmtZec(c.proposal.value_zec)} ZEC</span></Secret>
                      {c.kind === 'changed' && c.from && <> · {t('since.fromTo', { from: t('state.' + c.from), to: t('state.' + c.to) })}</>}
                    </span>
                  </span>
                  <span className="since-go" aria-hidden="true">→</span>
                </button>
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
