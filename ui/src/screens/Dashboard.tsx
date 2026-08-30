import { useEffect, useState } from 'react'
import { startVisiblePoll } from '../usePoll'
import { Link, useNavigate } from 'react-router-dom'
import { Seal, Secret, RevealButton, Loading } from '../components'
import { SkeletonStat, SkeletonRows } from '../skeleton'
import { SpendBars, type SpendPoint } from '../charts'
import { PageHeader } from '../page'
import { Identicon } from '../avatar'
import { fmtZec as fmt4, expiryLabel, fmtDate } from '../format'
import { rankDesk, type Band } from '../desk'
import { balanceParts } from '../balance-parts'
import { participation } from '../participation'
import { usdEnabled, setUsdEnabled, cachedRate, rateIsStale, fetchRate, zecToUsd, type Rate } from '../price'
import { CONFIRMATIONS_UNTRUSTED, getTransactions } from '../api'
import { useT, useTr } from '../i18n'
import {
  getVault, getProposals, getBalance, getLedger, health, shortAddr, isVaultUnlocked,
  type Vault, type Proposal, type Balance,
} from '../api'
import { listVaults } from '../storage'
import { useVaultSigner } from '../VaultSigner'
import { getUnlockedShare } from '../session'
import { useLoading } from '../loading'

type Movimento = { date: string; title: string; by?: string; value: string; dir: 'out' | 'in'; status: string }

// Locale helpers for the few neutral labels this screen renders outside the i18n table. `dl` reads
// the persisted locale per access, so it re-resolves when the language toggles.
const dpt = (): boolean => {
  try {
    const l = localStorage.getItem('konclave.locale')
    if (l === 'en') return false
    if (l === 'pt-BR') return true
    return (navigator.language || '').toLowerCase().startsWith('pt')
  } catch {
    return false
  }
}
const dl = (pt: string, en: string): string => (dpt() ? pt : en)

/** How many queued rows sit under the open one before the card sends you to /proposals. */
const QUEUE_ROWS = 3

const STAMP_CLASS: Record<Band, string> = {
  sign: 'st-ready',
  vote: '',
  wait: 'st-wait',
  voted: 'st-wait',
}

const NOTE_KEY: Record<Band, string> = {
  sign: 'desk.noteSign',
  vote: 'desk.noteVote',
  wait: 'desk.noteWait',
  voted: 'desk.noteVoted',
}

/**
 * The stamp and the one-line summary. Both fall back to neutral, vault-level wording when this
 * device does not know its own member name (`desk.personal === false`): we will not tell someone
 * their vote is missing when we cannot tell whether they voted.
 */
function stampKey(band: Band, personal: boolean): string {
  if (!personal) return band === 'sign' ? 'stamp.ready' : 'stamp.awaiting'
  return `desk.band.${band}`
}
function lineKey(band: Band, personal: boolean): string {
  if (!personal) return band === 'sign' ? 'dashboard.readyToSign' : 'dashboard.needsYou'
  return `desk.line.${band}`
}

/** What a proposal is about, in the member's own words when they left any. */
function whatOf(p: Proposal, t: (k: string) => string): string {
  return p.memo?.trim() || (p.kind === 'payroll' ? t('kind.payroll') : t('kind.payment'))
}

export default function Dashboard() {
  const t = useT()
  const tr = useTr()
  const nav = useNavigate()
  const { open: openSigning, bg } = useVaultSigner()
  const { begin, end } = useLoading()
  // The page renders once the FAST data (vault + proposals + ledger) is in - no placeholder flash.
  const [firstLoaded, setFirstLoaded] = useState(false)
  // The balance is fetched separately (it triggers a slow helper wallet sync); its card shows a
  // skeleton until this flips, so it never flashes "not connected" while merely syncing.
  const [balLoaded, setBalLoaded] = useState(false)
  const [vault, setVault] = useState<Vault | null>(null)
  const [proposals, setProposals] = useState<Proposal[]>([])
  const [ledger, setLedger] = useState<Proposal[] | null>(null)
  const [balance, setBalance] = useState<Balance | null>(null)
  const [live, setLive] = useState<boolean | null>(null)
  // For the members peek: this device's seat and the vault creator (on-device record). Loaded once
  // per vault id, not on every poll.
  const [me, setMe] = useState<string | null>(null)
  const [creator, setCreator] = useState<string | null>(null)
  const [rate, setRate] = useState<Rate | null>(cachedRate())
  // How far the newest note has confirmed. Only fetched while something IS confirming, so a settled
  // vault pays nothing for it.
  const [newestHeight, setNewestHeight] = useState<number | null>(null)
  const [usdOn, setUsdOn] = useState<boolean>(usdEnabled())
  const [rateBusy, setRateBusy] = useState(false)

  async function refreshRate() {
    setRateBusy(true)
    const r = await fetchRate()
    if (r) setRate(r)
    setRateBusy(false)
  }
  function enableUsd() {
    setUsdEnabled(true)
    setUsdOn(true)
    void refreshRate()
  }

  // Fetch a fresh rate on mount only if the user has opted in and the cache is stale (privacy:
  // no outbound price call otherwise).
  useEffect(() => {
    if (usdOn && rateIsStale(cachedRate())) void refreshRate()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  useEffect(() => {
    let on = true
    let inFlight = false
    const load = async (first: boolean) => {
      if (inFlight) return // never overlap polls (the helper's wallet sync can be slow)
      inFlight = true
      if (first) begin()
      try {
        const ok = await health()
        if (!on) return
        setLive(ok)
        if (!ok) return
        const v = await getVault()
        if (!on) return
        // Locked vault not unlocked this session → send back to unlock. Only on first load, so a
        // background poll never yanks the user off the dashboard.
        if (first && v?.locked && !isVaultUnlocked(v.id)) { nav('/vaults'); return }
        if (v) setVault(v)
        // FAST data first: proposals + ledger are plain file reads (no wallet sync). Render the
        // dashboard on these so it appears immediately, instead of waiting on the balance.
        const [ps, l] = await Promise.all([getProposals(), getLedger()])
        if (!on) return
        if (ps) setProposals(ps)
        if (l) setLedger(l)
        if (first && on) setFirstLoaded(true) // page is usable now; the balance fills in below
        // SLOW data separately: getBalance triggers a helper wallet SYNC (seconds). It never gates
        // the page - the balance card shows a skeleton until it lands (the top-progress runs meanwhile).
        const b = await getBalance()
        if (!on) return
        if (b) setBalance(b)
        if (on) setBalLoaded(true)
      } finally {
        inFlight = false
        if (first) { end(); if (on) setFirstLoaded(true) }
      }
    }
    void load(true)
    // Auto-refresh: a freshly-funded vault (and its confirming balance / new proposals) updates on
    // its own, so a user watching for funds to land never has to hit reload. Polls every 12s.
    // Visibility-aware: pause while the tab is hidden (getBalance triggers a costly helper wallet
    // sync) and refresh immediately on return (#123).
    const stop = startVisiblePoll(() => void load(false), 12_000)
    return () => { on = false; stop() }
  }, [])

  // Load "you" + creator for the members peek, once per vault (not on the 12s poll).
  useEffect(() => {
    if (!vault) return
    let on = true
    void (async () => {
      try {
        const saved = await listVaults()
        const rec = saved.find((s) => s.id === vault.id)
        if (on && rec) { setMe(rec.myName ?? null); setCreator(rec.creatorName ?? null) }
      } catch { /* local-bridge mode: no on-device record - the peek just omits the you/creator marks */ }
    })()
    return () => { on = false }
  }, [vault?.id]) // eslint-disable-line react-hooks/exhaustive-deps

  const isLive = live === true
  const loading = live === null // initial fetch still in flight

  // Vault header - the real vault from the bridge/helper. The header only renders past the
  // firstLoaded gate, so a real vault is already resolved; a null vault here is the genuine
  // no-vault edge, shown with a neutral label (never a "…" that reads as a truncation bug, never a
  // fabricated name).
  const name = vault?.name ?? dl('Cofre', 'Vault')
  const thr = vault?.threshold ?? 2
  const n = vault?.total ?? 3
  const members = vault?.members ?? n
  const roster = vault?.member_list ?? []
  const addr = vault ? shortAddr(vault.orchard_address) : '-'

  // Balance - real when the wallet is wired; "-" when live-but-unwired or still loading.
  const hasBal = balance?.configured === true
  // Live but no wallet wired: show an explicit "not connected" state, never a dash veiled
  // behind the redaction tarja (the privacy gesture must never hide *nothing*).
  // Only claim "not connected" AFTER the balance actually loaded; while it is still syncing we show a
  // skeleton, never a false "not connected".
  const walletUnwired = isLive && !hasBal && balLoaded
  // The balance is still loading (live, but its first fetch/sync hasn't returned) - show the skeleton.
  const balLoading = loading || (isLive && !balLoaded)
  // Show a figure only when it is real (hasBal). Never fabricate a balance: while loading or
  // offline we show a neutral dash.
  const amt = hasBal ? fmt4(balance!.total_zec) : '-'

  // The desk: every OPEN proposal, ranked for THIS device (the rule lives in desk.ts). This
  // replaces the old "pick one" logic, which hid a ready-to-sign proposal behind any awaiting one,
  // ordered by array position rather than urgency, and said "needs you" to a member who had
  // already voted. Open proposals still hold funds, so they also feed the reserved KPI below.
  const desk = rankDesk(proposals, me, thr)
  const lead = desk.items[0] ?? null
  const queue = desk.items.slice(1, 1 + QUEUE_ROWS)
  const open = desk.items.map((i) => i.p)
  const leadExpiry = lead ? expiryLabel(lead.p.expiry_unix, t) : ''


  // Movements - the real ledger, or nothing at all.
  const movs: Movimento[] | null = ledger && ledger.length
    ? ledger.slice(0, 6).map((p) => ({
        date: fmtDate(p.created_at, dpt() ? 'pt-BR' : 'en'),
        title: p.memo || (p.kind === 'payroll' ? t('kind.payroll') : t('kind.payment')),
        by: t('dashboard.movBy', { proposer: p.proposer }) + (p.approvals.length ? t('dashboard.movApprovedBy', { who: p.approvals.join(', ') }) : ''),
        value: `−${fmt4(p.value_zec)}`,
        dir: 'out',
        status: p.state === 'sent' || p.state === 'confirmed' ? 'confirmado' : 'verificar',
      }))
    : null
  // A vault with an empty ledger (e.g. a fresh /net vault, no proposals yet) shows the empty state
  // below, never a fabricated movement.
  const movimentos: Movimento[] = movs ?? []

  // KPIs - all derived from real data (no fabrication). Reserved = funds committed by open
  // proposals (a product rule, not a protocol lock); Paid = settled outflow across the ledger.
  const parseZ = (s?: string) => { const n = parseFloat(s || ''); return isFinite(n) ? n : 0 }
  // Confirming = not-yet-spendable funds (still gathering the ~10 confirmations). Use the helper's
  // pending figure when present; otherwise derive it as total - spendable so the card never shows a
  // stray "+-".
  const pendZatNow = hasBal ? Math.max(0, parseZ(balance!.total_zec) - parseZ(balance!.spendable_zec)) : 0
  useEffect(() => {
    if (pendZatNow <= 0) { setNewestHeight(null); return }
    let on = true
    void getTransactions().then((txs) => {
      const h = txs?.[0]?.mined_height
      if (on && typeof h === 'number' && h > 0) setNewestHeight(h)
    })
    return () => { on = false }
  }, [pendZatNow])

  const pendNum = hasBal
    ? (balance!.pending_zec != null
        ? parseZ(balance!.pending_zec)
        : Math.max(0, parseZ(balance!.total_zec) - parseZ(balance!.spendable_zec)))
    : 0
  const settled = (ledger ?? []).filter((p) => p.state === 'sent' || p.state === 'confirmed')
  // Reserved = funds committed by every OPEN proposal (awaiting approval OR approved and awaiting
  // signing). An approved-not-yet-sent proposal still holds its funds; counting only `awaiting`
  // made the reservation vanish the moment quorum was reached.
  const reservedZec = open.reduce((a, p) => a + parseZ(p.value_zec), 0)
  const paidZec = settled.reduce((a, p) => a + parseZ(p.value_zec), 0)

  // The balance as a composition rather than one number. `free` is spendable MINUS what open
  // proposals already claim, which is the figure a treasurer is actually asking for: what can be
  // committed without double-committing (#293). Reserved is a product rule, not a protocol lock.
  // Integers all the way: the DTO carries zatoshi, and a proposal carries `value_zat`. Going via
  // the decimal strings would put money back through floating point, which is #303's whole point.
  const reservedZat = open.reduce((a, p) => a + p.value_zat, 0)
  const parts = hasBal && balance!.total_zat != null
    ? balanceParts(balance!.total_zat, balance!.spendable_zat ?? balance!.total_zat, reservedZat)
    : null
  // Who takes part, from the book. Approvals only - nothing records who SIGNED (#290), so a
  // "approved and signed" reading would be half invented.
  const part = participation(ledger ?? [], roster.map((m) => m.name))

  // Can this vault pay right now? Four conditions, every one from data already on this page. The
  // point is answering BEFORE the click what today could only be discovered after it.
  const seatsHere = bg.seatCount
  const quorumReachable = thr > 0 && seatsHere >= thr
  const hasFree = parts !== null && parts.freeZat > 0
  const backendsUp = isLive
  const canPay = quorumReachable && hasFree && backendsUp

  // Settled spend grouped by month (ascending, last 6). SpendBars self-hides below two periods.
  const byMonth = new Map<string, SpendPoint>()
  for (const p of settled) {
    if (!p.created_at) continue
    const d = new Date(p.created_at * 1000)
    const key = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`
    const label = d.toLocaleDateString(undefined, { month: 'short' })
    const cur = byMonth.get(key) ?? { label, zec: 0 }
    cur.zec += parseZ(p.value_zec)
    byMonth.set(key, cur)
  }
  const spendSeries: SpendPoint[] = Array.from(byMonth.entries())
    .sort((a, b) => (a[0] < b[0] ? -1 : 1))
    .slice(-6)
    .map(([, v]) => v)

  // USD estimate (opt-in). Only priceable when there is a real ZEC figure.
  const tip = hasBal ? balance!.chain_tip_height : undefined
  const confs = tip && newestHeight ? Math.max(0, tip - newestHeight + 1) : null
  const balZecNum = hasBal ? parseZ(balance!.total_zec) : undefined
  const usdBal = usdOn ? zecToUsd(balZecNum, rate) : null
  const usdPaid = usdOn ? zecToUsd(paidZec, rate) : null
  // "how fresh is the rate" label
  const rateAgo = (): string => {
    if (!rate) return ''
    const min = Math.floor((Date.now() - rate.at) / 60000)
    if (min < 1) return t('dashboard.agoNow')
    if (min < 60) return t('dashboard.agoMin', { n: min })
    return t('dashboard.agoHours', { n: Math.floor(min / 60) })
  }


  // #388: is this vault protected by S? The unlocked share carries it when secured. `undefined`
  // means unknown (no in-session unlocked share, e.g. a local/bridge vault) -> show no banner.
  const unlockedShare = vault ? getUnlockedShare(vault.id) : undefined
  const secured = unlockedShare ? unlockedShare.accessSecret != null : undefined

  // Nothing renders until the first full fetch is in - no half-built page with placeholders.
  if (!firstLoaded) {
    return <main className="page dash"><Loading /></main>
  }

  return (
    <>
      <main className="page dash">
        <PageHeader
          eyebrow={t('dashboard.collectiveVault')}
          title={name}
          subtitle={<>
            {tr('dashboard.vmetaPre')} · <span className="members-peek">
              <Link className="link" to="/members" aria-describedby={roster.length > 0 ? 'members-pop' : undefined}>{t('dashboard.membersCount', { n: members })}</Link>
              {roster.length > 0 && (
                <span className="members-pop" role="tooltip" id="members-pop">
                  <span className="members-pop-head">{t('dashboard.membersQuorum', { t: thr, n })}</span>
                  <span className="members-pop-list">
                    {roster.map((m) => (
                      <span className="members-pop-row" key={m.pubkey || m.name}>
                        <Identicon seed={m.pubkey || m.name} size={22} />
                        <span className="members-pop-name">{m.name}</span>
                        {m.name === creator && <span className="klab members-pop-tag creator">{t('members.creatorShort')}</span>}
                        {m.name === me && <span className="klab members-pop-tag">{t('members.youShort')}</span>}
                      </span>
                    ))}
                  </span>
                </span>
              )}
            </span>
            {live === true && <span className="livetag" title={t('dashboard.liveTitle')} aria-live="polite">{t('dashboard.live')}</span>}
          </>}
          actions={<Seal t={thr} n={n} />}
        />

        {secured === false && (
          <div className="dash-openwarn" role="alert">
            <span className="ow-ic" aria-hidden="true">⚠</span> {t('dashboard.openBanner')}
          </div>
        )}

        {/* 1+2 · The desk leads, the balance follows it on the right and stays there while the
            page scrolls - the two questions a treasurer asks in that order, side by side instead
            of stacked with the money below the fold. */}
        <div className="dash-cols">
          <div className="dash-main">
        {/* 1 · Your desk - every open proposal, ranked (desk.ts), action first */}
        {loading ? (
          <section className="needyou calm"><Loading /></section>
        ) : lead ? (
          <section className="needyou act">
            <div className="req">
              <span className={'stamp ' + STAMP_CLASS[lead.band]}>{t(stampKey(lead.band, desk.personal))}</span>
              <span className="desk-line">{t(lineKey(lead.band, desk.personal))}</span>
              {lead.last && <span className="desk-last">{t('desk.last')}</span>}
              {desk.open > 1 && <span className="desk-count">{t('desk.openCount', { n: desk.open })}</span>}
            </div>
            <div className="ny-body">
              <Identicon seed={lead.p.proposer} size={38} />
              <div className="ny-main">
                <div className="ny-amt"><Secret>{fmt4(lead.p.value_zec)}</Secret> <span className="dim small">ZEC</span></div>
                <div className="a-to">{tr('dashboard.memoProposedBy', { memo: whatOf(lead.p, t), proposer: lead.p.proposer })}</div>
                <div className="a-meta">
                  <span className="prog">{Array.from({ length: thr }, (_, i) => <i key={i} className={i < lead.p.approvals_count ? 'on' : ''} />)}</span>
                  <span>
                    {t('dashboard.ofApprovals', { count: lead.p.approvals_count, total: thr })}
                    {lead.last ? ` · ${t('desk.signSends')}` : ''}
                    {leadExpiry ? ` · ${leadExpiry}` : ''}
                  </span>
                </div>
              </div>
            </div>
            <div className="btns">
              {lead.band === 'sign' ? (
                <>
                  <button className="btn ok" onClick={() => openSigning(lead.p)}>
                    {lead.last ? t('desk.signAndSend') : t('dashboard.goSign')}
                  </button>
                  <Link className="btn ghost" to="/proposal" state={{ id: lead.p.id }}>{t('desk.view')}</Link>
                </>
              ) : lead.band === 'vote' ? (
                <Link className="btn ok" to="/proposal" state={{ id: lead.p.id }}>{t('dashboard.reviewVote')}</Link>
              ) : (
                <Link className="btn ghost" to="/proposal" state={{ id: lead.p.id }}>{t('desk.view')}</Link>
              )}
            </div>
            <div className="note">{t(NOTE_KEY[lead.band])}</div>

            {queue.length > 0 && (
              <div className="desk-queue">
                {queue.map((it) => {
                  const when = expiryLabel(it.p.expiry_unix, t)
                  return (
                    <Link className="desk-row" key={it.p.id} to="/proposal" state={{ id: it.p.id }}>
                      <span className={'stamp ' + STAMP_CLASS[it.band]}>{t(stampKey(it.band, desk.personal))}</span>
                      <span className="dq-amt"><Secret sm>{fmt4(it.p.value_zec)}</Secret> <span className="dim">ZEC</span></span>
                      <span className="dq-what">{whatOf(it.p, t)}</span>
                      <span className="prog sm">{Array.from({ length: thr }, (_, i) => <i key={i} className={i < it.p.approvals_count ? 'on' : ''} />)}</span>
                      <span className="dq-when">{when || t('dashboard.ofApprovals', { count: it.p.approvals_count, total: thr })}</span>
                      <span className="dq-go" aria-hidden="true">›</span>
                    </Link>
                  )
                })}
              </div>
            )}
            {desk.open > 1 + queue.length && (
              <Link className="desk-foot" to="/proposals">{t('desk.seeAll', { n: desk.open })}</Link>
            )}
          </section>
        ) : (
          <section className="needyou calm">
            <div className="req"><span className="stamp" aria-hidden="true">·</span> {t('dashboard.nothingWaiting')}</div>
            <div className="note">{t('dashboard.nothingWaitingNote')}</div>
            <div className="btns"><Link className="btn ok" to="/pay">{t('dashboard.proposePayment')}</Link></div>
          </section>
        )}

          {/* 3 · How the vault has been behaving. Two panels, one series each, one hue each. */}
          {!loading && (spendSeries.length >= 2 || part.considered > 0) && (
            <div className="dash-charts">
              {spendSeries.length >= 2 && (
                <section className="panel">
                  <h3>{t('dashboard.spendByMonth')}</h3>
                  <SpendBars data={spendSeries} />
                </section>
              )}
              {part.considered > 0 && (
                <section className="panel">
                  <h3>{t('dashboard.whoApproves')}</h3>
                  <span className="chartcap">{t('dashboard.lastNProposals', { n: part.considered })}</span>
                  <div className="prows">
                    {part.rows.map((r) => (
                      <div className="prow" key={r.name}>
                        <span className="pname">{r.name}</span>
                        <span className="trk"><span className="fil" style={{ width: `${r.pct}%` }} /></span>
                        <span className="pn num">{r.approved}/{part.considered}</span>
                      </div>
                    ))}
                  </div>
                  {/* Says approvals, not signatures, because nothing records who signed (#290). */}
                  <p className="cap">{t('dashboard.whoApprovesNote')}</p>
                </section>
              )}
            </div>
          )}

          {/* 4 · History, as a table: four aligned columns read better than loose rows. */}
          <section className="ledger">
            <div className="ledger-head">
              <h2 className="klab">{t('dashboard.movements')}</h2>
              <span className="cap">{t('dashboard.movementsCap')}</span>
            </div>
            {loading && <SkeletonRows n={4} />}
            {!loading && movimentos.length === 0 && (
              <div className="cap">{t('dashboard.noMovements')}</div>
            )}
            {!loading && movimentos.length > 0 && (
              <div className="tblwrap">
                <table className="movtbl">
                  <thead>
                    <tr>
                      <th>{t('dashboard.colDate')}</th>
                      <th>{t('dashboard.colWhat')}</th>
                      <th>{t('dashboard.colWho')}</th>
                      <th className="n">{t('dashboard.colValue')}</th>
                      <th>{t('dashboard.colState')}</th>
                    </tr>
                  </thead>
                  <tbody>
                    {movimentos.map((m, i) => (
                      <tr key={i}>
                        <td className="n dt">{m.date}</td>
                        <td className="what">{m.title}</td>
                        <td className="who">{m.by}</td>
                        <td className="n"><Secret sm><span>{m.value}</span></Secret></td>
                        <td>{m.status === 'verificar'
                          ? <Link className="chip pend" to="/ledger">{t('dashboard.verify')}</Link>
                          : <span className="chip ok">{t('dashboard.confirmed')}</span>}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </section>

          </div>

          <aside className="dash-aside">
        {/* 2a · Can this vault pay right now? Answering it here is the point: every condition below
            was previously discovered only AFTER proposing, approving, signing and waiting. */}
        {!loading && (
          <section className={'ready ' + (canPay ? 'ok' : 'not')}>
            <div className="ready-top">
              <span className="ready-dot" aria-hidden="true" />
              <b>{canPay ? t('dashboard.readyYes') : t('dashboard.readyNo')}</b>
            </div>
            <span className={'chk ' + (quorumReachable ? 'y' : 'n')}>
              <span className="m" aria-hidden="true">{quorumReachable ? '✓' : '!'}</span>
              <span>{t('dashboard.readySeats', { present: seatsHere, threshold: thr })}</span>
            </span>
            <span className={'chk ' + (hasFree ? 'y' : 'n')}>
              <span className="m" aria-hidden="true">{hasFree ? '✓' : '!'}</span>
              <span>{hasFree
                ? tr('dashboard.readyFree', { amt: fmt4(String((parts?.freeZat ?? 0) / 1e8)) })
                : t('dashboard.readyNoFree')}</span>
            </span>
            <span className={'chk ' + (backendsUp ? 'y' : 'n')}>
              <span className="m" aria-hidden="true">{backendsUp ? '✓' : '!'}</span>
              <span>{backendsUp ? t('dashboard.readyBackends') : t('dashboard.readyBackendsDown')}</span>
            </span>
          </section>
        )}

        {/* 2 · Saldo */}
        <section className="entry">
          <div className="entry-top">
            <h2 className="klab">{t('dashboard.vaultBalance')}</h2>
            <RevealButton />
          </div>
          {balLoading ? (
            <SkeletonStat />
          ) : walletUnwired ? (
            <div className="fig">
              <span className="amt" style={{ fontSize: '17px', letterSpacing: '.02em', color: 'var(--text-muted)' }}>
                {t('dashboard.walletNotConnected')}
              </span>
            </div>
          ) : (
            <>
              <div className="fig">
                <Secret><span className="amt">{amt}</span></Secret>
                <span className="unit">ZEC</span>
              </div>
              {/* The balance as a composition. Free is what can be committed WITHOUT
                  double-committing: spendable minus what open proposals already claim. Every
                  segment carries its own value, so identity never rests on colour alone. */}
              {parts && parts.totalZat > 0 && (
                <div className="bal-comp">
                  <div className="comp" role="img"
                    aria-label={t('dashboard.compAria', {
                      free: fmt4(String(parts.freeZat / 1e8)),
                      reserved: fmt4(String(parts.reservedZat / 1e8)),
                      confirming: fmt4(String(parts.confirmingZat / 1e8)),
                    })}>
                    {parts.pct.free > 0 && <span className="c-free" style={{ width: `${parts.pct.free}%` }} />}
                    {parts.pct.reserved > 0 && <span className="c-res" style={{ width: `${parts.pct.reserved}%` }} />}
                    {parts.pct.confirming > 0 && <span className="c-conf" style={{ width: `${parts.pct.confirming}%` }} />}
                  </div>
                  <div className="comp-legend">
                    <span className="cl"><i className="c-free" /> {t('dashboard.compFree')}
                      <b><Secret sm>{fmt4(String(parts.freeZat / 1e8))}</Secret></b></span>
                    {parts.reservedZat > 0 && (
                      <span className="cl"><i className="c-res" /> {t('dashboard.compReserved')}
                        <b><Secret sm>{fmt4(String(parts.reservedZat / 1e8))}</Secret></b></span>
                    )}
                    {parts.confirmingZat > 0 && (
                      <span className="cl"><i className="c-conf" /> {t('dashboard.compConfirming')}
                        <b><Secret sm>{fmt4(String(parts.confirmingZat / 1e8))}</Secret></b></span>
                    )}
                  </div>
                  {parts.overCommitted && (
                    <div className="hint warn sm" role="status">{t('dashboard.overCommitted')}</div>
                  )}
                </div>
              )}
              {pendNum > 0 && (
                <div className="breakdown">
                  {/* The amount already sits in the composition legend above; repeating it here
                      just made the same number appear twice. What this line adds is the WAIT: how
                      far the chain has buried it and how far there is to go. */}
                  {!parts && <span className="pd">{t('dashboard.confirming', { amt: `+${fmt4(String(pendNum))}` })}</span>}
                  {parts && <span className="pd">{t('dashboard.spendableIn')}</span>}
                  {/* A count, not a promise. The vault decides when a note is spendable; this only
                      shows how far the chain has buried it, so the wait stops being a blank pause.
                      The bar can fill early for change, which the wallet clears at three - the truth
                      is the pending line disappearing, and it disappears the moment that happens. */}
                  {confs !== null && (
                    <span className="confbar" role="status"
                      aria-label={t('dashboard.confirmProgress', { n: Math.min(confs, CONFIRMATIONS_UNTRUSTED), of: CONFIRMATIONS_UNTRUSTED })}>
                      <span className="confbar-track">
                        <span className="confbar-fill" style={{ width: `${Math.min(100, (confs / CONFIRMATIONS_UNTRUSTED) * 100)}%` }} />
                      </span>
                      <span className="confbar-n num">{Math.min(confs, CONFIRMATIONS_UNTRUSTED)}/{CONFIRMATIONS_UNTRUSTED}</span>
                    </span>
                  )}
                </div>
              )}
              <div className="usd">
                {usdOn ? (
                  <>
                    <span className="usd-v">≈ <Secret sm><b>{usdBal ?? '-'}</b></Secret></span>
                    <span className="usd-src">{rate
                      ? `${rate.source} · ${rateAgo()}${rateIsStale(rate) ? ` · ${t('dashboard.rateStale')}` : ''}`
                      : t('dashboard.rateNone')}</span>
                    <button type="button" className="linkbtn" onClick={() => void refreshRate()} disabled={rateBusy}>
                      {rateBusy ? t('dashboard.updating') : t('dashboard.refresh')}
                    </button>
                  </>
                ) : (
                  <button type="button" className="linkbtn" onClick={enableUsd} title={t('dashboard.usdDisclosure')}>
                    {t('dashboard.showUsd')}
                  </button>
                )}
              </div>
            </>
          )}
          {walletUnwired && <div className="breakdown"><span className="dim small">{t('dashboard.walletNotConnectedNote')}</span></div>}
          <div className="receive">
            <span className="klab plain">{t('dashboard.receiveIn')}</span>
            <code>{addr}</code>
            <span className="orchard">
              <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M12 2.5 4.5 5.5v6c0 5 3.4 8.4 7.5 9.9 4.1-1.5 7.5-4.9 7.5-9.9v-6L12 2.5Z" /></svg>
              {t('dashboard.orchardOnly')}
            </span>
          </div>
        </section>

        {/* 2c · Acting on a balance happens next to the balance, not in a band further down. */}
        <div className="aside-acts">
          <Link className="btn ok" to="/pay">{t('dashboard.actPayTitle')}</Link>
          <Link className="btn ghost" to="/payroll">{t('dashboard.actPayrollTitle')}</Link>
        </div>

        {/* 2b · KPIs - vault figures, all derived from real data */}
        {!loading && (
          <section className="kpis">
            <div className="kpi">
              <span className="kpi-k klab">{t('dashboard.kpiOpen')}</span>
              <span className="kpi-v">{open.length}</span>
            </div>
            <div className="kpi">
              <span className="kpi-k klab">{t('dashboard.kpiReserved')}</span>
              <span className="kpi-v"><Secret sm><b>{fmt4(String(reservedZec))}</b></Secret> <span className="kpi-u">ZEC</span></span>
            </div>
            <div className="kpi">
              <span className="kpi-k klab">{t('dashboard.kpiPaid')}</span>
              <span className="kpi-v"><Secret sm><b>{fmt4(String(paidZec))}</b></Secret> <span className="kpi-u">ZEC</span></span>
              {usdPaid && <span className="kpi-sub">≈ {usdPaid}</span>}
            </div>
          </section>
        )}
          </aside>
        </div>

      </main>

    </>
  )
}
