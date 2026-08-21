import { useEffect, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { Seal, Loading } from '../components'
import { PageHeader, PageFooter } from '../page'
import { Identicon } from '../avatar'
import { useT, useTr } from '../i18n'
import { getVault, health, shortAddr, IS_NET, renameSelf, IS_DEMO, type Vault } from '../api'
import { listVaults, type Governance } from '../storage'
import { vaultFingerprint } from '../format'

const ME = 'Alice' // this device acts as the coordinator member (single-device demo)

export default function Members() {
  const t = useT()
  const tr = useTr()
  const nav = useNavigate()
  const [vault, setVault] = useState<Vault | null>(null)
  const [live, setLive] = useState<boolean | null>(null)
  // Browser-native: the members are the DKG seats, each named at creation from that member's own
  // self-declared name. A device may edit ONLY its own seat's name (public coordination data, never
  // a share); the rename migrates that member's past votes so it never spawns a "ghost" approver.
  const [myNewName, setMyNewName] = useState('')
  const [saving, setSaving] = useState(false)
  const [renameErr, setRenameErr] = useState<string | null>(null)
  const [renamed, setRenamed] = useState(false)
  const [gov, setGov] = useState<Governance | null>(null)
  // The name THIS device chose at create/join, so "you" marks the right seat (was hardcoded to
  // 'Alice', which mislabeled every other device). Falls back to ME for the offline demo.
  const [me, setMe] = useState<string | null>(null)
  // Who set up the vault (propagated). Marks the creator - a real fixed fact - rather than the
  // per-ceremony FROST "coordinator" role, which used to be pinned to seat 0 (the wrong member).
  const [creator, setCreator] = useState<string | null>(null)
  // The vault's public group identity, hashed to a short code members compare out of band (#65 I4).
  const [fp, setFp] = useState<string | null>(null)
  const [copied, setCopied] = useState(false)

  useEffect(() => {
    let on = true
    void (async () => {
      const ok = await health()
      if (!on) return
      setLive(ok)
      // The identity we fingerprint: a real vault's group key when we have one, else a stable
      // demo identity so the sample screen still showcases the check.
      let identity = 'konclave-demo-vault'
      if (ok) {
        const v = await getVault()
        if (on && v) {
          setVault(v)
          identity = v.id
          try {
            const saved = await listVaults()
            const rec = saved.find((s) => s.id === v.id)
            if (on) { setGov(rec?.governance ?? 'open'); setMe(rec?.myName ?? null); setMyNewName(rec?.myName ?? ''); setCreator(rec?.creatorName ?? null) }
            if (rec?.groupKey) identity = rec.groupKey
          } catch { /* local-bridge mode - no on-device record */ }
        }
      }
      try {
        const code = await vaultFingerprint(identity)
        if (on) setFp(code)
      } catch { /* WebCrypto unavailable - skip the fingerprint callout */ }
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

  async function saveMyName() {
    if (!me) return
    const next = myNewName.trim()
    if (!next || next === me) return
    setSaving(true); setRenameErr(null); setRenamed(false)
    const res = await renameSelf(me, next)
    if ('members' in res) {
      const v = await getVault()
      if (v) setVault(v)
      setMe(next); setRenamed(true)
      setTimeout(() => setRenamed(false), 1800)
    } else {
      setRenameErr(res.error)
    }
    setSaving(false)
  }

  const thr = vault?.threshold ?? 2
  const n = vault?.total ?? 3
  // Sample roster ONLY in demo; a real vault still loading shows nothing (the Loading guard above
  // covers live===null), never a fabricated Alice/Bob/Carol.
  const members = vault?.member_list ?? (IS_DEMO ? [
    { name: 'Alice', pubkey: '317db593' },
    { name: 'Bob', pubkey: '2ca6d736' },
    { name: 'Carol', pubkey: '2fd84a5c' },
  ] : [])
  // Mark the actual creator; in the offline demo (no propagated creator) fall back to the first seat.
  const creatorLabel = creator ?? (IS_DEMO ? members[0]?.name ?? null : null)

  return (
    <>
      <main className="page">
        <PageHeader
          eyebrow={t('members.eyebrow', { t: thr, n })}
          title={t('members.title')}
          subtitle={<>
            {tr('members.vmeta', { t: thr })}
            {IS_DEMO && <span className="livetag off"> {t('members.demo')}</span>}
          </>}
          actions={<Seal t={thr} n={n} />}
        />

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

        {live === null ? <Loading /> : (
        <div className="signers mt">
          {members.map((m, i) => {
            const isMe = m.name === (me ?? ME)
            const isCreator = m.name === creatorLabel
            return (
              <div className={'signer-row' + (isMe ? ' me' : '')} key={i}>
                <Identicon seed={m.pubkey || m.name} size={40} />
                <div className="signer-main">
                  <div className="signer-name">
                    {m.name}
                    {isMe && <span className="you-tag">{t('members.youShort')}</span>}
                  </div>
                  <div className="signer-meta">
                    {/* the governance role, spelled out - this is a quorum body, not a contact list */}
                    <span className="role-chip">{t('members.roleShareVote')}</span>
                    {isCreator && <span className="role-chip creator">{t('members.roleCreatorChip')}</span>}
                  </div>
                </div>
                <span className="signer-id mono">id {shortAddr(m.pubkey, 6, 4)}</span>
              </div>
            )
          })}
        </div>
        )}

        {IS_NET && vault && gov === 'quorum' && (
          <div className="gov-nudge mt" role="note">{t('gov.nudgeSigners')}</div>
        )}

        {IS_NET && vault && me && (
          <div className="confirm mt">
            <div className="who-name mb-sm">{t('members.yourNameTitle')}</div>
            <div className="field">
              <input
                className="input"
                placeholder={me}
                value={myNewName}
                onChange={(e) => { setMyNewName(e.target.value); setRenameErr(null) }}
                onKeyDown={(e) => { if (e.key === 'Enter') void saveMyName() }}
              />
            </div>
            <button
              className="btn ok sm-btn mt-sm"
              disabled={saving || !myNewName.trim() || myNewName.trim() === me}
              aria-busy={saving}
              onClick={() => void saveMyName()}
            >
              {saving ? '…' : t('members.yourNameSave')}
            </button>
            {renamed && <div className="hint ready mt-sm">{t('members.yourNameSaved')}</div>}
            {renameErr && <div className="hint err mt-sm" role="alert">{t('members.renameErr')}: {renameErr}</div>}
            <div className="fp-help dim mt-sm">{t('members.yourNameHelp')}</div>
          </div>
        )}

        <PageFooter>
          <span>{t('members.footCount', { count: members.length, t: thr, n })}</span>
          <span className="dim pushr">{t('members.footNote')}</span>
        </PageFooter>

        <div className="confirm mt">{IS_NET ? tr('members.netNote') : tr('members.demoNote')}</div>
        <div className="right mt"><button className="btn ghost sm-btn" onClick={() => nav(IS_NET ? '/net' : '/create')}>{t('members.createNew')}</button></div>

      </main>
    </>
  )
}
