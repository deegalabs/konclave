import { useEffect, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { Letterhead, Secret, RevealButton } from '../components'
import { getLedger, ledgerCsvUrl, health, shortAddr, type Proposal } from '../api'

const STATE_LABEL: Record<string, string> = {
  awaiting: 'aguardando', ready: 'pronta', sent: 'enviada',
  confirmed: 'confirmada', rejected: 'recusada', expired: 'expirada', cancelled: 'cancelada',
}

function dateFromExpiry(unix?: number): string {
  if (!unix) return '—'
  // proposals carry expiry = created + 72h; recover an approximate creation date.
  const d = new Date((unix - 72 * 3600) * 1000)
  return `${String(d.getDate()).padStart(2, '0')}/${String(d.getMonth() + 1).padStart(2, '0')}`
}

export default function Razao() {
  const nav = useNavigate()
  const [rows, setRows] = useState<Proposal[] | null>(null)
  const [live, setLive] = useState(false)

  useEffect(() => {
    let on = true
    void (async () => {
      const ok = await health()
      if (!on) return
      setLive(ok)
      const l = await getLedger()
      if (on && l) setRows(l)
    })()
    return () => { on = false }
  }, [])

  const ledger = rows ?? []
  // Period total: what actually left the vault (sent/confirmed payments).
  const settled = ledger.filter((p) => p.state === 'sent' || p.state === 'confirmed')
  const totalOut = settled.reduce((acc, p) => acc + Number(p.value_zec), 0)

  return (
    <>
      <Letterhead
        right={
          <span className="lh-actions">
            <span className="klab back" onClick={() => nav('/painel')}>← Painel</span>
            <a className="btn ghost sm-btn" href={ledgerCsvUrl()} download="konclave-razao.csv">⭳ Exportar CSV</a>
            <button className="btn ghost sm-btn" onClick={() => window.print()}>⭳ PDF</button>
          </span>
        }
      />
      <div className="page">
        <h1 className="h1">Razão</h1>
        <div className="filters">
          <span className="klab">
            {live ? <>registro ao vivo · {ledger.length} lançamentos</> : 'modo demonstração'}
          </span>
          <span className="chip pushr"><RevealButton /></span>
        </div>
        <table className="tbl razao">
          <thead><tr><th>Data</th><th>Descrição</th><th>Quem propôs / aprovou</th><th>Valor</th></tr></thead>
          <tbody>
            {ledger.length === 0 && (
              <tr><td colSpan={4} className="by">Nenhum lançamento ainda. Propostas aparecem aqui conforme são criadas.</td></tr>
            )}
            {ledger.map((p) => {
              const kind = p.kind === 'payroll' ? 'tipo: folha' : 'tipo: pagamento'
              const who = `prop. ${p.proposer}${p.approvals.length ? ` / aprov. ${p.approvals.join(', ')}` : ''}`
              const settledRow = p.state === 'sent' || p.state === 'confirmed'
              return (
                <tr key={p.id}>
                  <td className="mono">{dateFromExpiry(p.expiry_unix)}</td>
                  <td>
                    {p.memo || (p.kind === 'payroll' ? 'Folha de pagamento' : 'Pagamento')}
                    <div className="by">{kind}{p.to_address ? ` · para ${shortAddr(p.to_address)}` : ''}</div>
                  </td>
                  <td className="by">{who}</td>
                  <td className="num out">
                    <Secret sm><span>−{Number(p.value_zec).toFixed(4)}</span></Secret>
                    <div className="by">
                      {settledRow && p.txid
                        ? <a className="link" href={`https://mainnet.zcashexplorer.app/transactions/${p.txid}`} target="_blank" rel="noreferrer">{STATE_LABEL[p.state]} ↗</a>
                        : (STATE_LABEL[p.state] ?? p.state)}
                    </div>
                  </td>
                </tr>
              )
            })}
          </tbody>
        </table>
        <div className="foot">
          <span>saída liquidada no período <Secret sm><b>−{totalOut.toFixed(4)} ZEC</b></Secret></span>
          <span className="dim pushr">transparência interna · a blockchain pública nada revela</span>
        </div>
      </div>
    </>
  )
}
