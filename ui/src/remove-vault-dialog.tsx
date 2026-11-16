// The one confirmation before a vault leaves this device (Vaults, Settings and the /net restore row
// all render it). Three screens had each written their own, and they had drifted: the /net one had
// no typed name and no failure message. What it owns: the title, the body, the Export-first action,
// the typed-name gate, the failure message, focus on open and the destructive button. What each
// screen passes: how to remove (they differ in where the record lives), where Export goes, and what
// happens after. `removeVaultFromDevice` stays the single removal underneath (#813).
import { useState } from 'react'
import { Dialog } from './components'
import { useT, useTr } from './i18n'

export type RemoveResult = 'ok' | 'wrong' | 'fail'

/** What a member types, and sees in the title: the vault's name, or the short id the lists show. */
export function removeLabel(id: string, name?: string): string {
  return name?.trim() ? name : id.slice(0, 8)
}

/** The gate. One function, so no screen can accept something looser. */
export function canRemove(typed: string, label: string): boolean {
  return typed.trim() === label
}

export function RemoveVaultDialog({ id, name, remove, onExport, onClose, onRemoved }: {
  id: string
  name?: string
  /** Remove it; `fail` when the record is still there, `wrong` when the owner refused the name. */
  remove: (typed: string) => Promise<RemoveResult>
  /** Offer the export first; the screen decides where it leads. */
  onExport?: () => void
  onClose: () => void
  onRemoved: () => void
}) {
  const t = useT()
  const tr = useTr()
  const label = removeLabel(id, name)
  const [typed, setTyped] = useState('')
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState<string | null>(null)

  async function go() {
    if (busy || !canRemove(typed, label)) return
    setBusy(true)
    setErr(null)
    try {
      const res = await remove(typed)
      if (res === 'ok') { onRemoved(); return }
      setErr(t(res === 'wrong' ? 'settings.nameMismatch' : 'settings.removeFail'))
    } catch {
      // Stay open and say so: closing would look like it worked while the share is still here.
      setErr(t('settings.removeFail'))
    } finally {
      setBusy(false)
    }
  }

  return (
    // focusCard: the dialog says what is lost before any control can be pressed.
    <Dialog className="unlock-overlay" cardClassName="unlock-card" labelledBy="remove-title" focusCard onClose={onClose}>
      <h2 id="remove-title">{tr('dashboard.deleteConfirmTitle', { name: label })}</h2>
      <p className="rm-lead">{tr('dashboard.deleteConfirmBody')}</p>
      <div className="rm-funds">
        <span className="rm-ic" aria-hidden="true">!</span>
        <p>{tr('dashboard.deleteFundsWarn')}</p>
      </div>
      <p className="rm-quiet">{tr('dashboard.deleteLocalHint')}</p>
      {onExport && (
        <button type="button" className="rm-backup" onClick={onExport}>{t('dashboard.deleteBackupFirst')}</button>
      )}
      <p className="rm-quiet rm-why">{tr('dashboard.deleteBackupWhy')}</p>
      <label className="rm-field">
        {/* The name is in the label, not the placeholder: a placeholder prints the answer in the box. */}
        <span>{tr('dashboard.deleteTypeName', { name: label })}</span>
        <input className="unlock-input" value={typed} spellCheck={false} autoComplete="off"
          onChange={(e) => { setTyped(e.target.value); setErr(null) }} />
      </label>
      {err && <p className="unlock-err" role="alert">{err}</p>}
      <div className="unlock-btns">
        <button className="rd-enter" onClick={onClose}>{t('common.cancel')}</button>
        <button className="rd-enter danger" disabled={busy || !canRemove(typed, label)} onClick={() => void go()}>
          {t('dashboard.deletePermanently')}
        </button>
      </div>
    </Dialog>
  )
}
