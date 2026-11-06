import { useCallback, useEffect, useRef, useState } from 'react'
import { useToast } from '../toast'
import { SkeletonRoster } from '../skeleton'
import { Seal } from '../components'
import { PageHeader, PageFooter } from '../page'
import { Identicon } from '../avatar'
import { useT, useTr } from '../i18n'
import { useVaultReadable } from '../vault-readable'
import { getVault, health, humanError, shortAddr, IS_NET, renameSelf, adoptSelfName, type Vault } from '../api'
import { listVaults, type Governance } from '../storage'

/** What the screen shows for a roster: still reading, could not read (the coordinator did not
 *  answer, or answered without a vault), or the real list. One rule, so a list that was not read
 *  is never drawn as an empty vault with every seat marked healthy (#315). */
export type MembersView = 'loading' | 'unread' | 'roster'
export function membersView(live: boolean | null, vault: Vault | null): MembersView {
  if (live === null) return 'loading'
  // A vault whose names came from this device's roster, not the coordinator, is not a list that
  // was read (api.ts falls back to the on-device names so the ceremony drawer keeps its names).
  return live && vault && vault.members_read !== false ? 'roster' : 'unread'
}


export default function Members() {
  const t = useT()
  const toast = useToast()
  const tr = useTr()
  const [vault, setVault] = useState<Vault | null>(null)
  const [live, setLive] = useState<boolean | null>(null)
  // Browser-native: the members are the DKG seats, each named at creation from that member's own
  // self-declared name. A device may edit ONLY its own seat's name (public coordination data, never
  // a share); the rename migrates that member's past votes so it never spawns a "ghost" approver.
  const [myNewName, setMyNewName] = useState('')
  const [saving, setSaving] = useState(false)
  const [renameErr, setRenameErr] = useState<string | null>(null)
  // Read from the on-device record but not shown: the governance nudge it used to gate was
  // removed. Kept as a setter-only so the record read stays intact for whatever needs it next.
  const [, setGov] = useState<Governance | null>(null)
  // The vault's public group identity, hashed to a short code members compare out of band (#65 I4).
  // The name THIS device chose at create/join, so "you" marks the right seat. Without an on-device
  // record there is no "you" to mark - never guess a seat.
  const [me, setMe] = useState<string | null>(null)
  // Who set up the vault (propagated). Marks the creator - a real fixed fact - rather than the
  // per-ceremony FROST "coordinator" role, which used to be pinned to seat 0 (the wrong member).
  const [creator, setCreator] = useState<string | null>(null)
  // Bumped by the retry button: the read runs again from the start (#315).
  const [attempt, setAttempt] = useState(0)
  const readable = useVaultReadable()
  const retry = useCallback(() => { setLive(null); setVault(null); setAttempt((a) => a + 1) }, [])
  // The retry button unmounts with the message; focus moves to the message when it comes back,
  // so a keyboard or screen-reader member is not dropped at the top of the page.
  const unreadRef = useRef<HTMLDivElement>(null)
  useEffect(() => {
    // Locked: the roster read would 401; nothing is read until the passphrase lands (#439).
    if (!readable) return
    let on = true
    void (async () => {
      const ok = await health()
      if (!on) return
      if (ok) {
        const v = await getVault()
        if (!on) return
        if (v) {
          setVault(v)
          try {
            const saved = await listVaults()
            const rec = saved.find((s) => s.id === v.id)
            if (on) { setGov(rec?.governance ?? 'open'); setMe(rec?.myName ?? null); setMyNewName(rec?.myName ?? ''); setCreator(rec?.creatorName ?? null) }
          } catch { /* local-bridge mode - no on-device record */ }
        }
      }
      // Set last, so the screen never shows "live" with a vault still on its way.
      setLive(ok)
    })()
    return () => { on = false }
  }, [attempt, readable])

  async function saveMyName() {
    const next = myNewName.trim()
    if (!next) return
    const rosterNames = (vault?.member_list ?? []).map((m) => m.name)
    const meInRoster = !!me && rosterNames.includes(me)
    // Self-heal for a stale on-device name: a prior rename synced the helper (the roster already
    // shows the new name) but not this device (its record kept the OLD name). The server would reject
    // renaming a name it no longer has ("no such member to rename"). If the name you want is ALREADY
    // in the roster and your stored name is not, just ADOPT it locally - no server rename.
    if (!meInRoster && rosterNames.includes(next)) {
      setSaving(true); setRenameErr(null)
      const res = await adoptSelfName(next)
      if ('ok' in res) { setMe(next); setMyNewName(''); toast.ok(t('toast.nameSaved')) }
      else setRenameErr(res.error)
      setSaving(false)
      return
    }
    if (!me || next === me) return
    setSaving(true); setRenameErr(null)
    const res = await renameSelf(me, next)
    if ('members' in res) {
      const v = await getVault()
      if (v) setVault(v)
      setMe(next); setMyNewName('')
      toast.ok(t('toast.nameSaved'))
    } else {
      setRenameErr(res.error)
    }
    setSaving(false)
  }

  const thr = vault?.threshold ?? 2
  const n = vault?.total ?? 3
  // The real roster only; a vault still loading shows nothing (the Loading guard below covers
  // live===null), never a fabricated Alice/Bob/Carol.
  const members = vault?.member_list ?? []
  // Mark the actual creator when the on-device record carries one.
  const creatorLabel = creator
  // This device's stored name is NOT in the current roster: a prior rename synced the helper but not
  // this device, so it is "stuck". The editor self-heals (adopt an existing roster name); flag it.
  const meOutOfSync = !!me && members.length > 0 && !members.some((m) => m.name === me)
  const view = membersView(live, vault)
  useEffect(() => { if (view === 'unread' && attempt > 0) unreadRef.current?.focus() }, [view, attempt])

  return (
    <>
      <main className="page">
        <PageHeader
          eyebrow={t('members.eyebrow', { t: thr, n })}
          title={t('members.title')}
          subtitle={<>
            {tr('members.vmeta', { t: thr })}
          </>}
          actions={<Seal t={thr} n={n} />}
        />


        {view === 'loading' && <SkeletonRoster n={4} />}
        {view === 'unread' && (
          <div className="hint warn mt" role="alert" tabIndex={-1} ref={unreadRef}>
            <div className="who-name mb-sm">{t('members.unreadTitle')}</div>
            <p className="dim">{t('members.unreadLead')}</p>
            <button className="btn ok sm-btn mt-sm" onClick={retry}>{t('members.retry')}</button>
          </div>
        )}
        {view === 'roster' && (
        <div className="signers mt">
          {members.map((m, i) => {
            const isMe = !!me && m.name === me
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

        {IS_NET && vault && me && (
          <div className="confirm mt">
            <div className="who-name mb-sm">{t('members.yourNameTitle')}</div>
            {meOutOfSync && <div className="hint warn mt-sm">{t('members.yourNameOutOfSync')}</div>}
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
            {renameErr && <div className="hint err mt-sm" role="alert">{t('members.renameErr')}: {humanError(t, renameErr)}</div>}
          </div>
        )}

        <PageFooter>
          <span>{view === 'roster' ? t('members.footCount', { count: members.length, t: thr, n }) : t('members.footUnread')}</span>
          <span className="dim pushr">{t('members.footNote')}</span>
        </PageFooter>

        <div className="confirm mt">{IS_NET ? tr('members.netNote') : tr('members.localNote')}</div>

      </main>
    </>
  )
}
