import { useLocation, useNavigate } from 'react-router-dom'
import { Letterhead } from '../components'
import { shortAddr } from '../api'

// Success confirmation. The live flow confirms inline on the proposal screen; this
// screen is a standalone confirmation when routed with { amount, to, txid }.
export default function Enviado() {
  const nav = useNavigate()
  const loc = useLocation() as { state?: { amount?: string; to?: string; txid?: string } }
  const amount = loc.state?.amount ?? '0.5000'
  const to = loc.state?.to ?? 'u1vjgx…d406dr'
  const txid = loc.state?.txid

  return (
    <>
      <Letterhead />
      <div className="page enviado">
        <h1 className="h1 pine">✓ Pagamento enviado</h1>
        <div className="enviado-amt">{amount} ZEC → {shortAddr(to)}</div>
        <div className="dim mono enviado-sub">registrado no razão · o holerite fica só com o destinatário</div>
        <div className="btns center">
          <a className="btn ok"
            href={txid ? `https://mainnet.zcashexplorer.app/transactions/${txid}` : 'https://mainnet.zcashexplorer.app'}
            target="_blank" rel="noreferrer">▸ Ver no explorador ↗</a>
          <button className="btn ghost" onClick={() => nav('/painel')}>Voltar ao painel</button>
        </div>
      </div>
    </>
  )
}
