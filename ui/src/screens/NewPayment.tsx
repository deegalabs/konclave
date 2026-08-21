import { useEffect, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { Secret, Loading } from '../components'
import { PageHeader } from '../page'
import { useT, useTr } from '../i18n'
import { fmtZec, parseZecToZat, zatToZec } from '../format'
import {
  createProposal, getBalance, getVault, getBeneficiaries, health, shortAddr, classifyAddress, humanError,
  IS_DEMO, type Beneficiary, type Member,
} from '../api'
import { listVaults } from '../storage'

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
  // Neutral placeholder while the real vault name loads; the sample name only in demo, never a
  // fake name flashed to a real user (the real name replaces this as soon as getVault resolves).
  const [vaultName, setVaultName] = useState(IS_DEMO ? t('common.sampleVault') : '…')
  const [membersList, setMembersList] = useState<Member[]>([])
  const [proposer, setProposer] = useState('Alice')
  const [toName, setToName] = useState<string | null>(null)
  const [live, setLive] = useState<boolean | null>(null)
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
        if (first0) {
          setMembersList(v.member_list!)
          // Live: this device proposes as ITSELF (its own member name), never as the first seat -
          // the "act as any member" picker is a single-device DEMO artifice. Fall back to the first
          // seat only when there is no on-device record (local-bridge mode).
          let mine: string | null = null
          if (!IS_DEMO) {
            try { mine = (await listVaults()).find((s) => s.id === v.id)?.myName ?? null } catch { /* no record */ }
          }
          setProposer(mine ?? first0.name)
        }
      }
      // Spendable (not total): the send can only draw on confirmed, spendable funds, so the
      // "available" and the balance-after preview must be against spendable to catch amount+fee
      // overspend BEFORE a proposal is created (the helper rejected 0.0120 on a 0.01213 spendable).
      if (b?.configured) setAvailable(b.spendable_zec ?? b.total_zec ?? null)
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
  // A real available balance when we have it; the demo figure only when genuinely offline
  // (live === false); a neutral dash while still loading (live === null) - never a fake number.
  const shownAvailable = available ?? (IS_DEMO ? '2.4180' : '-')
  // Preview the balance after this payment (like the payroll screen). Display only - the backend
  // stays authoritative on the real fee; ~0.0001 ZEC is a reasonable single-payment estimate.
  const amountZat = parseZecToZat(value)
  const availableZat = parseZecToZat(shownAvailable)
  // ZIP-317 conservative estimate covering the change output (the real single-payment fee observed
  // on mainnet was 15000). Better to slightly over-estimate so we never let an unsendable amount
  // through to a dead-end proposal.
  const feeZat = 15000
  const afterZat = availableZat == null || amountZat == null ? null : availableZat - amountZat - feeZat
  // Amount + fee exceeds the spendable balance: block proposing, so a member never approves a
  // payment that the vault cannot actually send (the dead-end the helper rejected at build time).
  const overBalance = afterZat !== null && afterZat < 0

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
        <PageHeader title={t('payment.title')} subtitle={t('payment.cap')} />

        {live === null ? <Loading /> : (
        <div className="ctx">
          <span>{tr('payment.fromVault', { name: vaultName })}</span>
          <span className="ctx-sep">·</span>
          <span>{t('payment.available')} <Secret sm><b>{shownAvailable} ZEC</b></Secret></span>
          {membersList.length > 0 && (
            IS_DEMO ? (
              // DEMO only: one device stands in for the whole quorum, so it may act as any member.
              <label className="ctx-as">
                {t('payment.proposingAs')}
                <select value={proposer} onChange={(e) => setProposer(e.target.value)}>
                  {membersList.map((m) => <option key={m.pubkey || m.name} value={m.name}>{m.name}</option>)}
                </select>
              </label>
            ) : (
              // Live: you propose as yourself - a static label, never a member picker.
              <span className="ctx-as">{t('payment.proposingAs')} <b>{proposer}</b></span>
            )
          )}
        </div>
        )}

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
        {/* The payee registry lives here, inside the compose flow (not a rail peer): pick above, or
            open it to add/edit. */}
        <div className="mt-sm"><button type="button" className="btn ghost sm-btn" onClick={() => nav('/people')}>{t('people.manage')}</button></div>

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
        {IS_DEMO && <div className="hint" aria-live="polite">{t('common.demoModeNoBridge')}</div>}

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
          <div className="pv-row"><span className="pv-k">{t('payment.pvPays')}</span><span className="pv-v"><b>{value || '-'} ZEC</b></span></div>
          <div className="pv-row"><span className="pv-k">{t('payment.pvTo')}</span><span className="pv-v">{toName ? <><b>{toName}</b> · {to ? shortAddr(to) : '…'}</> : (to ? shortAddr(to) : '…')}</span></div>
          {memo.trim() && !publicDest && <div className="pv-row"><span className="pv-k">{t('payment.pvMemo')}</span><span className="pv-v">“{memo.trim()}”</span></div>}
          <div className="pv-row"><span className="pv-k">{t('payment.pvApprovals')}</span><span className="pv-v"><b>{threshold}</b> {t('payment.includingYours')}</span></div>
          <div className="pv-row"><span className="pv-k">{t('payroll.pvAfter')}</span><span className="pv-v">{afterZat === null ? <b className="dim">-</b> : <Secret sm><b>{fmtZec(zatToZec(afterZat))}</b></Secret>}</span></div>
        </div>
        {overBalance && <div className="hint warn mt-sm">{t('payment.warnOverBalance')}</div>}
        <div className="hint">{tr('payment.approvalHint', { proposer, threshold, rest: threshold > 1 ? t('payment.approvalHintMore', { n: threshold - 1 }) : t('payment.approvalHintReady'), aval: threshold === 1 ? t('payment.avalSingular') : t('payment.avalPlural') })}</div>

        {error && <div className="hint err mt" role="alert">{error}</div>}

        <div className="right mt">
          <button className="btn ok" onClick={submit} disabled={busy || memoOver || overBalance || !to.trim() || !(parseFloat(String(value).replace(',', '.')) > 0)}>
            {busy ? t('payment.proposing') : t('payment.proposeBtn')}
          </button>
        </div>
      </main>
    </>
  )
}
