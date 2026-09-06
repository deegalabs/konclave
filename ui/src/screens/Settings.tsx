import { useEffect, useState } from 'react'
import { Skeleton } from '../skeleton'
import { Dialog, PassphraseField, Secret } from '../components'
import CopyButton from '../CopyButton'
import { changePassphrase } from '../storage'
import { useNavigate } from 'react-router-dom'
import { Seal, Loading, LangToggle } from '../components'
import { VersionBadge } from '../UpdatePrompt'
import { PageHeader, PageFooter } from '../page'
import { useT, useTr } from '../i18n'
import { loadPrfWrap, savePrfWrap, clearPrfWrap } from '../prf-store'
import { enrolPrf } from '../prf-wrap'
import { readSecretFor, getUnlockedShare } from '../session'
import { deviceCommsKey, devicePubHex } from '../device-key'
import { decodeBundle } from '../signing'
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
      // The viewing key AND the scan floor, from one gated call (#480). An export with the key but
      // no floor rebuilds a wallet that starts at NOW and never sees the notes the vault holds.
      //
      // The device key opens it (#481): the helper seals this response once the vault has a
      // registered device, so nothing on this machine that is not the vault's own device can read
      // it off the wire. The share is in session here - the member just typed their passphrase to
      // export - and `undefined` degrades to the plaintext compat path for an unmigrated vault.
      const loadedShare = getUnlockedShare(id)
      const device = loadedShare
        ? (() => {
            const kp = decodeBundle(loadedShare).keyPackage
            return { key: deviceCommsKey(kp), pubHex: devicePubHex(kp) }
          })()
        : undefined
      const keys = await getUfvk(id, device)
      const bundle = await exportVault(id, xpPass, keys?.ufvk, keys?.birthday)
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
      {/* No invented quorum. `thr`/`n` fall back to 2 and 3, so until `getVault` answered, every
          vault in the world was announced as 2/3 - in the subtitle AND stamped into the 90px seal.
          That is the exact defect the sections below were fixed for. The quorum is also stated once
          now, in the vault table, instead of three times in three renderings. */}
      <PageHeader
        eyebrow={t('settings.eyebrow')}
        title={t('settings.title')}
        subtitle={vault?.name ?? t('settings.vault')}
        actions={vault ? <Seal t={vault.threshold} n={vault.total} /> : undefined}
      />


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
      <h2 className="set-sec">{t('set.secVault')}</h2>
      <div className="set-list">
        {network && (
          <div className="set-row">
            <span className="set-k">{t('settings.network')}</span>
            <span className="set-v"><span className="set-badge">{network === 'test' ? 'testnet' : 'mainnet'}</span></span>
          </div>
        )}
        <div className="set-row">
          <span className="set-k">{t('settings.quorum')}</span>
          {/* Figures are mono. The contract has no exception for small ones. */}
          <span className="set-v mono">{thr} / {n}</span>
        </div>
        <div className="set-row">
          <span className="set-k">{t('settings.members')}</span>
          {/* `?? n` reported the CONFIGURED total as the seated count when the list was missing -
              a number standing in for a different number. It says nothing until it knows. */}
          <span className="set-v mono">{vault?.member_list?.length ?? '-'}</span>
        </div>
        <div className="set-row">
          <span className="set-k">{t('settings.address')}</span>
          {/* The tarja. This is the value that ties the vault to the chain, and Settings may be on
              screen while someone is looking over a shoulder. The app already veils it elsewhere
              through the same global reveal, so showing it in clear HERE was the inconsistency. */}
          <span className="set-v mono">
            {vault ? <Secret sm>{shortAddr(vault.orchard_address)}</Secret> : '-'}
          </span>
        </div>
        {/* The "Chave do grupo" row is GONE. It printed a truncated public key in hex on a screen
            whose rule is that the member sees vault, members, approval, payment - and the
            fingerprint below is derived from that same material, which is the speakable form of
            the identical fact. One of the two was redundant, and it was this one. */}
        {settled && fp && (
          <div className="set-row">
            <span className="set-k">{t('set.fingerprint')}</span>
            <span className="set-v">
              <span className="set-val-txt mono">{fp}</span>
              <CopyButton value={fp} />
            </span>
          </div>
        )}
        {!settled && (
          <div className="set-row">
            <Skeleton width={90} height={12} />
            <Skeleton width={150} height={12} />
          </div>
        )}
      </div>
      <p className="set-hint">{tr('members.fpHelp')}</p>

      <h2 className="set-sec">{t('set.secAccess')}</h2>
      <div className="set-list">
        {/* #468: this row used to render a FIXED string - "passphrase on this device" - regardless
            of what the device actually held, so it was a label pretending to be state. It is also
            the only sensible home for turning the passkey shortcut ON: enrolment needs `S`, which
            exists only once the vault is unlocked, so it cannot be offered at the lock screen
            before the first passphrase. Turn it on here once; the lock screen offers it from then
            on. Per device, because the spec guarantees nothing about PRF output surviving a
            passkey sync. */}
        <div className="set-row">
          <span className="set-k">{t('set.readRow')}</span>
          <span className="set-v">
            <span className="set-val-txt">{hasPasskey ? t('set.passkeyValue') : t('set.readValuePass')}</span>
            {(hasPasskey || canEnrol) && (
              <span className="set-actions">
                {hasPasskey ? (
                  <button type="button" className="btn ghost sm-btn" onClick={dropPasskey}>{t('set.passkeyOff')}</button>
                ) : (
                  <button type="button" className="btn ghost sm-btn" disabled={pkBusy} onClick={() => void addPasskey()}>
                    {pkBusy ? t('settings.passkeyBusy') : t('set.passkeyOn')}
                  </button>
                )}
              </span>
            )}
          </span>
        </div>
        {/* Two rows, not one with a "+". "passphrase + this device" reads as a requirement for
            both; the truth is the opposite - the shortcut opens the BOOKS, and spending still
            demands the passphrase. A row that cannot be acted on is the honest way to say a rule
            that has no setting. */}
        <div className="set-row">
          <span className="set-k">{t('set.spendRow')}</span>
          <span className="set-v"><span className="set-val-txt">{t('set.spendValue')}</span></span>
        </div>
        {pkErr && <div className="unlock-err" role="alert">{pkErr}</div>}
      </div>
      {/* Unconditional. It used to render only when this device could use a passkey, so a device
          that cannot never learned the rule it is subject to. */}
      <p className="set-hint">{t('set.accessNote')}</p>

      {gov && (
        <>
          <h2 className="set-sec">{t('set.secGov')}</h2>
          <div className="set-list">
            <div className="set-row">
              <span className="set-k">{t('settings.governance')}</span>
              {/* "Aberto" already means "anyone with the link reads your books" on the vault list.
                  One word, two meanings, on adjacent screens - so the governance one is renamed.
                  And an absent field is "no record", never an asserted policy. */}
              <span className="set-v">{gov === 'quorum' ? t('settings.govQuorum') : t('set.govNoQuorum')}</span>
            </div>
          </div>
          <p className="set-hint">{t('settings.govNote')}</p>
        </>
      )}

      <h2 className="set-sec">{t('set.secKeys')}</h2>
      {!settled ? (
        <div className="set-list">
          <div className="set-row"><Skeleton width={130} height={12} /><Skeleton width={96} height={34} radius={10} /></div>
          <div className="set-row"><Skeleton width={150} height={12} /><Skeleton width={96} height={34} radius={10} /></div>
        </div>
      ) : hasLocal ? (
        <div className="set-list">
          {/* Export comes FIRST because rotating depends on it: the rotation dialog tells the
              member to make one, and it used to live in a different section with no link between
              them. Both are `…` because both now open a dialog - the ellipsis was already there,
              describing a pattern the code did not have. */}
          <div className="set-row">
            <span className="set-k">{t('export.title')}</span>
            <span className="set-v"><span className="set-actions">
              <button type="button" className="btn ghost sm-btn" onClick={() => { setXpOpen(true); setXpErr(null) }}>
                {t('export.open')}
              </button>
            </span></span>
          </div>
          <div className="set-row">
            <span className="set-k">{t('rotate.btn')}</span>
            <span className="set-v"><span className="set-actions">
              <button type="button" className="btn ghost sm-btn" onClick={() => setRotOpen(true)}>
                {t('rotate.open')}
              </button>
            </span></span>
          </div>
        </div>
      ) : null}
      {settled && hasLocal && <p className="set-hint">{t('export.note')}</p>}

      <h2 className="set-sec">{t('set.secRemove')}</h2>
      <section className="set-danger">
        {/* The old note said what is NOT lost ("nothing is deleted from the network"), which is
            true and hides the part that matters. This says the cost. */}
        <p className="set-danger-note">{t('set.removeCost')}</p>
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
            <div className="hint warn mt-xs" id="rm-warn">{tr('dashboard.deleteFundsWarn')}</div>
            <label className="field">
              {/* The name is in the LABEL. It used to be the `placeholder`, so the gate that exists
                  to force an act of recall printed the answer inside the box - a transcription
                  exercise, not a confirmation. `aria-describedby` ties the funds warning to the
                  field, because `autoFocus` lands past it and it is never read otherwise. */}
              <span>{t('set.confirmLabel').replace('{name}', vault?.name ?? '')}</span>
              <input
                className="input mono"
                value={confirmName}
                onChange={(e) => setConfirmName(e.target.value)}
                aria-describedby="rm-warn"
                autoFocus
              />
            </label>
            {err && <p className="set-err" role="alert">{err}</p>}
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

      {/* Both disclosures are DIALOGS now. As inline cards they pushed the page ~260px, so the
          member lost their place; the dismiss lived in the row ABOVE the form, off-screen on a
          phone; and after success the only way out was a button labelled "Cancel". `Dialog` brings
          the focus trap, Escape, and focus return that were all missing. */}
      {rotOpen && (
        <Dialog className="unlock-overlay" cardClassName="unlock-card" labelledBy="rot-title"
          onClose={resetRotate}>
          <div className="rd-eyebrow">{t('vaults.protectedVault')}</div>
          <h2 id="rot-title">{t('rotate.btn')}</h2>
          {rotDone ? (
            <>
              <div className="dlg-ok" role="status">
                <b>{t('rotate.doneTitle')}</b> {t('rotate.doneBody')}
              </div>
              {/* The reminder belongs HERE, because this is the moment the old export went stale. */}
              <p className="set-hint" style={{ margin: '0 0 4px' }}>{t('rotate.doneExport')}</p>
              <div className="unlock-btns">
                <button className="rd-enter" onClick={() => { resetRotate(); setXpOpen(true) }}>
                  {t('rotate.exportNow')}
                </button>
                {/* "Concluir", never "Cancelar". The member just rotated the passphrase that seals
                    their share; an exit that reads as "undo" is the wrong last word. */}
                <button className="rd-enter primary" onClick={resetRotate}>{t('rotate.finish')}</button>
              </div>
            </>
          ) : (
            <>
              {/* The warning comes BEFORE the fields. It used to render below the confirm button,
                  and error prevention past the commit point prevents nothing. */}
              <div className="dlg-warn">
                <b>{t('rotate.note')}</b>{' '}
                <button type="button" className="lnk" onClick={() => { resetRotate(); setXpOpen(true) }}>
                  {t('rotate.exportFirst')}
                </button>
              </div>
              {rotErr && <div className="unlock-err" role="alert">{rotErr}</div>}
              <label className="field">
                <span>{t('rotate.currentLabel')}</span>
                <PassphraseField value={rotOld} onChange={(v) => { setRotOld(v); setRotErr(null) }}
                  placeholder={t('rotate.currentPlaceholder')} autoFocus
                  autoComplete="current-password" choosing={false} invalid={!!rotErr} />
              </label>
              <label className="field">
                <span>{t('rotate.newLabel')}</span>
                <PassphraseField value={rotNew} onChange={(v) => { setRotNew(v); setRotErr(null) }} />
              </label>
              <label className="field">
                <span>{t('rotate.new2Label')}</span>
                <PassphraseField value={rotNew2} onChange={(v) => { setRotNew2(v); setRotErr(null) }}
                  choosing={false} />
              </label>
              <div className="unlock-btns">
                <button className="rd-enter" onClick={resetRotate}>{t('common.cancel')}</button>
                <button className="rd-enter primary" disabled={rotBusy || !rotOld || !rotNew || !rotNew2}
                  onClick={() => void doRotate()}>
                  {rotBusy ? t('vaults.verifying') : t('rotate.confirm')}
                </button>
              </div>
            </>
          )}
        </Dialog>
      )}

      {xpOpen && (
        <Dialog className="unlock-overlay" cardClassName="unlock-card" labelledBy="xp-title"
          onClose={() => { setXpOpen(false); setXpPass(''); setXpErr(null) }}>
          <div className="rd-eyebrow">{t('vaults.protectedVault')}</div>
          <h2 id="xp-title">{t('export.title')}</h2>
          <p>{t('export.help')}</p>
          {xpErr && <div className="unlock-err" role="alert">{xpErr}</div>}
          <label className="field">
            <span>{t('export.currentLabel')}</span>
            <PassphraseField value={xpPass} onChange={(v) => { setXpPass(v); setXpErr(null) }}
              autoFocus autoComplete="current-password" choosing={false} invalid={!!xpErr} />
          </label>
          <div className="unlock-btns">
            <button className="rd-enter" onClick={() => void exportCopy()} disabled={xpBusy || !xpPass}>
              {xpCopied ? t('members.fpCopied') : t('export.copy')}
            </button>
            <button className="rd-enter primary" disabled={xpBusy || !xpPass} onClick={() => void exportDownload()}>
              {xpBusy ? t('settings.removing') : t('export.download')}
            </button>
          </div>
        </Dialog>
      )}

      {/* LAST, and under its own name. These are per-DEVICE app preferences, not vault settings,
          and they used to occupy the first screenful above the vault's own identity. Moving them
          into the shell is the fuller change and touches the rail; this is the reversible half. */}
      <h2 className="set-sec">{t('set.secApp')}</h2>
      <section className="set-list">
        <div className="set-row">
          <span className="set-k">{t('settings.appearance')}</span>
          {/* `aria-pressed`, so the selected option is exposed at all - the state was conveyed
              only by swapping the accent fill, which a screen reader cannot see. `LangToggle` in
              components.tsx already does this correctly; this is the same rule, second copy.
              And `.btn.ok` is gone: the blue means focus, primary action and QUORUM, never "this
              is the one you picked". */}
          <span className="set-v" role="group" aria-label={t('settings.appearance')}>
            <button type="button" aria-pressed={theme === 'light'} className={'btn sm-btn' + (theme === 'light' ? ' sel' : ' ghost')} onClick={() => pickTheme('light')}>{t('settings.light')}</button>
            <button type="button" aria-pressed={theme === 'dark'} className={'btn sm-btn' + (theme === 'dark' ? ' sel' : ' ghost')} onClick={() => pickTheme('dark')}>{t('settings.dark')}</button>
          </span>
        </div>
        <div className="set-row">
          <span className="set-k">{t('settings.language')}</span>
          <span className="set-v"><LangToggle /></span>
        </div>
      </section>

      <PageFooter>{t('settings.footer')} · <VersionBadge /></PageFooter>
    </main>
  )
}
