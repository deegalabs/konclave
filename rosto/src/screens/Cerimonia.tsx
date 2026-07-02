import { useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { Letterhead, Stepper } from '../components'
import { createVaultDkg, setSelectedVault, markVaultUnlocked, shortAddr, humanError, type Vault } from '../api'

/** Illustrative invite code for the demo. In the product each member generates
 *  their own from their own device (frost-client contact token, zffrost1…). */
function inviteCode(name: string, i: number): string {
  const seed = `${name}#${i}`
  let h = 2166136261
  for (let k = 0; k < seed.length; k++) { h ^= seed.charCodeAt(k); h = Math.imul(h, 16777619) }
  const abc = 'abcdefghijklmnopqrstuvwxyz0123456789'
  let s = ''
  let x = h >>> 0
  for (let k = 0; k < 34; k++) { s += abc[x % 36]; x = Math.floor(x / 36) + (k + 3) * 2654435 }
  return `zffrost1${s}`
}

export default function Cerimonia() {
  const nav = useNavigate()
  const [step, setStep] = useState(1) // 1 Definir · 2 Convidar · 3 Criar
  const [name, setName] = useState('Tesouraria da comunidade')
  const [members, setMembers] = useState<string[]>(['Alice', 'Bob', 'Carol'])
  const [threshold, setThreshold] = useState(2)
  const [creating, setCreating] = useState(false)
  const [vault, setVault] = useState<Vault | null>(null)
  const [passphrase, setPassphrase] = useState<string | null>(null)
  const [acked, setAcked] = useState(false)
  const [wordCopied, setWordCopied] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [copied, setCopied] = useState<number | null>(null)

  const names = members.map((m) => m.trim()).filter(Boolean)
  const n = members.length
  const updateMember = (i: number, v: string) => setMembers((p) => p.map((m, idx) => (idx === i ? v : m)))
  const addMember = () => setMembers((p) => [...p, ''])
  const removeMember = (i: number) => setMembers((p) => (p.length > 2 ? p.filter((_, idx) => idx !== i) : p))

  function goConvidar() {
    setError(null)
    if (names.length < 2) { setError('Um cofre precisa de ao menos 2 membros.'); return }
    if (threshold < 1 || threshold > names.length) { setError('Quórum inválido para o número de membros.'); return }
    if (threshold > n) setThreshold(n)
    setStep(2)
  }

  async function copyInvite(i: number) {
    try { await navigator.clipboard.writeText(inviteCode(names[i] ?? `m${i}`, i)); setCopied(i); setTimeout(() => setCopied(null), 1400) } catch { /* clipboard blocked */ }
  }

  async function create() {
    setError(null)
    if (names.length < 2) { setError('Um cofre precisa de ao menos 2 membros.'); setStep(1); return }
    setCreating(true)
    const res = await createVaultDkg(name.trim() || 'Cofre', threshold, names)
    setCreating(false)
    if (res.ok) { setSelectedVault(res.vault.id); markVaultUnlocked(res.vault.id); setVault(res.vault); setPassphrase(res.passphrase ?? null) }
    else setError(humanError(res.error, res.detail))
  }

  // --- result ---
  if (vault) {
    return (
      <>
        <Letterhead right={<span className="klab back" onClick={() => nav('/painel')}>← Painel</span>} />
        <div className="page">
          <Stepper step={4} />
          <h1 className="h1 pine">✓ Cofre criado por DKG</h1>
          <div className="vmeta">A chave <b>nunca foi remontada</b> — cada membro gerou apenas a sua parte, e elas ficam <b>seladas</b> neste aparelho.</div>

          {passphrase && (
            <div className="word-box mt">
              <div className="word-head">🔑 A palavra do cofre — <b>anote agora</b></div>
              <div className="word-value mono">{passphrase}</div>
              <button className="btn ghost sm-btn" onClick={() => { void navigator.clipboard.writeText(passphrase).then(() => setWordCopied(true)).catch(() => {}) }}>
                {wordCopied ? '✓ copiada' : 'copiar palavra'}
              </button>
              <div className="word-warn">
                É a <b>senha do cofre</b>: sem ela, a parte da chave selada neste aparelho <b>não abre</b> — nem para você.
                <b> Ninguém recupera.</b> Mostramos uma única vez. Guarde num lugar seguro e combine com os membros.
                <div className="hint mt-xs">Isso é uma trava de acesso ao cofre — diferente do <b>quórum</b>, que é a garantia criptográfica do FROST.</div>
              </div>
              <label className="word-ack">
                <input type="checkbox" checked={acked} onChange={(e) => setAcked(e.target.checked)} /> Guardei a palavra num lugar seguro.
              </label>
            </div>
          )}

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
          <div className="right">
            <button className="btn ok" onClick={() => nav('/painel')} disabled={!!passphrase && !acked}
              title={!!passphrase && !acked ? 'Confirme que guardou a palavra' : ''}>▸ Ir para o cofre</button>
          </div>
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
          <Stepper step={3} />
          <h1 className="h1">Gerando as chaves em conjunto…</h1>
          <div className="vmeta">Cada membro gera a sua parte e elas se combinam pela rede. A chave nunca existe inteira. Pode levar alguns segundos.</div>
          <div className="progress-bar"><span /></div>
        </div>
      </>
    )
  }

  // --- form: step 1 Definir · step 2 Convidar ---
  return (
    <>
      <Letterhead right={<span className="klab back" onClick={() => nav('/')}>← Meus cofres</span>} />
      <div className="page narrow">
        <Stepper step={step} />

        {step === 1 && (
          <>
            <h1 className="h1">Criar um cofre</h1>
            <p className="cap">Um cofre é um fundo que várias pessoas cuidam <b>juntas</b>. A chave é gerada em conjunto e <b>nunca existe inteira</b> em lugar nenhum.</p>

            <label className="field"><span>Nome do cofre</span>
              <input className="input" value={name} onChange={(e) => setName(e.target.value)} />
            </label>

            <span className="klab">Quem cuida deste cofre</span>
            {members.map((m, i) => (
              <div key={i} className="row-gap mt-xs">
                <input className="input" value={m} onChange={(e) => updateMember(i, e.target.value)} placeholder="nome da pessoa" />
                <button className="row-del" title="remover" onClick={() => removeMember(i)} disabled={members.length <= 2}>×</button>
              </div>
            ))}
            <div className="mt-sm"><button className="btn ghost sm-btn" onClick={addMember}>+ Adicionar pessoa</button></div>

            <div className="field mt"><span>Quantas aprovações cada pagamento precisa?</span>
              <div className="selq">
                <select className="box" value={threshold} onChange={(e) => setThreshold(Number(e.target.value))}>
                  {Array.from({ length: Math.max(n, 1) }, (_, i) => i + 1).map((t) => <option key={t} value={t}>{t}</option>)}
                </select>
                <span className="selq-unit"> de {n} pessoas</span>
              </div>
              <div className="hint">↳ Nenhum pagamento sai sem {threshold} {threshold === 1 ? 'aprovação' : 'aprovações'}. Ninguém sozinho move o dinheiro.</div>
            </div>

            {error && <div className="hint err mt">✗ {error}</div>}
            <hr className="rule" />
            <div className="right"><button className="btn ok" onClick={goConvidar}>Convidar as pessoas →</button></div>
          </>
        )}

        {step === 2 && (
          <>
            <h1 className="h1">Convidar</h1>
            <p className="cap">Cada pessoa entra <b>do seu próprio aparelho</b> e gera ali a sua parte da chave — nada secreto trafega entre vocês, só material público. Envie a cada uma o seu <b>código de convite</b>.</p>

            <div className="invite-list">
              {names.map((nm, i) => (
                <div className="invite" key={i}>
                  <div className="invite-top">
                    <span className="invite-name">{nm}</span>
                    <span className="invite-tag">{i === 0 ? 'você (anfitrião)' : 'convidado'}</span>
                  </div>
                  <div className="invite-code">
                    <code>{shortAddr(inviteCode(nm, i), 14, 8)}</code>
                    <button className="btn ghost sm-btn" onClick={() => copyInvite(i)}>{copied === i ? '✓ copiado' : 'copiar convite'}</button>
                  </div>
                </div>
              ))}
            </div>

            <div className="confirm mt">
              <b>Nesta demonstração</b>, o Konclave gera as partes de todos aqui neste aparelho, para você experimentar o fluxo de ponta a ponta.
              No produto, cada convidado abre o Konclave no seu dispositivo, cola o código e gera a sua parte — que nunca sai de lá.
            </div>

            {error && <div className="hint err mt">✗ {error}</div>}
            <hr className="rule" />
            <div className="row-gap center-between">
              <button className="btn ghost" onClick={() => setStep(1)}>← Voltar</button>
              <button className="btn ok" onClick={create}>▸ Criar cofre agora (DKG)</button>
            </div>
          </>
        )}
      </div>
    </>
  )
}
