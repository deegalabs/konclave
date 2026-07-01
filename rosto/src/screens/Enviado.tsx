import { useNavigate } from 'react-router-dom'
import { Letterhead } from '../components'

export default function Enviado() {
  const nav = useNavigate()
  return (
    <>
      <Letterhead />
      <div className="page enviado">
        <h1 className="h1 pine">✓ Pagamento enviado</h1>
        <div className="enviado-amt">0.5000 ZEC → zs1q9f…7ka2</div>
        <div className="dim mono enviado-sub">registrado no razão · o holerite fica só com o destinatário</div>
        <div className="btns center">
          <a className="btn ok" href="https://mainnet.zcashexplorer.app" target="_blank" rel="noreferrer">▸ Ver no explorador ↗</a>
          <button className="btn ghost" onClick={() => nav('/')}>Voltar ao painel</button>
        </div>
      </div>
    </>
  )
}
