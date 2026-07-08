import { useEffect, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { Letterhead, Secret } from '../components'
import {
  createProposal, getBalance, getVault, getBeneficiaries, health, shortAddr, classifyAddress, humanError,
  type Beneficiary, type Member,
} from '../api'

const MEMO_MAX = 512

function memoBytes(s: string): number {
  return new TextEncoder().encode(s).length
}

export default function NovoPagamento() {
  const nav = useNavigate()
  const [to, setTo] = useState('')
  const [value, setValue] = useState('0.5')
  const [memo, setMemo] = useState('adiantamento maio')
  const [threshold, setThreshold] = useState(2)
  const [available, setAvailable] = useState<string | null>(null)
  const [benefs, setBenefs] = useState<Beneficiary[]>([])
  const [vaultName, setVaultName] = useState('Tesouraria Comum')
  const [membersList, setMembersList] = useState<Member[]>([])
  const [proposer, setProposer] = useState('Alice')
  const [toName, setToName] = useState<string | null>(null)
  const [live, setLive] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    let on = true
    void (async () => {
      const ok = await health()
      if (!on) return
      setLive(ok)
      if (!ok) return
      const [v, b, bs] = await Promise.all([getVault(), getBalance(), getBeneficiaries()])
      if (!on) return
      if (v) {
        setThreshold(v.threshold)
        setVaultName(v.name)
        const first0 = v.member_list?.[0]
        if (first0) { setMembersList(v.member_list!); setProposer(first0.name) }
      }
      if (b?.configured) setAvailable(b.total_zec ?? null)
      if (bs) setBenefs(bs)
    })()
    return () => { on = false }
  }, [])

  const memoLen = memoBytes(memo)
  const memoOver = memoLen > MEMO_MAX
  const kind = to.trim().length > 1 ? classifyAddress(to.trim()) : null
  const publicDest = kind === 'transparent'
  const saplingDest = kind === 'sapling'
  const unknownDest = kind === 'unknown'
  const shownAvailable = available ?? '2.4180'

  async function submit() {
    setError(null)
    if (!to.trim()) { setError('Informe o endereço de destino.'); return }
    setBusy(true)
    const res = await createProposal({
      proposer, // the member this device is acting as (single-device demo)
      to_address: to.trim(),
      value_zec: value.trim(),
      memo: memo.trim() || undefined,
    })
    setBusy(false)
    if (res.ok) {
      nav('/proposta', { state: { id: res.proposal.id } })
    } else {
      setError(humanError(res.error, res.detail))
    }
  }

  return (
    <>
      <Letterhead right={<span className="klab back" onClick={() => nav('/painel')}>← Painel</span>} />
      <div className="page narrow">
        <h1 className="h1">Novo pagamento</h1>

        <div className="ctx">
          <span>Do cofre <b>{vaultName}</b></span>
          <span className="ctx-sep">·</span>
          <span>disponível <Secret sm><b>{shownAvailable} ZEC</b></Secret></span>
          {membersList.length > 0 && (
            <label className="ctx-as">
              propondo como
              <select value={proposer} onChange={(e) => setProposer(e.target.value)}>
                {membersList.map((m) => <option key={m.pubkey || m.name} value={m.name}>{m.name}</option>)}
              </select>
            </label>
          )}
        </div>

        {benefs.length > 0 && (
          <label className="field"><span>Pessoa (do cadastro)</span>
            <select className="input" value="" onChange={(e) => {
              const b = benefs.find((x) => x.id === e.target.value)
              if (b) { setTo(b.address); setToName(b.name); if (b.memo) setMemo(b.memo) }
            }}>
              <option value="">— escolher pelo nome, ou digite o endereço abaixo —</option>
              {benefs.map((b) => <option key={b.id} value={b.id}>{b.name}</option>)}
            </select>
          </label>
        )}

        <label className="field"><span>Para</span>
          <input className="input mono" placeholder="endereço Zcash (u1… recomendado)"
            value={to} onChange={(e) => { setTo(e.target.value); setToName(null) }} />
        </label>
        {publicDest && (
          <div className="hint warn">⚠ Endereço transparente — este pagamento fica <b>público</b> na blockchain.</div>
        )}
        {saplingDest && (
          <div className="hint warn">⚠ Endereço <b>Sapling</b> — funciona, mas o Konclave prefere <b>Orchard</b> (<span className="mono">u1…</span>) para privacidade máxima.</div>
        )}
        {unknownDest && (
          <div className="hint warn">⚠ Endereço <b>não reconhecido</b> — confira. Um endereço inválido será recusado ao propor.</div>
        )}

        <label className="field"><span>Valor</span>
          <input className="input mono" value={value} onChange={(e) => setValue(e.target.value)} />
        </label>
        {!live && <div className="hint">modo demonstração — sem o cofre local rodando</div>}

        <label className="field mt"><span>
          Memo · recibo/holerite — só o destinatário lê{' '}
          <span className={'dim ns' + (memoOver ? ' over' : '')}>({memoLen}/{MEMO_MAX})</span>
        </span>
          <input className="input" value={memo} onChange={(e) => setMemo(e.target.value)}
            disabled={publicDest} placeholder={publicDest ? 'sem memo em endereço transparente' : ''} />
        </label>

        <hr className="rule thin" />
        <div className="mono dim fee">Taxa estimada <b className="ink">0.0001 ZEC</b> · confirmada ao construir a transação</div>

        <div className="confirm mt preview">
          <div className="pv-row"><span className="pv-k">Propõe</span><span className="pv-v"><b>{proposer}</b></span></div>
          <div className="pv-row"><span className="pv-k">Paga</span><span className="pv-v"><b>{value || '—'} ZEC</b></span></div>
          <div className="pv-row"><span className="pv-k">Para</span><span className="pv-v">{toName ? <><b>{toName}</b> · {to ? shortAddr(to) : '…'}</> : (to ? shortAddr(to) : '…')}</span></div>
          {memo.trim() && !publicDest && <div className="pv-row"><span className="pv-k">Memo</span><span className="pv-v">“{memo.trim()}”</span></div>}
          <div className="pv-row"><span className="pv-k">Aprovações</span><span className="pv-v"><b>{threshold}</b> (incluindo a sua)</span></div>
        </div>
        <div className="hint">Propor <b>já conta como a aprovação de {proposer}</b> (1 de {threshold}). Nada sai antes de {threshold} {threshold === 1 ? 'aval' : 'avais'} — {threshold > 1 ? `faltará mais ${threshold - 1}` : 'já fica pronta'}.</div>

        {error && <div className="hint err mt">✗ {error}</div>}

        <div className="right mt">
          <button className="btn ok" onClick={submit} disabled={busy || memoOver}>
            {busy ? 'Propondo…' : '▸ Propor pagamento'}
          </button>
        </div>
      </div>
    </>
  )
}
