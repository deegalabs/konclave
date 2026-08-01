import { useEffect, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { Letterhead } from '../components'
import { useI18n } from '../i18n'
import { getSelectedVault, markVaultUnlocked } from '../api'
import { loadVault, listVaults, type VaultPublic } from '../storage'
import { setUnlockedShare } from '../session'
import '../redesign.css'
import '../net.css'

/**
 * /unlock — the single access gate (redesign Fase 1). Entering a vault requires unlocking YOUR
 * share on this device: the passphrase decrypts the share from IndexedDB into the session store,
 * then the app opens. No passphrase, no entry. The decrypted share is held in memory (session.ts)
 * so the signing ceremony reuses it without a second prompt. This IS the login, and it is local.
 */
export default function Unlock() {
  const { locale } = useI18n()
  const pe = (pt: string, en: string) => (locale === 'pt-BR' ? pt : en)
  const nav = useNavigate()
  const id = getSelectedVault()
  const [meta, setMeta] = useState<VaultPublic | null>(null)
  const [pass, setPass] = useState('')
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState<string | null>(null)

  useEffect(() => {
    if (!id) { nav('/vaults'); return }
    let on = true
    void (async () => {
      const list = await listVaults()
      if (on) setMeta(list.find((v) => v.id === id) ?? null)
    })()
    return () => { on = false }
  }, [id, nav])

  async function submit(e: React.FormEvent) {
    e.preventDefault()
    if (!id || !pass || busy) return
    setBusy(true)
    setErr(null)
    try {
      const v = await loadVault(id, pass)
      setUnlockedShare(id, v)
      markVaultUnlocked(id)
      nav('/dashboard')
    } catch {
      setErr(pe('Frase-senha incorreta.', 'Wrong passphrase.'))
      setBusy(false)
    }
  }

  const shortId = id ? id.slice(0, 10) + '…' : ''

  return (
    <div className="rd net-wrap">
      <Letterhead right={<button type="button" className="net-back-btn" onClick={() => nav('/vaults')}>← {pe('Cofres', 'Vaults')}</button>} />
      <div className="unlock-card">
        <svg className="unlock-lock" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" aria-hidden="true">
          <rect x="4.5" y="10.5" width="15" height="10" rx="2" />
          <path d="M8 10.5V7a4 4 0 0 1 8 0v3.5" />
          <circle cx="12" cy="15.5" r="1.4" fill="currentColor" stroke="none" />
        </svg>
        <h1 className="unlock-h1">{pe('Desbloquear o cofre', 'Unlock the vault')}</h1>
        <p className="unlock-sub">
          {pe(
            'Digite a sua frase-senha deste aparelho para abrir o seu pedaço da chave. Nada sai daqui: a chave é decifrada só na memória.',
            'Enter your passphrase for this device to open your share of the key. Nothing leaves here: the key is decrypted only in memory.',
          )}
        </p>
        <div className="unlock-meta">
          <span>{meta?.roster?.length ? pe('Cofre em rede', 'Networked vault') : pe('Cofre', 'Vault')}</span>
          <code>{shortId}</code>
        </div>
        <form onSubmit={submit} className="unlock-form">
          <input
            className="unlock-input"
            type="password"
            value={pass}
            onChange={(e) => setPass(e.target.value)}
            placeholder={pe('Frase-senha', 'Passphrase')}
            autoFocus
            autoComplete="current-password"
          />
          {err && <p className="unlock-err">{err}</p>}
          <button type="submit" className="net-btn primary" disabled={!pass || busy}>
            {busy ? pe('Abrindo…', 'Opening…') : pe('Desbloquear e entrar', 'Unlock and enter')}
          </button>
        </form>
      </div>
    </div>
  )
}
