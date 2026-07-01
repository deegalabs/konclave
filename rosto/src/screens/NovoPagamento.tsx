import { useNavigate } from 'react-router-dom'
import { Letterhead, Secret } from '../components'

export default function NovoPagamento() {
  const nav = useNavigate()
  return (
    <>
      <Letterhead right={<span className="klab back" onClick={() => nav('/')}>← Painel</span>} />
      <div className="page narrow">
        <h1 className="h1">Novo pagamento</h1>
        <label className="field"><span>Para</span>
          <input className="input mono" placeholder="endereço Zcash…" defaultValue="zs1q9f7m…4ka2" />
        </label>
        <label className="field"><span>Valor</span>
          <input className="input mono" defaultValue="0.5" />
        </label>
        <div className="hint">disponível para propor: <Secret sm><b>2.4180 ZEC</b></Secret></div>
        <label className="field mt"><span>Memo · recibo/holerite — só o destinatário lê <span className="dim ns">(6/512)</span></span>
          <input className="input" defaultValue="adiantamento maio" />
        </label>
        <hr className="rule thin" />
        <div className="mono dim fee">Taxa estimada <b className="ink">0.0001 ZEC</b> · saldo após <Secret sm><b>—</b></Secret></div>
        <div className="confirm mt">⚑ Você vai <b>PROPOR</b> 0,5 ZEC → zs1q9f…4ka2. Precisa de <b>2 aprovações</b> (incluindo a sua).</div>
        <div className="right mt"><button className="btn ok" onClick={() => nav('/proposta')}>▸ Propor pagamento</button></div>
      </div>
    </>
  )
}
