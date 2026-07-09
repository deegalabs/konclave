import { useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import { Letterhead } from '../components'
import { Identicon } from '../avatar'
import { useT } from '../i18n'
import {
  getBeneficiaries, addBeneficiary, deleteBeneficiary, classifyAddress, shortAddr, humanError,
  type Beneficiary,
} from '../api'

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

  async function reload() {
    const b = await getBeneficiaries()
    if (b) setList(b)
    setLoaded(true)
    // First time / empty registry: open the form so there's an obvious next step.
    if (b && b.length === 0) setShowForm(true)
  }
  useEffect(() => { void reload() }, [])

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
    else setError(humanError(res.error, res.detail))
  }

  async function remove(id: string) {
    if (await deleteBeneficiary(id)) void reload()
  }

  return (
    <>
      <Letterhead right={<Link className="klab back" to="/dashboard">{t('common.backPanel')}</Link>} />
      <main className="page">
        <h1 className="h1">{t('people.title')}</h1>
        <p className="cap">{t('people.cap')}</p>

        {/* Lista primeiro — é o que se consulta */}
        {loaded && list.length === 0 ? (
          <div className="empty-note mt">{t('people.empty')}</div>
        ) : (
          <div className="people mt">
            {list.map((b) => (
              <div className="who-row" key={b.id}>
                <Identicon seed={b.address || b.name} size={34} />
                <div className="person-main">
                  <div className="who-name">{b.name}</div>
                  <div className="person-sub mono">
                    <span className={b.is_public ? 'seal-tx' : 'dim'}>{shortAddr(b.address)}{b.is_public ? t('people.publicSuffix') : ''}</span>
                    {b.memo ? <span className="dim"> · {b.memo}</span> : null}
                  </div>
                </div>
                <button className="row-edit" title={t('people.edit')} onClick={() => startEdit(b)}>✎</button>
                <button className="row-del" title={t('common.remove')} onClick={() => remove(b.id)}>×</button>
              </div>
            ))}
          </div>
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
            {error && <div className="hint err mt" role="alert">✗ {error}</div>}
            <div className="mt-sm folha-actions">
              <button className="btn ok sm-btn" onClick={add} disabled={busy}>{busy ? t('people.saving') : (editingId ? t('people.saveChanges') : t('people.savePerson'))}</button>
              {editingId && <button className="btn ghost sm-btn" onClick={cancelForm}>{t('common.cancel')}</button>}
            </div>
          </div>
        )}
      </main>
    </>
  )
}
