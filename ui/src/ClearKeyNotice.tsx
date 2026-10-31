// #784: a device that imported a backup before #781 may still hold the vault's viewing key in the
// clear. Typing the passphrase runs the rewrite in `loadVault` (the key is sealed under it); a
// passkey unlock cannot, because a passkey does not open what the key is sealed under. So a member
// who only uses a passkey on this device kept the old record, and nothing on screen said so. This
// notice asks for the passphrase once, while the clear field is there, and goes away when it is gone.
// It reads only whether the field is present; it never shows or logs the value.
import { useEffect, useState } from 'react'
import { PassphraseField } from './components'
import { hasClearViewingKey, loadVault } from './storage'
import { storageErrorKey } from './storage-errors'
import { useT } from './i18n'

/** `unlockNonce` is the shell's unlock counter: a passphrase unlock rewrites the record on its own,
 *  so the notice looks again each time the door opens. */
export default function ClearKeyNotice({ vaultId, unlockNonce }: { vaultId: string; unlockNonce: number }) {
  const t = useT()
  const [pending, setPending] = useState<boolean | null>(null)
  const [pass, setPass] = useState('')
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState<string | null>(null)
  const [done, setDone] = useState(false)

  useEffect(() => {
    let on = true
    setPending(null); setDone(false); setErr(null); setPass('')
    void hasClearViewingKey(vaultId).then((v) => { if (on) setPending(v) }, () => { if (on) setPending(false) })
    return () => { on = false }
  }, [vaultId, unlockNonce])

  async function seal() {
    if (!pass || busy) return
    setBusy(true); setErr(null)
    try {
      // The rewrite happens inside loadVault: with the passphrase's key at hand it seals the clear
      // field and removes it. What it returns is not kept here.
      await loadVault(vaultId, pass)
      setPending(await hasClearViewingKey(vaultId))
      setDone(true)
    } catch (e) {
      setErr(t(storageErrorKey(e, 'storage.err.wrongPassphraseSaved')))
    } finally {
      setBusy(false); setPass('')
    }
  }

  if (pending === null) return null
  if (!pending) {
    return done ? <p className="hint clearkey-done" role="status">{t('clearKey.done')}</p> : null
  }
  return (
    <section className="clearkey" role="region" aria-labelledby="clearkey-title">
      <h2 id="clearkey-title" className="clearkey-title">{t('clearKey.title')}</h2>
      <p className="clearkey-body">{t('clearKey.body')}</p>
      <form className="clearkey-form" onSubmit={(e) => { e.preventDefault(); void seal() }}>
        <label className="field">
          <span>{t('clearKey.passphrase')}</span>
          <PassphraseField value={pass} onChange={(v) => { setPass(v); setErr(null) }} autoComplete="current-password" choosing={false} invalid={!!err} />
        </label>
        {err && <p className="hint err" role="alert">{err}</p>}
        <button type="submit" className="btn ok sm-btn" disabled={!pass || busy} aria-busy={busy}>{busy ? '…' : t('clearKey.submit')}</button>
      </form>
    </section>
  )
}
