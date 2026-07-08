import { useEffect, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { Letterhead, Secret } from '../components'
import { fmtZec, parseZecToZat, zatToZec } from '../format'
import { stateLabel } from '../labels'
import {
  previewPayroll, createPayroll, getBalance, getBeneficiaries, getLedger, getVault, health, classifyAddress, humanError,
  type Beneficiary, type Proposal, type Member,
} from '../api'

const DRAFT_KEY = 'konclave.folha.rascunho'

type Row = { label: string; address: string; value: string; memo: string }
const emptyRow = (): Row => ({ label: '', address: '', value: '', memo: '' })


// A blocking problem with a row (null = ok). Warnings (public/sapling) are separate.
function rowIssue(r: Row): string | null {
  if (!r.address.trim()) return 'endereço vazio'
  const k = classifyAddress(r.address.trim())
  if (k === 'unknown') return 'endereço não reconhecido'
  const zat = parseZecToZat(r.value)
  if (zat === null || zat <= 0) return 'valor inválido'
  if (k === 'transparent' && r.memo.trim()) return 'memo não vale em endereço transparente'
  return null
}
const rowTouched = (r: Row) => !!(r.address.trim() || r.value.trim() || r.label.trim() || r.memo.trim())

export default function NovaFolha() {
  const nav = useNavigate()
  const [competencia, setCompetencia] = useState('')
  const [description, setDescription] = useState('')
  const [rows, setRows] = useState<Row[]>([emptyRow()])
  const [showImport, setShowImport] = useState(false)
  const [csv, setCsv] = useState('')
  const [balanceZat, setBalanceZat] = useState<number | null>(null)
  const [benefs, setBenefs] = useState<Beneficiary[]>([])
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [saved, setSaved] = useState(false)
  const [pastFolhas, setPastFolhas] = useState<Proposal[]>([])
  const [vaultName, setVaultName] = useState('Tesouraria Comum')
  const [membersList, setMembersList] = useState<Member[]>([])
  const [proposer, setProposer] = useState('Alice')

  // Restore the local draft.
  useEffect(() => {
    const raw = localStorage.getItem(DRAFT_KEY)
    if (raw) {
      try {
        const d = JSON.parse(raw)
        setCompetencia(d.competencia ?? '')
        setDescription(d.description ?? '')
        if (Array.isArray(d.rows) && d.rows.length) setRows(d.rows)
      } catch { /* ignore corrupt draft */ }
    }
  }, [])

  // Auto-save the local draft (local-first: stays on this device).
  useEffect(() => {
    localStorage.setItem(DRAFT_KEY, JSON.stringify({ competencia, description, rows }))
    setSaved(true)
  }, [competencia, description, rows])

  useEffect(() => {
    let on = true
    void (async () => {
      if (await health()) {
        const [b, bs, led, v] = await Promise.all([getBalance(), getBeneficiaries(), getLedger(), getVault()])
        if (!on) return
        if (b?.configured) setBalanceZat(b.total_zat ?? null)
        if (bs) setBenefs(bs)
        if (led) setPastFolhas(led.filter((x) => x.kind === 'payroll'))
        if (v) {
          setVaultName(v.name)
          const first0 = v.member_list?.[0]
          if (first0) { setMembersList(v.member_list!); setProposer(first0.name) }
        }
      }
    })()
    return () => { on = false }
  }, [])

  function updateRow(i: number, patch: Partial<Row>) {
    setRows((prev) => prev.map((r, idx) => (idx === i ? { ...r, ...patch } : r)))
  }
  const addRow = () => setRows((prev) => [...prev, emptyRow()])
  const removeRow = (i: number) => setRows((prev) => (prev.length > 1 ? prev.filter((_, idx) => idx !== i) : [emptyRow()]))

  async function importCsv() {
    setError(null)
    const p = await previewPayroll(csv)
    if (!p) { setError('Não foi possível ler o CSV (bridge local offline?).'); return }
    const imported: Row[] = p.lines.map((l) => ({
      label: l.label ?? '', address: l.address, value: l.value_zec, memo: l.memo,
    }))
    setRows(imported.length ? imported : [emptyRow()])
    setShowImport(false)
    const e0 = p.errors[0]
    if (e0) setError(`${p.errors.length} linha(s) do CSV com erro foram ignoradas (ex.: linha ${e0.row}: ${e0.reason}).`)
  }

  // Live aggregates over the valid rows.
  const validRows = rows.filter((r) => rowTouched(r) && rowIssue(r) === null)
  const count = validRows.length
  const totalZat = validRows.reduce((acc, r) => acc + (parseZecToZat(r.value) ?? 0), 0)
  const feeZat = count > 0 ? 5000 * Math.max(2, count + 1) : 0
  const afterZat = balanceZat === null ? null : balanceZat - totalZat - feeZat
  const anyBadTouched = rows.some((r) => rowTouched(r) && rowIssue(r) !== null)
  const canSubmit = count > 0 && !anyBadTouched && !busy

  async function submit() {
    setError(null)
    if (count === 0) { setError('Adicione ao menos uma linha válida.'); return }
    if (anyBadTouched) { setError('Corrija as linhas marcadas antes de enviar para aprovação.'); return }
    setBusy(true)
    const desc = competencia.trim()
      ? `Folha · ${competencia.trim()}${description.trim() ? ` — ${description.trim()}` : ''}`
      : (description.trim() || undefined)
    const res = await createPayroll(
      proposer,
      validRows.map((r) => ({ label: r.label || undefined, address: r.address.trim(), value_zec: r.value.trim(), memo: r.memo || undefined })),
      desc,
    )
    setBusy(false)
    if (res.ok) { localStorage.removeItem(DRAFT_KEY); nav('/proposta', { state: { id: res.proposal.id } }) }
    else setError(humanError(res.error, res.detail))
  }

  return (
    <>
      <Letterhead right={<span className="klab back" onClick={() => nav('/painel')}>← Painel</span>} />
      <div className="page">
        <h1 className="h1">Nova folha</h1>
        <p className="cap">Um documento: vários pagamentos numa transação, aprovada uma vez. {saved && <span className="livetag" title="Rascunho salvo neste dispositivo">● rascunho salvo</span>}</p>

        <div className="ctx">
          <span>Do cofre <b>{vaultName}</b></span>
          {membersList.length > 0 && (
            <label className="ctx-as">
              propondo como
              <select value={proposer} onChange={(e) => setProposer(e.target.value)}>
                {membersList.map((m) => <option key={m.pubkey || m.name} value={m.name}>{m.name}</option>)}
              </select>
            </label>
          )}
        </div>

        {pastFolhas.length > 0 && (
          <div className="past-folhas">
            <span className="klab">Folhas anteriores</span>
            {pastFolhas.slice(0, 4).map((f) => (
              <div className="pf-row" key={f.id} onClick={() => nav('/proposta', { state: { id: f.id } })}>
                <span className="pf-name">{f.memo || 'Folha de pagamento'}</span>
                <span className="pf-meta">
                  <span className="pf-val"><Secret sm><span>{fmtZec(f.value_zec)} ZEC</span></Secret></span>
                  <span className={'pf-st ' + f.state}>{stateLabel(f.state)}</span>
                  <span className="pf-go">→</span>
                </span>
              </div>
            ))}
          </div>
        )}

        <div className="doc-head">
          <label className="field inline"><span>Competência</span>
            <input className="input mono" placeholder="ex.: abril/2026" value={competencia} onChange={(e) => setCompetencia(e.target.value)} />
          </label>
          <label className="field inline"><span>Descrição (opcional)</span>
            <input className="input" placeholder="ex.: contribuições de abril" value={description} onChange={(e) => setDescription(e.target.value)} />
          </label>
        </div>

        <table className="tbl folha mt">
          <thead><tr><th>#</th><th>Beneficiário</th><th>Endereço</th><th>Valor</th><th>Memo / holerite</th><th></th></tr></thead>
          <tbody>
            {rows.map((r, i) => {
              const k = r.address.trim().length > 1 ? classifyAddress(r.address.trim()) : null
              const issue = rowTouched(r) ? rowIssue(r) : null
              return (
                <tr key={i} className={issue ? 'row-bad' : ''}>
                  <td className="mono dim">{i + 1}</td>
                  <td><input className="cell-input" placeholder="nome" value={r.label} onChange={(e) => updateRow(i, { label: e.target.value })} /></td>
                  <td>
                    <input className="cell-input mono" placeholder="u1… (Orchard)" value={r.address} onChange={(e) => updateRow(i, { address: e.target.value })} />
                    {k === 'transparent' && <div className="cell-warn">⚠ público</div>}
                    {k === 'sapling' && <div className="cell-warn">⚠ Sapling — prefira u1…</div>}
                  </td>
                  <td><input className="cell-input mono num-input" placeholder="0.0000" value={r.value} onChange={(e) => updateRow(i, { value: e.target.value })} /></td>
                  <td><input className="cell-input" placeholder={k === 'transparent' ? 'sem memo (público)' : 'holerite…'} value={r.memo} onChange={(e) => updateRow(i, { memo: e.target.value })} disabled={k === 'transparent'} /></td>
                  <td>
                    <button className="row-del" title="remover" onClick={() => removeRow(i)}>×</button>
                    {issue && <div className="cell-warn err">{issue}</div>}
                  </td>
                </tr>
              )
            })}
          </tbody>
        </table>

        <div className="mt-sm folha-actions">
          <button className="btn ghost sm-btn" onClick={addRow}>+ Adicionar linha</button>
          {benefs.length > 0 && (
            <select className="btn ghost sm-btn" value="" onChange={(e) => {
              const b = benefs.find((x) => x.id === e.target.value)
              if (b) setRows((prev) => [...prev.filter(rowTouched), { label: b.name, address: b.address, value: '', memo: b.memo }])
            }}>
              <option value="">+ do cadastro…</option>
              {benefs.map((b) => <option key={b.id} value={b.id}>{b.name}</option>)}
            </select>
          )}
          <button className="btn ghost sm-btn" onClick={() => setShowImport((v) => !v)}>↑ Importar CSV</button>
        </div>
        {count === 0 && !showImport && (
          <div className="hint mt-sm">Comece a montar a folha: escreva na tabela acima, escolha alguém <b>do cadastro</b>, ou <b>importe um CSV</b> (rótulo, endereço, valor, memo).</div>
        )}

        {showImport && (
          <div className="mt-sm">
            <textarea className="input mono csv-area" rows={4} placeholder="rótulo,endereço,valor,memo" value={csv} onChange={(e) => setCsv(e.target.value)} spellCheck={false} />
            <div className="mt-sm"><button className="btn ghost sm-btn" onClick={importCsv}>Ler e preencher tabela</button></div>
          </div>
        )}

        <div className="confirm mt preview">
          <div className="pv-row"><span className="pv-k">Documento</span><span className="pv-v"><b>{competencia ? `Folha · ${competencia}` : 'Folha'}</b></span></div>
          <div className="pv-row"><span className="pv-k">Pagamentos</span><span className="pv-v"><b>{count}</b> numa transação só, aprovada uma vez</span></div>
          <div className="pv-row"><span className="pv-k">Total</span><span className="pv-v"><Secret sm><b>{zatToZec(totalZat)} ZEC</b></Secret> + taxa est. {zatToZec(feeZat)}</span></div>
          <div className="pv-row"><span className="pv-k">Saldo após</span><span className="pv-v"><Secret sm><b>{afterZat === null ? '—' : zatToZec(afterZat)}</b></Secret></span></div>
          <div className="pv-row"><span className="pv-k">Aprovação</span><span className="pv-v">Enviar já conta como a de <b>{proposer}</b></span></div>
        </div>
        {afterZat !== null && afterZat < 0 && <div className="hint warn mt-sm">⚠ Total + taxa excede o saldo do cofre.</div>}
        {error && <div className="hint err mt">✗ {error}</div>}

        <div className="right mt">
          <button className="btn ok" onClick={submit} disabled={!canSubmit}>{busy ? 'Enviando…' : '▸ Enviar para aprovação'}</button>
        </div>
      </div>
    </>
  )
}
