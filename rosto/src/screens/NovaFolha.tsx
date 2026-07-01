import { useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { Letterhead, Secret } from '../components'
import { previewPayroll, createPayroll, shortAddr, type PayrollPreview } from '../api'

const ME = 'você'

const CSV_EXEMPLO = `rótulo,endereço,valor,memo
Ana,u1anaxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx,0.0003,contrib. abril
Bruno,u1brunoxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx,0.0002,contrib. abril`

export default function NovaFolha() {
  const nav = useNavigate()
  const [csv, setCsv] = useState(CSV_EXEMPLO)
  const [preview, setPreview] = useState<PayrollPreview | null>(null)
  const [busy, setBusy] = useState<null | 'preview' | 'propose'>(null)
  const [error, setError] = useState<string | null>(null)

  async function doPreview() {
    setError(null); setBusy('preview')
    const p = await previewPayroll(csv)
    setBusy(null)
    if (p) setPreview(p)
    else setError('Não foi possível ler a folha (bridge local offline?).')
  }

  async function propose() {
    if (!preview || preview.lines.length === 0) return
    setError(null); setBusy('propose')
    const res = await createPayroll(
      ME,
      preview.lines.map((l) => ({
        label: l.label ?? undefined,
        address: l.address,
        value_zec: l.value_zec,
        memo: l.memo || undefined,
      })),
    )
    setBusy(null)
    if (res.ok) nav('/proposta', { state: { id: res.proposal.id } })
    else setError(res.detail ? `${res.error}: ${res.detail}` : res.error)
  }

  const s = preview?.summary
  const canPropose = !!preview && preview.lines.length > 0 && busy === null

  return (
    <>
      <Letterhead right={<span className="klab back" onClick={() => nav('/')}>← Painel</span>} />
      <div className="page">
        <h1 className="h1">Nova folha</h1>
        <p className="cap">Uma transação com vários pagamentos, aprovada uma vez. Cole a planilha (CSV: <span className="mono">rótulo,endereço,valor,memo</span>) e confira antes de propor.</p>

        <textarea className="input mono csv-area" rows={6} value={csv} onChange={(e) => setCsv(e.target.value)} spellCheck={false} />
        <div className="mt-sm"><button className="btn ghost sm-btn" onClick={doPreview} disabled={busy !== null}>{busy === 'preview' ? 'Lendo…' : '⭱ Ler / conferir folha'}</button></div>

        {preview && (
          <>
            {preview.errors.length > 0 && (
              <div className="confirm import-report mt">
                <div><b>{preview.lines.length} linhas aceitas</b> · <span className="seal-tx">{preview.errors.length} com erro</span></div>
                {preview.errors.map((e, i) => (
                  <div className="import-detail" key={i}>⚠ linha {e.row}: {e.reason}</div>
                ))}
                <div className="import-detail dim">As linhas com erro são ignoradas; as demais seguem.</div>
              </div>
            )}

            <table className="tbl folha mt">
              <thead><tr><th>#</th><th>Rótulo</th><th>Endereço</th><th>Valor</th><th>Memo / holerite</th></tr></thead>
              <tbody>
                {preview.lines.map((l, i) => (
                  <tr key={i}>
                    <td className="mono dim">{i + 1}</td>
                    <td>{l.label || '—'}</td>
                    <td className={'mono' + (l.is_public ? ' seal-tx' : '')}>{shortAddr(l.address)}{l.is_public ? ' ⚠ público' : ''}</td>
                    <td className="num"><Secret sm><span>{Number(l.value_zec).toFixed(4)}</span></Secret></td>
                    <td className="mono dim">{l.memo || '—'}</td>
                  </tr>
                ))}
                {preview.lines.length === 0 && (
                  <tr><td colSpan={5} className="by">Nenhuma linha válida. Corrija a planilha e leia de novo.</td></tr>
                )}
              </tbody>
            </table>

            {s && (
              <div className="foot">
                <span>{s.count} pagamentos</span>
                <span>total <Secret sm><b>{s.total_zec} ZEC</b></Secret></span>
                <span>taxa est. <b>{s.fee_zec}</b></span>
                <span>total + taxa <Secret sm><b>{s.total_with_fee_zec}</b></Secret></span>
              </div>
            )}

            <div className="confirm mt">⚑ <b>Folha</b> — {s?.count ?? 0} pagamentos numa transação só. Precisa de <b>2 aprovações</b> (incluindo a sua).</div>
          </>
        )}

        {error && <div className="hint err mt">✗ {error}</div>}

        <div className="right mt">
          <button className="btn ok" onClick={propose} disabled={!canPropose}>
            {busy === 'propose' ? 'Propondo…' : '▸ Propor folha'}
          </button>
        </div>
      </div>
    </>
  )
}
