import { useNavigate } from 'react-router-dom'
import { Letterhead, Secret } from '../components'

export default function Proposta() {
  const nav = useNavigate()
  return (
    <>
      <Letterhead right={<span className="klab back" onClick={() => nav('/')}>← Propostas</span>} />
      <div className="page narrow">
        <div><span className="stamp">Pendente</span></div>
        <div className="p-amt"><Secret><span>0.5000</span></Secret> <span className="dim small">ZEC</span></div>
        <div className="a-to">para <b>zs1q9f…7ka2</b> · memo “adiantamento maio”</div>
        <hr className="rule thin" />
        <div className="p-meta">
          <div>proposto por <b>Bruno</b></div>
          <div className="mt-xs">progresso <span className="prog"><i className="on" /><i /></span> <b>1 de 2</b> · aprovou: Bruno · expira em 71h</div>
        </div>
        <div className="confirm mt">Ao aprovar, você autoriza este pagamento com a <b>sua parte da chave</b>.</div>
        <div className="btns mt"><button className="btn ok" onClick={() => nav('/enviado')}>▸ Aprovar</button><button className="btn">Recusar</button></div>
        <div className="hint mt-sm">Ao bater 2 de 2, a transação vai à mainnet automaticamente.</div>
      </div>
    </>
  )
}
