import { useEffect, useState } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import { Letterhead, Seal, Secret, RevealButton } from '../components'
import { Identicon } from '../avatar'
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
    ['03', 'Propostas', `${isLive ? awaiting.length : 1} aguardando`, '/propostas'],
    ['04', 'Razão / contas', 'entregar ao contador', '/razao'],
    ['05', 'Pessoas', 'cadastro de quem recebe', '/beneficiarios'],
  ]

  // Delete flow (local only). Locked vaults require the word; unlocked ones require
  // typing the vault name. If this device sees a spendable balance, warn hard.
  const locked = vault?.locked === true
  const seesFunds = hasBal && Number(balance?.total_zat ?? 0) > 0
  const canDelete = locked ? delPass.length > 0 : delName.trim() === name
  async function doDelete() {
    setDelBusy(true); setDelErr(null)
    const r = await deleteVault(locked ? delPass : undefined)
    setDelBusy(false)
    if (r.ok) { clearSelectedVault(); nav('/') }
    else setDelErr(r.wrong ? 'Palavra do cofre incorreta.' : 'Não foi possível excluir (cofre local offline?).')
  }

  return (
    <>
      <Letterhead right={<Link className="switch" to="/" title="Trocar de cofre">COFRE · <b>{name}</b> ▾</Link>} />
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

        {/* 1 · O que precisa de você — a ação primeiro */}
        {showApprovalCard ? (
          <section className="needyou act">
            <div className="req"><span className="stamp">Pendente</span> Precisa de você{isLive && awaiting.length > 1 ? ` · ${awaiting.length} aguardando` : ''}</div>
            <div className="ny-body">
              <Identicon seed={pProposer} size={38} />
              <div className="ny-main">
                <div className="ny-amt">{pAmt} <span className="dim small">ZEC</span></div>
                <div className="a-to">memo “{pMemo}” · proposto por <b>{pProposer}</b></div>
                <div className="a-meta">
                  <span className="prog">{Array.from({ length: t }, (_, i) => <i key={i} className={i < pApprovals ? 'on' : ''} />)}</span>
                  <span>{pApprovals} de {t}{pExpiry ? ` · ${pExpiry}` : ''}</span>
                </div>
              </div>
            </div>
            <div className="btns">
              <Link className="btn ok" to="/proposta" state={pending ? { id: pending.id } : undefined}>▸ Revisar e votar</Link>
            </div>
            <div className="note">Você escolhe por quem aprova ou recusa na próxima tela.</div>
          </section>
        ) : (
          <section className="needyou calm">
            <div className="req"><span className="stamp">—</span> Nada aguardando você</div>
            <div className="note">Quando alguém propuser um pagamento, ele aparece aqui para o seu aval.</div>
            <div className="btns"><Link className="btn ok" to="/pagar">▸ Propor pagamento</Link></div>
          </section>
        )}

        {/* 2 · Saldo */}
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

        {/* 3 · O que fazer */}
        <nav className="opnav card">
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

        {/* 4 · Histórico */}
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

        {/* Zona de perigo */}
        <section className="danger-zone">
          <span className="klab danger-lab">Zona de perigo</span>
          <div className="danger-body">
            <div>
              <div className="danger-t">Excluir este cofre</div>
              <div className="danger-d">Remove o cofre deste aparelho. Não afeta a rede Zcash nem os outros membros.</div>
            </div>
            <button className="btn danger-btn" onClick={() => { setShowDelete(true); setDelErr(null); setDelPass(''); setDelName('') }}>Excluir cofre</button>
          </div>
        </section>
      </div>

      {showDelete && (
        <div className="modal-overlay" onClick={() => setShowDelete(false)}>
          <div className="modal-card danger" onClick={(e) => e.stopPropagation()}>
            <span className="klab danger-lab">Excluir cofre</span>
            <h2 className="modal-h">Excluir “{name}”?</h2>
            <p className="modal-p">Isto remove o cofre <b>só deste aparelho</b> — registros, propostas e pessoas. <b>Não dá para desfazer.</b></p>

            <div className="danger-funds">
              ⚠ Se este cofre tiver <b>ZEC</b>, ao excluir você <b>perde o acesso a esse dinheiro</b> — a sua parte da chave some deste aparelho.
              {' '}<b>Envie o saldo para outro lugar antes de excluir.</b>
              {seesFunds && <div className="mt-xs">Este dispositivo vê um saldo de <b>{fmt4(balance?.total_zec)} ZEC</b>.</div>}
            </div>
            <div className="hint">Isto não apaga nada na rede Zcash nem no aparelho dos outros membros — é só a sua cópia local.</div>

            {locked ? (
              <label className="field mt"><span>Digite a palavra do cofre para confirmar</span>
                <input className="input" type="password" value={delPass} onChange={(e) => setDelPass(e.target.value)}
                  onKeyDown={(e) => { if (e.key === 'Enter' && canDelete) void doDelete() }} autoFocus />
              </label>
            ) : (
              <label className="field mt"><span>Digite o nome do cofre (<b>{name}</b>) para confirmar</span>
                <input className="input" value={delName} onChange={(e) => setDelName(e.target.value)} placeholder={name}
                  onKeyDown={(e) => { if (e.key === 'Enter' && canDelete) void doDelete() }} autoFocus />
              </label>
            )}
            {delErr && <div className="hint err mt">✗ {delErr}</div>}

            <div className="btns right mt">
              <button className="btn ghost" onClick={() => setShowDelete(false)}>Cancelar</button>
              <button className="btn danger-btn" onClick={() => void doDelete()} disabled={delBusy || !canDelete}>
                {delBusy ? 'Excluindo…' : 'Excluir definitivamente'}
              </button>
            </div>
          </div>
        </div>
      )}
    </>
  )
}
