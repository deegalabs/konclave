import { useEffect, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { Seal, Loading } from '../components'
import { PageHeader, PageFooter } from '../page'
import { useT, useI18n } from '../i18n'
import { getVault, health, shortAddr, deleteVault, type Vault } from '../api'
import { listVaults, type Governance } from '../storage'
import { getTheme, setTheme, type Theme } from '../theme'
import { getCoordMode, setCoordMode, getCustomHelper, HELPER_BASE, type CoordMode } from '../helper'
import { isDesktop } from '../platform'

/**
 * Per-vault settings (redesign Fase 0). Shows the vault's public identity (quorum, group,
 * address, members) and the local-device controls: the unlock method and "remove from this
 * device". Network is shown only once the vault carries it (Fase 2 wires per-vault network);
 * until then we do not invent one.
 */
export default function Settings() {
  const t = useT()
  const { locale } = useI18n()
  const pt = locale === 'pt-BR'
  const nav = useNavigate()
  const [theme, setThemeState] = useState<Theme>(getTheme())
  const pickTheme = (v: Theme) => { setTheme(v); setThemeState(v) }
  // Coordination mode (desktop): our helper / your own / local. Persist + reload so netMode
  // recomputes app-wide. The helper stays blind in every mode.
  const [coord, setCoord] = useState<CoordMode>(getCoordMode())
  const [helperUrl, setHelperUrl] = useState(getCustomHelper())
  const applyCoord = (mode: CoordMode, url?: string) => { setCoordMode(mode, url); location.reload() }
  const validHelperUrl = (u: string) => /^https:\/\/\S+\.\S+/.test(u.trim())
  const [vault, setVault] = useState<Vault | null>(null)
  const [gov, setGov] = useState<Governance | null>(null)
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
        // Governance is public vault metadata kept on-device (browser-native). Match by id; older
        // vaults without the field read as 'open' (the historical behavior).
        if (v) {
          try {
            const saved = await listVaults()
            const found = saved.find((s) => s.id === v.id)
            if (on) setGov(found?.governance ?? 'open')
          } catch { /* no local record (local-bridge mode) - leave governance unshown */ }
        }
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

      {/* Appearance - a per-device theme choice (white-first; dark opt-in). Not per-vault, so it
          renders regardless of vault/live state. */}
      <section className="set-list mt">
        <div className="set-row">
          <span className="set-k">{pt ? 'Aparência' : 'Appearance'}</span>
          <span className="set-v" style={{ display: 'inline-flex', gap: 8 }}>
            <button type="button" className={'btn' + (theme === 'light' ? ' ok' : ' ghost')} onClick={() => pickTheme('light')}>{pt ? 'Claro' : 'Light'}</button>
            <button type="button" className={'btn' + (theme === 'dark' ? ' ok' : ' ghost')} onClick={() => pickTheme('dark')}>{pt ? 'Escuro' : 'Dark'}</button>
          </span>
        </div>
      </section>
      <p className="set-hint">{pt ? 'Preferência deste dispositivo · o branco é o padrão, o escuro é opcional.' : 'A per-device preference · white is the default, dark is optional.'}</p>

      {/* Coordination - WHERE the blind ceremony helper lives (desktop). Our hosted helper, your
          own, or fully local (no helper). The helper never sees a share in any mode. */}
      {isDesktop && (
        <>
          <section className="set-list mt">
            <div className="set-row">
              <span className="set-k">{pt ? 'Coordenação' : 'Coordination'}</span>
              <span className="set-v" style={{ display: 'inline-flex', gap: 8, flexWrap: 'wrap' }}>
                {HELPER_BASE && (
                  <button type="button" className={'btn' + (coord === 'ours' ? ' ok' : ' ghost')} onClick={() => applyCoord('ours')}>{pt ? 'Hospedado pela Konclave' : 'Konclave-hosted'}</button>
                )}
                <button type="button" className={'btn' + (coord === 'custom' ? ' ok' : ' ghost')} onClick={() => setCoord('custom')}>{pt ? 'Seu servidor' : 'Your server'}</button>
                <button type="button" className={'btn' + (coord === 'local' ? ' ok' : ' ghost')} onClick={() => applyCoord('local')}>{pt ? 'Só neste dispositivo' : 'This device only'}</button>
              </span>
            </div>
            {coord === 'custom' && (
              <div className="set-row" style={{ gap: 8 }}>
                <input className="unlock-input mono" style={{ flex: 1 }} inputMode="url" placeholder={pt ? 'https://seu-servidor.exemplo.com' : 'https://your-server.example.com'} value={helperUrl} onChange={(e) => setHelperUrl(e.target.value)} />
                <button type="button" className="btn ok" disabled={!validHelperUrl(helperUrl)} onClick={() => applyCoord('custom', helperUrl)}>{pt ? 'Salvar' : 'Save'}</button>
              </div>
            )}
          </section>
          <p className="set-hint">{pt
            ? 'Quem coordena as aprovações. Ninguém vê sua chave; só o grupo assina. Use uma URL https. Aplica ao trocar.'
            : 'Who coordinates approvals. No one sees your key; only the group signs. Use an https URL. Applies on change.'}</p>
        </>
      )}

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
          <span className="set-v mono">{vault ? shortAddr(vault.orchard_address) : '-'}</span>
        </div>
        <div className="set-row">
          <span className="set-k">{t('settings.group')}</span>
          <span className="set-v mono">{vault ? vault.group_pubkey.slice(0, 10) + '…' : '-'}</span>
        </div>
        {gov && (
          <div className="set-row">
            <span className="set-k">{t('settings.governance')}</span>
            <span className="set-v">{gov === 'quorum' ? t('settings.govQuorum') : t('settings.govOpen')}</span>
          </div>
        )}
        <div className="set-row">
          <span className="set-k">{t('settings.unlock')}</span>
          <span className="set-v">{t('settings.unlockValue')}</span>
        </div>
      </div>
      {gov && <p className="set-hint">{t('settings.govNote')}</p>}

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
