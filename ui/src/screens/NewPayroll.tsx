import { useEffect, useState } from 'react'
import { usePoll } from '../usePoll'
import { confirmingZatOf, freeZatOf, reservedZatOf, shortfallIsConfirming } from '../balance-parts'
import { isOpen } from '../desk'
import { SkeletonForm, SkeletonRows } from '../skeleton'
import { useNavigate } from 'react-router-dom'
import { Secret, activateOnKey, Soon } from '../components'
import { PageHeader } from '../page'
import { amountAmbiguous, amountTyped, fmtZec, fmtZecExact, typedAmountZat, zatToZec } from '../format'
import { estimatedFeeZat } from '../fee-estimate'
import { useT, useTr } from '../i18n'
import { useToast } from '../toast'
import {
  previewPayroll, createPayroll, getBeneficiaries, getLedger, getProposals, getVault, health, classifyAddress, addressRefusal, humanError, IS_NET,
  type Beneficiary, type Proposal, type Member,
} from '../api'
import { listVaults } from '../storage'
import { RecipientCombobox } from '../RecipientCombobox'
import { usdEnabled, setUsdEnabled, cachedRate, rateIsStale, fetchRate, zecToUsd, type Rate } from '../price'
import { proposeBlock, blockMessageKey, poolsOf } from '../propose-guard'
import { useVaultBalance } from '../useVaultBalance'

const DRAFT_KEY = 'konclave.folha.rascunho'

type Row = { label: string; address: string; value: string; memo: string }
const emptyRow = (): Row => ({ label: '', address: '', value: '', memo: '' })


// A blocking problem with a row (null = ok); returns an i18n key. The public-address warning is
// separate (the memo placeholder says it). Exported for its test; it is pure.
export function rowIssue(r: Row): string | null {
  if (!r.address.trim()) return 'payroll.issueEmpty'
  const k = classifyAddress(r.address.trim())
  // (#294): the coordinator refuses a Sapling line for the whole sheet. Said on the line, before the
  // sheet is composed, by the same rule the payment screen asks.
  const refused = addressRefusal(r.address.trim())
  if (refused === 'unknown') return 'payroll.issueUnknown'
  if (refused === 'sapling') return 'payroll.cellSapling'
  if (amountAmbiguous(r.value)) return 'money.blockAmountAmbiguous'
  const zat = typedAmountZat(r.value)
  if (zat === null || zat <= 0) return 'payroll.issueInvalid'
  if (k === 'transparent' && r.memo.trim()) return 'payroll.issueMemoPublic'
  return null
}
const rowTouched = (r: Row) => !!(r.address.trim() || r.value.trim() || r.label.trim() || r.memo.trim())

export default function NewPayroll() {
  const t = useT()
  const toast = useToast()
  const tr = useTr()
  const nav = useNavigate()
  const [competencia, setCompetencia] = useState('')
  const [description, setDescription] = useState('')
  const [rows, setRows] = useState<Row[]>([emptyRow()])
  const [showImport, setShowImport] = useState(false)
  const [csv, setCsv] = useState('')
  // The same balance the payment screen reads, refreshed on the same cadence (useVaultBalance): this
  // screen used to read it once, so a payroll opened while the wallet was busy stayed blocked.
  const { bal, busy: walletBusy } = useVaultBalance()
  // What this payroll may draw on, from the ONE function Pay and the Dashboard use (#293): spendable
  // minus what open proposals already hold. This screen read `spendable_zat` on its own, so two
  // payrolls against the same funds both validated and the second died at build.
  const [openProps, setOpenProps] = useState<Proposal[] | null>(null)
  const reservedZat = reservedZatOf(openProps)
  const openHolding = [...new Set((openProps ?? []).filter(isOpen).map((x) => x.proposer))].join(', ')
  const balanceZat = freeZatOf(bal, openProps)
  // Funds that are merely confirming, derived (total minus spendable): never `pending_zat`, which
  // the web path does not fill (#352).
  const confirmingZat = confirmingZatOf(bal)
  // #427: the two shielded pools separately. `spendable` is their sum, and one payment cannot
  // always spend the sum.
  const pools = bal ? poolsOf(bal) : undefined
  const [benefs, setBenefs] = useState<Beneficiary[]>([])
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [saved, setSaved] = useState(false)
  const [pastFolhas, setPastFolhas] = useState<Proposal[]>([])
  // Neutral placeholder while the real vault name loads (never a fake name).
  const [vaultName, setVaultName] = useState('…')
  const [membersList, setMembersList] = useState<Member[]>([])
  const [proposer, setProposer] = useState('Alice')
  const [loaded, setLoaded] = useState(false)

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
        const [bs, led, v] = await Promise.all([getBeneficiaries(), getLedger(), getVault()])
        if (!on) return
        void getProposals().then((ps) => { if (on) setOpenProps(ps) })
        if (bs) setBenefs(bs)
        if (led) setPastFolhas(led.filter((x) => x.kind === 'payroll'))
        if (v) {
          setVaultName(v.name)
          const first0 = v.member_list?.[0]
          if (first0) {
            setMembersList(v.member_list!)
            // Propose as THIS device's own member (never another seat). Fall back to the first
            // seat only without an on-device record.
            let mine: string | null = null
            try { mine = (await listVaults()).find((s) => s.id === v.id)?.myName ?? null } catch { /* no record */ }
            setProposer(mine ?? first0.name)
          }
        }
      }
      if (on) setLoaded(true)
    })()
    return () => { on = false }
  }, [])

  // Live ZEC->USD estimate on the total (opt-in + disclosed, mirrors /pay and the Dashboard). Off
  // until the user turns it on; the source is named; at most one call per TTL. Never sends amounts.
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

  function updateRow(i: number, patch: Partial<Row>) {
    setRows((prev) => prev.map((r, idx) => (idx === i ? { ...r, ...patch } : r)))
  }
  const addRow = () => setRows((prev) => [...prev, emptyRow()])
  const removeRow = (i: number) => setRows((prev) => (prev.length > 1 ? prev.filter((_, idx) => idx !== i) : [emptyRow()]))
  // Funds are released when someone else's proposal is sent or refused, and a payroll blocked by a
  // reservation must see it lift without a reload: the same cadence as the balance and as Pay.
  usePoll(() => {
    // A failed read answers null; the last list is kept, or a dropped tick would erase the
    // reservation and enable the button for the double-commit this exists to stop.
    void getProposals().then((ps) => { if (ps) setOpenProps(ps) })
  }, 12_000)

  const reloadBenefs = () => { void getBeneficiaries().then((b) => { if (b) setBenefs(b) }) }

  async function importCsv() {
    setError(null)
    const p = await previewPayroll(csv)
    if (!p) { setError(t('payroll.errCsvRead')); return }
    const imported: Row[] = p.lines.map((l) => ({
      label: l.label ?? '', address: l.address, value: l.value_zec, memo: l.memo,
    }))
    setRows(imported.length ? imported : [emptyRow()])
    setShowImport(false)
    const e0 = p.errors[0]
    if (e0) {
      // Rejected rows stay inline: they name a row number the reader has to go and fix.
      setError(t('payroll.errCsvRows', { count: p.errors.length, row: e0.row, reason: e0.reason }))
      toast.warn(t('toast.csvPartial', { ok: imported.length, bad: p.errors.length }))
    } else if (imported.length) {
      toast.ok(t('toast.csvImported', { n: imported.length }))
    }
  }

  // Live aggregates over the valid rows.
  const validRows = rows.filter((r) => rowTouched(r) && rowIssue(r) === null)
  const count = validRows.length
  const totalZat = validRows.reduce((acc, r) => acc + (typedAmountZat(r.value) ?? 0), 0)
  // ZIP-317: 5000 zat per logical action, minimum 2. `max(spends, outputs)` - one spend, N lines
  // plus change - which is what EVERY successful send has actually been charged:
  //
  //   payment, 1 destination   1 spend + 2 outputs   fee 10000   max(1,2)=2
  //   payroll, 2 lines         1 spend + 3 outputs   fee 15000   max(1,3)=3
  //
  // I briefly changed this to spends+outputs on the strength of one refusal - a 2-line payroll of
  // 4000 zat against a 20000 balance came back `InsufficientFunds { available: 20000, required:
  // 24000 }`, implying four actions. The very same payroll then went through against a larger
  // balance at 15000, three actions. Same outputs, different answer: the refusal is not explained
  // by the action count, and one data point was not enough to move the formula. It is back to what
  // matches every send that worked, and the outlier is recorded in #206.
  //
  // This is an ESTIMATE and always will be: only the wallet knows its note selection. The gate that
  // can actually be right is the helper's, using build_unproven before anyone signs (#293).
  const feeZat = count > 0 ? estimatedFeeZat(count) : 0
  // What batching is worth, in the vault's own money. Paying these N people one at a time is N
  // transactions of two actions each; one payroll is a single spend, N outputs and change. The
  // saving grows toward half as N grows, and it is the whole reason this screen exists - so it is
  // stated rather than left for the reader to work out from a fee they cannot see the shape of.
  const soloFeeZat = count > 0 ? count * 5000 * 2 : 0
  const savedZat = Math.max(0, soloFeeZat - feeZat)

  const afterZat = balanceZat === null ? null : balanceZat - totalZat - feeZat
  // Same pure gate as the payment screen (`propose-guard.ts`). This screen had the identical
  // fail-open: a balance we could not read left `overBalance` false, and the payroll submitted
  // against an unknown balance.
  const block = proposeBlock({ amountZat: totalZat, availableZat: balanceZat, feeZat, pools, reservedZat })
  // When the whole shortfall is confirmations, say that, not "exceeds the balance" (#352).
  const onlyConfirming = (block === 'over-balance' || block === 'no-funds') && shortfallIsConfirming(bal, reservedZat, totalZat, feeZat)
  const overBalance = block === 'over-balance' && !onlyConfirming
  // The "after" figure subtracts from FREE funds; while a reservation or confirmations are the
  // block, a negative figure beside "the vault has the funds" would contradict it: a dash.
  const hideAfter = block === 'reserved' || onlyConfirming
  // One sentence for the block, composed once, in one live region the button points at (same
  // shape as Pay). The reserved clause stays when both a reservation and confirmations stand.
  const moneyVars = { free: fmtZecExact((balanceZat ?? 0) / 1e8), reserved: fmtZecExact(reservedZat / 1e8), held: String(openHolding) }
  const anyBadTouched = rows.some((r) => rowTouched(r) && rowIssue(r) !== null)
  const blockMsg = (() => {
    // A flagged line disables the button too; say so here, where the button points, instead of
    // leaving a greyed button and a red line to find above it.
    if (anyBadTouched) return t('payroll.errFixRows')
    if (count === 0 || block === null) return null
    if (walletBusy && block === 'balance-unknown') return null
    if (onlyConfirming) return [reservedZat > 0 ? t('money.blockReserved', moneyVars) : null, t('money.blockConfirming', { confirming: fmtZecExact((confirmingZat ?? 0) / 1e8) })].filter(Boolean).join(' ')
    if (block === 'over-balance') return t('payroll.warnExceeds')
    const k = blockMessageKey(block)
    return k ? t(k, moneyVars) : null
  })()
  const canSubmit = count > 0 && !anyBadTouched && !busy && block === null

  async function submit() {
    setError(null)
    if (count === 0) { setError(t('payroll.errNoRows')); return }
    if (anyBadTouched) { setError(t('payroll.errFixRows')); return }
    setBusy(true)
    const desc = competencia.trim()
      ? `${t('payroll.docPrefix')} · ${competencia.trim()}${description.trim() ? ` · ${description.trim()}` : ''}`
      : (description.trim() || undefined)
    const res = await createPayroll(
      proposer,
      validRows.map((r) => ({ label: r.label || undefined, address: r.address.trim(), value_zec: amountTyped(r.value), memo: r.memo || undefined })),
      desc,
    )
    setBusy(false)
    if (res.ok) {
      localStorage.removeItem(DRAFT_KEY)
      // We navigate away, so the confirmation has to travel with the reader.
      toast.ok(t('toast.payrollSent'))
      nav('/proposal', { state: { id: res.proposal.id } })
    } else {
      const msg = humanError(t, res.error, res.detail)
      setError(msg)
      toast.err(msg)
    }
  }

  return (
    <>
      <main className="page pay">
        <PageHeader
          title={t('payroll.title')}
          subtitle={<>{t('payroll.cap')} {saved && <span className="draft-note" title={t('payroll.draftSavedTitle')} aria-live="polite">{t('payroll.draftSaved')}</span>}</>}
        />

        {!loaded ? <><SkeletonForm fields={2} inline /><SkeletonRows n={2} compact status={false} /></> : (<>
        <div className="ctx">
          <span>{tr('payment.fromVault', { name: vaultName })}</span>
          {membersList.length > 0 && (
            <span className="ctx-as">{t('payment.proposingAs')} <b>{proposer}</b></span>
          )}
        </div>

        {/* A payroll is a DOCUMENT, so it is laid out as one: full width for the lines, and the
            totals at the foot where a document's totals belong. The side rail this replaces was
            taking 40% of the page from the one thing that needs room - the table - leaving the
            recipient chip wrapping onto three lines beside a 96px value box. */}
        <div className="payroll-doc">
          <div className="doc-head">
            <label className="field inline"><span>{t('payroll.competence')}</span>
              <input className="input mono" placeholder={t('payroll.competencePlaceholder')} value={competencia} onChange={(e) => setCompetencia(e.target.value)} />
            </label>
            <label className="field inline wide"><span>{t('payroll.description')}</span>
              <input className="input" placeholder={t('payroll.descriptionPlaceholder')} value={description} onChange={(e) => setDescription(e.target.value)} />
            </label>
          </div>

          {/* Each line uses the same recipient combobox as /pay (search a payee, paste, add inline).
              A div-grid (not a table) so the combobox dropdown can overflow the row freely. */}
          <div className="plr-head"><span>#</span><span>{t('payroll.colRecipient')}</span><span>{t('payroll.colValue')}</span><span>{t('payroll.colMemo')}</span><span aria-hidden="true"></span></div>
          <div className="plr-list">
            {rows.map((r, i) => {
              const k = r.address.trim().length > 1 ? classifyAddress(r.address.trim()) : null
              const issue = rowTouched(r) ? rowIssue(r) : null
              return (
                <div key={i} className={'plr-line' + (issue ? ' bad' : '')}>
                  <span className="plr-n mono">{i + 1}</span>
                  <div className="plr-to">
                    <RecipientCombobox
                      compact
                      invalid={!!issue}
                      describedBy={issue ? `plr-issue-${i}` : undefined}
                      benefs={benefs}
                      address={r.address}
                      name={r.label || null}
                      placeholder={t('payroll.recipientPlaceholder')}
                      onReloadBenefs={reloadBenefs}
                      onChange={(rc) => updateRow(i, { address: rc.address, ...(rc.name ? { label: rc.name } : {}), ...(rc.memo ? { memo: rc.memo } : {}) })}
                    />
                  </div>
                  {/* The unit lives in the field, so the column reads as money and the number has
                      room to be a number. */}
                  <span className="plr-valwrap">
                    <input className="plr-val num" inputMode="decimal" placeholder="0.0000" value={r.value} onChange={(e) => updateRow(i, { value: e.target.value })} aria-label={t('payroll.colValue')} aria-invalid={issue ? true : undefined} aria-describedby={issue ? `plr-issue-${i}` : undefined} />
                    <span className="plr-unit" aria-hidden="true">ZEC</span>
                  </span>
                  <input className="plr-memo" placeholder={k === 'transparent' ? t('payroll.memoPublicPlaceholder') : t('payroll.memoPlaceholder')} value={r.memo} onChange={(e) => updateRow(i, { memo: e.target.value })} disabled={k === 'transparent'} />
                  <button className="row-del plr-del" title={t('common.remove')} onClick={() => removeRow(i)}>×</button>
                  {/* Named so the row's inputs can point at it, and live so a newly flagged line is heard once. */}
                  {issue && <div className="cell-warn err plr-issue" id={`plr-issue-${i}`} role="status">{t(issue)}</div>}
                </div>
              )
            })}
          </div>

          <div className="mt-sm folha-actions">
            <button className="btn ghost sm-btn" onClick={addRow}>{t('payroll.addRow')}</button>
            {/* CSV import runs through `previewPayroll`, which posts to the local bridge and has no
                web path. Shown rather than hidden: the reader can see the product intends to do
                this, and is told it is not ready instead of meeting a control that fails. */}
            {IS_NET ? (
              <Soon reason={t('payroll.importSoonWhy')}>
                <button className="btn ghost sm-btn" disabled>{t('payroll.importCsv')}</button>
              </Soon>
            ) : (
              <button className="btn ghost sm-btn" onClick={() => setShowImport((v) => !v)}>{t('payroll.importCsv')}</button>
            )}
          </div>
          {count === 0 && !showImport && (
            <div className="hint mt-sm">{tr(IS_NET ? 'payroll.startHintWeb' : 'payroll.startHint')}</div>
          )}

          {showImport && (
            <div className="mt-sm">
              <textarea className="input mono csv-area" rows={4} placeholder={t('payroll.csvPlaceholder')} value={csv} onChange={(e) => setCsv(e.target.value)} spellCheck={false} />
              <div className="mt-sm"><button className="btn ghost sm-btn" onClick={importCsv}>{t('payroll.csvRead')}</button></div>
            </div>
          )}
        </div>

        {/* The foot of the document: what the co-signers will approve, the three figures that decide
            it, and the action. The fee is given the same weight as the total - on a small balance it
            is most of what leaves the vault, and it used to be dim 10px text in a corner. */}
        <div className={'payroll-foot' + (overBalance ? ' over' : '')}>
          <div className="plf-doc">
            <span className="pv-tag">◆ {t('payroll.reviewTag')}</span>
            <span className="plf-title"><b>{competencia ? `${t('payroll.docPrefix')} · ${competencia}` : t('payroll.docPrefix')}</b></span>
            <span className="plf-sub"><b>{count}</b> {t('payroll.pvPaymentsSuffix')}</span>
          </div>

          <div className="plf-figs">
            {/* In the clear. See the note on the veil at the foot of this file: this is the draft you
                are typing, and every line of it is already legible in the fields above. */}
            <span className="plf-fig">
              <span className="plf-k">{t('payroll.pvTotal')}</span>
              <span className="plf-v num">
                <b className={count > 0 ? undefined : 'dim'}>{fmtZecExact(totalZat / 1e8)} ZEC</b>
              </span>
              {usdOn && count > 0 && zecToUsd(zatToZec(totalZat), rate) && (
                <span className="plf-usd">≈ {zecToUsd(zatToZec(totalZat), rate)}</span>
              )}
            </span>

            <span className="plf-fig">
              <span className="plf-k">{t('payroll.pvFeeK')}</span>
              <span className="plf-v num dim">+ {fmtZecExact(feeZat / 1e8)} ZEC</span>
              {savedZat > 0 && (
                <span className="plf-saved">{t('payroll.feeSaved', { n: count, saved: fmtZecExact(savedZat / 1e8) })}</span>
              )}
            </span>

            <span className={'plf-fig' + (overBalance ? ' bad' : '')}>
              <span className="plf-k">{t('payroll.pvAfter')}</span>
              <span className="plf-v num">
                {afterZat === null || hideAfter ? <b className="dim">-</b>
                  : <b className={count > 0 ? undefined : 'dim'}>{fmtZecExact(afterZat / 1e8)} ZEC</b>}
              </span>
            </span>
          </div>

          <div className="plf-act">
            <button className="btn ok" onClick={submit} disabled={!canSubmit} aria-describedby={[walletBusy && block === 'balance-unknown' ? 'payroll-busy' : null, blockMsg ? 'payroll-block' : null].filter(Boolean).join(' ') || undefined}>{busy ? t('payroll.sending') : t('payroll.submitBtn')}</button>
            <span className="plf-note">{tr('payroll.pvApprovalValue', { proposer })}</span>
          </div>

          <div className="plf-rate">
            {usdOn ? (
              <span className="payamt-rate">
                <span className="payamt-live" aria-hidden="true" />
                {rate ? `${rate.source} · ${rateIsStale(rate) ? t('dashboard.rateStale') : t('dashboard.rateLive')}` : t('dashboard.rateNone')}
                {' · '}<button type="button" className="linkbtn" onClick={() => void refreshRate()} disabled={rateBusy}>{rateBusy ? t('dashboard.updating') : t('dashboard.refresh')}</button>
              </span>
            ) : (
              <button type="button" className="linkbtn" onClick={enableUsd} title={t('dashboard.usdDisclosure')}>{t('dashboard.showUsd')} ≈</button>
            )}
          </div>
        </div>

        {/* Same reason as the payment screen: the gate fails closed, so name the block. Only once
            there is a valid row - on an empty sheet the total is 0 and would always warn. */}
        <div role="status" id="payroll-busy">{walletBusy && <div className="hint mt-sm">{t(bal ? 'wallet.busyKept' : 'wallet.busyBlocked')}</div>}</div>
        {/* The region stays mounted and the sentence swaps inside it, so a screen reader hears the
            block appear, change and clear. */}
        <div role="status" id="payroll-block">{blockMsg && <div className="hint warn mt-sm">{blockMsg}</div>}</div>
        {error && <div className="hint err mt-sm" role="alert">{error}</div>}

        {/* THE VEIL (tarja). It hides the VAULT's own figures - its balance, its history, its pending
            payments - so a glance at the screen does not read the treasury. It does not hide the
            draft you are composing: you typed it, and it is legible in the fields either way, so a
            bar over the total bought no privacy and cost you the ability to check your own
            arithmetic. The list below is the vault's history, not your draft, so it stays veiled -
            the rule is about what the figure IS, not which screen it happens to be on. */}
        {pastFolhas.length > 0 && (
          <div className="past-folhas mt">
            <span className="klab">{t('payroll.pastPayrolls')}</span>
            {pastFolhas.slice(0, 4).map((f) => (
              <div className="pf-row" key={f.id} role="button" tabIndex={0}
                onClick={() => nav('/proposal', { state: { id: f.id } })}
                onKeyDown={activateOnKey(() => nav('/proposal', { state: { id: f.id } }))}>
                <span className="pf-name">{f.memo || t('kind.payroll')}</span>
                <span className="pf-meta">
                  <span className="pf-val"><Secret sm><span>{fmtZec(f.value_zec)} ZEC</span></Secret></span>
                  <span className={'pf-st ' + f.state}>{t('state.' + f.state)}</span>
                  <span className="pf-go">→</span>
                </span>
              </div>
            ))}
          </div>
        )}
        </>)}
      </main>
    </>
  )
}
