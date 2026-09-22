import { useEffect, useState } from 'react'
import { usePoll } from '../usePoll'
import { useNavigate } from 'react-router-dom'
import { Loading } from '../components'
import { PageHeader } from '../page'
import { useT, useTr } from '../i18n'
import { useToast } from '../toast'
import { fmtZecExact, parseZecToZat, zatToZec } from '../format'
import { freeZatOf, reservedZatOf } from '../balance-parts'
import { isOpen } from '../desk'
import {
  createProposal, getBalance, getVault, getBeneficiaries, getProposals, health, shortAddr, classifyAddress, humanError,
  type Balance, type Beneficiary, type Member, type Proposal,
} from '../api'
import { listVaults } from '../storage'
import { RecipientCombobox } from '../RecipientCombobox'
import { usdEnabled, setUsdEnabled, cachedRate, rateIsStale, fetchRate, zecToUsd, type Rate } from '../price'
import { proposeBlock, blockMessageKey, poolsOf, SINGLE_PAYMENT_FEE_ZAT } from '../propose-guard'

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
  // The balance object and the ledger, kept RAW so "available" is derived rather than stored.
  // Storing a single string was how this screen came to mean something different by "available"
  // than the Dashboard did: the Dashboard subtracts what open proposals hold, this one did not,
  // and the screen that CREATES payments held the more permissive meaning.
  const [bal, setBal] = useState<Balance | null>(null)
  const [openProps, setOpenProps] = useState<Proposal[] | null>(null)
  // #427: the two shielded pools separately. `spendable` is their sum, and one payment cannot
  // always spend the sum.
  const [pools, setPools] = useState<ReturnType<typeof poolsOf>>(undefined)
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
      if (b?.configured) { setBal(b); setPools(poolsOf(b)) }
      void getProposals().then((ps) => { if (on) setOpenProps(ps) })
      if (bs) setBenefs(bs)
    })()
    return () => { on = false }
  }, [])

  // The balance refreshes on its own, on the shared cadence the other screens use.
  //
  // Without this the screen read the balance ONCE, at mount. Every block it can show - no funds,
  // not enough, balance unknown - was therefore permanent until the member thought to reload, and
  // the screen gave them no reason to think so. Someone waiting for a deposit to confirm sat in
  // front of a Propose button that would have worked minutes ago.
  //
  // A disabled money control has to watch the condition that disabled it, or it is not a block, it
  // is a dead end.
  usePoll(() => {
    void getBalance().then((b) => {
      if (!b?.configured) return
      setBal(b)
      setPools(poolsOf(b))
    })
    // The ledger too: funds are released when someone else's proposal is sent or refused, and a
    // member blocked by a reservation must see it lift without reloading.
    void getProposals().then(setOpenProps)
  }, 12_000)

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
  // What a NEW payment may draw on, from the ONE function the Dashboard also uses. Not
  // `spendable`: that is the number this screen used to show while the Dashboard was telling the
  // member the vault could not pay.
  const reservedZat = reservedZatOf(openProps)
  // Named, not counted: "0.0004 held by Zka's proposal" tells the member who to go and ask. A bare
  // number tells them only that they are stuck.
  const openHolding = (openProps ?? []).filter(isOpen).map((x) => x.proposer).join(', ')
  const freeZat = freeZatOf(bal, openProps)
  const shownAvailable = freeZat == null ? '-' : fmtZecExact(freeZat / 1e8)
  // Preview the balance after this payment (like the payroll screen). Display only - the backend
  // stays authoritative on the real fee; ~0.0001 ZEC is a reasonable single-payment estimate.
  const amountZat = parseZecToZat(value)
  const availableZat = freeZat
  // ZIP-317 conservative estimate covering the change output (the real single-payment fee observed
  // on mainnet was 15000). Better to slightly over-estimate so we never let an unsendable amount
  // through to a dead-end proposal.
  const feeZat = SINGLE_PAYMENT_FEE_ZAT
  const afterZat = availableZat == null || amountZat == null ? null : availableZat - amountZat - feeZat
  // A fraction of the balance is only a real offer when a fraction of it can actually be sent:
  // known, above zero, and with room for the fee that 100% has to leave behind.
  const canTakeFraction = availableZat != null && availableZat > feeZat
  // The submit gate is a pure rule (`propose-guard.ts`) shared with the payroll screen, because it
  // used to live inline in both and FAIL OPEN in both: any figure that would not parse made the
  // over-balance test false, which the screen read as "all clear". A balance we cannot read and an
  // amount we cannot parse now block instead of waving the payment through.
  const block = proposeBlock({ amountZat, availableZat, feeZat, memoOver, pools, reservedZat })
  const overBalance = block === 'over-balance'

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

  // `block === null` covers memo, amount and balance. The amount check used to be a looser
  // `parseFloat(value.replace(',', '.')) > 0`, which accepted a comma decimal that `parseZecToZat`
  // rejects - so the button enabled for an amount the rest of the code could not read.
  const canSubmit = !busy && block === null && !!to.trim()

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
                {/* Disabled when there is NOTHING to take a fraction of, not merely when the
                    balance is unknown. At zero spendable these four stayed live and did nothing:
                    `setFraction` computed a target of zero (or minus the fee) and set no amount.
                    Four controls that respond to a click by doing nothing, on a money screen, is
                    worse than four that are visibly unavailable. */}
                {[25, 50, 75].map((p) => (
                  <button key={p} type="button" className="payamt-max" disabled={!canTakeFraction}
                    onClick={() => setFraction(p)}>{p}%</button>
                ))}
                <button type="button" className="payamt-max" disabled={!canTakeFraction}
                  onClick={() => setFraction(100)}>{t('payment.max')}</button>
              </span>
            </div>
          </label>
          {live === false && <div className="hint" aria-live="polite">{t('common.vaultUnreachable')}</div>}

          <label className="field mt"><span>
            {t('payment.memoLabel')}{' '}
            <span className={'dim ns num' + (memoOver ? ' over' : '')}>({memoLen}/{MEMO_MAX})</span>
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
            <div className="pv-fee mono dim">{tr('payment.feeEstimate', { fee: fmtZecExact(feeZat / 1e8) })}</div>
          </div>

          {overBalance && <div className="hint warn mt-sm">{t('payment.warnOverBalance')}</div>}
          {/* The gate fails closed now, so a member can meet a disabled button for reasons the
              screen used to stay silent about. Say which one - but never on an untouched form:
              an empty amount also parses to null, and a warning on a blank field is noise. */}
          {value.trim() !== '' && blockMessageKey(block) && (
            <div className="hint warn mt-sm">{t(blockMessageKey(block)!, {
              free: fmtZecExact((freeZat ?? 0) / 1e8),
              reserved: fmtZecExact(reservedZat / 1e8),
              held: String(openHolding),
            })}</div>
          )}
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
