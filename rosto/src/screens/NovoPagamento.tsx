import { useEffect, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { Letterhead, Secret } from '../components'
import {
  createProposal, getBalance, getVault, health, shortAddr, classifyAddress, humanError,
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
      const [v, b] = await Promise.all([getVault(), getBalance()])
      if (!on) return
      if (v) setThreshold(v.threshold)
      if (b?.configured) setAvailable(b.total_zec ?? null)
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
      proposer: 'você', // this device's member; real member id wired with identity (fase seguinte)
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
      <Letterhead right={<span className="klab back" onClick={() => nav('/')}>← Painel</span>} />
      <div className="page narrow">
        <h1 className="h1">Novo pagamento</h1>

        <label className="field"><span>Para</span>
          <input className="input mono" placeholder="endereço Zcash (u1… recomendado)"
            value={to} onChange={(e) => setTo(e.target.value)} />
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
        <div className="hint">
          disponível para propor: <Secret sm><b>{shownAvailable} ZEC</b></Secret>
          {live ? '' : ' (modo demonstração)'}
        </div>

        <label className="field mt"><span>
          Memo · recibo/holerite — só o destinatário lê{' '}
          <span className={'dim ns' + (memoOver ? ' over' : '')}>({memoLen}/{MEMO_MAX})</span>
        </span>
          <input className="input" value={memo} onChange={(e) => setMemo(e.target.value)}
            disabled={publicDest} placeholder={publicDest ? 'sem memo em endereço transparente' : ''} />
        </label>

        <hr className="rule thin" />
        <div className="mono dim fee">Taxa estimada <b className="ink">0.0001 ZEC</b> · confirmada ao construir a transação</div>

        <div className="confirm mt">
          ⚑ Você vai <b>PROPOR</b> {value || '—'} ZEC → {to ? shortAddr(to) : '…'}.
          {' '}Precisa de <b>{threshold} aprovações</b> (incluindo a sua).
        </div>

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
