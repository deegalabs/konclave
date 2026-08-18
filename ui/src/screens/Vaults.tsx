import { useEffect, useState } from 'react'
import { useNavigate, Link } from 'react-router-dom'
import { getVaults, health, setSelectedVault, unlockVault, markVaultUnlocked, isVaultUnlocked, shortAddr, IS_DEMO, type Vault } from '../api'
import { helperConfigured, getCustomHelper, setCoordMode, HELPER_BASE } from '../helper'
import { isDesktop } from '../platform'
import { listVaults, loadVault } from '../storage'
import { setUnlockedShare } from '../session'
import { Identicon } from '../avatar'
import { Dialog, Letterhead, activateOnKey } from '../components'
import NetVault from './NetVault'
import { useT, useTr, useI18n } from '../i18n'
import '../redesign.css'

const MOCK: Vault[] = [
  {
    id: 'mock', name: 'Tesouraria Comum', threshold: 2, total: 3, members: 3,
    member_list: [{ name: 'Alice', pubkey: 'a' }, { name: 'Bob', pubkey: 'b' }, { name: 'Carol', pubkey: 'c' }],
    group_pubkey: '', orchard_address: 'u1vjgxlvz4ewnt43rkq6fzexpld406dr',
  },
]

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
  // dialog; otherwise the local /create ceremony). It no longer gates the LIST — that's unified.
  const netMode = helperConfigured() && !IS_DEMO
  const [rows, setRows] = useState<Row[]>([])
  const [loaded, setLoaded] = useState(false)
  const [live, setLive] = useState(false)
  const [unlocking, setUnlocking] = useState<Row | null>(null)
  const [creating, setCreating] = useState(false)
  const [pass, setPass] = useState('')
  const [unlockErr, setUnlockErr] = useState<string | null>(null)
  const [unlockBusy, setUnlockBusy] = useState(false)
  // Ask-before-create (desktop): pick WHERE the ceremony is coordinated for this new vault.
  const [choosing, setChoosing] = useState(false)
  const [customStep, setCustomStep] = useState(false)
  const [chooseUrl, setChooseUrl] = useState(getCustomHelper())

  // Route the create card: on desktop, ask the coordination mode first; on the web the helper is
  // fixed, so go straight (helper -> browser DKG dialog, else the local /create ceremony).
  const startCreate = () => (isDesktop ? setChoosing(true) : netMode ? setCreating(true) : nav('/create'))

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
      // Demo: the coherent mock, unchanged.
      if (IS_DEMO) {
        const ok = await health()
        if (!on) return
        setLive(ok)
        const vs = ok ? await getVaults() : null
        if (!on) return
        setRows((vs && vs.length ? vs : MOCK).map((v) => ({ v, src: 'local' as Src })))
        setLoaded(true)
        return
      }
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
      setLive(bridgeOk || saved.length > 0)
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

        <div className="rd-grid">
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

          <div className="rd-card rd-create" role="button" tabIndex={0}
            onClick={startCreate} onKeyDown={activateOnKey(startCreate)}>
            <div>
              <div className="ic">
                <svg width="34" height="34" viewBox="0 0 34 34" fill="none" stroke="currentColor" strokeWidth="1.6">
                  <circle cx="13.5" cy="17" r="7.5" /><circle cx="20.5" cy="17" r="7.5" />
                </svg>
              </div>
              <div className="t">{t('vaults.createTitle')}</div>
              <div className="sub">{t('vaults.createSub')}</div>
            </div>
          </div>
        </div>

        {loaded && rows.length === 0 && (
          <div className="rd-empty">{t('vaults.empty')}</div>
        )}

        <div className="rd-note">
          {tr('vaults.note')}
          {' · '}<span className="rd-link" onClick={() => nav('/intro')} role="link" tabIndex={0}
            onKeyDown={(e) => { if (e.key === 'Enter') nav('/intro') }}>{t('vaults.howItWorks')}</span>
          {' · '}<span className="rd-link" onClick={() => nav('/demo')} role="link" tabIndex={0}
            onKeyDown={(e) => { if (e.key === 'Enter') nav('/demo') }}>{t('demo.watchCta')}</span>
          {!live && <> · <i>{t('vaults.demoMode')}</i></>}
        </div>
      </main>

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
          <h2 id="choose-title">{pt ? 'Como coordenar a cerimônia?' : 'How to coordinate the ceremony?'}</h2>
          <p>{pt
            ? 'Onde a cerimônia de aprovação é coordenada. O helper nunca vê um share em nenhuma opção.'
            : 'Where the approval ceremony is coordinated. The helper never sees a share in any option.'}</p>
          {!customStep ? (
            <div className="unlock-btns" style={{ flexDirection: 'column', gap: 8, alignItems: 'stretch' }}>
              {HELPER_BASE && (
                <button className="rd-enter primary" onClick={() => { setCoordMode('ours'); setChoosing(false); setCreating(true) }}>{pt ? 'Nosso helper hospedado' : 'Our hosted helper'}</button>
              )}
              <button className="rd-enter" onClick={() => setCustomStep(true)}>{pt ? 'Seu próprio helper' : 'Your own helper'}</button>
              <button className="rd-enter" onClick={() => { setCoordMode('local'); setChoosing(false); nav('/create') }}>{pt ? 'Local, sem helper' : 'Local, no helper'}</button>
            </div>
          ) : (
            <>
              <input className="unlock-input mono" inputMode="url" placeholder="https://seu-helper.exemplo.com"
                value={chooseUrl} onChange={(e) => setChooseUrl(e.target.value)}
                onKeyDown={(e) => { if (e.key === 'Enter' && chooseUrl.trim()) { setCoordMode('custom', chooseUrl); setChoosing(false); setCustomStep(false); setCreating(true) } }} />
              <div className="unlock-btns">
                <button className="rd-enter" onClick={() => setCustomStep(false)}>{t('common.cancel')}</button>
                <button className="rd-enter primary" disabled={!chooseUrl.trim()}
                  onClick={() => { setCoordMode('custom', chooseUrl); setChoosing(false); setCustomStep(false); setCreating(true) }}>{pt ? 'Continuar' : 'Continue'}</button>
              </div>
            </>
          )}
        </Dialog>
      )}

      {creating && (
        <Dialog className="create-overlay" cardClassName="create-card" labelledBy="create-title" onClose={() => setCreating(false)}>
          <NetVault embedded />
        </Dialog>
      )}
    </div>
  )
}
