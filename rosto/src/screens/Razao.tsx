import { useNavigate } from 'react-router-dom'
import { Letterhead, Secret, RevealButton } from '../components'

type Row = { date: string; desc: string; kind: string; who?: string; value: string; dir: 'out' | 'in'; verify?: boolean }

const ROWS: Row[] = [
  { date: '28/04', desc: 'Folha de abril — 8 pagamentos', kind: 'tipo: folha', who: 'prop. Ana / aprov. Ana, Bruno', value: '−4.2000', dir: 'out', verify: true },
  { date: '22/04', desc: 'Doação recebida', kind: 'de contribuinte anônimo', value: '+1.0000', dir: 'in' },
  { date: '15/04', desc: 'Pagamento — infraestrutura', kind: 'tipo: pagamento', who: 'prop. Bruno / aprov. Bruno, Carla', value: '−0.3000', dir: 'out', verify: true },
]

export default function Razao() {
  const nav = useNavigate()
  return (
    <>
      <Letterhead
        right={
          <span className="lh-actions">
            <span className="klab back" onClick={() => nav('/')}>← Painel</span>
            <button className="btn ghost sm-btn">⭳ Exportar CSV/PDF</button>
          </span>
        }
      />
      <div className="page">
        <h1 className="h1">Razão</h1>
        <div className="filters">
          <span className="chip">mês: abril ▾</span>
          <span className="chip">membro: todos ▾</span>
          <span className="chip">tipo: todos ▾</span>
          <span className="chip pushr"><RevealButton /></span>
        </div>
        <table className="tbl razao">
          <thead><tr><th>Data</th><th>Descrição</th><th>Quem propôs / aprovou</th><th>Valor</th></tr></thead>
          <tbody>
            {ROWS.map((r, i) => (
              <tr key={i}>
                <td className="mono">{r.date}</td>
                <td>{r.desc}<div className="by">{r.kind}</div></td>
                <td className="by">{r.who ?? '—'}</td>
                <td className={'num ' + r.dir}>
                  <Secret sm><span>{r.value}</span></Secret>
                  <div className="by">{r.verify ? <a className="link" href="#">verificar ↗</a> : 'confirmado'}</div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        <div className="foot">
          <span>saldo do período <Secret sm><b>—</b></Secret></span>
          <span className="dim pushr">transparência interna · a blockchain pública nada revela</span>
        </div>
      </div>
    </>
  )
}
