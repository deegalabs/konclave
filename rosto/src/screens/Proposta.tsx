import { useEffect, useState } from 'react'
import { useLocation, useNavigate } from 'react-router-dom'
import { Letterhead, Secret } from '../components'
import {
  getProposalDetail, getProposals, getVault, voteProposal, sendProposal, shortAddr, humanError,
  type Proposal, type PayrollLine,
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
  const [lines, setLines] = useState<PayrollLine[]>([])
  const [threshold, setThreshold] = useState(2)
  const [loading, setLoading] = useState(true)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [sending, setSending] = useState<null | 'dry' | 'real'>(null)
  const [dryOk, setDryOk] = useState<string | null>(null)

  useEffect(() => {
    let on = true
    void (async () => {
      const v = await getVault()
      if (on && v) setThreshold(v.threshold)
      let id = loc.state?.id
      if (!id) {
        const list = await getProposals()
        id = (list?.find((x) => x.state === 'awaiting') ?? list?.[0])?.id
      }
      const detail = id ? await getProposalDetail(id) : null
      if (on) {
        setP(detail?.proposal ?? null)
        setLines(detail?.lines ?? [])
        setLoading(false)
      }
    })()
    return () => { on = false }
  }, [loc.state])

  async function vote(approve: boolean) {
    if (!p) return
    setError(null); setBusy(true)
    const res = await voteProposal(p.id, ME, approve)
    setBusy(false)
    if (res.ok) setP(res.proposal)
    else setError(humanError(res.error, res.detail))
  }

  async function send(dryRun: boolean) {
    if (!p) return
    setError(null); setDryOk(null); setSending(dryRun ? 'dry' : 'real')
    const res = await sendProposal(p.id, dryRun)
    setSending(null)
    if (!res.ok) { setError(humanError(res.error, res.detail)); return }
    if (res.dryRun) {
      setDryOk(res.sighash ?? 'assinatura válida')
    } else if (res.proposal) {
      setP(res.proposal) // now Sent, carries the txid
    }
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
  const isPayroll = p.kind === 'payroll'
  const isAwaiting = p.state === 'awaiting'
  const isReady = p.state === 'ready'
  const isRejected = p.state === 'rejected'
  const isExpired = p.state === 'expired'
  const isSent = p.state === 'sent' || p.state === 'confirmed'

  return (
    <>
      <Letterhead right={<span className="klab back" onClick={() => nav('/')}>← Propostas</span>} />
      <div className="page narrow">
        <div><span className="stamp">{STAMP[p.state] ?? p.state}</span></div>
        <div className="p-amt"><Secret><span>{val}</span></Secret> <span className="dim small">ZEC</span></div>
        {isPayroll ? (
          <>
            <div className="a-to">folha · <b>{lines.length} pagamentos</b> numa transação, aprovada uma vez</div>
            <table className="tbl folha mt">
              <thead><tr><th>Rótulo</th><th>Destino</th><th>Valor</th><th>Memo</th></tr></thead>
              <tbody>
                {lines.map((l, i) => (
                  <tr key={i}>
                    <td>{l.label || '—'}</td>
                    <td className={'mono' + (l.is_public ? ' seal-tx' : '')}>{shortAddr(l.address)}{l.is_public ? ' ⚠' : ''}</td>
                    <td className="num"><Secret sm><span>{Number(l.value_zec).toFixed(4)}</span></Secret></td>
                    <td className="mono dim">{l.memo || '—'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </>
        ) : (
          <div className="a-to">
            para <b>{dest}</b>{p.memo ? <> · memo “{p.memo}”</> : null}
            {p.is_public && <span className="hint warn"> · ⚠ destino público</span>}
          </div>
        )}
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
            <div className="confirm mt ready">
              ✓ <b>Quórum atingido.</b>{' '}
              {isPayroll
                ? <>A folha está pronta. Assinar reúne as partes da chave (FROST) e transmite as N saídas numa transação só.</>
                : <>A proposta está <b>pronta</b>. Assinar reúne as partes da chave (FROST) e transmite à mainnet.</>}
            </div>
            <div className="btns mt">
              <button className="btn ok" onClick={() => send(false)} disabled={sending !== null}>
                {sending === 'real' ? 'Assinando e enviando… (pode levar ~1 min)' : (isPayroll ? '▸ Assinar e enviar a folha' : '▸ Assinar e enviar à mainnet')}
              </button>
              <button className="btn" onClick={() => send(true)} disabled={sending !== null} title="Executa a cerimônia e assina, sem transmitir">
                {sending === 'dry' ? 'Validando…' : 'Validar (sem enviar)'}
              </button>
            </div>
            {dryOk && <div className="hint mt-sm ready">✓ Assinatura FROST válida (sighash <code>{dryOk.slice(0, 16)}…</code>). Nada foi transmitido.</div>}
            <div className="hint mt-sm">A assinatura nunca remonta a chave: cada parte assina no seu lugar e só o resultado combinado vai à rede.</div>
          </>
        )}

        {isSent && (
          <>
            <div className="confirm mt ready">✓ <b>Enviada à mainnet.</b> Pagamento transmitido e assinado por quórum.</div>
            {p.txid && (
              <div className="p-meta mt">
                <div>txid</div>
                <div className="mt-xs"><code>{p.txid}</code></div>
                <div className="mt-xs"><a className="link" href={`https://mainnet.zcashexplorer.app/transactions/${p.txid}`} target="_blank" rel="noreferrer">ver no explorador ↗</a></div>
              </div>
            )}
          </>
        )}

        {isRejected && (
          <div className="confirm mt">✗ <b>Recusada.</b> As recusas tornaram o quórum inviável.</div>
        )}

        {isExpired && (
          <div className="confirm mt">⌛ <b>Expirada.</b> O prazo de aprovação passou sem atingir o quórum. Crie uma nova proposta.</div>
        )}

        {error && <div className="hint err mt">✗ {error}</div>}
      </div>
    </>
  )
}
