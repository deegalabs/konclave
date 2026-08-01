import { useEffect, useState } from 'react'
import { useNavigate, Link } from 'react-router-dom'
import { getVaults, health, setSelectedVault, unlockVault, markVaultUnlocked, isVaultUnlocked, shortAddr, type Vault } from '../api'
import { helperConfigured } from '../helper'
import { listVaults } from '../storage'
import { Identicon } from '../avatar'
import { Dialog, Letterhead, activateOnKey } from '../components'
import { useT, useTr, useI18n } from '../i18n'
import '../redesign.css'

const MOCK: Vault[] = [
  {
    id: 'mock', name: 'Tesouraria Comum', threshold: 2, total: 3, members: 3,
    member_list: [{ name: 'Alice', pubkey: 'a' }, { name: 'Bob', pubkey: 'b' }, { name: 'Carol', pubkey: 'c' }],
    group_pubkey: '', orchard_address: 'u1vjgxlvz4ewnt43rkq6fzexpld406dr',
  },
]

export default function Vaults() {
  const t = useT()
  const tr = useTr()
  const { locale } = useI18n()
  const pe = (pt: string, en: string) => (locale === 'pt-BR' ? pt : en)
  const nav = useNavigate()
  // Browser-native mode (a hosted blind helper is configured): the /vaults screen lists the vaults
  // THIS DEVICE holds a share for (from encrypted IndexedDB), never a global helper list, so one
  // device cannot enumerate another's vaults. Create/Enter route to the /net (Architecture B) flow.
  const netMode = helperConfigured()
  const [vaults, setVaults] = useState<Vault[]>([])
  const [loaded, setLoaded] = useState(false)
  const [live, setLive] = useState(false)
  const [unlocking, setUnlocking] = useState<Vault | null>(null)
  const [pass, setPass] = useState('')
  const [unlockErr, setUnlockErr] = useState<string | null>(null)
  const [unlockBusy, setUnlockBusy] = useState(false)

  function enter(v: Vault) {
    setSelectedVault(v.id)
    // Browser-native: entering a vault requires unlocking YOUR share on this device (the access
    // gate). The /unlock screen decrypts it into the session store; the Dashboard then opens and the
    // signing ceremony reuses the same unlocked share. Already unlocked this session -> straight in.
    if (netMode) { nav(isVaultUnlocked(v.id) ? '/dashboard' : '/unlock'); return }
    if (v.locked) { setUnlocking(v); setPass(''); setUnlockErr(null) }
    else nav('/dashboard')
  }
  async function doUnlock() {
    if (!unlocking || !pass) return
    setUnlockBusy(true); setUnlockErr(null)
    const r = await unlockVault(pass)
    setUnlockBusy(false)
    if (r.ok) { markVaultUnlocked(unlocking.id); nav('/dashboard') }
    else setUnlockErr(r.wrong ? t('vaults.unlockWrong') : t('vaults.unlockFail'))
  }

  useEffect(() => {
    let on = true
    void (async () => {
      // Browser-native: list the vaults this device holds a share for (encrypted IndexedDB).
      // Public metadata only (id, address, roster); the share never leaves storage here. No mock,
      // and no global helper enumeration.
      if (netMode) {
        let saved: Awaited<ReturnType<typeof listVaults>> = []
        try { saved = await listVaults() } catch { saved = [] }
        if (!on) return
        setLive(true)
        setVaults(saved.map((s) => ({
          id: s.id,
          name: pe('Cofre em rede', 'Networked vault'),
          // roster length is the participant count; the threshold is not stored on-device, so the
          // card shows a neutral "networked" tag instead of a possibly-wrong quorum (threshold: 0).
          threshold: 0,
          total: s.roster.length,
          members: s.roster.length,
          member_list: s.roster.map((name) => ({ name, pubkey: name })),
          group_pubkey: s.groupKey,
          orchard_address: s.address,
        })))
        setLoaded(true)
        return
      }
      const ok = await health()
      if (!on) return
      setLive(ok)
      const vs = ok ? await getVaults() : null
      if (!on) return
      setVaults(vs && vs.length ? vs : MOCK)
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
          {vaults.map((v) => {
            const ms = v.member_list ?? []
            const avatars = ms.length ? ms : Array.from({ length: v.total }, (_, i) => ({ name: t('vaults.memberN', { n: i + 1 }), pubkey: '' }))
            return (
              <div key={v.id} className="rd-card" role="button" tabIndex={0}
                onClick={() => enter(v)} onKeyDown={activateOnKey(() => enter(v))}>
                <span className="rd-qtag">{v.threshold > 0 ? t('vaults.quorumOf', { t: v.threshold, n: v.total }) : pe('Em rede', 'Networked')}{v.locked ? ` · ${t('vaults.lockedTag')}` : ''}</span>
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
            onClick={() => nav(netMode ? '/net' : '/create')} onKeyDown={activateOnKey(() => nav(netMode ? '/net' : '/create'))}>
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

        {loaded && vaults.length === 0 && (
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
          <h2 id="unlock-title">{unlocking.name}</h2>
          <p>{tr('vaults.unlockPrompt')}</p>
          <input
            className="unlock-input mono" type="password" placeholder={t('vaults.wordPlaceholder')}
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
    </div>
  )
}
