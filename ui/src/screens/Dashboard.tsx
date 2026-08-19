import { useEffect, useState } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import { Seal, Secret, RevealButton, Loading } from '../components'
import { SkeletonStat, SkeletonRows } from '../skeleton'
import { SpendBars, type SpendPoint } from '../charts'
import { PageHeader } from '../page'
import { Identicon } from '../avatar'
import { fmtZec as fmt4, expiryLabel, fmtDate } from '../format'
import { usdEnabled, setUsdEnabled, cachedRate, rateIsStale, fetchRate, zecToUsd, type Rate } from '../price'
import { useT, useTr } from '../i18n'
import {
  getVault, getProposals, getBalance, getLedger, health, shortAddr, isVaultUnlocked, IS_DEMO,
  type Vault, type Proposal, type Balance,
} from '../api'

type Movimento = { date: string; title: string; by?: string; value: string; dir: 'out' | 'in'; status: string }

// Offline placeholder (only shown when there is no ledger - the demo and the live app both use
// the real ledger). Locale-aware so it never shows PT copy in the EN interface. `dl` reads the
// persisted locale per access; the getters re-resolve when the language toggles.
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
const MOVIMENTOS_MOCK: Movimento[] = [
  {
    date: '28/04',
    get title() { return dl('Folha de abril · 8 pagamentos', 'April payroll · 8 payments') },
    get by() { return dl('prop. Ana · aprov. Ana, Bruno', 'by Ana · approved Ana, Bruno') },
    value: '−4.2000',
    dir: 'out',
    status: 'verificar', // stable key: the label is translated at render via t()
  },
  {
    date: '22/04',
    get title() { return dl('Doação recebida', 'Donation received') },
    get by() { return dl('de contribuinte anônimo', 'from an anonymous contributor') },
    value: '+1.0000',
    dir: 'in',
    status: 'confirmado', // stable key
  },
]


export default function Dashboard() {
  const t = useT()
  const tr = useTr()
  const nav = useNavigate()
  const [vault, setVault] = useState<Vault | null>(null)
  const [proposals, setProposals] = useState<Proposal[]>([])
  const [ledger, setLedger] = useState<Proposal[] | null>(null)
  const [balance, setBalance] = useState<Balance | null>(null)
  const [live, setLive] = useState<boolean | null>(null)
  const [rate, setRate] = useState<Rate | null>(cachedRate())
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
    void (async () => {
      const ok = await health()
      if (!on) return
      setLive(ok)
      if (!ok && !IS_DEMO) return
      const v = await getVault()
      if (!on) return
      // Locked vault not unlocked this session → send back to unlock (§ passphrase).
      if (v?.locked && !isVaultUnlocked(v.id)) { nav('/vaults'); return }
      if (v) setVault(v)
      const [ps, b, l] = await Promise.all([getProposals(), getBalance(), getLedger()])
      if (!on) return
      if (ps) setProposals(ps)
      if (b) setBalance(b)
      if (l) setLedger(l)
    })()
    return () => { on = false }
  }, [])

  const isLive = live === true
  const loading = live === null // initial fetch still in flight

  // Vault header - real vault from the bridge; placeholder only in the offline showcase.
  const name = vault?.name ?? dl('Tesouraria Comum', 'Common Treasury')
  const thr = vault?.threshold ?? 2
  const n = vault?.total ?? 3
  const members = vault?.members ?? n
  const addr = vault ? shortAddr(vault.orchard_address) : 'u1vjgx…d406dr'

  // Balance - real when the wallet is wired; "-" when live-but-unwired; mock when offline.
  const hasBal = balance?.configured === true
  // Live but no wallet wired: show an explicit "not connected" state, never a dash veiled
  // behind the redaction tarja (the privacy gesture must never hide *nothing*).
  const walletUnwired = isLive && !hasBal
  // Show a figure only when it is real (hasBal) or genuinely offline-demo (live === false).
  // While still loading (live === null) show a neutral dash, never a fabricated balance.
  const amt = hasBal ? fmt4(balance!.total_zec) : (live === false ? '2.4180' : '-')
  const confirmado = hasBal ? fmt4(balance!.spendable_zec) : (live === false ? '2.4180' : '-')
  const pendente = hasBal ? `+${fmt4(balance!.pending_zec)}` : (live === false ? '+0.0100' : '-')

  // Pending approval - first awaiting proposal. When live with none, show an empty state
  // instead of a fabricated card.
  const awaiting = proposals.filter((p) => p.state === 'awaiting')
  const pending = awaiting[0] ?? null
  // Show the (mock) approval card only when genuinely offline; during load (live === null) wait
  // for real proposals instead of flashing a fabricated one.
  const showApprovalCard = live === false || pending !== null
  const pAmt = pending ? fmt4(pending.value_zec, '0.0003') : '0.5000'
  const pMemo = pending?.memo ?? dl('adiantamento de maio', 'May advance')
  const pProposer = pending?.proposer ?? 'Bruno'
  const pApprovals = pending?.approvals_count ?? 1
  const pExpiry = pending ? expiryLabel(pending.expiry_unix, t) : t('expiry.hours', { h: 71 })

  // Movements - the real ledger when live; the mock only in the offline showcase.
  const movs: Movimento[] | null = ledger && ledger.length
    ? ledger.slice(0, 6).map((p) => ({
        date: fmtDate(p.created_at),
        title: p.memo || (p.kind === 'payroll' ? t('kind.payroll') : t('kind.payment')),
        by: t('dashboard.movBy', { proposer: p.proposer }) + (p.approvals.length ? t('dashboard.movApprovedBy', { who: p.approvals.join(', ') }) : ''),
        value: `−${fmt4(p.value_zec)}`,
        dir: 'out',
        status: p.state === 'sent' || p.state === 'confirmed' ? 'confirmado' : 'verificar',
      }))
    : null
  // Real ledger when there is one; the mock showcase ONLY when genuinely offline/demo. A LIVE vault
  // with an empty ledger (e.g. a fresh /net vault, no proposals yet) shows no movements, not mock.
  const movimentos: Movimento[] = movs ?? (live === false || IS_DEMO ? MOVIMENTOS_MOCK : [])

  // KPIs - all derived from real data (no fabrication). Reserved = funds committed by open
  // proposals (a product rule, not a protocol lock); Paid = settled outflow across the ledger.
  const parseZ = (s?: string) => { const n = parseFloat(s || ''); return isFinite(n) ? n : 0 }
  const settled = (ledger ?? []).filter((p) => p.state === 'sent' || p.state === 'confirmed')
  const reservedZec = awaiting.reduce((a, p) => a + parseZ(p.value_zec), 0)
  const paidZec = settled.reduce((a, p) => a + parseZ(p.value_zec), 0)

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

  // USD estimate (opt-in). Only priceable when there is a real or offline-demo ZEC figure.
  const balZecNum = hasBal ? parseZ(balance!.total_zec) : (live === false ? 2.418 : undefined)
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


  return (
    <>
      <main className="page dash">
        <PageHeader
          eyebrow={t('dashboard.collectiveVault')}
          title={name}
          subtitle={<>
            {tr('dashboard.vmetaPre')} · <Link className="link" to="/members">{t('dashboard.membersCount', { n: members })}</Link>
            {live === true && <span className="livetag" title={t('dashboard.liveTitle')} aria-live="polite">{t('dashboard.live')}</span>}
            {live === false && <span className="livetag off" title={t('dashboard.demoTitle')} aria-live="polite">{t('dashboard.demo')}</span>}
          </>}
          actions={<Seal t={thr} n={n} />}
        />

        {/* 1 · What needs you - the action first */}
        {loading ? (
          <section className="needyou calm"><Loading /></section>
        ) : showApprovalCard ? (
          <section className="needyou act">
            <div className="req"><span className="stamp">{t('stamp.awaiting')}</span> {t('dashboard.needsYou')}{isLive && awaiting.length > 1 ? t('dashboard.awaitingSuffix', { n: awaiting.length }) : ''}</div>
            <div className="ny-body">
              <Identicon seed={pProposer} size={38} />
              <div className="ny-main">
                <div className="ny-amt">{pAmt} <span className="dim small">ZEC</span></div>
                <div className="a-to">{tr('dashboard.memoProposedBy', { memo: pMemo, proposer: pProposer })}</div>
                <div className="a-meta">
                  <span className="prog">{Array.from({ length: thr }, (_, i) => <i key={i} className={i < pApprovals ? 'on' : ''} />)}</span>
                  <span>{t('dashboard.ofApprovals', { count: pApprovals, total: thr })}{pExpiry ? ` · ${pExpiry}` : ''}</span>
                </div>
              </div>
            </div>
            <div className="btns">
              <Link className="btn ok" to="/proposal" state={pending ? { id: pending.id } : undefined}>{t('dashboard.reviewVote')}</Link>
            </div>
            <div className="note">{t('dashboard.chooseWhoNote')}</div>
          </section>
        ) : (
          <section className="needyou calm">
            <div className="req"><span className="stamp" aria-hidden="true">·</span> {t('dashboard.nothingWaiting')}</div>
            <div className="note">{t('dashboard.nothingWaitingNote')}</div>
            <div className="btns"><Link className="btn ok" to="/pay">{t('dashboard.proposePayment')}</Link></div>
          </section>
        )}

        {/* 2 · Saldo */}
        <section className="entry">
          <div className="entry-top">
            <h2 className="klab">{t('dashboard.vaultBalance')}</h2>
            <RevealButton />
          </div>
          {loading ? (
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
              <div className="breakdown">
                <span>{t('dashboard.confirmedLower')} <Secret sm><b>{confirmado}</b></Secret></span>
                <span className="pd">{t('dashboard.pendingLower')} <Secret sm><b>{pendente}</b></Secret></span>
              </div>
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

        {/* 2b · KPIs - vault figures, all derived from real data */}
        {!loading && (
          <section className="kpis">
            <div className="kpi">
              <span className="kpi-k klab">{t('dashboard.kpiOpen')}</span>
              <span className="kpi-v mono">{awaiting.length}</span>
            </div>
            <div className="kpi">
              <span className="kpi-k klab">{t('dashboard.kpiReserved')}</span>
              <span className="kpi-v mono"><Secret sm><b>{fmt4(String(reservedZec))}</b></Secret> <span className="kpi-u">ZEC</span></span>
            </div>
            <div className="kpi">
              <span className="kpi-k klab">{t('dashboard.kpiPaid')}</span>
              <span className="kpi-v mono"><Secret sm><b>{fmt4(String(paidZec))}</b></Secret> <span className="kpi-u">ZEC</span></span>
              {usdPaid && <span className="kpi-sub">≈ {usdPaid}</span>}
            </div>
          </section>
        )}

        {/* 3 · Primary actions (section nav lives in the rail) */}
        <section className="actions">
          <Link className="action" to="/pay">
            <span className="ico"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8"><path d="M12 5v14M5 12h14" /></svg></span>
            <div className="action-main"><h3>{t('dashboard.actPayTitle')}</h3><p>{t('dashboard.actPayDesc')}</p></div>
            <span className="go">→</span>
          </Link>
          <Link className="action" to="/payroll">
            <span className="ico"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8"><path d="M4 7h16M4 12h16M4 17h10" /></svg></span>
            <div className="action-main"><h3>{t('dashboard.actPayrollTitle')}</h3><p>{t('dashboard.actPayrollDesc')}</p></div>
            <span className="go">→</span>
          </Link>
        </section>

        {/* 4 · History */}
        <section className="ledger">
          <h2 className="klab">{t('dashboard.movements')}</h2>
          <div className="cap">{t('dashboard.movementsCap')}</div>
          {!loading && spendSeries.length >= 2 && (
            <div className="spendwrap">
              <div className="klab plain">{t('dashboard.spendByMonth')}</div>
              <SpendBars data={spendSeries} />
            </div>
          )}
          {loading && <SkeletonRows n={4} />}
          {!loading && movimentos.length === 0 && (
            <div className="cap">{t('dashboard.noMovements')}</div>
          )}
          {!loading && movimentos.map((m, i) => (
            <div className="lrow" key={i}>
              <div className="ldate">{m.date}</div>
              <div className="ldesc">
                <div className="t">{m.title}</div>
                {m.by && <div className="by">{m.by}</div>}
              </div>
              <div className={'lval ' + m.dir}>
                <Secret sm><span>{m.value}</span></Secret>
                <div className="st">{m.status === 'verificar' ? <Link className="link" to="/ledger">{t('dashboard.verify')}</Link> : t('dashboard.confirmed')}</div>
              </div>
            </div>
          ))}
        </section>

      </main>

    </>
  )
}
