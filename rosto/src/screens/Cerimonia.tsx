import { useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { Letterhead } from '../components'
import { createVaultDkg, shortAddr, humanError, type Vault } from '../api'

export default function Cerimonia() {
  const nav = useNavigate()
  const [name, setName] = useState('Tesouraria da comunidade')
  const [members, setMembers] = useState<string[]>(['Alice', 'Bob', 'Carol'])
  const [threshold, setThreshold] = useState(2)
  const [creating, setCreating] = useState(false)
  const [vault, setVault] = useState<Vault | null>(null)
  const [error, setError] = useState<string | null>(null)

  const n = members.length
  const updateMember = (i: number, v: string) => setMembers((p) => p.map((m, idx) => (idx === i ? v : m)))
  const addMember = () => setMembers((p) => [...p, ''])
  const removeMember = (i: number) => setMembers((p) => (p.length > 2 ? p.filter((_, idx) => idx !== i) : p))

  async function create() {
    setError(null)
    const names = members.map((m) => m.trim()).filter(Boolean)
    if (names.length < 2) { setError('Um cofre precisa de ao menos 2 membros.'); return }
    if (threshold < 1 || threshold > names.length) { setError('Quórum inválido para o número de membros.'); return }
    setCreating(true)
    const res = await createVaultDkg(name.trim() || 'Cofre', threshold, names)
    setCreating(false)
    if (res.ok) setVault(res.vault)
    else setError(humanError(res.error, res.detail))
  }

  // --- result ---
  if (vault) {
    return (
      <>
        <Letterhead right={<span className="klab back" onClick={() => nav('/')}>← Painel</span>} />
        <div className="page">
          <h1 className="h1 pine">✓ Cofre criado por DKG</h1>
          <div className="vmeta">A chave <b>nunca foi remontada</b> — cada membro gerou apenas a sua parte, e elas ficam <b>seladas</b> neste aparelho.</div>

          <span className="klab mt">Cofre</span>
          <div className="mono">{vault.name} · quórum {vault.threshold}-de-{vault.total}</div>

          <span className="klab mt">Endereço para receber ZEC</span>
          <div className="row-gap"><input className="input mono" value={vault.orchard_address} readOnly /></div>
          <div className="hint warn">⚠ Receba apenas em endereço Orchard (u1…).</div>

          <span className="klab mt">Chave do grupo</span>
          <div className="mono dim">{shortAddr(vault.group_pubkey, 10, 8)}</div>

          <span className="klab mt">Membros</span>
          <table className="tbl razao">
            <tbody>
              {vault.member_list.map((m, i) => (
                <tr key={i}><td><b>{m.name}</b></td><td className="mono dim">{shortAddr(m.pubkey, 8, 6)}</td></tr>
              ))}
            </tbody>
          </table>

          <hr className="rule" />
          <div className="right"><button className="btn ok" onClick={() => nav('/membros')}>▸ Ver membros</button></div>
        </div>
      </>
    )
  }

  // --- creating ---
  if (creating) {
    return (
      <>
        <Letterhead right={<span className="klab">criando…</span>} />
        <div className="page">
          <h1 className="h1">Gerando as chaves via DKG…</h1>
          <div className="vmeta">Os membros geram suas partes em conjunto pela rede. A chave nunca existe inteira. Pode levar alguns segundos.</div>
          <div className="progress-bar"><span /></div>
        </div>
      </>
    )
  }

  // --- form ---
  return (
    <>
      <Letterhead right={<span className="klab back" onClick={() => nav('/')}>← Painel</span>} />
      <div className="page">
        <h1 className="h1">Criar cofre (DKG)</h1>
        <p className="cap">A chave é gerada <b>em conjunto</b> pelos membros e <b>nunca existe inteira</b> em lugar nenhum. Nesta demonstração as partes rodam neste aparelho; no produto, cada membro entra do seu dispositivo.</p>

        <label className="field"><span>Nome do cofre</span>
          <input className="input" value={name} onChange={(e) => setName(e.target.value)} />
        </label>

        <div className="field"><span>Quantas aprovações cada pagamento precisa?</span>
          <div className="selq">
            <select className="box" value={threshold} onChange={(e) => setThreshold(Number(e.target.value))}>
              {Array.from({ length: n }, (_, i) => i + 1).map((t) => <option key={t} value={t}>{t}</option>)}
            </select>
            <span> de {n} membros</span>
          </div>
          <div className="hint">↳ Nenhum pagamento sai sem {threshold} aprovações. Ninguém sozinho controla o dinheiro.</div>
        </div>

        <span className="klab">Membros</span>
        {members.map((m, i) => (
          <div key={i} className="row-gap mt-xs">
            <input className="input" value={m} onChange={(e) => updateMember(i, e.target.value)} placeholder="nome do membro" />
            <button className="row-del" title="remover" onClick={() => removeMember(i)}>×</button>
          </div>
        ))}
        <div className="mt-sm"><button className="btn ghost sm-btn" onClick={addMember}>+ Adicionar membro</button></div>

        {error && <div className="hint err mt">✗ {error}</div>}
        <hr className="rule" />
        <div className="confirm">⚠ A criação acontece uma vez, em conjunto. Ao confirmar, roda a cerimônia DKG de verdade.</div>
        <div className="right mt"><button className="btn ok" onClick={create}>▸ Criar cofre agora (DKG)</button></div>
      </div>
    </>
  )
}
