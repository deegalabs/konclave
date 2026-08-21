// A recipient / payee picker used by Pay and Payroll (redesign, artifact-approved). One field that
// (a) searches saved payees by name, (b) accepts a pasted address (recognized via classifyAddress),
// (c) lets you add a new payee INLINE (writes to the shared registry), and (d) links to the full
// list. Replaces the old "select + Manage payees button + raw address input" trio. WAI-ARIA combobox.

import { useEffect, useMemo, useRef, useState } from 'react'
import { addBeneficiary, classifyAddress, shortAddr, type Beneficiary } from './api'
import { Identicon } from './avatar'
import { useT } from './i18n'

const RECENTS_KEY = 'konclave.recentPayees'

function recentAddrs(): string[] {
  try { return JSON.parse(localStorage.getItem(RECENTS_KEY) ?? '[]') as string[] } catch { return [] }
}
function pushRecent(addr: string): void {
  try {
    const next = [addr, ...recentAddrs().filter((a) => a !== addr)].slice(0, 4)
    localStorage.setItem(RECENTS_KEY, JSON.stringify(next))
  } catch { /* storage blocked */ }
}

/** A resolved recipient. `name` is null for a raw pasted address. */
export type Recipient = { address: string; name: string | null; memo?: string }

export function RecipientCombobox({
  benefs, address, name, onChange, onReloadBenefs, placeholder, autoFocus, compact,
}: {
  benefs: Beneficiary[]
  address: string
  name: string | null
  onChange: (r: Recipient) => void
  onReloadBenefs?: () => void
  placeholder?: string
  autoFocus?: boolean
  compact?: boolean
}) {
  const t = useT()
  const [open, setOpen] = useState(false)
  const [q, setQ] = useState('')
  const [hi, setHi] = useState(0)
  const [adding, setAdding] = useState(false)
  const [newAddr, setNewAddr] = useState('')
  const [newMemo, setNewMemo] = useState('')
  const [saving, setSaving] = useState(false)
  const [saveErr, setSaveErr] = useState<string | null>(null)
  const rootRef = useRef<HTMLDivElement>(null)
  const inputRef = useRef<HTMLInputElement>(null)

  const picked = !!name && !!address
  const kind = address.trim().length > 1 ? classifyAddress(address.trim()) : null
  const qIsAddr = classifyAddress(q.trim()) !== 'unknown' && q.trim().length > 6

  // The dropdown rows: pasted address, or recents+saved filtered by the query, then an inline "add".
  const rows = useMemo(() => {
    if (qIsAddr) return { pasted: q.trim(), recents: [] as Beneficiary[], saved: [] as Beneficiary[] }
    const ql = q.trim().toLowerCase()
    const match = (b: Beneficiary) => !ql || b.name.toLowerCase().includes(ql)
    const rec = recentAddrs()
    const recents = rec.map((a) => benefs.find((b) => b.address === a)).filter((b): b is Beneficiary => !!b && match(b)).slice(0, 3)
    const recentIds = new Set(recents.map((b) => b.id))
    const saved = benefs.filter((b) => match(b) && !recentIds.has(b.id))
    return { pasted: null as string | null, recents, saved }
  }, [q, qIsAddr, benefs])

  // Flat option list (for keyboard nav): each entry is a Beneficiary or the pasted address or add.
  const flat = useMemo(() => {
    const out: ({ b: Beneficiary } | { pasted: string } | { add: true })[] = []
    if (rows.pasted) out.push({ pasted: rows.pasted })
    rows.recents.forEach((b) => out.push({ b }))
    rows.saved.forEach((b) => out.push({ b }))
    if (!rows.pasted && rows.recents.length === 0 && rows.saved.length === 0 && q.trim()) out.push({ add: true })
    return out
  }, [rows, q])

  useEffect(() => { setHi(0) }, [q, open])
  useEffect(() => {
    function onDoc(e: MouseEvent) { if (rootRef.current && !rootRef.current.contains(e.target as Node)) { setOpen(false); setAdding(false) } }
    document.addEventListener('mousedown', onDoc)
    return () => document.removeEventListener('mousedown', onDoc)
  }, [])
  useEffect(() => { if (autoFocus) inputRef.current?.focus() }, [autoFocus])

  function pick(r: Recipient) {
    pushRecent(r.address)
    onChange(r)
    setQ(''); setOpen(false); setAdding(false)
  }
  function pickBenef(b: Beneficiary) {
    pick({ address: b.address, name: b.name, memo: b.memo || undefined })
  }
  function clear() {
    onChange({ address: '', name: null }); setQ(''); setOpen(true)
    requestAnimationFrame(() => inputRef.current?.focus())
  }

  async function saveNew() {
    const nm = q.trim(); const ad = newAddr.trim()
    setSaveErr(null)
    if (!nm || !ad) { setSaveErr(t('rec.errFill')); return }
    if (classifyAddress(ad) === 'unknown') { setSaveErr(t('rec.errAddr')); return }
    setSaving(true)
    const res = await addBeneficiary(nm, ad, newMemo.trim() || undefined)
    setSaving(false)
    if (res.ok) {
      onReloadBenefs?.()
      pick({ address: res.beneficiary.address, name: res.beneficiary.name, memo: res.beneficiary.memo || undefined })
      setNewAddr(''); setNewMemo('')
    } else {
      setSaveErr(t('rec.errSave'))
    }
  }

  function onInput(v: string) {
    setQ(v); setOpen(true); setAdding(false)
    const k = classifyAddress(v.trim())
    if (k !== 'unknown' && v.trim().length > 6) onChange({ address: v.trim(), name: null })
    else if (address && !name) onChange({ address: '', name: null }) // typing a name clears a raw address
  }

  function onKey(e: React.KeyboardEvent) {
    if (e.key === 'Escape') { setOpen(false); setAdding(false); return }
    if (e.key === 'ArrowDown') { e.preventDefault(); setOpen(true); setHi((h) => Math.min(h + 1, flat.length - 1)); return }
    if (e.key === 'ArrowUp') { e.preventDefault(); setHi((h) => Math.max(h - 1, 0)); return }
    if (e.key === 'Enter') {
      const sel = flat[hi]
      if (!sel) return
      e.preventDefault()
      if ('b' in sel) pickBenef(sel.b)
      else if ('pasted' in sel) pick({ address: sel.pasted, name: null })
      else if ('add' in sel) setAdding(true)
    }
  }

  const chip = (k: ReturnType<typeof classifyAddress>) =>
    k === 'transparent' ? <span className="rcb-chip pub">{t('rec.chipPublic')}</span>
    : k === 'sapling' ? <span className="rcb-chip pub">Sapling</span>
    : k === 'unified' ? <span className="rcb-chip ok">{t('rec.chipShielded')}</span> : null

  return (
    <div className={'rcb' + (open ? ' open' : '') + (compact ? ' compact' : '')} ref={rootRef}>
      <div className="rcb-field">
        {!picked && (
          <svg className="rcb-lupa" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" aria-hidden="true"><circle cx="11" cy="11" r="7" /><path d="M20 20l-3.2-3.2" /></svg>
        )}
        {picked ? (
          <span className="rcb-picked">
            <Identicon seed={address || name || ''} size={compact ? 18 : 24} />
            <span className="rcb-nm">{name}</span>
            <span className="rcb-ad">{shortAddr(address)}</span>
            {kind && chip(kind)}
          </span>
        ) : (
          <input
            ref={inputRef}
            className="rcb-input mono"
            role="combobox"
            aria-expanded={open}
            aria-autocomplete="list"
            aria-controls="rcb-pop"
            autoComplete="off"
            spellCheck={false}
            placeholder={placeholder ?? t('rec.placeholder')}
            value={q || (address && !name ? address : '')}
            onChange={(e) => onInput(e.target.value)}
            onFocus={() => setOpen(true)}
            onKeyDown={onKey}
          />
        )}
        {(picked || address) && (
          <button type="button" className="rcb-x" onClick={clear} aria-label={t('common.remove')}>×</button>
        )}
      </div>

      {open && (
        <div className="rcb-pop" id="rcb-pop" role="listbox">
          {rows.pasted && (() => {
            const k = classifyAddress(rows.pasted!)
            const idx = 0
            return (<>
              <div className="rcb-grp">{t('rec.pasted')}</div>
              <button type="button" role="option" aria-selected={hi === idx} className={'rcb-opt' + (hi === idx ? ' hi' : '')} onClick={() => pick({ address: rows.pasted!, name: null })}>
                <Identicon seed={rows.pasted!} size={26} />
                <span className="rcb-om"><span className="rcb-on">{k === 'unified' ? t('rec.addrShielded') : t('rec.addrPublic')} {chip(k)}</span><span className="rcb-oa">{shortAddr(rows.pasted!)}</span></span>
              </button>
            </>)
          })()}

          {rows.recents.length > 0 && <div className="rcb-grp">{t('rec.recents')}</div>}
          {rows.recents.map((b) => {
            const idx = flat.findIndex((f) => 'b' in f && f.b.id === b.id)
            return (
              <button key={b.id} type="button" role="option" aria-selected={hi === idx} className={'rcb-opt' + (hi === idx ? ' hi' : '')} onMouseEnter={() => setHi(idx)} onClick={() => pickBenef(b)}>
                <Identicon seed={b.address || b.name} size={26} />
                <span className="rcb-om"><span className="rcb-on">{b.name} {chip(classifyAddress(b.address))}</span><span className="rcb-oa">{shortAddr(b.address)}</span></span>
              </button>
            )
          })}

          {rows.saved.length > 0 && <div className="rcb-grp">{t('rec.saved')}</div>}
          {rows.saved.map((b) => {
            const idx = flat.findIndex((f) => 'b' in f && f.b.id === b.id)
            return (
              <button key={b.id} type="button" role="option" aria-selected={hi === idx} className={'rcb-opt' + (hi === idx ? ' hi' : '')} onMouseEnter={() => setHi(idx)} onClick={() => pickBenef(b)}>
                <Identicon seed={b.address || b.name} size={26} />
                <span className="rcb-om"><span className="rcb-on">{b.name} {chip(classifyAddress(b.address))}</span><span className="rcb-oa">{shortAddr(b.address)}</span></span>
              </button>
            )
          })}

          {!rows.pasted && rows.recents.length === 0 && rows.saved.length === 0 && q.trim() && (
            adding ? (
              <div className="rcb-addbox">
                <input className="input mono" placeholder={t('rec.addAddr')} value={newAddr} onChange={(e) => { setNewAddr(e.target.value); setSaveErr(null) }} autoFocus />
                <input className="input" placeholder={t('rec.addMemo')} value={newMemo} onChange={(e) => setNewMemo(e.target.value)} />
                {saveErr && <div className="hint err mt-xs">{saveErr}</div>}
                <div className="rcb-addacts">
                  <button type="button" className="btn ghost sm-btn" onClick={() => setAdding(false)}>{t('common.cancel')}</button>
                  <button type="button" className="btn ok sm-btn" disabled={saving} onClick={() => void saveNew()}>{saving ? '…' : t('rec.saveUse')}</button>
                </div>
              </div>
            ) : (
              <button type="button" role="option" aria-selected={hi === 0} className="rcb-opt rcb-add" onClick={() => setAdding(true)}>
                <span className="rcb-plus">+</span><span>{t('rec.add', { q: q.trim() })}</span>
              </button>
            )
          )}

          <div className="rcb-sep" />
          <div className="rcb-manage">
            <span>{t('rec.orPaste')}</span>
            <a href="#/people" onClick={(e) => { e.preventDefault(); window.location.hash = '#/people' }}>{t('people.manage')} →</a>
          </div>
        </div>
      )}

      {/* Under-field validation for a raw / picked address. */}
      {!open && kind && (
        <div className={'hint mt-xs ' + (kind === 'unified' ? 'rcb-ok' : 'warn')}>
          {kind === 'unified' ? t('rec.shieldedOk')
            : kind === 'transparent' ? t('rec.publicWarn')
            : kind === 'sapling' ? t('rec.saplingWarn')
            : t('rec.unknownWarn')}
        </div>
      )}
    </div>
  )
}
