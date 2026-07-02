import { useEffect, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { Letterhead } from '../components'
import {
  getBeneficiaries, addBeneficiary, deleteBeneficiary, classifyAddress, shortAddr, humanError,
  type Beneficiary,
} from '../api'

export default function Beneficiarios() {
  const nav = useNavigate()
  const [list, setList] = useState<Beneficiary[]>([])
  const [name, setName] = useState('')
  const [address, setAddress] = useState('')
  const [memo, setMemo] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  async function reload() {
    const b = await getBeneficiaries()
    if (b) setList(b)
  }
  useEffect(() => { void reload() }, [])

  const kind = address.trim().length > 1 ? classifyAddress(address.trim()) : null

  async function add() {
    setError(null)
    if (!name.trim() || !address.trim()) { setError('Preencha nome e endereço.'); return }
    setBusy(true)
    const res = await addBeneficiary(name.trim(), address.trim(), memo.trim() || undefined)
    setBusy(false)
    if (res.ok) { setName(''); setAddress(''); setMemo(''); void reload() }
    else setError(humanError(res.error, res.detail))
  }

  async function remove(id: string) {
    if (await deleteBeneficiary(id)) void reload()
  }

  return (
    <>
      <Letterhead right={<span className="klab back" onClick={() => nav('/painel')}>← Painel</span>} />
      <div className="page">
        <h1 className="h1">Beneficiários</h1>
        <p className="cap">Uma agenda de quem recebe. Cadastre uma vez e escolha por nome ao pagar ou montar a folha — em vez de colar endereços.</p>

        <div className="doc-head">
          <label className="field inline"><span>Nome</span>
            <input className="input" placeholder="ex.: Prestador Infra" value={name} onChange={(e) => setName(e.target.value)} />
          </label>
          <label className="field inline"><span>Endereço</span>
            <input className="input mono" placeholder="u1… (Orchard)" value={address} onChange={(e) => setAddress(e.target.value)} />
          </label>
          <label className="field inline"><span>Memo padrão (opcional)</span>
            <input className="input" placeholder="ex.: infra mensal" value={memo} onChange={(e) => setMemo(e.target.value)} disabled={kind === 'transparent'} />
          </label>
        </div>
        {kind === 'transparent' && <div className="hint warn">⚠ Endereço transparente (público) — sem memo.</div>}
        {kind === 'sapling' && <div className="hint warn">⚠ Endereço Sapling — prefira Orchard (u1…).</div>}
        {error && <div className="hint err">✗ {error}</div>}
        <div className="mt-sm"><button className="btn ok sm-btn" onClick={add} disabled={busy}>{busy ? 'Salvando…' : '+ Cadastrar beneficiário'}</button></div>

        <table className="tbl razao mt">
          <thead><tr><th>Nome</th><th>Endereço</th><th>Memo padrão</th><th></th></tr></thead>
          <tbody>
            {list.length === 0 && <tr><td colSpan={4} className="by">Nenhum beneficiário cadastrado ainda.</td></tr>}
            {list.map((b) => (
              <tr key={b.id}>
                <td><b>{b.name}</b></td>
                <td className={'mono' + (b.is_public ? ' seal-tx' : '')}>{shortAddr(b.address)}{b.is_public ? ' ⚠' : ''}</td>
                <td className="mono dim">{b.memo || '—'}</td>
                <td><button className="row-del" title="remover" onClick={() => remove(b.id)}>×</button></td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </>
  )
}
