import { useEffect, useState } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import { Dialog, Seal, Secret, RevealButton } from '../components'
import { Identicon } from '../avatar'
import { fmtZec as fmt4, expiryLabel, fmtDate } from '../format'
import { useT, useTr } from '../i18n'
import {
  getVault, getProposals, getBalance, getLedger, health, shortAddr, isVaultUnlocked,
  deleteVault, clearSelectedVault,
  type Vault, type Proposal, type Balance,
} from '../api'

type Movimento = { date: string; title: string; by?: string; value: string; dir: 'out' | 'in'; status: string }

// Offline placeholder (only shown in the hosted mock showcase; the live app uses the ledger).
const MOVIMENTOS_MOCK: Movimento[] = [
  { date: '28/04', title: 'Folha de abril — 8 pagamentos', by: 'prop. Ana · aprov. Ana, Bruno', value: '−4.2000', dir: 'out', status: 'verificar' },
  { date: '22/04', title: 'Doação recebida', by: 'de contribuinte anônimo', value: '+1.0000', dir: 'in', status: 'confirmado' },
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
  const [showDelete, setShowDelete] = useState(false)
  const [delPass, setDelPass] = useState('')
  const [delName, setDelName] = useState('')
  const [delErr, setDelErr] = useState<string | null>(null)
  const [delBusy, setDelBusy] = useState(false)

  useEffect(() => {
    let on = true
    void (async () => {
      const ok = await health()
      if (!on) return
      setLive(ok)
      if (!ok) return
      const v = await getVault()
      if (!on) return
      // Locked vault not unlocked this session → send back to unlock (§ passphrase).
      if (v?.locked && !isVaultUnlocked(v.id)) { nav('/'); return }
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

  // Vault header — real vault from the bridge; placeholder only in the offline showcase.
  const name = vault?.name ?? 'Tesouraria Comum'
  const thr = vault?.threshold ?? 2
  const n = vault?.total ?? 3
  const members = vault?.members ?? n
  const addr = vault ? shortAddr(vault.orchard_address) : 'u1vjgx…d406dr'

  // Balance — real when the wallet is wired; "—" when live-but-unwired; mock when offline.
  const hasBal = balance?.configured === true
  // Live but no wallet wired: show an explicit "not connected" state, never a dash veiled
  // behind the redaction tarja (the privacy gesture must never hide *nothing*).
  const walletUnwired = isLive && !hasBal
  const amt = hasBal ? fmt4(balance!.total_zec) : (isLive ? '—' : '2.4180')
  const confirmado = hasBal ? fmt4(balance!.spendable_zec) : (isLive ? '—' : '2.4180')
  const pendente = hasBal ? `+${fmt4(balance!.pending_zec)}` : (isLive ? '—' : '+0.0100')

  // Pending approval — first awaiting proposal. When live with none, show an empty state
  // instead of a fabricated card.
  const awaiting = proposals.filter((p) => p.state === 'awaiting')
  const pending = awaiting[0] ?? null
  const showApprovalCard = !isLive || pending !== null
  const pAmt = pending ? fmt4(pending.value_zec, '0.0003') : '0.5000'
  const pMemo = pending?.memo ?? 'adiantamento maio'
  const pProposer = pending?.proposer ?? 'Bruno'
  const pApprovals = pending?.approvals_count ?? 1
  const pExpiry = pending ? expiryLabel(pending.expiry_unix, t) : t('expiry.hours', { h: 71 })

  // Movements — the real ledger when live; the mock only in the offline showcase.
  const movs: Movimento[] | null = isLive && ledger
    ? ledger.slice(0, 6).map((p) => ({
        date: fmtDate(p.created_at),
        title: p.memo || (p.kind === 'payroll' ? t('kind.payroll') : t('kind.payment')),
        by: t('dashboard.movBy', { proposer: p.proposer }) + (p.approvals.length ? t('dashboard.movApprovedBy', { who: p.approvals.join(', ') }) : ''),
        value: `−${fmt4(p.value_zec)}`,
        dir: 'out',
        status: p.state === 'sent' || p.state === 'confirmed' ? 'confirmado' : 'verificar',
      }))
    : null
  const movimentos = movs ?? MOVIMENTOS_MOCK

  // Delete flow (local only). Locked vaults require the word; unlocked ones require
  // typing the vault name. If this device sees a spendable balance, warn hard.
  const locked = vault?.locked === true
  const seesFunds = hasBal && Number(balance?.total_zat ?? 0) > 0
  const canDelete = locked ? delPass.length > 0 : delName.trim() === name
  async function doDelete() {
    setDelBusy(true); setDelErr(null)
    const r = await deleteVault(locked ? delPass : undefined, locked ? undefined : delName.trim())
    setDelBusy(false)
    if (r.ok) { clearSelectedVault(); nav('/') }
    else setDelErr(r.wrong ? t('dashboard.delWrong') : t('dashboard.delFail'))
  }

  return (
    <>
      <main className="page dash">
        <div className="title-row">
          <div>
            <span className="klab">{t('dashboard.collectiveVault')}</span>
            <h1 className="h1">{name}</h1>
            <div className="vmeta">
              {tr('dashboard.vmetaPre')} · <Link className="link" to="/members">{t('dashboard.membersCount', { n: members })}</Link>
              {live === true && <span className="livetag" title={t('dashboard.liveTitle')} aria-live="polite">{t('dashboard.live')}</span>}
              {live === false && <span className="livetag off" title={t('dashboard.demoTitle')} aria-live="polite">{t('dashboard.demo')}</span>}
            </div>
          </div>
          <Seal t={thr} n={n} />
        </div>

        {/* 1 · O que precisa de você — a ação primeiro */}
        {showApprovalCard ? (
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
            <div className="req"><span className="stamp">—</span> {t('dashboard.nothingWaiting')}</div>
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
          {walletUnwired ? (
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

        {/* 3 · Ações primárias (a navegação de seções vive no rail) */}
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

        {/* 4 · Histórico */}
        <section className="ledger">
          <h2 className="klab">{t('dashboard.movements')}</h2>
          <div className="cap">{t('dashboard.movementsCap')}</div>
          {movimentos.length === 0 && (
            <div className="cap">{t('dashboard.noMovements')}</div>
          )}
          {movimentos.map((m, i) => (
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

        {/* Zona de perigo */}
        <section className="danger-zone">
          <h2 className="klab danger-lab">{t('dashboard.dangerZone')}</h2>
          <div className="danger-body">
            <div>
              <div className="danger-t">{t('dashboard.deleteThisVault')}</div>
              <div className="danger-d">{t('dashboard.deleteThisVaultDesc')}</div>
            </div>
            <button className="btn danger-btn" onClick={() => { setShowDelete(true); setDelErr(null); setDelPass(''); setDelName('') }}>{t('dashboard.deleteVault')}</button>
          </div>
        </section>
      </main>

      {showDelete && (
        <Dialog className="modal-overlay" cardClassName="modal-card danger" labelledBy="delete-title" onClose={() => setShowDelete(false)}>
            <span className="klab danger-lab">{t('dashboard.deleteVault')}</span>
            <h2 id="delete-title" className="modal-h">{tr('dashboard.deleteConfirmTitle', { name })}</h2>
            <p className="modal-p">{tr('dashboard.deleteConfirmBody')}</p>

            <div className="danger-funds">
              {tr('dashboard.deleteFundsWarn')}
              {seesFunds && <div className="mt-xs">{tr('dashboard.deleteSeesFunds', { amt: fmt4(balance?.total_zec) })}</div>}
            </div>
            <div className="hint">{t('dashboard.deleteLocalHint')}</div>

            {locked ? (
              <label className="field mt"><span>{t('dashboard.deleteTypeWord')}</span>
                <input className="input" type="password" value={delPass} onChange={(e) => setDelPass(e.target.value)}
                  onKeyDown={(e) => { if (e.key === 'Enter' && canDelete) void doDelete() }} autoFocus />
              </label>
            ) : (
              <label className="field mt"><span>{tr('dashboard.deleteTypeName', { name })}</span>
                <input className="input" value={delName} onChange={(e) => setDelName(e.target.value)} placeholder={name}
                  onKeyDown={(e) => { if (e.key === 'Enter' && canDelete) void doDelete() }} autoFocus />
              </label>
            )}
            {delErr && <div className="hint err mt" role="alert">✗ {delErr}</div>}

            <div className="btns right mt">
              <button className="btn ghost" onClick={() => setShowDelete(false)}>{t('common.cancel')}</button>
              <button className="btn danger-btn" onClick={() => void doDelete()} disabled={delBusy || !canDelete}>
                {delBusy ? t('dashboard.deleting') : t('dashboard.deletePermanently')}
              </button>
            </div>
        </Dialog>
      )}
    </>
  )
}
