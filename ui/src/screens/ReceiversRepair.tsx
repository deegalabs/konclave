import { useState } from 'react'
import { addressText } from '../approved-payment'
import { useT } from '../i18n'
import type { VaultPublic } from '../storage'
import { repairVaultReceivers } from '../vault-receivers'

/** A device that refused the viewing key it was served. The coordinator's answer can make this appear,
 *  and carries only a code in it; nothing runs until the member opens the form, types and clicks. */
export function ReceiversRepair({ rec, onDone }: { rec: VaultPublic; onDone: () => void }) {
  const t = useT()
  const [open, setOpen] = useState(false)
  const [typed, setTyped] = useState('')
  const [pass, setPass] = useState('')
  const [msg, setMsg] = useState('')
  const [busy, setBusy] = useState(false)

  const run = async () => {
    const passphrase = pass
    setPass('')
    setBusy(true)
    let r: Awaited<ReturnType<typeof repairVaultReceivers>>
    try {
      r = await repairVaultReceivers(rec.id, passphrase, typed)
    } catch {
      r = { state: 'unavailable' }
    } finally {
      setBusy(false)
    }
    setMsg(t(r.state === 'verified' ? 'set.repairDone' : r.state === 'refused' ? 'set.repairRefused' : r.state === 'unavailable' ? 'set.repairWaiting' : r.state === 'unreadable' ? 'set.repairUnreadable' : 'set.repairWrong'))
    onDone()
  }

  const held = rec.viewingFingerprint
  const served = rec.servedFingerprint
  const refused = rec.receiversState === 'refused' && !!addressText(rec.address)
  if (!refused) return msg ? <p role="status">{msg}</p> : null
  return (
    <>
      <section className="set-danger">
        <div role="alert">
          <h2 className="set-sec">{t('set.repairTitle')}</h2>
          <p>{!served ? t('set.repairForeign') : held ? t('set.repairBody', { held, served }) : t('set.repairBodyNoCode', { served })}</p>
        </div>
        {!open && <button type="button" className="cv-linkbtn" onClick={() => setOpen(true)}>{t('set.repairOpen')}</button>}
        {open && (
          <>
            <p>{t('set.repairHow')}</p>
            <label>{t('set.repairTyped')} <input value={typed} onChange={(e) => setTyped(e.target.value)} autoComplete="off" /></label>
            <label>{t('set.readValuePass')} <input type="password" value={pass} onChange={(e) => setPass(e.target.value)} autoComplete="current-password" /></label>
            <button type="button" className="btn" disabled={!typed || !pass || busy} onClick={() => { void run() }}>{t('set.repairGo')}</button>
          </>
        )}
      </section>
      {msg && <p role="status">{msg}</p>}
    </>
  )
}
