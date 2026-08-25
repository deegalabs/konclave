import { useEffect, useState } from 'react'
import { useNavigate, Link } from 'react-router-dom'
import { getVaults, health, setSelectedVault, unlockVault, markVaultUnlocked, isVaultUnlocked, shortAddr, type Vault } from '../api'
import { helperConfigured, getCustomHelper, setCoordMode, HELPER_BASE } from '../helper'
import { isDesktop } from '../platform'
import { listVaults, loadVault, importVault, parseVaultExport, type VaultExport } from '../storage'
import { setUnlockedShare } from '../session'
import { Identicon } from '../avatar'
import { Dialog, Letterhead, activateOnKey } from '../components'
import NetVault from './NetVault'
import { useT, useTr, useI18n } from '../i18n'
import '../redesign.css'

// Every vault carries WHERE it lives, so one unified list can hold both worlds and route each
// card's unlock correctly: 'net' = a browser-DKG vault this device holds a share for (encrypted
// IndexedDB, unlocked by decrypting the share); 'local' = a local-bridge/orchestrator vault.
type Src = 'net' | 'local'
type Row = { v: Vault; src: Src }

export default function Vaults() {
  const t = useT()
  const tr = useTr()
  const { locale } = useI18n()
  const pt = locale === 'pt-BR'
  const nav = useNavigate()
  // netMode still decides how a NEW vault is created (a hosted helper configured -> browser DKG
  // dialog; otherwise the local /create ceremony). It no longer gates the LIST - that's unified.
  const netMode = helperConfigured()
  const [rows, setRows] = useState<Row[]>([])
  const [loaded, setLoaded] = useState(false)
  const [unlocking, setUnlocking] = useState<Row | null>(null)
  const [creating, setCreating] = useState(false)
  const [joinMode, setJoinMode] = useState(false) // the Join door opens the create modal straight into join
  const [pass, setPass] = useState('')
  const [unlockErr, setUnlockErr] = useState<string | null>(null)
  const [unlockBusy, setUnlockBusy] = useState(false)
  // Ask-before-create (desktop): pick WHERE the ceremony is coordinated for this new vault.
  const [choosing, setChoosing] = useState(false)
  const [customStep, setCustomStep] = useState(false)
  const [chooseUrl, setChooseUrl] = useState(getCustomHelper())
  // Import a vault export (#214, redesign): ONE field that is both the drop zone and the paste/type
  // target; the passphrase (stage B) is revealed only after the export validates (validate-then-unlock).
  const [importing, setImporting] = useState(false)
  const [impText, setImpText] = useState('')
  const [impParsed, setImpParsed] = useState<VaultExport | null>(null)
  const [dragOver, setDragOver] = useState(false)
  const [impPass, setImpPass] = useState('')
  const [impBusy, setImpBusy] = useState(false)
  const [impErr, setImpErr] = useState<string | null>(null)

  // Re-validate on every change to the single field (paste, type, or a dropped/chosen file's text).
  function onImpText(txt: string) {
    setImpText(txt); setImpErr(null); setImpPass('')
    const trimmed = txt.trim()
    if (!trimmed) { setImpParsed(null); return }
    try { setImpParsed(parseVaultExport(trimmed)) } catch { setImpParsed(null) }
  }
  function readFile(f: File | undefined | null) {
    if (!f) return
    void f.text().then(onImpText).catch(() => setImpErr(t('import.errFile')))
  }
  function onDrop(e: React.DragEvent) {
    e.preventDefault(); setDragOver(false)
    readFile(e.dataTransfer.files?.[0])
  }
  function onImportFile(e: React.ChangeEvent<HTMLInputElement>) {
    readFile(e.target.files?.[0])
    e.target.value = '' // allow re-picking the same file
  }
  function resetImport() {
    setImporting(false); setImpText(''); setImpParsed(null); setImpPass(''); setImpErr(null); setDragOver(false)
  }

  async function doImport() {
    if (!impParsed) return
    if (!impPass) { setImpErr(t('import.errPass')); return }
    setImpErr(null); setImpBusy(true)
    try {
      const meta = await importVault(impParsed, impPass)
      const row: Row = {
        src: 'net',
        v: {
          id: meta.id,
          name: meta.name || t('vaults.networkedVault'),
          threshold: 0,
          total: meta.roster.length,
          members: meta.roster.length,
          member_list: meta.roster.map((name) => ({ name, pubkey: name })),
          group_pubkey: meta.groupKey,
          orchard_address: meta.address,
        },
      }
      setRows((prev) => (prev.some((r) => r.v.id === meta.id) ? prev.map((r) => (r.v.id === meta.id ? row : r)) : [row, ...prev]))
      resetImport()
    } catch (e) {
      setImpErr(e instanceof Error ? e.message : t('import.errGeneric'))
    } finally {
      setImpBusy(false)
    }
  }

  // Route the create card: on desktop, ask the coordination mode first; on the web the helper is
  // fixed, so go straight (helper -> browser DKG dialog, else the local /create ceremony).
  const startCreate = () => (isDesktop ? setChoosing(true) : netMode ? setCreating(true) : nav('/create'))
  const validHelperUrl = (u: string) => /^https:\/\/\S+\.\S+/.test(u.trim())

  function enter(row: Row) {
    const { v, src } = row
    setSelectedVault(v.id)
    // Same inline unlock gate for both worlds. Already unlocked this session -> straight in. A 'net'
    // vault always holds a device share, so it always unlocks; a 'local' vault only when locked.
    if (isVaultUnlocked(v.id)) { nav('/dashboard'); return }
    if (src === 'net' || v.locked) { setUnlocking(row); setPass(''); setUnlockErr(null) }
    else nav('/dashboard')
  }
  async function doUnlock() {
    if (!unlocking || !pass) return
    const { v, src } = unlocking
    setUnlockBusy(true); setUnlockErr(null)
    try {
      if (src === 'net') {
        // Browser-native: decrypt this device's share into the session store, then open.
        const share = await loadVault(v.id, pass)
        setUnlockedShare(v.id, share)
        markVaultUnlocked(v.id)
        nav('/dashboard')
        return
      }
      const r = await unlockVault(pass)
      if (r.ok) { markVaultUnlocked(v.id); nav('/dashboard') }
      else setUnlockErr(r.wrong ? t('vaults.unlockWrong') : t('vaults.unlockFail'))
    } catch {
      setUnlockErr(t('vaults.unlockWrong'))
    } finally {
      setUnlockBusy(false)
    }
  }

  useEffect(() => {
    let on = true
    void (async () => {
      // Unified: every vault this device can reach, from BOTH sources.
      //  - 'net'   → browser-DKG vaults in encrypted IndexedDB (public metadata only; the share
      //             never leaves storage; no global helper enumeration).
      //  - 'local' → the local orchestrator/bridge's vaults (present on desktop/local server).
      // On the plain web the bridge is absent, so this degrades to the net-only list (as before).
      const [saved, bridgeOk] = await Promise.all([
        listVaults().catch(() => [] as Awaited<ReturnType<typeof listVaults>>),
        health().catch(() => false),
      ])
      const bridge = bridgeOk ? ((await getVaults().catch(() => null)) ?? []) : []
      if (!on) return
      const netRows: Row[] = saved.map((s) => ({
        src: 'net',
        v: {
          id: s.id,
          name: s.name || t('vaults.networkedVault'),
          // roster length is the participant count; the threshold isn't stored on-device, so the
          // card shows a neutral "networked" tag instead of a possibly-wrong quorum (threshold: 0).
          threshold: 0,
          total: s.roster.length,
          members: s.roster.length,
          member_list: s.roster.map((name) => ({ name, pubkey: name })),
          group_pubkey: s.groupKey,
          orchard_address: s.address,
        },
      }))
      const localRows: Row[] = bridge.map((v) => ({ src: 'local', v }))
      // Dedupe by id (the two sources shouldn't collide, but guard so a vault never shows twice).
      const seen = new Set<string>()
      const merged = [...netRows, ...localRows].filter((r) => (seen.has(r.v.id) ? false : (seen.add(r.v.id), true)))
      setRows(merged)
      setLoaded(true)
    })()
    return () => { on = false }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  return (
    <div className="rd">
      <main className="rd-shell">
        <Letterhead right={<>
          <span className="rd-status"><span className="dot" /> {tr('vaults.secureEnv')}</span>
          <Link to="/docs" className="doclink">Docs</Link>
        </>} />

        <div className="rd-hero">
          <span className="rd-eyebrow">{t('vaults.eyebrow')}</span>
          <h1>{t('vaults.heading')}</h1>
          <p>{tr('vaults.lead')}</p>
        </div>

        {/* Three equal doors: Create / Join / Import — the two cold-start doors are no longer hidden. */}
        <div className="rd-doors">
          <button type="button" className="rd-door primary" onClick={() => { setJoinMode(false); startCreate() }}>
            <span className="rd-door-ic" aria-hidden="true">
              <svg width="22" height="22" viewBox="0 0 34 34" fill="none" stroke="currentColor" strokeWidth="2"><circle cx="13.5" cy="17" r="7.5" /><circle cx="20.5" cy="17" r="7.5" /></svg>
            </span>
            <span className="rd-door-t">{t('vaults.doorCreate')}</span>
            <span className="rd-door-d">{t('vaults.doorCreateSub')}</span>
          </button>
          <button type="button" className="rd-door" onClick={() => { setJoinMode(true); setCreating(true) }}>
            <span className="rd-door-ic" aria-hidden="true">→</span>
            <span className="rd-door-t">{t('vaults.doorJoin')}</span>
            <span className="rd-door-d">{t('vaults.doorJoinSub')}</span>
          </button>
          <button type="button" className="rd-door" onClick={() => { setImpText(''); setImpParsed(null); setImpPass(''); setImpErr(null); setImporting(true) }}>
            <span className="rd-door-ic" aria-hidden="true">↑</span>
            <span className="rd-door-t">{t('vaults.doorImport')}</span>
            <span className="rd-door-d">{t('vaults.doorImportSub')}</span>
          </button>
        </div>

        {(rows.length > 0 || !loaded) && <div className="rd-vlabel">{t('vaults.onThisDevice')}</div>}

        <div className="rd-grid">
          {!loaded && Array.from({ length: 2 }, (_, i) => (
            <div key={'sk' + i} className="rd-card rd-skel" aria-hidden="true">
              <span className="sk-line" style={{ width: '42%', height: 20, borderRadius: 999 }} />
              <span className="sk-line" style={{ width: '58%', height: 22, marginTop: 14 }} />
              <div className="rd-avatars" style={{ marginTop: 16 }}>
                <span className="sk-dot" /><span className="sk-dot" />
                <span className="sk-line" style={{ width: '40%', height: 12 }} />
              </div>
              <span className="sk-line" style={{ width: '30%', height: 12, marginTop: 18 }} />
            </div>
          ))}
          {rows.map((row) => {
            const v = row.v
            const ms = v.member_list ?? []
            const avatars = ms.length ? ms : Array.from({ length: v.total }, (_, i) => ({ name: t('vaults.memberN', { n: i + 1 }), pubkey: '' }))
            return (
              <div key={v.id} className="rd-card" role="button" tabIndex={0}
                onClick={() => enter(row)} onKeyDown={activateOnKey(() => enter(row))}>
                <span className="rd-qtag">{v.threshold > 0 ? t('vaults.quorumOf', { t: v.threshold, n: v.total }) : t('vaults.networkedTag')}{v.locked ? ` · ${t('vaults.lockedTag')}` : ''}</span>
                <h3>{v.name}</h3>
                <div className="rd-avatars">
                  {avatars.slice(0, 4).map((m, i) => <Identicon key={i} seed={m.pubkey || m.name} />)}
                  <span className="names">{ms.length ? ms.map((m) => m.name).join(', ') : t('vaults.membersCount', { n: v.total })}</span>
                </div>
                {v.orchard_address && (
                  <div className="rd-recv"><span className="lab">{t('vaults.receive')}&nbsp;</span><span className="val">{shortAddr(v.orchard_address)}</span></div>
                )}
                <span className="rd-enter">{t('vaults.enter')} <span className="arw">→</span></span>
              </div>
            )
          })}
        </div>

        {loaded && rows.length === 0 && (
          <div className="rd-empty">{t('vaults.empty')}</div>
        )}

        {/* Only after the vault list resolves, so the local-first note does not flash above the
            skeleton during load. */}
        {loaded && (
          <div className="rd-note">
            {tr('vaults.note')}
            {' · '}<span className="rd-link" onClick={() => nav('/intro')} role="link" tabIndex={0}
              onKeyDown={activateOnKey(() => nav('/intro'))}>{t('vaults.howItWorks')}</span>
          </div>
        )}
      </main>

      {importing && (
        <Dialog className="unlock-overlay" cardClassName="unlock-card" labelledBy="import-title" onClose={resetImport}>
          <div className="rd-eyebrow">{t('import.eyebrow')}</div>
          <h2 id="import-title">{t('import.title')}</h2>

          {!impParsed ? (
            // Stage A: one field — drop a .konclave OR paste/type the export text (validated live).
            <>
              <p>{t('import.help')}</p>
              <label className={'imp-field' + (dragOver ? ' hot' : '')}
                onDragOver={(e) => { e.preventDefault(); setDragOver(true) }}
                onDragLeave={() => setDragOver(false)}
                onDrop={onDrop}>
                <textarea className="imp-field-ta mono" placeholder={t('import.dropOrPaste')}
                  value={impText} onChange={(e) => onImpText(e.target.value)} spellCheck={false} autoFocus />
                <span className="imp-field-file">
                  {t('import.orFile')}
                  <input type="file" accept=".json,.konclave,application/json" hidden onChange={onImportFile} />
                </span>
              </label>
              {impText.trim() && !impParsed && <div className="hint warn mt-xs">{t('import.notRecognized')}</div>}
              {impErr && <div className="unlock-err" role="alert">{impErr}</div>}
              <div className="unlock-btns">
                <button className="rd-enter" onClick={resetImport}>{t('common.cancel')}</button>
              </div>
            </>
          ) : (
            // Stage B: validated — show a preview from the public metadata, then unlock with the passphrase.
            <>
              <div className="imp-preview">
                <Identicon seed={impParsed.vault.groupKey || impParsed.vault.id} size={40} />
                <div className="imp-preview-main">
                  <div className="imp-preview-nm">{impParsed.vault.name || t('vaults.networkedVault')}</div>
                  <div className="imp-preview-meta mono">{t('import.previewMembers', { n: impParsed.vault.roster.length })} · {shortAddr(impParsed.vault.id, 6, 4)}</div>
                </div>
                <span className="imp-preview-ok mono">✓ {t('import.valid')}</span>
              </div>
              <input className="unlock-input mono" type="password" style={{ marginTop: 12 }} placeholder={t('import.passPlaceholder')}
                value={impPass} autoFocus onChange={(e) => { setImpPass(e.target.value); setImpErr(null) }}
                onKeyDown={(e) => { if (e.key === 'Enter') void doImport() }} />
              <div className="hint dim mt-xs">{t('import.stillSealed')}</div>
              {impErr && <div className="unlock-err" role="alert">{impErr}</div>}
              <div className="unlock-btns">
                <button className="rd-enter" onClick={() => { setImpParsed(null); setImpPass(''); setImpErr(null) }}>{t('common.back')}</button>
                <button className="rd-enter primary" onClick={() => void doImport()} disabled={impBusy || !impPass}>
                  {impBusy ? t('import.importing') : t('import.btn')}
                </button>
              </div>
            </>
          )}
        </Dialog>
      )}

      {unlocking && (
        <Dialog className="unlock-overlay" cardClassName="unlock-card" labelledBy="unlock-title" onClose={() => setUnlocking(null)}>
          <div className="rd-eyebrow">{t('vaults.protectedVault')}</div>
          <h2 id="unlock-title">{unlocking.v.name}</h2>
          <p>{unlocking.src === 'net'
            ? t('vaults.netUnlockPrompt')
            : tr('vaults.unlockPrompt')}</p>
          <input
            className="unlock-input mono" type="password" placeholder={unlocking.src === 'net' ? t('vaults.passphrase') : t('vaults.wordPlaceholder')}
            value={pass} onChange={(e) => setPass(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter') void doUnlock() }}
          />
          {unlockErr && <div className="unlock-err" role="alert">{unlockErr}</div>}
          <div className="unlock-btns">
            <button className="rd-enter" onClick={() => setUnlocking(null)}>{t('common.cancel')}</button>
            <button className="rd-enter primary" onClick={() => void doUnlock()} disabled={unlockBusy || !pass}>
              {unlockBusy ? t('vaults.verifying') : t('vaults.enterArrow')}
            </button>
          </div>
        </Dialog>
      )}

      {choosing && (
        <Dialog className="unlock-overlay" cardClassName="unlock-card" labelledBy="choose-title" onClose={() => { setChoosing(false); setCustomStep(false) }}>
          <div className="rd-eyebrow">{pt ? 'Criar cofre' : 'Create a vault'}</div>
          <h2 id="choose-title">{pt ? 'Onde coordenar as aprovações?' : 'Where to coordinate approvals?'}</h2>
          <p>{pt
            ? 'Onde as aprovações do grupo são coordenadas. Ninguém vê sua chave; só o grupo assina.'
            : 'Where the group approvals are coordinated. No one sees your key; only the group signs.'}</p>
          {!customStep ? (
            <div className="unlock-btns" style={{ flexDirection: 'column', gap: 8, alignItems: 'stretch' }}>
              {HELPER_BASE && (
                <button className="rd-enter primary" onClick={() => { setCoordMode('ours'); setChoosing(false); setCreating(true) }}>{pt ? 'Hospedado pela Konclave' : 'Konclave-hosted'}</button>
              )}
              <button className="rd-enter" onClick={() => setCustomStep(true)}>{pt ? 'Seu servidor' : 'Your server'}</button>
              <button className="rd-enter" onClick={() => { setCoordMode('local'); setChoosing(false); nav('/create') }}>{pt ? 'Só neste dispositivo' : 'This device only'}</button>
            </div>
          ) : (
            <>
              <input className="unlock-input mono" inputMode="url" placeholder={pt ? 'https://seu-servidor.exemplo.com' : 'https://your-server.example.com'}
                value={chooseUrl} onChange={(e) => setChooseUrl(e.target.value)}
                onKeyDown={(e) => { if (e.key === 'Enter' && validHelperUrl(chooseUrl)) { setCoordMode('custom', chooseUrl); setChoosing(false); setCustomStep(false); setCreating(true) } }} />
              <div className="unlock-btns">
                <button className="rd-enter" onClick={() => setCustomStep(false)}>{t('common.cancel')}</button>
                <button className="rd-enter primary" disabled={!validHelperUrl(chooseUrl)}
                  onClick={() => { setCoordMode('custom', chooseUrl); setChoosing(false); setCustomStep(false); setCreating(true) }}>{pt ? 'Continuar' : 'Continue'}</button>
              </div>
            </>
          )}
        </Dialog>
      )}

      {creating && (
        <Dialog className="create-overlay" cardClassName="create-card" labelledBy="create-title" onClose={() => setCreating(false)}>
          <NetVault embedded initialJoin={joinMode} />
        </Dialog>
      )}
    </div>
  )
}
