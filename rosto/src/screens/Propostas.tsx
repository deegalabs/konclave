import { useEffect, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { Letterhead, Secret } from '../components'
import { Identicon } from '../avatar'
import { getProposals, getVault, health, type Proposal } from '../api'
import { expiryLabel } from '../format'

const MOCK: Proposal[] = [
  { id: 'm1', vault_id: '', kind: 'payment', state: 'awaiting', proposer: 'Bruno', value_zat: 30000, value_zec: '0.0003', memo: 'adiantamento maio', is_public: false, approvals: ['Bruno'], refusals: [], approvals_count: 1, expiry_unix: undefined },
]

export default function Propostas() {
  const nav = useNavigate()
  const [rows, setRows] = useState<Proposal[]>([])
  const [threshold, setThreshold] = useState(2)
  const [live, setLive] = useState(false)
  const [loaded, setLoaded] = useState(false)

  useEffect(() => {
    let on = true
    void (async () => {
      const ok = await health()
      if (!on) return
      setLive(ok)
      const [ps, v] = await Promise.all([ok ? getProposals() : null, ok ? getVault() : null])
      if (!on) return
      if (v) setThreshold(v.threshold)
      setRows(ps && ps.length ? ps : (ok ? [] : MOCK))
      setLoaded(true)
    })()
    return () => { on = false }
  }, [])

  const awaiting = rows.filter((p) => p.state === 'awaiting')
  const ready = rows.filter((p) => p.state === 'ready')

  const open = (p: Proposal) => nav('/proposta', { state: { id: p.id } })

  const Row = ({ p }: { p: Proposal }) => (
    <div className="plist-row" onClick={() => open(p)}>
      <Identicon seed={p.proposer} size={34} />
      <div className="plist-main">
        <div className="plist-title">{p.memo || (p.kind === 'payroll' ? 'Folha de pagamento' : 'Pagamento')}</div>
        <div className="plist-sub">
          {p.kind === 'payroll' ? 'folha' : 'pagamento'} · proposto por <b>{p.proposer}</b>
          {p.expiry_unix ? ` · ${expiryLabel(p.expiry_unix)}` : ''}
        </div>
      </div>
      <div className="plist-right">
        <div className="plist-val"><Secret sm><span>{Number(p.value_zec).toFixed(4)} ZEC</span></Secret></div>
        <div className="plist-prog">
          <span className="prog">{Array.from({ length: threshold }, (_, i) => <i key={i} className={i < p.approvals_count ? 'on' : ''} />)}</span>
          {' '}{p.approvals_count} de {threshold}
        </div>
      </div>
      <span className="plist-go">→</span>
    </div>
  )

  return (
    <>
      <Letterhead right={<span className="klab back" onClick={() => nav('/painel')}>← Painel</span>} />
      <div className="page narrow">
        <h1 className="h1">Propostas</h1>
        <p className="cap">Pagamentos e folhas em andamento neste cofre. {live ? '' : '(modo demonstração)'}</p>

        {ready.length > 0 && (
          <>
            <div className="plist-head"><span className="klab">Prontas para assinar</span><span className="plist-count ready">{ready.length}</span></div>
            <div className="plist">{ready.map((p) => <Row key={p.id} p={p} />)}</div>
          </>
        )}

        <div className="plist-head mt"><span className="klab">Aguardando aprovação</span><span className="plist-count">{awaiting.length}</span></div>
        {awaiting.length > 0 ? (
          <div className="plist">{awaiting.map((p) => <Row key={p.id} p={p} />)}</div>
        ) : (
          <div className="empty-note">Nada aguardando aprovação. <span className="link" onClick={() => nav('/pagar')}>Propor um pagamento →</span></div>
        )}

        {loaded && rows.length === 0 && ready.length === 0 && (
          <div className="hint mt">O razão guarda o histórico completo, inclusive as concluídas. <span className="link" onClick={() => nav('/razao')}>Ver razão →</span></div>
        )}
      </div>
    </>
  )
}
