import { useEffect, useState } from 'react'
import { useLocation, useNavigate } from 'react-router-dom'
import { Letterhead, Secret } from '../components'
import {
  getProposal, getProposals, getVault, voteProposal, shortAddr,
  type Proposal,
} from '../api'

const ME = 'você' // this device's member id (real identity wired in a later phase)

const STAMP: Record<string, string> = {
  awaiting: 'Pendente', ready: 'Pronta', sent: 'Enviada',
  confirmed: 'Confirmada', rejected: 'Recusada', expired: 'Expirada', cancelled: 'Cancelada',
}

export default function Proposta() {
  const nav = useNavigate()
  const loc = useLocation() as { state?: { id?: string } }
  const [p, setP] = useState<Proposal | null>(null)
  const [threshold, setThreshold] = useState(2)
  const [loading, setLoading] = useState(true)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    let on = true
    void (async () => {
      const v = await getVault()
      if (on && v) setThreshold(v.threshold)
      const id = loc.state?.id
      let prop: Proposal | null = null
      if (id) prop = await getProposal(id)
      if (!prop) {
        const list = await getProposals()
        prop = list?.find((x) => x.state === 'awaiting') ?? list?.[0] ?? null
      }
      if (on) { setP(prop); setLoading(false) }
    })()
    return () => { on = false }
  }, [loc.state])

  async function vote(approve: boolean) {
    if (!p) return
    setError(null); setBusy(true)
    const res = await voteProposal(p.id, ME, approve)
    setBusy(false)
    if (res.ok) setP(res.proposal)
    else setError(res.detail ? `${res.error}: ${res.detail}` : res.error)
  }

  if (loading) {
    return (<><Letterhead right={<span className="klab back" onClick={() => nav('/')}>← Propostas</span>} />
      <div className="page narrow"><div className="hint">Carregando proposta…</div></div></>)
  }
  if (!p) {
    return (<><Letterhead right={<span className="klab back" onClick={() => nav('/')}>← Propostas</span>} />
      <div className="page narrow"><h1 className="h1">Nenhuma proposta</h1>
        <div className="hint">Não há proposta aberta. <span className="link" onClick={() => nav('/pagar')}>Propor um pagamento →</span></div>
      </div></>)
  }

  const val = Number(p.value_zec).toFixed(4)
  const dest = p.to_address ? shortAddr(p.to_address) : '—'
  const isAwaiting = p.state === 'awaiting'
  const isReady = p.state === 'ready'
  const isRejected = p.state === 'rejected'

  return (
    <>
      <Letterhead right={<span className="klab back" onClick={() => nav('/')}>← Propostas</span>} />
      <div className="page narrow">
        <div><span className="stamp">{STAMP[p.state] ?? p.state}</span></div>
        <div className="p-amt"><Secret><span>{val}</span></Secret> <span className="dim small">ZEC</span></div>
        <div className="a-to">
          para <b>{dest}</b>{p.memo ? <> · memo “{p.memo}”</> : null}
          {p.is_public && <span className="hint warn"> · ⚠ destino público</span>}
        </div>
        <hr className="rule thin" />
        <div className="p-meta">
          <div>proposto por <b>{p.proposer}</b></div>
          <div className="mt-xs">
            progresso <span className="prog">{Array.from({ length: threshold }, (_, i) => <i key={i} className={i < p.approvals_count ? 'on' : ''} />)}</span>
            {' '}<b>{p.approvals_count} de {threshold}</b>
            {p.approvals.length > 0 && <> · aprovou: {p.approvals.join(', ')}</>}
            {p.refusals.length > 0 && <> · recusou: {p.refusals.join(', ')}</>}
          </div>
        </div>

        {isAwaiting && (
          <>
            <div className="confirm mt">Ao aprovar, você autoriza este pagamento com a <b>sua parte da chave</b>.</div>
            <div className="btns mt">
              <button className="btn ok" onClick={() => vote(true)} disabled={busy}>{busy ? '…' : '▸ Aprovar'}</button>
              <button className="btn" onClick={() => vote(false)} disabled={busy}>Recusar</button>
            </div>
            <div className="hint mt-sm">Ao bater {threshold} de {threshold}, a proposta fica pronta para a assinatura FROST.</div>
          </>
        )}

        {isReady && (
          <>
            <div className="confirm mt ready">✓ <b>Quórum atingido.</b> A proposta está <b>pronta para enviar</b>.</div>
            <div className="btns mt"><button className="btn ok" disabled title="Assinatura FROST + broadcast — próximo passo">▸ Assinar e enviar à mainnet</button></div>
            <div className="hint mt-sm">Assinatura FROST das partes + broadcast à mainnet: <b>próxima etapa</b> (2c).</div>
          </>
        )}

        {isRejected && (
          <div className="confirm mt">✗ <b>Recusada.</b> As recusas tornaram o quórum inviável.</div>
        )}

        {error && <div className="hint err mt">✗ {error}</div>}
      </div>
    </>
  )
}
