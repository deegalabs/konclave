import { useEffect, useState } from 'react'
import { Dialog, Loading } from '../components'
import { PageHeader } from '../page'
import { Identicon } from '../avatar'
import { useT } from '../i18n'
import {
  getBeneficiaries, addBeneficiary, deleteBeneficiary, classifyAddress, shortAddr, humanError,
  getVault, type Beneficiary,
} from '../api'
import { listVaults, type Governance } from '../storage'

/**
 * What kind of address this is, said plainly on BOTH kinds - the way a shielded wallet labels it.
 * "public" alone (and only on transparent) left the shielded case unlabelled, so a reader could not
 * tell whether the absence meant private or unknown. Transparent is the exception that carries a
 * warning tone, because paying it puts the amount and the recipient on a public ledger.
 */
function AddrKind({ transparent, t }: { transparent?: boolean; t: (k: string) => string }) {
  return transparent ? (
    <span className="akind akind-pub" title={t('people.kindTransparentHelp')}>
      <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2"
        strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
        <path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7S2 12 2 12Z" /><circle cx="12" cy="12" r="2.6" />
      </svg>
      {t('people.kindTransparent')}
    </span>
  ) : (
    <span className="akind akind-shield" title={t('people.kindShieldedHelp')}>
      <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2"
        strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
        <path d="M12 3l7.5 3v5.4c0 4.5-3.1 8.2-7.5 9.6-4.4-1.4-7.5-5.1-7.5-9.6V6z" />
      </svg>
      {t('people.kindShielded')}
    </span>
  )
}

export default function People() {
  const t = useT()
  const [list, setList] = useState<Beneficiary[]>([])
  const [name, setName] = useState('')
  const [address, setAddress] = useState('')
  const [memo, setMemo] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [showForm, setShowForm] = useState(false)
  const [loaded, setLoaded] = useState(false)
  const [editingId, setEditingId] = useState<string | null>(null)
  const [confirmDel, setConfirmDel] = useState<Beneficiary | null>(null)
  const [gov, setGov] = useState<Governance | null>(null)

  async function reload() {
    const b = await getBeneficiaries()
    if (b) setList(b)
    setLoaded(true)
    // First time / empty registry: open the form so there's an obvious next step.
    if (b && b.length === 0) setShowForm(true)
  }
  useEffect(() => {
    void reload()
    // Governance policy (public vault metadata, on-device). Undefined reads as 'open'.
    void (async () => {
      try {
        const v = await getVault()
        if (!v) return
        const saved = await listVaults()
        setGov(saved.find((s) => s.id === v.id)?.governance ?? 'open')
      } catch { /* local-bridge mode - no on-device record */ }
    })()
  }, [])

  const kind = address.trim().length > 1 ? classifyAddress(address.trim()) : null

  function startEdit(b: Beneficiary) {
    setEditingId(b.id); setName(b.name); setAddress(b.address); setMemo(b.memo)
    setError(null); setShowForm(true)
  }
  function cancelForm() {
    setEditingId(null); setName(''); setAddress(''); setMemo(''); setError(null); setShowForm(false)
  }

  async function add() {
    setError(null)
    if (!name.trim() || !address.trim()) { setError(t('people.errFillNameAddr')); return }
    setBusy(true)
    // Edit = add the updated entry, then drop the old one (no update endpoint).
    const res = await addBeneficiary(name.trim(), address.trim(), memo.trim() || undefined)
    if (res.ok && editingId) await deleteBeneficiary(editingId)
    setBusy(false)
    if (res.ok) { setName(''); setAddress(''); setMemo(''); setShowForm(false); setEditingId(null); void reload() }
    else setError(humanError(t, res.error, res.detail))
  }

  async function doRemove() {
    const b = confirmDel
    setConfirmDel(null)
    if (b && (await deleteBeneficiary(b.id))) void reload()
  }

  return (
    <>
      <main className="page">
        <PageHeader back={{ to: '/pay', label: t('nav.pay') }} title={t('people.title')} subtitle={t('people.cap')} />

        {/* List first - it is what gets consulted */}
        {!loaded ? (
          <Loading />
        ) : list.length === 0 ? (
          <div className="empty-note mt">{t('people.empty')}</div>
        ) : (
          <div className="people mt">
            {list.map((b) => (
              <div className="who-row" key={b.id}>
                <Identicon seed={b.address || b.name} size={34} />
                <div className="person-main">
                  <div className="who-name">{b.name}</div>
                  <div className="person-sub mono">
                    <span className="dim">{shortAddr(b.address)}</span>
                    <AddrKind transparent={b.is_public} t={t} />
                    {b.memo ? <span className="dim"> · {b.memo}</span> : null}
                  </div>
                </div>
                <button className="row-edit" title={t('people.edit')} onClick={() => startEdit(b)}>✎</button>
                <button className="row-del" title={t('common.remove')} onClick={() => setConfirmDel(b)}>×</button>
              </div>
            ))}
          </div>
        )}

        {gov === 'quorum' && (
          <div className="gov-nudge mt" role="note">{t('gov.nudgeBeneficiaries')}</div>
        )}

        <div className="mt">
          <button className="btn ghost sm-btn" onClick={() => (showForm ? cancelForm() : setShowForm(true))}>
            {showForm ? t('people.close') : t('people.register')}
          </button>
        </div>

        {showForm && (
          <div className="add-form mt">
            <div className="klab">{editingId ? t('people.editPerson') : t('people.newPerson')}</div>
            <div className="doc-head">
              <label className="field inline"><span>{t('people.name')}</span>
                <input className="input" placeholder={t('people.namePlaceholder')} value={name} onChange={(e) => setName(e.target.value)} />
              </label>
              <label className="field inline"><span>{t('people.address')}</span>
                <input className="input mono" placeholder={t('payroll.addrPlaceholder')} value={address} onChange={(e) => setAddress(e.target.value)} />
              </label>
              <label className="field inline"><span>{t('people.defaultMemo')}</span>
                <input className="input" placeholder={t('people.memoPlaceholder')} value={memo} onChange={(e) => setMemo(e.target.value)} disabled={kind === 'transparent'} />
              </label>
            </div>
            {kind === 'transparent' && <div className="hint warn">{t('people.warnTransparent')}</div>}
            {kind === 'sapling' && <div className="hint warn">{t('people.warnSapling')}</div>}
            {error && <div className="hint err mt" role="alert">{error}</div>}
            <div className="mt-sm folha-actions">
              <button className="btn ok sm-btn" onClick={add} disabled={busy}>{busy ? t('people.saving') : (editingId ? t('people.saveChanges') : t('people.savePerson'))}</button>
              {editingId && <button className="btn ghost sm-btn" onClick={cancelForm}>{t('common.cancel')}</button>}
            </div>
          </div>
        )}

      </main>

      {confirmDel && (
        <Dialog className="unlock-overlay" cardClassName="unlock-card" labelledBy="del-title" onClose={() => setConfirmDel(null)}>
          <div className="klab">{t('people.confirmDeleteEyebrow')}</div>
          <h2 id="del-title">{confirmDel.name}</h2>
          <p>{t('people.confirmDeleteBody')}</p>
          {gov === 'quorum' && <p className="hint">{t('gov.nudgeBeneficiaries')}</p>}
          <div className="unlock-btns">
            <button className="btn ghost" onClick={() => setConfirmDel(null)}>{t('common.cancel')}</button>
            <button className="btn danger" onClick={() => void doRemove()}>{t('people.confirmDeleteAction')}</button>
          </div>
        </Dialog>
      )}
    </>
  )
}
