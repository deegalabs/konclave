// The in-place unlock (#467).
//
// A reload used to bounce the member out to `/vaults` to pick the vault again, then walk back in.
// #446 D softened that by returning them where they were, but the trip still happened: the vault
// they were already inside vanished, they re-chose it from a list, and only then got the field.
//
// A locked vault is not a different place. This asks for the passphrase ON the screen the member
// was on, the way an OS keychain does - the page stays, the door is what is shut.
//
// It is rendered by `Layout`, so every in-vault screen gets it from one place. The alternative -
// each screen showing its own - is the duplication this repo keeps paying for.

import { useEffect, useRef, useState } from 'react'
import { Dialog } from './components'
import { useT } from './i18n'
import { unlockOnDevice, type VaultSrc } from './unlock'
import { loadPrfWrap } from './prf-store'
import { openPrf } from './prf-wrap'
import { setReadSecret } from './session'
import { markVaultUnlocked } from './api'

export interface LockOverlayProps {
  vaultId: string
  vaultName: string
  src: VaultSrc
  /** Unlocked: the caller drops the overlay and lets the screens load. */
  onUnlocked: () => void
  /** The member chose not to unlock. The caller sends them to the picker - the only honest exit,
   *  since staying would show a screen whose every read is refused. */
  onCancel: () => void
}

export default function LockOverlay({ vaultId, vaultName, src, onUnlocked, onCancel }: LockOverlayProps) {
  const t = useT()
  const [pass, setPass] = useState('')
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState<string | null>(null)
  const [prfBusy, setPrfBusy] = useState(false)
  const inputRef = useRef<HTMLInputElement>(null)

  // The member did not navigate here - the lock appeared under them - so the field takes focus and
  // they can just type. Without this the first keystroke goes nowhere.
  useEffect(() => { inputRef.current?.focus() }, [])

  async function submit() {
    if (!pass || busy) return
    setBusy(true); setErr(null)
    const r = await unlockOnDevice(vaultId, src, pass)
    setBusy(false)
    if (r.ok) { setPass(''); onUnlocked(); return }
    setErr(r.wrong ? t('vaults.unlockWrong') : t('vaults.unlockFail'))
  }

  /** The passkey shortcut, when this device holds a wrap. `S` only - signing still asks for the
   *  passphrase. Any failure is silent: a shortcut that fails must cost nothing. */
  async function withPasskey() {
    const wrap = loadPrfWrap(vaultId)
    if (!wrap) return
    setPrfBusy(true)
    try {
      const s = await openPrf(navigator.credentials, wrap, location.hostname)
      if (!s) return
      setReadSecret(vaultId, s)
      markVaultUnlocked(vaultId)
      onUnlocked()
    } finally {
      setPrfBusy(false)
    }
  }

  return (
    // NOT dismissible. `Dialog` closes on Escape and on a backdrop click, and both would throw the
    // member out of the vault by accident - there is nothing usable behind this overlay to dismiss
    // TO. Leaving is a deliberate button, the way an OS keychain does it.
    <Dialog className="unlock-overlay" cardClassName="unlock-card" labelledBy="relock-title" onClose={() => {}}>
      <div className="rd-eyebrow">{t('vaults.protectedVault')}</div>
      <h2 id="relock-title">{vaultName}</h2>
      <p>{t('lock.prompt')}</p>
      {loadPrfWrap(vaultId) && (
        <button type="button" className="rm-backup" disabled={prfBusy} onClick={() => void withPasskey()}>
          {prfBusy ? t('vaults.passkeyBusy') : t('vaults.passkeyUnlock')}
        </button>
      )}
      <input
        ref={inputRef}
        className="unlock-input mono"
        type="password"
        placeholder={t('vaults.passphrase')}
        value={pass}
        onChange={(e) => setPass(e.target.value)}
        onKeyDown={(e) => { if (e.key === 'Enter') void submit() }}
      />
      {err && <div className="unlock-err" role="alert">{err}</div>}
      <div className="unlock-btns">
        <button className="rd-enter" onClick={onCancel}>{t('lock.leave')}</button>
        <button className="rd-enter primary" onClick={() => void submit()} disabled={busy || !pass}>
          {busy ? t('vaults.verifying') : t('lock.unlock')}
        </button>
      </div>
    </Dialog>
  )
}
