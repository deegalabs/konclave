import { useState } from 'react'
import { ACTING_KEYS, type ActingAs } from './api'
import { useI18n } from './i18n'
import { openFailKey, unlockOnDevice } from './unlock'

/** What a proposing screen says when it cannot name the proposer, and the roster warning beside the
 *  name when this device's own list disagrees. When the reason is "locked" it also offers the unlock,
 *  through `unlockOnDevice`, the one way the app opens a share with the passphrase: a passkey opens
 *  the vault for reading only, so without this a member had nowhere to unlock from here (#591). */
export function ProposerNotice({ acting, differs, vaultId, onUnlocked }: {
  acting: ActingAs | null
  differs: boolean
  vaultId: string | null
  /** Called once the share is open, so the proposer resolves at once and not on the next poll. */
  onUnlocked: () => void
}) {
  const { t } = useI18n()
  const [pass, setPass] = useState('')
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState('')
  async function unlock() {
    if (!vaultId || busy) return
    setBusy(true); setErr('')
    try {
      const r = await unlockOnDevice(vaultId, 'net', pass)
      if (!r.ok) { setErr(t(openFailKey(r.wrong))); return }
      setPass('')
      onUnlocked()
    } finally { setBusy(false) }
  }
  return (
    <div role="status">
      {acting && !acting.ok && <div className="hint warn mt-sm">{t(ACTING_KEYS[acting.why])}</div>}
      {acting && !acting.ok && acting.why === 'locked' && vaultId && (
        <div className="sign-unlock mt-sm">
          <input type="password" autoComplete="current-password" value={pass} placeholder={t('vaults.passphrase')} aria-label={t('vaults.passphrase')}
            onChange={(e) => setPass(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter') void unlock() }} />
          {err && <div className="hint err mt-sm" role="alert">{err}</div>}
          <button type="button" className="btn mt-sm" disabled={busy || pass.length < 1} onClick={() => void unlock()}>
            {busy ? t('vaults.verifying') : t('lock.unlock')}
          </button>
        </div>
      )}
      {differs && <div className="hint warn mt-sm">{t('members.rosterDiffers')}</div>}
    </div>
  )
}
