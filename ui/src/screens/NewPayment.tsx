import { useEffect, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { Loading } from '../components'
import { PageHeader } from '../page'
import { useT, useTr } from '../i18n'
import { useToast } from '../toast'
import { fmtZecExact, parseZecToZat, zatToZec } from '../format'
import {
  createProposal, getBalance, getVault, getBeneficiaries, health, shortAddr, classifyAddress, humanError,
  type Beneficiary, type Member,
} from '../api'
import { listVaults } from '../storage'
import { RecipientCombobox } from '../RecipientCombobox'
import { usdEnabled, setUsdEnabled, cachedRate, rateIsStale, fetchRate, zecToUsd, type Rate } from '../price'

const MEMO_MAX = 512

function memoBytes(s: string): number {
  return new TextEncoder().encode(s).length
}

export default function NewPayment() {
  const t = useT()
  const toast = useToast()
  const tr = useTr()
  const nav = useNavigate()
  const [to, setTo] = useState('')
  const [value, setValue] = useState('') // never prefill an amount — the one field with financial consequence
  const [memo, setMemo] = useState('')
  const [threshold, setThreshold] = useState(2)
  const [available, setAvailable] = useState<string | null>(null)
  const [benefs, setBenefs] = useState<Beneficiary[]>([])
  // Neutral placeholder while the real vault name loads - never a fake name flashed to a real
  // user (the real name replaces this as soon as getVault resolves).
  const [vaultName, setVaultName] = useState('…')
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
          // This device proposes as ITSELF (its own member name), never as another seat. Fall back
          // to the first seat only when there is no on-device record (local-bridge mode).
          let mine: string | null = null
          try { mine = (await listVaults()).find((s) => s.id === v.id)?.myName ?? null } catch { /* no record */ }
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

  // Refresh the payee list after one is added inline from the recipient field.
  const reloadBenefs = () => { void getBeneficiaries().then((b) => { if (b) setBenefs(b) }) }

  // Live ZEC->USD estimate on the amount (opt-in + disclosed, mirrors the Dashboard). Off until the
  // user turns it on; the source is named; at most one call per TTL. Never sends the amount.
  const [usdOn, setUsdOn] = useState<boolean>(usdEnabled())
  const [rate, setRate] = useState<Rate | null>(cachedRate())
  const [rateBusy, setRateBusy] = useState(false)
  async function refreshRate() {
    setRateBusy(true)
    const r = await fetchRate()
    setRateBusy(false)
    if (r) setRate(r)
  }
  function enableUsd() { setUsdEnabled(true); setUsdOn(true); void refreshRate() }
  useEffect(() => { if (usdOn && rateIsStale(cachedRate())) void refreshRate() }, [usdOn])
  const rateAgo = (r: Rate) => {
    const m = Math.max(0, Math.round((Date.now() - r.at) / 60000))
    // Plain string (t), NOT tr — this is interpolated into a template literal; a React node would
    // stringify to "[object Object]".
    return m < 1 ? t('payment.rateNow') : t('payment.rateAgo', { m })
  }
  /// Quick amounts. 100% is "everything the vault can actually send", i.e. spendable minus the
  /// fee - anything else would be rejected as an overspend. The smaller fractions are of the
  /// spendable balance (the fee still comes out of the vault on top, and the balance-after
  /// preview below shows the real remainder).
  function setFraction(pct: number) {
    if (availableZat == null) return
    const target = pct >= 100 ? availableZat - feeZat : Math.floor((availableZat * pct) / 100)
    if (target > 0) setValue(zatToZec(target))
  }

  const memoLen = memoBytes(memo)
  const memoOver = memoLen > MEMO_MAX
  const kind = to.trim().length > 1 ? classifyAddress(to.trim()) : null
  const publicDest = kind === 'transparent' // still drives the memo-disable (transparent = no memo)
  // A real available balance when we have it; a neutral dash otherwise - never a fake number.
  const shownAvailable = available ?? '-'
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
      proposer, // the member seat this device holds
      to_address: to.trim(),
      value_zec: value.trim(),
      memo: memo.trim() || undefined,
    })
    setBusy(false)
    if (res.ok) {
      // We navigate away, so the confirmation has to travel with the reader.
      toast.ok(t('toast.paymentSent'))
      nav('/proposal', { state: { id: res.proposal.id } })
    } else {
      const msg = humanError(t, res.error, res.detail)
      setError(msg)
      toast.err(msg)
    }
  }

  const canSubmit = !busy && !memoOver && !overBalance && !!to.trim() && parseFloat(String(value).replace(',', '.')) > 0

  return (
    <main className="page pay">
      <PageHeader title={t('payment.title')} subtitle={t('payment.cap')} />

      {live === null ? <Loading /> : (<>
      <div className="ctx">
        <span>{tr('payment.fromVault', { name: vaultName })}</span>
        <span className="ctx-sep">·</span>
        {/* Was veiled here and printed in the clear 40px lower, beside the 25/50/75/Max controls -
            which cost the friction of a toggle and protected nothing, since the same figure was
            readable further down the page. You cannot responsibly choose an amount without seeing
            what there is, so on a compose screen it reads. The veil governs the surfaces that
            merely DISPLAY the vault (Dashboard, Ledger, proposals). */}
        <span>{t('payment.available')} <b className="num">{shownAvailable} ZEC</b></span>
        {membersList.length > 0 && (
          <span className="ctx-as">{t('payment.proposingAs')} <b>{proposer}</b></span>
        )}
      </div>

      <div className="pay-cols">
        {/* LEFT: the form you fill in. */}
        <div className="pay-form">
          {/* One "To" field: search saved payees, paste an address, add a new one inline. */}
          <label className="field mt0"><span>{t('payment.to')}</span>
            <RecipientCombobox
              benefs={benefs}
              address={to}
              name={toName}
              onChange={(r) => { setTo(r.address); setToName(r.name); if (r.memo) setMemo(r.memo) }}
              onReloadBenefs={reloadBenefs}
            />
          </label>

          <label className="field"><span>{t('payment.value')}</span>
            <div className="payamt">
              <input className="payamt-in mono" inputMode="decimal" value={value} placeholder="0.00" onChange={(e) => setValue(e.target.value)} />
              <span className="payamt-unit">ZEC</span>
            </div>
            <div className="payamt-meta">
              {usdOn ? (
                <>
                  <span className="payamt-echo">{zecToUsd(value, rate) ? `≈ ${zecToUsd(value, rate)}` : '≈ $-'}</span>
                  <span className="payamt-rate">
                    <span className="payamt-live" aria-hidden="true" />
                    {rate ? `${rate.source} · ${rateAgo(rate)}${rateIsStale(rate) ? ` · ${t('dashboard.rateStale')}` : ''}` : t('dashboard.rateNone')}
                    {' · '}<button type="button" className="linkbtn" onClick={() => void refreshRate()} disabled={rateBusy}>{rateBusy ? t('dashboard.updating') : t('dashboard.refresh')}</button>
                  </span>
                </>
              ) : (
                <button type="button" className="linkbtn" onClick={enableUsd} title={t('dashboard.usdDisclosure')}>{t('dashboard.showUsd')} ≈</button>
              )}
              <span className="payamt-avail">
                {t('payment.available')} <b className="num">{shownAvailable}</b> ZEC
              </span>
              <span className="payamt-quick">
                {[25, 50, 75].map((p) => (
                  <button key={p} type="button" className="payamt-max" disabled={availableZat == null}
                    onClick={() => setFraction(p)}>{p}%</button>
                ))}
                <button type="button" className="payamt-max" disabled={availableZat == null}
                  onClick={() => setFraction(100)}>{t('payment.max')}</button>
              </span>
            </div>
          </label>
          {live === false && <div className="hint" aria-live="polite">{t('common.vaultUnreachable')}</div>}

          <label className="field mt"><span>
            {t('payment.memoLabel')}{' '}
            <span className={'dim ns' + (memoOver ? ' over' : '')}>({memoLen}/{MEMO_MAX})</span>
          </span>
            <input className="input" value={memo} onChange={(e) => setMemo(e.target.value)}
              disabled={publicDest} placeholder={publicDest ? t('payment.memoDisabledPlaceholder') : ''} />
          </label>
        </div>

        {/* RIGHT: the review/orientation card — what your co-signers will see, plus fee + guidance. */}
        <aside className="pay-review">
          <div className="preview">
            <div className="pv-tag">◆ {t('payment.reviewTag')}</div>
            <div className="pv-row"><span className="pv-k">{t('payment.pvProposes')}</span><span className="pv-v"><b>{proposer}</b></span></div>
            <div className="pv-row"><span className="pv-k">{t('payment.pvPays')}</span><span className="pv-v"><b>{value || '-'} ZEC</b>{usdOn && zecToUsd(value, rate) ? <span className="pv-usd"> ≈ {zecToUsd(value, rate)}</span> : null}</span></div>
            <div className="pv-row"><span className="pv-k">{t('payment.pvTo')}</span><span className="pv-v">{toName ? <><b>{toName}</b> · {to ? shortAddr(to) : '…'}</> : (to ? shortAddr(to) : '…')}</span></div>
            {memo.trim() && !publicDest && <div className="pv-row"><span className="pv-k">{t('payment.pvMemo')}</span><span className="pv-v">“{memo.trim()}”</span></div>}
            <div className="pv-row"><span className="pv-k">{t('payment.pvApprovals')}</span><span className="pv-v"><b>{threshold}</b> {t('payment.includingYours')}</span></div>
            <div className="pv-row"><span className="pv-k">{t('payroll.pvAfter')}</span><span className="pv-v">{afterZat === null ? <b className="dim">-</b> : <b className="num">{fmtZecExact(afterZat / 1e8)}</b>}</span></div>
            <div className="pv-fee mono dim">{tr('payment.feeEstimate')}</div>
          </div>

          {overBalance && <div className="hint warn mt-sm">{t('payment.warnOverBalance')}</div>}
          <div className="hint mt-sm">{tr('payment.approvalHint', { proposer, threshold, rest: threshold > 1 ? t('payment.approvalHintMore', { n: threshold - 1 }) : t('payment.approvalHintReady'), aval: threshold === 1 ? t('payment.avalSingular') : t('payment.avalPlural') })}</div>
          {error && <div className="hint err mt-sm" role="alert">{error}</div>}

          <button className="btn ok pay-submit mt" onClick={submit} disabled={!canSubmit}>
            {busy ? t('payment.proposing') : t('payment.proposeBtn')}
          </button>
        </aside>
      </div>
      </>)}
    </main>
  )
}
