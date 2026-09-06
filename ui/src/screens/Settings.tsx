import { useEffect, useState } from 'react'
import { Skeleton } from '../skeleton'
import { changePassphrase } from '../storage'
import { useNavigate } from 'react-router-dom'
import { Seal, Loading, LangToggle } from '../components'
import { VersionBadge } from '../UpdatePrompt'
import { PageHeader, PageFooter } from '../page'
import { useT, useTr } from '../i18n'
import { loadPrfWrap, savePrfWrap, clearPrfWrap } from '../prf-store'
import { enrolPrf } from '../prf-wrap'
import { readSecretFor } from '../session'
import { getVault, getSelectedVault, clearSelectedVault, health, shortAddr, deleteVault, IS_NET, type Vault } from '../api'
import { listVaults, exportVault, forgetVault, type Governance } from '../storage'
import { clearUnlockedShare } from '../session'
import { downloadText } from '../download'
import { vaultFingerprint } from '../format'
import { getTheme, setTheme, type Theme } from '../theme'
import { getCoordMode, setCoordMode, getCustomHelper, HELPER_BASE, getUfvk, type CoordMode } from '../helper'
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
  // #469: everything below the vault card is gated on an async chain (health -> getVault ->
  // listVaults -> fingerprint), and until it lands the sections are simply ABSENT - they pop in one
  // by one. Worse, the danger zone renders `removeNoLocal` meanwhile, which asserts this device
  // holds nothing of the vault. That is not slowness, it is a wrong answer shown confidently, so
  // the fix is to say "loading" rather than to say the wrong thing faster.
  const [settled, setSettled] = useState(false)
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
      .finally(() => { if (on) setSettled(true) })
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

  // #468: the passkey shortcut, enrolled from here. `S` only - signing still asks for the
  // passphrase, which is the separation the whole thing exists for.
  const vaultId = getSelectedVault()
  const [hasPasskey, setHasPasskey] = useState(false)
  const [pkBusy, setPkBusy] = useState(false)
  const [pkErr, setPkErr] = useState<string | null>(null)
  useEffect(() => { setHasPasskey(!!(vaultId && loadPrfWrap(vaultId))) }, [vaultId])
  // Offered only when this device can actually do it: a vault selected, `S` in the session, and a
  // browser with WebAuthn. Advertising a control that cannot work is worse than not offering it.
  const canEnrol = !!vaultId && !!readSecretFor(vaultId) && typeof navigator !== 'undefined' && !!navigator.credentials

  async function addPasskey() {
    if (!vaultId) return
    const s = readSecretFor(vaultId)
    if (!s) { setPkErr(t('settings.passkeyNeedUnlock')); return }
    setPkBusy(true); setPkErr(null)
    try {
      const label = vault?.name || t('settings.vault')
      const wrap = await enrolPrf(navigator.credentials, vaultId, s, location.hostname, label)
      // `enrolPrf` returns null on ANY failure, cancellation included. Nothing is stored, and the
      // passphrase is untouched - a shortcut that fails must cost nothing.
      if (!wrap) { setPkErr(t('settings.passkeyFail')); return }
      savePrfWrap(vaultId, wrap)
      setHasPasskey(true)
    } finally {
      setPkBusy(false)
    }
  }

  /** Forget the wrap on THIS device. The vault is untouched: the passphrase still opens it. */
  function dropPasskey() {
    if (!vaultId) return
    clearPrfWrap(vaultId)
    setHasPasskey(false)
    setPkErr(null)
  }

  // #470: rotating the passphrase that seals this device's share. Local and per DEVICE - the
  // member's other machines keep theirs, which the copy says because the mechanics cannot.
  const [rotOpen, setRotOpen] = useState(false)
  const [rotOld, setRotOld] = useState('')
  const [rotNew, setRotNew] = useState('')
  const [rotNew2, setRotNew2] = useState('')
  const [rotBusy, setRotBusy] = useState(false)
  const [rotErr, setRotErr] = useState<string | null>(null)
  const [rotDone, setRotDone] = useState(false)

  function resetRotate() {
    setRotOpen(false); setRotOld(''); setRotNew(''); setRotNew2(''); setRotErr(null); setRotDone(false)
  }

  async function doRotate() {
    if (!vaultId) return
    if (rotNew !== rotNew2) { setRotErr(t('rotate.errMismatch')); return }
    setRotBusy(true); setRotErr(null)
    try {
      await changePassphrase(vaultId, rotOld, rotNew)
      setRotDone(true)
      setRotOld(''); setRotNew(''); setRotNew2('')
    } catch (e) {
      // `changePassphrase` proves the new seal opens before it writes, so a failure here means the
      // record was NOT touched - which is what the message promises.
      setRotErr(String(e).includes('same as') ? t('rotate.errSame') : t('rotate.errWrong'))
    } finally {
      setRotBusy(false)
    }
  }

  async function runExport(): Promise<{ json: string; name: string } | null> {
    setXpErr(null)
    const id = getSelectedVault()
    if (!id) { setXpErr(t('export.errNoVault')); return null }
    if (xpPass.length < 1) { setXpErr(t('export.errPass')); return null }
    try {
      // #214/#434: fetch the viewing key so the export can REBUILD the vault, not just restore the
      // seat. Without it, `t` members hold real spend authority over money none of them can see:
      // detecting notes needs the UFVK, and it is minted once, randomly, and kept on the helper.
      //
      // Best-effort by design. The helper refuses it for a vault with no readKey, and refuses it to
      // a device that cannot present one, so an open or locked vault gets `null` here. That export
      // is incomplete, and an incomplete export is far better than none - `docs/RECOVERY.md` still
      // describes the two halves.
      const ufvk = (await getUfvk(id)) ?? undefined
      const bundle = await exportVault(id, xpPass, ufvk)
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
    if (!vault || confirmName.trim() !== vault.name) return
    setBusy(true)
    setErr(null)
    // Two worlds, one control (#426). On the web the vault lives in THIS browser, so removing it
    // is a local delete - the record carries the sealed share, so dropping it gives up this
    // device's ability to sign. On the local bridge the orchestrator owns the record and deletes
    // it. Either way the member typed the vault's name to get here.
    if (IS_NET) {
      const gone = await forgetVault(vault.id).catch(() => false)
      setBusy(false)
      if (!gone) { setErr(t('settings.removeFail')); return }
      clearUnlockedShare(vault.id)
      clearSelectedVault()
      nav('/vaults')
      return
    }
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
        {/* #468: this row used to render a FIXED string - "passphrase on this device" - regardless
            of what the device actually held, so it was a label pretending to be state. It is also
            the only sensible home for turning the passkey shortcut ON: enrolment needs `S`, which
            exists only once the vault is unlocked, so it cannot be offered at the lock screen
            before the first passphrase. Turn it on here once; the lock screen offers it from then
            on. Per device, because the spec guarantees nothing about PRF output surviving a
            passkey sync. */}
        <div className="set-row">
          <span className="set-k">{t('settings.unlock')}</span>
          <span className="set-v" style={{ display: 'inline-flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
            {hasPasskey ? t('settings.unlockBoth') : t('settings.unlockValue')}
            {hasPasskey ? (
              <button type="button" className="btn ghost sm-btn" onClick={dropPasskey}>{t('settings.passkeyOff')}</button>
            ) : canEnrol ? (
              <button type="button" className="btn ok sm-btn" disabled={pkBusy} onClick={() => void addPasskey()}>
                {pkBusy ? t('settings.passkeyBusy') : t('settings.passkeyOn')}
              </button>
            ) : null}
            {hasLocal && (
              <button type="button" className="btn ghost sm-btn" onClick={() => (rotOpen ? resetRotate() : setRotOpen(true))}>
                {rotOpen ? t('common.cancel') : t('rotate.btn')}
              </button>
            )}
          </span>
        </div>
        {pkErr && <div className="unlock-err" role="alert">{pkErr}</div>}
      </div>
      {gov && <p className="set-hint">{t('settings.govNote')}</p>}
      {/* `settings.passkeyWhy` has existed in both dictionaries since the flow was designed and
          dropped. It says the thing that matters - the passphrase always works, and sending money
          still asks for it - so it is used rather than rewritten. */}
      {canEnrol || hasPasskey ? <p className="set-hint">{t('settings.passkeyWhy')}</p> : null}

      {rotOpen && (
        <section className="set-list mt">
          <div className="set-row" style={{ display: 'block' }}>
            {rotDone ? (
              <p className="set-hint" style={{ margin: 0 }} role="status">{t('rotate.done')}</p>
            ) : (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
                <p className="set-hint" style={{ margin: 0 }}>{t('rotate.help')}</p>
                <input className="input mono" type="password" autoFocus placeholder={t('rotate.oldPlaceholder')}
                  value={rotOld} onChange={(e) => { setRotOld(e.target.value); setRotErr(null) }} />
                <input className="input mono" type="password" placeholder={t('rotate.newPlaceholder')}
                  value={rotNew} onChange={(e) => { setRotNew(e.target.value); setRotErr(null) }} />
                <input className="input mono" type="password" placeholder={t('rotate.new2Placeholder')}
                  value={rotNew2} onChange={(e) => { setRotNew2(e.target.value); setRotErr(null) }} />
                {rotErr && <p className="set-err">{rotErr}</p>}
                <div>
                  <button type="button" className="btn ok sm-btn" disabled={rotBusy || !rotOld || !rotNew || !rotNew2}
                    onClick={() => void doRotate()}>
                    {rotBusy ? t('vaults.verifying') : t('rotate.confirm')}
                  </button>
                </div>
              </div>
            )}
          </div>
        </section>
      )}
      {rotOpen && !rotDone && <p className="set-hint">{t('rotate.note')}</p>}

      {!settled && (
        <div className="fp-card mt" role="status" aria-label={t('common.loading')}>
          <div className="fp-head"><Skeleton width={130} height={11} /></div>
          <Skeleton width="58%" height={30} radius={8} style={{ marginTop: 10 }} />
          <Skeleton width="90%" height={11} style={{ marginTop: 12 }} />
        </div>
      )}

      {settled && fp && (
        <div className="fp-card mt" role="note" aria-label={t('members.fpTitle')}>
          <div className="fp-head">
            <span className="klab">{t('members.fpTitle')}</span>
            <button className="btn ghost sm-btn" onClick={() => void copyFp()}>
              {copied ? t('members.fpCopied') : t('members.fpCopy')}
            </button>
          </div>
          <div className="fp-code mono">{fp}</div>
          <div className="fp-help dim">{tr('members.fpHelp')}</div>
        </div>
      )}

      {!settled && (
        <section className="set-list mt" role="status" aria-label={t('common.loading')}>
          <div className="set-row">
            <Skeleton width={120} height={12} />
            <Skeleton width={104} height={34} radius={10} />
          </div>
        </section>
      )}

      {settled && hasLocal && (
        <section className="set-list mt">
          <div className="set-row">
            <span className="set-k">{t('export.title')}</span>
            <span className="set-v">
              {!xpOpen
                ? <button type="button" className="btn ghost sm-btn" onClick={() => { setXpOpen(true); setXpErr(null) }}>{t('export.btn')}</button>
                : <button type="button" className="btn ghost sm-btn" onClick={() => { setXpOpen(false); setXpPass(''); setXpErr(null) }}>{t('common.cancel')}</button>}
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
      {settled && hasLocal && <p className="set-hint">{t('export.note')}</p>}

      <section className="set-danger mt">
        <h2 className="set-danger-title">{t('settings.danger')}</h2>
        <p className="set-danger-note">{t('settings.dangerNote')}</p>
        {!settled ? (
          /* NOT `removeNoLocal`. Until `listVaults` answers, "this device holds nothing of the
             vault" is a guess, and it is the alarming one - so the row waits instead. */
          <Skeleton width={180} height={38} radius={10} />
        ) : IS_NET && !hasLocal ? (
          /* Nothing of this vault is on this device - it is read through the helper. There is no
             share to give up, so the honest thing is to say so rather than offer a dead button. */
          <p className="set-danger-note">{t('settings.removeNoLocal')}</p>
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
