import { useEffect, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { Seal, Loading, LangToggle, Soon } from '../components'
import { VersionBadge } from '../UpdatePrompt'
import { PageHeader, PageFooter } from '../page'
import { useT, useTr } from '../i18n'
import { getVault, getSelectedVault, health, shortAddr, deleteVault, IS_NET, type Vault } from '../api'
import { listVaults, exportVault, type Governance } from '../storage'
import { downloadText } from '../download'
import { vaultFingerprint } from '../format'
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
  const tr = useTr()
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
  // The vault fingerprint: a PUBLIC anti-impostor code members compare out of band. It lives here in
  // Settings (with the other vault-identity facts), not on the Signers roster (#160).
  const [fp, setFp] = useState<string | null>(null)
  const [copied, setCopied] = useState(false)
  // Export this vault (#214): only for vaults with a local encrypted record on this device (the
  // browser-native/relay path). The export is the sealed share + public record; never plaintext.
  const [hasLocal, setHasLocal] = useState(false)
  const [xpOpen, setXpOpen] = useState(false)
  const [xpPass, setXpPass] = useState('')
  const [xpBusy, setXpBusy] = useState(false)
  const [xpErr, setXpErr] = useState<string | null>(null)
  const [xpCopied, setXpCopied] = useState(false)

  useEffect(() => {
    let on = true
    void (async () => {
      const ok = await health()
      if (!on) return
      setLive(ok)
      // The identity we fingerprint: a real vault's group key when we have one, else the vault id.
      // Never a stand-in: a fabricated fingerprint would be compared out of band as if it were real.
      let identity: string | null = null
      if (ok) {
        const v = await getVault()
        if (on && v) setVault(v)
        // Governance is public vault metadata kept on-device (browser-native). Match by id; older
        // vaults without the field read as 'open' (the historical behavior).
        if (v) {
          identity = v.id
          try {
            const saved = await listVaults()
            const found = saved.find((s) => s.id === v.id)
            if (on) { setGov(found?.governance ?? 'open'); setHasLocal(!!found) }
            if (found?.groupKey) identity = found.groupKey
          } catch { /* no local record (local-bridge mode) - leave governance unshown */ }
        }
      }
      if (identity) {
        try {
          const code = await vaultFingerprint(identity)
          if (on) setFp(code)
        } catch { /* WebCrypto unavailable - skip the fingerprint callout */ }
      }
    })()
    return () => { on = false }
  }, [])

  async function copyFp() {
    if (!fp) return
    try {
      await navigator.clipboard.writeText(fp)
      setCopied(true)
      setTimeout(() => setCopied(false), 1500)
    } catch { /* clipboard blocked - the code is visible to read aloud anyway */ }
  }

  async function runExport(): Promise<{ json: string; name: string } | null> {
    setXpErr(null)
    const id = getSelectedVault()
    if (!id) { setXpErr(t('export.errNoVault')); return null }
    if (xpPass.length < 1) { setXpErr(t('export.errPass')); return null }
    try {
      const bundle = await exportVault(id, xpPass)
      const json = JSON.stringify(bundle, null, 2)
      const safe = (vault?.name ?? 'konclave-vault').replace(/[^\w.-]+/g, '-').toLowerCase()
      return { json, name: `${safe}.konclave.json` }
    } catch (e) {
      setXpErr(e instanceof Error ? e.message : t('export.errGeneric'))
      return null
    }
  }
  async function exportDownload() {
    setXpBusy(true)
    const out = await runExport()
    setXpBusy(false)
    if (out) downloadText(out.name, out.json)
  }
  async function exportCopy() {
    setXpBusy(true)
    const out = await runExport()
    setXpBusy(false)
    if (out) {
      try { await navigator.clipboard.writeText(out.json); setXpCopied(true); setTimeout(() => setXpCopied(false), 1500) } catch { setXpErr(t('export.errClipboard')) }
    }
  }

  const thr = vault?.threshold ?? 2
  const n = vault?.total ?? 3
  const network = (vault as unknown as { network?: string } | null)?.network

  async function removeFromDevice() {
    // `deleteVault` posts to the local bridge's /api/vault/delete and has no web path, so on the
    // web this could only ever fail. The control is hidden there rather than left to fail.
    if (IS_NET) return
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
        </>}
        actions={<Seal t={thr} n={n} />}
      />

      {/* Appearance - a per-device theme choice (white-first; dark opt-in). Not per-vault, so it
          renders regardless of vault/live state. */}
      <section className="set-list mt">
        <div className="set-row">
          <span className="set-k">{t('settings.appearance')}</span>
          <span className="set-v" style={{ display: 'inline-flex', gap: 8 }}>
            <button type="button" className={'btn' + (theme === 'light' ? ' ok' : ' ghost')} onClick={() => pickTheme('light')}>{t('settings.light')}</button>
            <button type="button" className={'btn' + (theme === 'dark' ? ' ok' : ' ghost')} onClick={() => pickTheme('dark')}>{t('settings.dark')}</button>
          </span>
        </div>
        <div className="set-row">
          <span className="set-k">{t('settings.language')}</span>
          <span className="set-v"><LangToggle /></span>
        </div>
      </section>
      <p className="set-hint">{t('settings.appearanceHint')}</p>

      {/* Coordination - WHERE the blind ceremony helper lives (desktop). Our hosted helper, your
          own, or fully local (no helper). The helper never sees a share in any mode. */}
      {isDesktop && (
        <>
          <section className="set-list mt">
            <div className="set-row">
              <span className="set-k">{t('settings.coordination')}</span>
              <span className="set-v" style={{ display: 'inline-flex', gap: 8, flexWrap: 'wrap' }}>
                {HELPER_BASE && (
                  <button type="button" className={'btn' + (coord === 'ours' ? ' ok' : ' ghost')} onClick={() => applyCoord('ours')}>{t('settings.coordHosted')}</button>
                )}
                <button type="button" className={'btn' + (coord === 'custom' ? ' ok' : ' ghost')} onClick={() => setCoord('custom')}>{t('settings.coordCustom')}</button>
                <button type="button" className={'btn' + (coord === 'local' ? ' ok' : ' ghost')} onClick={() => applyCoord('local')}>{t('settings.coordLocal')}</button>
              </span>
            </div>
            {coord === 'custom' && (
              <div className="set-row" style={{ gap: 8 }}>
                <input className="unlock-input mono" style={{ flex: 1 }} inputMode="url" placeholder={t('settings.coordUrlPlaceholder')} value={helperUrl} onChange={(e) => setHelperUrl(e.target.value)} />
                <button type="button" className="btn ok" disabled={!validHelperUrl(helperUrl)} onClick={() => applyCoord('custom', helperUrl)}>{t('settings.coordSave')}</button>
              </div>
            )}
          </section>
          <p className="set-hint">{t('settings.coordHint')}</p>
        </>
      )}

      {/* Relay selection (#213) is PARKED (single relay via VITE_RELAY_BASE for now); the picker lives
          on the feat/relay-in-invite branch until a real relay network exists. */}

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

      {fp && (
        <div className="fp-card mt" role="note" aria-label={t('members.fpTitle')}>
          <div className="fp-head">
            <span className="klab">{t('members.fpTitle')}</span>
            <button className="btn ghost xs-btn" onClick={() => void copyFp()}>
              {copied ? t('members.fpCopied') : t('members.fpCopy')}
            </button>
          </div>
          <div className="fp-code mono">{fp}</div>
          <div className="fp-help dim">{tr('members.fpHelp')}</div>
        </div>
      )}

      {hasLocal && (
        <section className="set-list mt">
          <div className="set-row">
            <span className="set-k">{t('export.title')}</span>
            <span className="set-v">
              {!xpOpen
                ? <button type="button" className="btn ghost" onClick={() => { setXpOpen(true); setXpErr(null) }}>{t('export.btn')}</button>
                : <button type="button" className="btn ghost" onClick={() => { setXpOpen(false); setXpPass(''); setXpErr(null) }}>{t('common.cancel')}</button>}
            </span>
          </div>
          {xpOpen && (
            <div className="set-row" style={{ flexDirection: 'column', alignItems: 'stretch', gap: 10 }}>
              <p className="set-hint" style={{ margin: 0 }}>{t('export.help')}</p>
              <input className="input mono" type="password" autoFocus placeholder={t('export.passPlaceholder')}
                value={xpPass} onChange={(e) => { setXpPass(e.target.value); setXpErr(null) }} />
              {xpErr && <p className="set-err">{xpErr}</p>}
              <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
                <button type="button" className="btn ok" disabled={xpBusy || !xpPass} onClick={() => void exportDownload()}>{xpBusy ? '…' : t('export.download')}</button>
                <button type="button" className="btn ghost" disabled={xpBusy || !xpPass} onClick={() => void exportCopy()}>{xpCopied ? t('members.fpCopied') : t('export.copy')}</button>
              </div>
            </div>
          )}
        </section>
      )}
      {hasLocal && <p className="set-hint">{t('export.note')}</p>}

      <section className="set-danger mt">
        <h2 className="set-danger-title">{t('settings.danger')}</h2>
        <p className="set-danger-note">{t('settings.dangerNote')}</p>
        {IS_NET ? (
          /* `deleteVault` posts to the local bridge and has no web path. Named rather than removed:
             a treasurer who wants to get rid of a vault should see that the product knows about it. */
          <Soon reason={t('settings.removeSoonWhy')}>
            <button type="button" className="btn danger" disabled>{t('settings.remove')}</button>
          </Soon>
        ) : !confirming ? (
          <button type="button" className="btn danger" onClick={() => setConfirming(true)}>
            {t('settings.remove')}
          </button>
        ) : (
          <div className="set-confirm">
            {/* Same funds-loss warning the Dashboard delete path shows — consistent risk disclosure. */}
            <div className="hint warn mt-xs">{tr('dashboard.deleteFundsWarn')}</div>
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

      <PageFooter>{t('settings.footer')} · <VersionBadge /></PageFooter>
    </main>
  )
}
