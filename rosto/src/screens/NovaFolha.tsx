import { useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { Letterhead, Secret } from '../components'

type Linha = { label: string; addr: string; value: string; memo: string; bad?: boolean }

const LINHAS: Linha[] = [
  { label: 'Ana', addr: 'u1ana…7f', value: '0.5000', memo: 'contrib. abril' },
  { label: 'Bruno', addr: 'u1bruno…q2', value: '0.2500', memo: 'contrib. abril' },
  { label: 'Carla', addr: 't1carla…9x ⚠ público', value: '0.3000', memo: '—', bad: true },
]

export default function NovaFolha() {
  const nav = useNavigate()
  const [report, setReport] = useState(false)
  return (
    <>
      <Letterhead right={<button className="btn ghost sm-btn" onClick={() => setReport(true)}>⭱ Importar CSV</button>} />
      <div className="page">
        <h1 className="h1">Nova folha</h1>

        {report && (
          <div className="confirm import-report">
            <div><b>7 linhas aceitas</b> · <span className="seal-tx">1 com erro</span></div>
            <div className="import-detail">⚠ linha 4: valor inválido ("oops"). As demais estão prontas.</div>
            <div className="btns mt-sm">
              <button className="btn ok" onClick={() => setReport(false)}>Ignorar linha 4 e continuar</button>
              <button className="btn ghost" onClick={() => setReport(false)}>Revisar planilha</button>
            </div>
          </div>
        )}

        <table className="tbl folha">
          <thead><tr><th>#</th><th>Rótulo</th><th>Endereço</th><th>Valor</th><th>Memo / holerite</th></tr></thead>
          <tbody>
            {LINHAS.map((l, i) => (
              <tr key={i}>
                <td className="mono dim">{i + 1}</td>
                <td>{l.label}</td>
                <td className={'mono' + (l.bad ? ' seal-tx' : '')}>{l.addr}</td>
                <td className="num">{l.value}</td>
                <td className="mono dim">{l.memo}</td>
              </tr>
            ))}
          </tbody>
        </table>
        <div className="mt-sm"><button className="btn ghost sm-btn">+ Adicionar linha</button></div>

        <div className="foot">
          <span>8 pagamentos</span>
          <span>total <Secret sm><b>4.2 ZEC</b></Secret></span>
          <span>taxa est. <b>0.00045</b></span>
          <span>saldo após <Secret sm><b>—</b></Secret></span>
        </div>
        <div className="confirm mt">⚑ <b>Folha de maio</b> — 8 pagamentos. Precisa de <b>2 aprovações</b>. <span className="seal-tx">Corrija a linha 3 (destino público) para prosseguir.</span></div>
        <div className="right mt"><button className="btn ok dimmed" onClick={() => nav('/proposta')}>▸ Propor folha</button></div>
      </div>
    </>
  )
}
