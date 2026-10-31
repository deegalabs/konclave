import { useState, type FormEvent } from 'react'
import { loadVault } from './storage'
import { useT } from './i18n'

// #784. Since #781, typing the passphrase seals a viewing key that an imported backup left in the
// clear on this device, and removes the clear copy. A passkey cannot do that: it does not open what
// the key is sealed under. So a member who only ever uses the passkey keeps the old record, and
// nothing told them. This asks for the passphrase once, on this device, and runs the same rewrite
// (`loadVault`). It reads only whether the clear field is PRESENT; the value is never shown or logged.

export default function PlainKeyNotice({ vaultId, onSealed }: { vaultId: string; onSealed: () => void }) {
  const t = useT()
  const [pass, setPass] = useState('')
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState<string | null>(null)

  const submit = async (e: FormEvent) => {
    e.preventDefault()
    if (!pass || busy) return
    setBusy(true); setErr(null)
    try {
      await loadVault(vaultId, pass) // seals the clear key and removes it (#781); the share is not kept
      setPass('')
      onSealed()
    } catch {
      setErr(t('vaults.plainKeyWrong'))
    } finally {
      setBusy(false)
    }
  }

  return (
    <form className="cv-warn plain-key" role="note" onSubmit={(e) => void submit(e)} onClick={(e) => e.stopPropagation()} onKeyDown={(e) => e.stopPropagation()}>
      <strong>{t('vaults.plainKeyTitle')}</strong>
      <p className="dim">{t('vaults.plainKeyLead')}</p>
      <label className="field"><span>{t('vaults.plainKeyPass')}</span>
        <input className="input" type="password" autoComplete="current-password" value={pass} onChange={(e) => setPass(e.target.value)} disabled={busy} />
      </label>
      <button type="submit" className="btn ok sm-btn" disabled={!pass || busy}>{busy ? t('vaults.plainKeyBusy') : t('vaults.plainKeyBtn')}</button>
      <div role="alert">{err && <div className="hint warn mt-sm">{err}</div>}</div>
    </form>
  )
}
