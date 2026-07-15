import { useEffect, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { Secret } from '../components'
import { useT, useTr } from '../i18n'
import {
  createProposal, getBalance, getVault, getBeneficiaries, health, shortAddr, classifyAddress, humanError,
  type Beneficiary, type Member,
} from '../api'

const MEMO_MAX = 512

function memoBytes(s: string): number {
  return new TextEncoder().encode(s).length
}

export default function NewPayment() {
  const t = useT()
  const tr = useTr()
  const nav = useNavigate()
  const [to, setTo] = useState('')
  const [value, setValue] = useState('0.5')
  const [memo, setMemo] = useState('')
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
    if (!to.trim()) { setError(t('payment.errNoAddress')); return }
    setBusy(true)
    const res = await createProposal({
      proposer, // the member this device is acting as (single-device demo)
      to_address: to.trim(),
      value_zec: value.trim(),
      memo: memo.trim() || undefined,
    })
    setBusy(false)
    if (res.ok) {
      nav('/proposal', { state: { id: res.proposal.id } })
    } else {
      setError(humanError(t, res.error, res.detail))
    }
  }

  return (
    <>
      <main className="page narrow">
        <h1 className="h1">{t('payment.title')}</h1>

        <div className="ctx">
          <span>{tr('payment.fromVault', { name: vaultName })}</span>
          <span className="ctx-sep">·</span>
          <span>{t('payment.available')} <Secret sm><b>{shownAvailable} ZEC</b></Secret></span>
          {membersList.length > 0 && (
            <label className="ctx-as">
              {t('payment.proposingAs')}
              <select value={proposer} onChange={(e) => setProposer(e.target.value)}>
                {membersList.map((m) => <option key={m.pubkey || m.name} value={m.name}>{m.name}</option>)}
              </select>
            </label>
          )}
        </div>

        {benefs.length > 0 && (
          <label className="field"><span>{t('payment.personFromRegistry')}</span>
            <select className="input" value="" onChange={(e) => {
              const b = benefs.find((x) => x.id === e.target.value)
              if (b) { setTo(b.address); setToName(b.name); if (b.memo) setMemo(b.memo) }
            }}>
              <option value="">{t('payment.chooseByName')}</option>
              {benefs.map((b) => <option key={b.id} value={b.id}>{b.name}</option>)}
            </select>
          </label>
        )}

        <label className="field"><span>{t('payment.to')}</span>
          <input className="input mono" placeholder={t('payment.addrPlaceholder')}
            value={to} onChange={(e) => { setTo(e.target.value); setToName(null) }} />
        </label>
        {publicDest && (
          <div className="hint warn">{tr('payment.warnTransparent')}</div>
        )}
        {saplingDest && (
          <div className="hint warn">{tr('payment.warnSaplingA')} (<span className="mono">u1…</span>) {tr('payment.warnSaplingB')}</div>
        )}
        {unknownDest && (
          <div className="hint warn">{tr('payment.warnUnknown')}</div>
        )}

        <label className="field"><span>{t('payment.value')}</span>
          <input className="input mono" value={value} onChange={(e) => setValue(e.target.value)} />
        </label>
        {!live && <div className="hint" aria-live="polite">{t('common.demoModeNoBridge')}</div>}

        <label className="field mt"><span>
          {t('payment.memoLabel')}{' '}
          <span className={'dim ns' + (memoOver ? ' over' : '')}>({memoLen}/{MEMO_MAX})</span>
        </span>
          <input className="input" value={memo} onChange={(e) => setMemo(e.target.value)}
            disabled={publicDest} placeholder={publicDest ? t('payment.memoDisabledPlaceholder') : ''} />
        </label>

        <hr className="rule thin" />
        <div className="mono dim fee">{tr('payment.feeEstimate')}</div>

        <div className="confirm mt preview">
          <div className="pv-row"><span className="pv-k">{t('payment.pvProposes')}</span><span className="pv-v"><b>{proposer}</b></span></div>
          <div className="pv-row"><span className="pv-k">{t('payment.pvPays')}</span><span className="pv-v"><b>{value || '—'} ZEC</b></span></div>
          <div className="pv-row"><span className="pv-k">{t('payment.pvTo')}</span><span className="pv-v">{toName ? <><b>{toName}</b> · {to ? shortAddr(to) : '…'}</> : (to ? shortAddr(to) : '…')}</span></div>
          {memo.trim() && !publicDest && <div className="pv-row"><span className="pv-k">{t('payment.pvMemo')}</span><span className="pv-v">“{memo.trim()}”</span></div>}
          <div className="pv-row"><span className="pv-k">{t('payment.pvApprovals')}</span><span className="pv-v"><b>{threshold}</b> {t('payment.includingYours')}</span></div>
        </div>
        <div className="hint">{tr('payment.approvalHint', { proposer, threshold, rest: threshold > 1 ? t('payment.approvalHintMore', { n: threshold - 1 }) : t('payment.approvalHintReady'), aval: threshold === 1 ? t('payment.avalSingular') : t('payment.avalPlural') })}</div>

        {error && <div className="hint err mt" role="alert">{error}</div>}

        <div className="right mt">
          <button className="btn ok" onClick={submit} disabled={busy || memoOver || !to.trim()}>
            {busy ? t('payment.proposing') : t('payment.proposeBtn')}
          </button>
        </div>
      </main>
    </>
  )
}
