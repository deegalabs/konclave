import { useEffect, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { Secret, activateOnKey, Loading } from '../components'
import { PageHeader } from '../page'
import { fmtZec, parseZecToZat, zatToZec } from '../format'
import { useT, useTr } from '../i18n'
import {
  previewPayroll, createPayroll, getBalance, getBeneficiaries, getLedger, getVault, health, classifyAddress, humanError,
  IS_DEMO, type Beneficiary, type Proposal, type Member,
} from '../api'
import { listVaults } from '../storage'
import { RecipientCombobox } from '../RecipientCombobox'
import { usdEnabled, setUsdEnabled, cachedRate, rateIsStale, fetchRate, zecToUsd, type Rate } from '../price'

const DRAFT_KEY = 'konclave.folha.rascunho'

type Row = { label: string; address: string; value: string; memo: string }
const emptyRow = (): Row => ({ label: '', address: '', value: '', memo: '' })


// A blocking problem with a row (null = ok); returns an i18n key. Warnings (public/sapling) separate.
function rowIssue(r: Row): string | null {
  if (!r.address.trim()) return 'payroll.issueEmpty'
  const k = classifyAddress(r.address.trim())
  if (k === 'unknown') return 'payroll.issueUnknown'
  const zat = parseZecToZat(r.value)
  if (zat === null || zat <= 0) return 'payroll.issueInvalid'
  if (k === 'transparent' && r.memo.trim()) return 'payroll.issueMemoPublic'
  return null
}
const rowTouched = (r: Row) => !!(r.address.trim() || r.value.trim() || r.label.trim() || r.memo.trim())

export default function NewPayroll() {
  const t = useT()
  const tr = useTr()
  const nav = useNavigate()
  const [competencia, setCompetencia] = useState('')
  const [description, setDescription] = useState('')
  const [rows, setRows] = useState<Row[]>([emptyRow()])
  const [showImport, setShowImport] = useState(false)
  const [csv, setCsv] = useState('')
  const [balanceZat, setBalanceZat] = useState<number | null>(null)
  const [benefs, setBenefs] = useState<Beneficiary[]>([])
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [saved, setSaved] = useState(false)
  const [pastFolhas, setPastFolhas] = useState<Proposal[]>([])
  // Neutral placeholder while the real vault name loads; sample only in demo (never a fake name).
  const [vaultName, setVaultName] = useState(IS_DEMO ? t('common.sampleVault') : '…')
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
        const [b, bs, led, v] = await Promise.all([getBalance(), getBeneficiaries(), getLedger(), getVault()])
        if (!on) return
        // Spendable, not total: only confirmed spendable funds can be sent, so the balance-after
        // and the over-balance block are against spendable (catches amount+fee overspend at propose).
        if (b?.configured) setBalanceZat(b.spendable_zat ?? b.total_zat ?? null)
        if (bs) setBenefs(bs)
        if (led) setPastFolhas(led.filter((x) => x.kind === 'payroll'))
        if (v) {
          setVaultName(v.name)
          const first0 = v.member_list?.[0]
          if (first0) {
            setMembersList(v.member_list!)
            // Live: propose as THIS device's own member (never the first seat); the picker is a
            // single-device demo artifice. Fall back to the first seat only without an on-device record.
            let mine: string | null = null
            if (!IS_DEMO) {
              try { mine = (await listVaults()).find((s) => s.id === v.id)?.myName ?? null } catch { /* no record */ }
            }
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
    if (e0) setError(t('payroll.errCsvRows', { count: p.errors.length, row: e0.row, reason: e0.reason }))
  }

  // Live aggregates over the valid rows.
  const validRows = rows.filter((r) => rowTouched(r) && rowIssue(r) === null)
  const count = validRows.length
  const totalZat = validRows.reduce((acc, r) => acc + (parseZecToZat(r.value) ?? 0), 0)
  const feeZat = count > 0 ? 5000 * Math.max(2, count + 1) : 0
  const afterZat = balanceZat === null ? null : balanceZat - totalZat - feeZat
  const overBalance = afterZat !== null && afterZat < 0
  const anyBadTouched = rows.some((r) => rowTouched(r) && rowIssue(r) !== null)
  const canSubmit = count > 0 && !anyBadTouched && !busy && !overBalance

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
      validRows.map((r) => ({ label: r.label || undefined, address: r.address.trim(), value_zec: r.value.trim(), memo: r.memo || undefined })),
      desc,
    )
    setBusy(false)
    if (res.ok) { localStorage.removeItem(DRAFT_KEY); nav('/proposal', { state: { id: res.proposal.id } }) }
    else setError(humanError(t, res.error, res.detail))
  }

  return (
    <>
      <main className="page pay">
        <PageHeader
          title={t('payroll.title')}
          subtitle={<>{t('payroll.cap')} {saved && <span className="draft-note" title={t('payroll.draftSavedTitle')} aria-live="polite">{t('payroll.draftSaved')}</span>}</>}
        />

        {!loaded && <Loading />}

        {loaded && <div className="ctx">
          <span>{tr('payment.fromVault', { name: vaultName })}</span>
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
              <span className="ctx-as">{t('payment.proposingAs')} <b>{proposer}</b></span>
            )
          )}
        </div>}

        <div className="pay-cols">
          {/* LEFT: the payroll document you fill in — heading + one line per payment. */}
          <div className="pay-form">
            <div className="doc-head">
              <label className="field inline"><span>{t('payroll.competence')}</span>
                <input className="input mono" placeholder={t('payroll.competencePlaceholder')} value={competencia} onChange={(e) => setCompetencia(e.target.value)} />
              </label>
              <label className="field inline"><span>{t('payroll.description')}</span>
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
                        benefs={benefs}
                        address={r.address}
                        name={r.label || null}
                        placeholder={t('payroll.recipientPlaceholder')}
                        onReloadBenefs={reloadBenefs}
                        onChange={(rc) => updateRow(i, { address: rc.address, ...(rc.name ? { label: rc.name } : {}), ...(rc.memo ? { memo: rc.memo } : {}) })}
                      />
                    </div>
                    <input className="plr-val mono" placeholder="0.0000" value={r.value} onChange={(e) => updateRow(i, { value: e.target.value })} />
                    <input className="plr-memo" placeholder={k === 'transparent' ? t('payroll.memoPublicPlaceholder') : t('payroll.memoPlaceholder')} value={r.memo} onChange={(e) => updateRow(i, { memo: e.target.value })} disabled={k === 'transparent'} />
                    <button className="row-del plr-del" title={t('common.remove')} onClick={() => removeRow(i)}>×</button>
                    {issue && <div className="cell-warn err plr-issue">{t(issue)}</div>}
                  </div>
                )
              })}
            </div>

            <div className="mt-sm folha-actions">
              <button className="btn ghost sm-btn" onClick={addRow}>{t('payroll.addRow')}</button>
              <button className="btn ghost sm-btn" onClick={() => setShowImport((v) => !v)}>{t('payroll.importCsv')}</button>
            </div>
            {count === 0 && !showImport && (
              <div className="hint mt-sm">{tr('payroll.startHint')}</div>
            )}

            {showImport && (
              <div className="mt-sm">
                <textarea className="input mono csv-area" rows={4} placeholder={t('payroll.csvPlaceholder')} value={csv} onChange={(e) => setCsv(e.target.value)} spellCheck={false} />
                <div className="mt-sm"><button className="btn ghost sm-btn" onClick={importCsv}>{t('payroll.csvRead')}</button></div>
              </div>
            )}
          </div>

          {/* RIGHT: the review card — the document your co-signers approve, plus total + guidance. */}
          <aside className="pay-review">
            <div className="preview">
              <div className="pv-tag">◆ {t('payroll.reviewTag')}</div>
              <div className="pv-row"><span className="pv-k">{t('payroll.pvDocument')}</span><span className="pv-v"><b>{competencia ? `${t('payroll.docPrefix')} · ${competencia}` : t('payroll.docPrefix')}</b></span></div>
              <div className="pv-row"><span className="pv-k">{t('payroll.pvPayments')}</span><span className="pv-v"><b>{count}</b> {t('payroll.pvPaymentsSuffix')}</span></div>
              {/* Redact only when there's a real figure - hiding a zero behind the tarja is theatre. */}
              <div className="pv-row"><span className="pv-k">{t('payroll.pvTotal')}</span><span className="pv-v">
                {count > 0
                  ? <><Secret sm><b>{fmtZec(zatToZec(totalZat))} ZEC</b></Secret>{usdOn && zecToUsd(zatToZec(totalZat), rate) ? <span className="pv-usd"> ≈ {zecToUsd(zatToZec(totalZat), rate)}</span> : null}</>
                  : <b className="dim">{fmtZec(zatToZec(totalZat))} ZEC</b>}
              </span></div>
              {count > 0 && <div className="pv-row"><span className="pv-k">{t('payroll.pvFeeK')}</span><span className="pv-v mono dim">+ {fmtZec(zatToZec(feeZat))} ZEC</span></div>}
              <div className="pv-row"><span className="pv-k">{t('payroll.pvAfter')}</span><span className="pv-v">
                {afterZat === null ? <b className="dim">-</b>
                  : count > 0 ? <Secret sm><b>{fmtZec(zatToZec(afterZat))}</b></Secret> : <b className="dim">{fmtZec(zatToZec(afterZat))}</b>}
              </span></div>
              <div className="pv-row"><span className="pv-k">{t('payroll.pvApproval')}</span><span className="pv-v">{tr('payroll.pvApprovalValue', { proposer })}</span></div>
              <div className="pv-fee">
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

            {afterZat !== null && afterZat < 0 && <div className="hint warn mt-sm">{t('payroll.warnExceeds')}</div>}
            {error && <div className="hint err mt-sm" role="alert">{error}</div>}

            <button className="btn ok pay-submit mt" onClick={submit} disabled={!canSubmit}>{busy ? t('payroll.sending') : t('payroll.submitBtn')}</button>
          </aside>
        </div>

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
      </main>
    </>
  )
}
