import { useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import { Letterhead, Seal, Secret, RevealButton } from '../components'
import {
  getVault, getProposals, getBalance, getLedger, health, shortAddr,
  type Vault, type Proposal, type Balance,
} from '../api'

type Movimento = { date: string; title: string; by?: string; value: string; dir: 'out' | 'in'; status: string }

// Offline placeholder (only shown in the hosted mock showcase; the live app uses the ledger).
const MOVIMENTOS_MOCK: Movimento[] = [
  { date: '28/04', title: 'Folha de abril — 8 pagamentos', by: 'prop. Ana · aprov. Ana, Bruno', value: '−4.2000', dir: 'out', status: 'verificar' },
  { date: '22/04', title: 'Doação recebida', by: 'de contribuinte anônimo', value: '+1.0000', dir: 'in', status: 'confirmado' },
]

function fmt4(zec?: string, fallback = ''): string {
  if (!zec) return fallback
  const n = Number(zec)
  return Number.isFinite(n) ? n.toFixed(4) : fallback
}

function expiryLabel(unix?: number): string {
  if (!unix) return ''
  const ms = unix * 1000 - Date.now()
  if (ms <= 0) return 'expirada'
  const h = Math.floor(ms / 3_600_000)
  return h < 48 ? `expira em ${h}h` : `expira em ${Math.floor(h / 24)}d`
}

function dateFromExpiry(unix?: number): string {
  if (!unix) return '—'
  const d = new Date((unix - 72 * 3600) * 1000)
  return `${String(d.getDate()).padStart(2, '0')}/${String(d.getMonth() + 1).padStart(2, '0')}`
}

export default function Painel() {
  const [vault, setVault] = useState<Vault | null>(null)
  const [proposals, setProposals] = useState<Proposal[]>([])
  const [ledger, setLedger] = useState<Proposal[] | null>(null)
  const [balance, setBalance] = useState<Balance | null>(null)
  const [live, setLive] = useState<boolean | null>(null)

  useEffect(() => {
    let on = true
    void (async () => {
      const ok = await health()
      if (!on) return
      setLive(ok)
      if (!ok) return
      const [v, ps, b, l] = await Promise.all([getVault(), getProposals(), getBalance(), getLedger()])
      if (!on) return
      if (v) setVault(v)
      if (ps) setProposals(ps)
      if (b) setBalance(b)
      if (l) setLedger(l)
    })()
    return () => { on = false }
  }, [])

  const isLive = live === true

  // Vault header — real vault from the bridge; placeholder only in the offline showcase.
  const name = vault?.name ?? 'Tesouraria Comum'
  const t = vault?.threshold ?? 2
  const n = vault?.total ?? 3
  const members = vault?.members ?? n
  const addr = vault ? shortAddr(vault.orchard_address) : 'u1vjgx…d406dr'

  // Balance — real when the wallet is wired; "—" when live-but-unwired; mock when offline.
  const hasBal = balance?.configured === true
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
  const pExpiry = pending ? expiryLabel(pending.expiry_unix) : 'expira em 71h'

  // Movements — the real ledger when live; the mock only in the offline showcase.
  const movs: Movimento[] | null = isLive && ledger
    ? ledger.slice(0, 6).map((p) => ({
        date: dateFromExpiry(p.expiry_unix),
        title: p.memo || (p.kind === 'payroll' ? 'Folha de pagamento' : 'Pagamento'),
        by: `prop. ${p.proposer}${p.approvals.length ? ` · aprov. ${p.approvals.join(', ')}` : ''}`,
        value: `−${fmt4(p.value_zec)}`,
        dir: 'out',
        status: p.state === 'sent' || p.state === 'confirmed' ? 'confirmado' : 'verificar',
      }))
    : null
  const movimentos = movs ?? MOVIMENTOS_MOCK

  const acoes: [string, string, string, string][] = [
    ['01', 'Novo pagamento', 'um destino', '/pagar'],
    ['02', 'Nova folha', 'N destinos, 1 aprovação', '/folha'],
    ['03', 'Propostas', `${isLive ? awaiting.length : 1} aguardando`, '/proposta'],
    ['04', 'Razão / contas', 'entregar ao contador', '/razao'],
    ['05', 'Beneficiários', 'agenda de quem recebe', '/beneficiarios'],
  ]

  return (
    <>
      <Letterhead right={<button className="switch">COFRE · <b>{name}</b> ▾</button>} />
      <div className="page">
        <div className="title-row">
          <div>
            <span className="klab">Cofre coletivo · quórum</span>
            <h1 className="h1">{name}</h1>
            <div className="vmeta">
              Privado por fora · <b>transparente por dentro</b> · <Link className="link" to="/membros">{members} membros</Link>
              {live === true && <span className="livetag" title="Conectado ao cofre local">● ao vivo</span>}
              {live === false && <span className="livetag off" title="Bridge local não encontrada">○ demonstração</span>}
            </div>
          </div>
          <Seal t={t} n={n} />
        </div>

        <section className="entry">
          <div className="entry-top">
            <span className="klab">Saldo do cofre</span>
            <RevealButton />
          </div>
          <div className="fig">
            <Secret><span className="amt">{amt}</span></Secret>
            <span className="unit">ZEC</span>
          </div>
          <div className="breakdown">
            <span>confirmado <Secret sm><b>{confirmado}</b></Secret></span>
            <span className="pd">pendente <Secret sm><b>{pendente}</b></Secret></span>
          </div>
          <div className="receive">
            <span className="klab plain">Receber em</span>
            <code>{addr}</code>
            <span className="orchard">
              <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M12 2.5 4.5 5.5v6c0 5 3.4 8.4 7.5 9.9 4.1-1.5 7.5-4.9 7.5-9.9v-6L12 2.5Z" /></svg>
              SÓ ENDEREÇO ORCHARD
            </span>
          </div>
        </section>

        <div className="cols">
          {showApprovalCard ? (
            <section className="approve">
              <div className="req"><span className="stamp">Pendente</span> Requer sua aprovação</div>
              <div className="a-amt">{pAmt} <span className="dim small">ZEC</span></div>
              <div className="a-to">memo “{pMemo}”</div>
              <div className="a-meta">
                <span>proposto por <b>{pProposer}</b></span>
                <span className="prog">{Array.from({ length: t }, (_, i) => <i key={i} className={i < pApprovals ? 'on' : ''} />)}</span>
                <span>{pApprovals} de {t}{pExpiry ? ` · ${pExpiry}` : ''}</span>
              </div>
              <div className="btns">
                <Link className="btn ok" to="/proposta">Aprovar</Link>
                <button className="btn">Recusar</button>
              </div>
              <div className="note">Ao aprovar, você autoriza este pagamento com a sua parte da chave.</div>
            </section>
          ) : (
            <section className="approve">
              <div className="req"><span className="stamp">—</span> Nenhuma aprovação pendente</div>
              <div className="note">Quando alguém propuser um pagamento, ele aparece aqui para o seu aval.</div>
              <div className="btns"><Link className="btn ok" to="/pagar">▸ Propor pagamento</Link></div>
            </section>
          )}

          <nav className="opnav">
            <span className="klab">O que fazer</span>
            {acoes.map(([num, title, desc, to]) => (
              <Link className="op" to={to} key={num}>
                <span className="n">{num}</span>
                <span className="t">{title}</span>
                <span className="d">{desc}</span>
                <span className="go">→</span>
              </Link>
            ))}
          </nav>
        </div>

        <section className="ledger">
          <span className="klab">Movimentações</span>
          <div className="cap">Transparência interna — quem propôs e quem aprovou fica registrado.</div>
          {movimentos.length === 0 && (
            <div className="cap">Nenhuma movimentação ainda. As propostas aparecem aqui conforme são criadas.</div>
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
                <div className="st">{m.status === 'verificar' ? <Link className="link" to="/razao">verificar ↗</Link> : 'confirmado'}</div>
              </div>
            </div>
          ))}
        </section>
      </div>
    </>
  )
}
