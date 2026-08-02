import { useEffect, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { Seal, Loading } from '../components'
import { PageHeader, PageFooter } from '../page'
import { useT } from '../i18n'
import { getVault, health, shortAddr, deleteVault, type Vault } from '../api'

/**
 * Per-vault settings (redesign Fase 0). Shows the vault's public identity (quorum, group,
 * address, members) and the local-device controls: the unlock method and "remove from this
 * device". Network is shown only once the vault carries it (Fase 2 wires per-vault network);
 * until then we do not invent one.
 */
export default function Settings() {
  const t = useT()
  const nav = useNavigate()
  const [vault, setVault] = useState<Vault | null>(null)
  const [live, setLive] = useState<boolean | null>(null)
  const [confirming, setConfirming] = useState(false)
  const [confirmName, setConfirmName] = useState('')
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState<string | null>(null)

  useEffect(() => {
    let on = true
    void (async () => {
      const ok = await health()
      if (!on) return
      setLive(ok)
      if (ok) {
        const v = await getVault()
        if (on && v) setVault(v)
      }
    })()
    return () => { on = false }
  }, [])

  const thr = vault?.threshold ?? 2
  const n = vault?.total ?? 3
  const network = (vault as unknown as { network?: string } | null)?.network

  async function removeFromDevice() {
    if (!vault || confirmName.trim() !== vault.name) return
    setBusy(true)
    setErr(null)
    const res = await deleteVault(undefined, confirmName.trim())
    setBusy(false)
    if (res.ok) { nav('/vaults'); return }
    setErr(res.wrong ? t('settings.nameMismatch') : t('settings.removeFail'))
  }

  return (
    <main className="page">
      <PageHeader
        eyebrow={t('settings.eyebrow')}
        title={t('settings.title')}
        subtitle={<>
          {vault?.name ?? t('settings.vault')} · {t('settings.quorumWord')} {thr}/{n}
          {live === false && <span className="livetag off"> {t('settings.demoTag')}</span>}
        </>}
        actions={<Seal t={thr} n={n} />}
      />

      {live === null && <Loading />}

      {live !== null && <>
      <div className="set-list mt">
        {network && (
          <div className="set-row">
            <span className="set-k">{t('settings.network')}</span>
            <span className="set-v"><span className="set-badge">{network === 'test' ? 'testnet' : 'mainnet'}</span></span>
          </div>
        )}
        <div className="set-row">
          <span className="set-k">{t('settings.quorum')}</span>
          <span className="set-v">{thr} {t('settings.of')} {n}</span>
        </div>
        <div className="set-row">
          <span className="set-k">{t('settings.members')}</span>
          <span className="set-v">{vault?.member_list?.length ?? n}</span>
        </div>
        <div className="set-row">
          <span className="set-k">{t('settings.address')}</span>
          <span className="set-v mono">{vault ? shortAddr(vault.orchard_address) : '—'}</span>
        </div>
        <div className="set-row">
          <span className="set-k">{t('settings.group')}</span>
          <span className="set-v mono">{vault ? vault.group_pubkey.slice(0, 10) + '…' : '—'}</span>
        </div>
        <div className="set-row">
          <span className="set-k">{t('settings.unlock')}</span>
          <span className="set-v">{t('settings.unlockValue')}</span>
        </div>
      </div>

      <section className="set-danger mt">
        <h2 className="set-danger-title">{t('settings.danger')}</h2>
        <p className="set-danger-note">{t('settings.dangerNote')}</p>
        {!confirming ? (
          <button type="button" className="btn danger" onClick={() => setConfirming(true)}>
            {t('settings.remove')}
          </button>
        ) : (
          <div className="set-confirm">
            <label className="field">
              <span>{t('settings.confirmPrompt')}</span>
              <input
                className="input mono"
                value={confirmName}
                onChange={(e) => setConfirmName(e.target.value)}
                placeholder={vault?.name ?? ''}
                autoFocus
              />
            </label>
            {err && <p className="set-err">{err}</p>}
            <div className="set-confirm-actions">
              <button
                type="button"
                className="btn danger"
                disabled={busy || confirmName.trim() !== vault?.name}
                onClick={removeFromDevice}
              >
                {busy ? t('settings.removing') : t('settings.confirmRemove')}
              </button>
              <button type="button" className="btn ghost" onClick={() => { setConfirming(false); setConfirmName(''); setErr(null) }}>
                {t('common.cancel')}
              </button>
            </div>
          </div>
        )}
      </section>
      </>}

      <PageFooter>{t('settings.footer')}</PageFooter>
    </main>
  )
}
