import { ensureWasm } from '../wasm-ready'
import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react'
import { useNavigate } from 'react-router-dom'
import { setSelectedVault, getSelectedVault } from '../api'
import CopyButton from '../CopyButton'
import { getUnlockedShare, clearUnlockedShare, setUnlockedShare } from '../session'
import {
  DeviceKey,
  identifierBytes,
  type CreationSession,
} from '../wasm-pkg/konclave_wasm.js'
import { DkgCeremony, DKG_VERSION, type DkgAbort, type DkgConfig, type DkgMsg } from '../dkg-ceremony'
import { InviteCard, CodeCheck, StopPanel, WaitLine, saveWaitText } from './CeremonyParts'
import { creationBusy, closeIntent } from '../creation-guard'
import { RelaySession, newRoomCode, newInviteCode, parseInvite, joinParam, formatInvite, deriveRoom, ephemeralTag, b64, relayBase, type RelayMsg } from '../net'
import { decodeBundle } from '../signing'
import { SigningMachine, type SignPreview } from '../signing-machine'
import { seatHolder } from '../signing-seats'
import { signRejoin, rejoinIsProven } from '../room-auth'
import { parseSignRequest, unsealSignRequest } from '../net-sign'
import { generateVaultSecret } from '../vault-secret'
import { deviceCommsKey, devicePubHex } from '../device-key'
import { concludeRegistration, refusalKey } from '../conclude-registration'
import { buildVaultBackup } from '../build-backup'
import { writeProof } from '../api'
import { useT, useTr, useI18n } from '../i18n'
import { Letterhead, PassphraseField } from '../components'
import {
  saveVault,
  updateVaultMeta,
  loadVault,
  listVaults,
  deleteVault,
  storageAvailable,
  type VaultPublic,
  type VaultLoaded,
  type Governance,
} from '../storage'
import { downloadText } from '../download'
import {
  helperConfigured,
  helperBase,
  coordinatorCreationMin,
  vaultBalance,
  listProposals,
  executeProposal,
  type Proposal,
} from '../helper'
import { readReply } from '../send-outcome'
import { netReplyText } from '../send-preflight'
import { zatToZec, fmtZecExact, vaultFingerprint } from '../format'
import { readingRows } from '../device-reading'
import encodeQR from '@paulmillr/qr'
import '../redesign.css'
import '../net.css'
import { CREATION_PROTOCOL, creationAllowed } from '../creation-protocol'
import { WALLET_BUSY } from '../helper'

// The konclave.xyz network, made visible: two (or three) browser contexts create ONE vault by
// a real DKG over the blind relay. Each keeps its own share; the round-2 secret pieces are
// sealed to their recipient, so the relay only ever carries public material or ciphertext.
// This is the "I created / I invited / I entered the code" flow, running for real across tabs.

// What each way a creation ceremony can stop says to the member.
const ABORT_MESSAGE: Record<DkgAbort, string> = {
  conflict: 'net.err.ceremonyConflict',
  extra: 'net.err.seatConflict',
  excluded: 'net.err.notInVault',
  gap: 'net.err.ceremonyGap',
  version: 'net.err.oldVersion',
  failed: 'net.err.creationFailed',
  mismatch: 'net.err.codeMismatch',
  secret: 'net.err.secretConflict',
}

type Phase = 'idle' | 'roster' | 'confirm' | 'dkg' | 'done' | 'error' | 'restored' | 'signsession'


// Wire messages (JSON inside the relay's opaque `data`; the relay never parses them).
type Msg =
  | DkgMsg
  // #388: the creator seals the per-vault access secret S to each seat over the ceremony's enc
  // channel (same encPub/aad as r2), so every member persists the same S with their share.
  | { type: 'vsec'; to: number; box: string; sig?: string }
  // rejoin (signing after restore): a restored device announces its ORIGINAL seat (its KeyPackage's
  // identifier is bound to it), so a signing session re-seats by declared seat, not by fresh tags.
  // `sig` proves the announcement came from that seat's share-holder (#392/#424). Optional on the
  // wire so a device on an older build still seats - it simply counts as unproven.
  | { type: 'rejoin'; seat: number; sig?: string }
  // signing (Marco 4): all public material - the proven PCZT to verify, the sighash to sign,
  // commitments, signing package, seed, shares, sig.
  | { type: 'sreq'; msg: string; pczt?: string }
  // `k` = the 0-based spend position in a multi-note tx. Each real Orchard spend is its own FROST
  // ceremony (fresh nonces, its own alpha) over the SAME sighash; devices tag every round with `k`
  // so a message for a later spend waits and an earlier one is ignored. For a single-spend tx k=0.
  | { type: 's1'; commit: string; k: number }
  | { type: 'sp'; signers: number[]; sp: string; msg: string; k: number }
  | { type: 's2'; share: string; k: number }
  | { type: 'signed'; sig: string; ok: boolean; k: number }

function hex(bytes: Uint8Array): string {
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('')
}

const shortId = (s: string) => (s.length > 24 ? `${s.slice(0, 14)}…${s.slice(-6)}` : s)
const fmtZec = (zat: number) => (zat / 1e8).toFixed(8).replace(/0+$/, '').replace(/\.$/, '')

function Shell({ error, children, onDashboard, embedded }: { error: string; children: ReactNode; onDashboard?: () => void; embedded?: boolean }) {
  const t = useT()
  // Embedded (inside the /vaults create modal): render just the content, no full-page wrap /
  // letterhead / frame - the Dialog is the chrome. Same DKG flow, different container.
  if (embedded) {
    return (
      <div className="rd net-embedded">
        <span id="create-title" className="sr-only">{t('vaults.createDialogTitle')}</span>
        {error && <div className="net-error" role="alert">{error}</div>}
        {children}
      </div>
    )
  }
  return (
    <div className="rd net-wrap">
      <Letterhead right={<>
        {onDashboard && (
          <button type="button" className="net-back-btn" onClick={onDashboard}>← {t('nav.dashboard')}</button>
        )}
        <span className="net-tag">{t('net.tag')}</span>
      </>} />
      <div className="demo-frame">
        <span className="demo-eyebrow"><span className="dot" aria-hidden="true" />{t('net.frame.tag')}</span>
        <p className="demo-note">{t('net.frame.note')}</p>
      </div>
      {error && <div className="net-error" role="alert">{error}</div>}
      {children}
    </div>
  )
}


export default function NetVault({ embedded, initialJoin, leaveAsk, onLeave }: {
  embedded?: boolean
  initialJoin?: boolean
  /** Bumped by the host on each attempt to close the dialog (Esc, backdrop); `closeIntent` decides. */
  leaveAsk?: number
  /** Close the dialog (the host also refreshes its list). */
  onLeave?: () => void
} = {}) {
  const tt = useT()
  const ttr = useTr()
  const { locale } = useI18n()
  const pe = (pt: string, en: string) => (locale === 'pt-BR' ? pt : en)
  const nav = useNavigate()
  // Open the vault in the app: select it (so api.ts reads it from the helper) and go to the
  // Dashboard, the everyday vault interface. This is the bridge from the /net ceremony screen to
  // the operating UI (create/restore here, operate there).
  const openDashboard = () => {
    if (!groupVk) return
    setSelectedVault(groupVk)
    nav('/dashboard')
  }
  // Persistence UI copy, now sourced from the central i18n dictionary (#173) instead of a local
  // PT/EN table. Keyed the same, so every `L.xxx` usage is unchanged.
  const L = {
    saveTitle: tt('net.persist.saveTitle'), saveHint: tt('net.persist.saveHint'),
    savePlaceholder: tt('net.persist.savePlaceholder'), saveBtn: tt('net.persist.saveBtn'),
    saving: tt('net.persist.saving'), saved: tt('net.persist.saved'),
    saveErr: tt('net.persist.saveErr'), unavailable: tt('net.persist.unavailable'),
    restoreTitle: tt('net.persist.restoreTitle'), restorePlaceholder: tt('net.persist.restorePlaceholder'),
    unlockBtn: tt('net.persist.unlockBtn'), deleteBtn: tt('net.persist.deleteBtn'),
    unlocking: tt('net.persist.unlocking'), restoreErr: tt('net.persist.restoreErr'),
    restoredTitle: tt('net.persist.restoredTitle'), restoredLead: tt('net.persist.restoredLead'),
    restoredNote: tt('net.persist.restoredNote'), rosterLabel: tt('net.persist.rosterLabel'),
    backBtn: tt('net.persist.backBtn'),
  }
  const [phase, setPhase] = useState<Phase>('idle')
  const [role, setRole] = useState<'create' | 'join'>('create')
  const [room, setRoom] = useState('')
  const [joinCode, setJoinCode] = useState('')
  const [n, setN] = useState(3) // default 2-of-3: redundancy so a lost device never locks the funds
  const [t, setT] = useState(2)
  const [showJoin, setShowJoin] = useState(!!initialJoin) // Join door opens straight into the join screen
  const [createStep, setCreateStep] = useState<1 | 2>(1) // create form is a 2-step flow (name -> rule)
  const [advOpen, setAdvOpen] = useState(false) // governance behind an Advanced disclosure (the PIN is required, outside it)
  const [vaultName, setVaultName] = useState('') // user-given vault name (create modal)
  const vaultNameRef = useRef('') // read at register time (after DKG), avoids a stale closure
  const [myName, setMyName] = useState('') // this participant's own name (create/join)
  const [pin, setPin] = useState('') // admission PIN (ADR-0007 I4): required, shared apart from the invite
  // The code the members compare before anything secret is sent, and the names it was computed over.
  const [code, setCode] = useState<{ code: string; names: string[]; mySeat: number; vaultName: string } | null>(null)
  // After round 3: the members who have not yet proven they finished, and whether it is taking long.
  const [waiting, setWaiting] = useState<string[]>([])
  const [slowFinish, setSlowFinish] = useState(false)
  // Every member saved and the vault is registered with the confirmed quorum: only now may the
  // create modal hand over to the Dashboard.
  const [finished, setFinished] = useState(false)
  const slowFinishTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const myNameRef = useRef('')
  const [peers, setPeers] = useState(0)
  const [rosterCount, setRosterCount] = useState(0)
  const [log, setLog] = useState<string[]>([])
  const [groupVk, setGroupVk] = useState('')
  // The vault fingerprint: the PUBLIC anti-impostor code members compare out of band (short,
  // human-comparable code of the group verifying key). Shown on the create-done step - the moment
  // it matters most across devices - and again in Settings (#160). Same identity Settings uses.
  const [fp, setFp] = useState<string | null>(null)
  const [error, setError] = useState('')
  // Hosted-helper registration (ADR-0006 Rung A): after DKG, register the vault with the blind
  // helper so it derives the vault's real Orchard address (view-only). Only runs when a helper is
  // configured; otherwise `/net` stays a pure two-device ceremony.
  const [hostedState, setHostedState] = useState<'idle' | 'registering' | 'registered' | 'failed'>(
    'idle',
  )
  const [hostedAddress, setHostedAddress] = useState('')
  const [balance, setBalance] = useState<{ spend: string; total: string } | null>(null)
  const [balanceBusy, setBalanceBusy] = useState(false)
  // Ceremony trail (A3): the auditable record of every spend the helper drove for this vault.
  // Proposals: proposing/voting lives in the PWA (Dashboard). /net only lists the READY ones and
  // signs them (the ceremony), so it keeps the list + a status message, not a create/vote form.
  const [proposals, setProposals] = useState<Proposal[] | null>(null)
  const [propMsg, setPropMsg] = useState('')
  // Single-flight guard: one send at a time from this device. Two concurrent sends (a double-click,
  // or the same tab firing twice) would publish two competing sign-requests into the relay room and
  // neither would gather quorum. The cross-DEVICE lock (two tabs pressing) is the per-vault signing
  // room + singleton in issue #49; this stops the same device from colliding with itself.
  const [sendingId, setSendingId] = useState<string | null>(null)
  const sendingRef = useRef(false)
  const [signPhase, setSignPhase] = useState<'none' | 'signing' | 'signed'>('none')
  const [signature, setSignature] = useState('')
  const [signOk, setSignOk] = useState(false)
  // What this device is about to sign, read on-device from the proven PCZT (describeOutputs).
  const [signWhat, setSignWhat] = useState<SignPreview | null>(null)
  // Signing-after-restore: how many devices (by declared seat) have rejoined the signing session.
  const [signSeatCount, setSignSeatCount] = useState(0)
  const [signRoomInput, setSignRoomInput] = useState('')

  // --- on-device persistence (Marco 5) - additive, does not touch the DKG/relay/ceremony ---
  const [savePass, setSavePass] = useState('')
  // A member saves only once it holds the vault's access secret S (the creator mints its own): a
  // member saved without S would lose the vault's reads the moment its read gate turns on.
  const [hasSecret, setHasSecret] = useState(false)
  const [secretSlow, setSecretSlow] = useState(false)
  useEffect(() => {
    if (phase !== 'done' || hasSecret) return
    const id = window.setTimeout(() => setSecretSlow(true), 120000)
    return () => window.clearTimeout(id)
  }, [phase, hasSecret])
  const [saveState, setSaveState] = useState<'idle' | 'saving' | 'saved'>('idle')
  const [saveErr, setSaveErr] = useState('')
  // Backup-on-create (create-done step): the encrypted portable copy is built at save time (reusing
  // the just-entered passphrase) so the operator can download/copy it before opening the vault. The
  // file is useless without the passphrase; the share never travels in the clear.
  const [backup, setBackup] = useState<{ json: string; name: string; complete: boolean } | null>(null)
  const [backupCopied, setBackupCopied] = useState(false)
  const [savedVaults, setSavedVaults] = useState<VaultPublic[]>([])
  const [restorePass, setRestorePass] = useState<Record<string, string>>({})
  const [restoreBusy, setRestoreBusy] = useState('')
  const [restoreErr, setRestoreErr] = useState('')
  const [restoredRoster, setRestoredRoster] = useState<string[]>([])
  // Restored secret material, kept only in memory (never surfaced to JSON logs). Present after a
  // restore; `beginSign` wires it into a signing-only relay session (the device re-announces its
  // original seat via `rejoin`, then signs with these bytes - no DKG redo).
  const restoredRef = useRef<{
    keyPackage: Uint8Array
    pubkeys: Uint8Array
    groupVk: Uint8Array
    seat: number
    n: number
    t: number
  } | null>(null)

  // --- mutable ceremony state (refs so the poll callback always sees the latest) ---
  const sessionRef = useRef<RelaySession | null>(null)
  const dkgRef = useRef<CreationSession | null>(null)
  // The creation ceremony (roster, seating, rounds 1-2): every rule about who gets a seat and whose
  // key a secret is sealed to lives in it, not here.
  const ceremonyRef = useRef<DkgCeremony | null>(null)

  // This device's signing material, from the live DKG session OR from a restored vault. Signing
  // after restore reads the same bytes the DKG produced (KeyPackage, group key, pubkeys), so a
  // reloaded device signs with no ceremony redo. Ref-only, so it is stable across renders.
  const signingMaterial = useCallback(() => {
    const d = dkgRef.current
    if (d) return { keyPackage: d.keyPackage(), groupVk: d.groupVk(), pubkeys: d.pubkeys() }
    const r = restoredRef.current
    if (r) return { keyPackage: r.keyPackage, groupVk: r.groupVk, pubkeys: r.pubkeys }
    throw new Error('no signing material: no live DKG session and no restored vault')
  }, [])
  const deviceKeyRef = useRef<DeviceKey | null>(null)
  // #388: this device is the vault creator (mints S), and the per-vault access secret S once it has
  // been minted (creator) or received sealed from the creator (joiner). null until then.
  const accessSecretRef = useRef<Uint8Array | null>(null)
  const myTagRef = useRef('')
  const configRef = useRef<DkgConfig | null>(null)
  // Governance policy the creator picks; propagated to every device in the `config` broadcast so
  // the whole vault agrees. Default `quorum` (safer for a shared fund); `open` for small trusted groups.
  const [governance, setGovernance] = useState<Governance>('quorum')
  const governanceRef = useRef<Governance>('quorum')
  const seatByTagRef = useRef<Map<string, number>>(new Map()) // tag -> 1-based seat
  const seatTableRef = useRef<{ tag: string; encPub: Uint8Array; id: Uint8Array }[]>([])
  const mySeatRef = useRef(0)
  const startedDkgRef = useRef(false)
  const part3DoneRef = useRef(false)
  const allMsgsRef = useRef<RelayMsg[]>([])
  const consumedRef = useRef<Set<number>>(new Set())
  const startGuardRef = useRef(false)
  const advancingRef = useRef(false)
  const rerunRef = useRef(false)
  // The per-ceremony signing state (started/nonces/commits/coord/shares/spends/…) now lives inside
  // the shared SigningMachine (issue #50), constructed below.
  // Ceremony watchdog: fires if the vault isn't created in time (a peer never joined, a
  // message was lost) - surfaces an error instead of hanging on "Criando…" forever (§8).
  const ceremonyTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  // Join fail-fast (#213/3): if a joiner hasn't heard the host's config in ~15s (wrong code/PIN, or
  // nobody hosting yet), surface an actionable hint instead of waiting out the 90s ceremony timeout.
  const joinTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const [joinSlow, setJoinSlow] = useState(false)

  const addLog = useCallback((line: string) => setLog((l) => [...l, line]), [])

  const send = useCallback(async (m: Msg) => {
    // A dropped relay POST would silently deadlock the ceremony. Retry a few times, and if the
    // relay is truly unreachable, surface it instead of hanging forever (§8: message lost / relay down).
    const body = JSON.stringify(m)
    for (let attempt = 0; attempt < 3; attempt++) {
      if (await sessionRef.current?.send(body)) return
      await new Promise((r) => setTimeout(r, 400))
    }
    setError(tt('net.err.relayDown'))
  }, [tt])

  // This device finished round 3 (inside DkgCeremony): it may save its share now. Nothing is
  // registered and no address exists yet: that waits until every member saved theirs.
  const round3SeenRef = useRef(false)
  const onRound3 = useCallback(() => {
    const dkg = dkgRef.current!
    round3SeenRef.current = true
    if (ceremonyTimerRef.current) clearTimeout(ceremonyTimerRef.current)
    setGroupVk(hex(dkg.groupVk()))
    setPhase('done')
    addLog(tt('net.log.round3'))
    // #388: the creator mints the per-vault access secret S and seals it, signed with its share,
    // to each other seat, before anyone saves. A member saves only once it holds S (doSave), so a
    // creation in which S never arrives does not finish: it has no address and holds no funds.
    if (ceremonyRef.current?.isCreator && !accessSecretRef.current) {
      const s = generateVaultSecret()
      accessSecretRef.current = s
      setHasSecret(true)
      void (async () => {
        for (const { to, box, sig } of ceremonyRef.current?.sealSecretToOthers(s) ?? []) {
          await send({ type: 'vsec', to, box, sig })
        }
      })()
    }
  }, [addLog, send, tt])

  // The passphrase, held only until the backup is built (after every member saved), and what this
  // device saved, so the record can take the address once the coordinator hands it out.
  const savePassRef = useRef('')
  const refreshSavedRef = useRef<() => Promise<void>>(async () => {})
  const savedRef = useRef<{ vaultId: string; meta: Parameters<typeof setUnlockedShare>[1] } | null>(null)

  // Every member saved its share and proved it: register the vault, record its address, and build
  // the backup. Only now does an address exist for anyone to fund.
  const finishVault = useCallback(async () => {
    part3DoneRef.current = true
    if (slowFinishTimerRef.current) clearTimeout(slowFinishTimerRef.current)
    setSlowFinish(false)
    setWaiting([])
    setError('') // the vault exists: no earlier warning stays over it
    const saved = savedRef.current
    // Every seat proved it saved (`cer.complete` needs a verified `done` from each), and that is
    // recorded BEFORE any network call: whatever the coordinator does next, a later open of this
    // vault may finish the registration without asking the member again.
    if (saved && helperConfigured()) {
      await updateVaultMeta(saved.vaultId, { allSaved: true, coordinator: helperBase() }).catch(() => {})
    }
    let addr = ''
    if (helperConfigured()) {
      setHostedState('registering')
      // The one implementation of the registration (also what the vault card calls). It reads this
      // device's saved record, so the quorum and the name are the ones every member confirmed.
      const r = saved ? await concludeRegistration(saved.vaultId) : ({ refused: 'unreachable' } as const)
      if ('address' in r) {
        setHostedAddress(r.address)
        addr = r.address
        setHostedState('registered')
      } else {
        setHostedState('failed')
        setError(tt(refusalKey(r)))
      }
    }
    // Finished: every member saved, and the coordinator (if any) holds the confirmed quorum. Only
    // then does the record stop being pending. A refusal leaves it pending: no address. Without a
    // coordinator there is nothing to wait for, and the record is finished locally.
    const finished = !helperConfigured() || !!addr
    if (saved && finished && !addr) {
      await updateVaultMeta(saved.vaultId, { pending: false }).catch(() => {})
    }
    // The portable backup, now that the address, the viewing key and the scan floor exist. A
    // backup failure must never block opening the vault.
    const pass = savePassRef.current
    savePassRef.current = ''
    if (saved && pass && finished) {
      try {
        const b = await buildVaultBackup(saved.vaultId, pass, getUnlockedShare(saved.vaultId) ?? saved.meta, saved.meta.name)
        setBackup({ json: b.json, name: b.name, complete: Boolean(addr) && b.complete })
      } catch { /* backup is optional; the vault is already saved on this device */ }
    }
    await refreshSavedRef.current()
    setFinished(finished)
  }, [tt])

  // `send`/`tt` change identity (tt on a locale switch); route the machine through refs kept fresh
  // each render so a mid-ceremony change never leaves it calling a stale closure.
  const sendRef = useRef(send)
  sendRef.current = send
  const ttRef = useRef(tt)
  ttRef.current = tt

  // The FROST signing ceremony, lifted into a shared state machine (issue #50). It owns the signing
  // state and the `sreq|s1|sp|s2|signed` handlers; the DKG, roster and transport stay here and are
  // reached through these injected deps. Constructed once (it holds state across renders/messages).
  const machineRef = useRef<SigningMachine | null>(null)
  if (!machineRef.current) {
    machineRef.current = new SigningMachine({
      signingMaterial,
      // #281, stated rather than silently skipped. This driver signs a ceremony that is not bound
      // to a proposal at all (#363), so it has no approved payment to compare an output against -
      // there is nothing here that could answer the question honestly. Answering `match` says "this
      // driver does not gate on content", which is the truth and is now visible at the call site;
      // refusing would refuse every /net signature, including vault creation.
      //
      // The reason the dep is REQUIRED rather than optional is exactly this: /net and the
      // background signer have diverged three times (#424, #425, #363) because a rule lived in one
      // and not the other. It cannot silently miss this one - it has to say so, here.
      decideApproval: () => 'match',
      // /net binds no consent to a transaction (Known limits, with its missing content gate).
      claim: () => true,
      // Nor does it keep a record of what it signed: /net has no proposal to key it by (Known limits).
      record: async () => {},
      seatOf: (tag) => seatByTagRef.current.get(tag),
      // #399: this driver has no notion of a proven seat. Its map is tag -> seat and nothing here
      // ever verified a rejoin signature, so the honest answer is false for every tag, which makes
      // the coordinator fall back to the lowest-seats order it has always used. Stated rather than
      // omitted, so the gap is visible at the call site instead of hiding behind a default. Closing
      // it properly is #363 (this driver never got the replay mitigation either).
      seatIsProven: () => false,
      mySeat: () => mySeatRef.current,
      myTag: () => myTagRef.current,
      // SIGNER-SEAT1, stated for this driver: /net has no signing tally, so it keeps its own rule, seat
      // 1 coordinates (null until seat 1 is seated here). A /net ceremony therefore still needs seat 1
      // present; the vault's own signing screen does not (Known limits).
      coordinatorTag: () =>
        mySeatRef.current === 1 ? myTagRef.current : ([...seatByTagRef.current].find(([, s]) => s === 1)?.[0] ?? null),
      threshold: () => configRef.current?.t ?? 0,
      hasVault: () => part3DoneRef.current && !ceremonyRef.current?.aborted,
      send: (m) => sendRef.current(m),
      rawSend: async (data) => (await sessionRef.current?.send(data)) ?? false,
      onLog: addLog,
      onError: setError,
      onPhase: setSignPhase,
      onWhat: setSignWhat,
      onSignature: (h, ok) => {
        setSignature(h)
        setSignOk(ok)
      },
      tt: (k, p) => ttRef.current(k, p),
    })
  }
  const machine = machineRef.current

  const applyMsg = useCallback(
    async (msg: RelayMsg): Promise<boolean> => {
      let parsed: Msg
      try {
        parsed = JSON.parse(msg.data) as Msg
      } catch {
        return true // unparseable - consume and ignore
      }
      // A throwing handler (a malformed package from a peer) must NOT poison the fixpoint: if it
      // never marked the message consumed, advance() would re-apply and re-throw it forever. Catch,
      // surface, and consume it (§8: corrupted/missing material stays a clear failure, not a hang).
      try {
      // Architecture B: a helper's raw sign-request is detected before the typed dispatch and drives
      // the ceremony over its real PCZT (the machine posts the aggregate signature back RAW). Open a
      // SEALED request (#63) with this device's persistent (share-derived) comms key first; a
      // plaintext request passes straight through. Guard: no signing material yet means we hold no
      // share, so a sealed request cannot be for us - leave it for the parser to ignore.
      let reqData = msg.data
      try {
        const kp = signingMaterial().keyPackage
        reqData = unsealSignRequest(msg.data, deviceCommsKey(kp), devicePubHex(kp))
      } catch {
        /* no signing material yet */
      }
      if (await machine.tryHelperRequest(reqData)) return true
      // A request whose coordinator is not seated here yet waits for the rejoin that seats it.
      if (parseSignRequest(reqData)) return false
      // ---- the creation ceremony: these go to DkgCeremony, which owns the rules ----
      if (parsed.type === 'config' || parsed.type === 'hello' || parsed.type === 'commit' || parsed.type === 'reveal'
        || parsed.type === 'r1' || parsed.type === 'r2' || parsed.type === 'done') {
        const cer = ceremonyRef.current
        if (!cer) return true // a signing session runs no ceremony
        const r = cer.apply(msg.from, parsed)
        if (!r.applied) return false
        if (parsed.type === 'config' && cer.config && !configRef.current) {
          configRef.current = cer.config
          setN(cer.config.n)
          setT(cer.config.t)
          if (cer.config.g) { setGovernance(cer.config.g); governanceRef.current = cer.config.g }
          // Heard the host: the joiner is in the right room — clear the fail-fast hint.
          setJoinSlow(false)
          if (joinTimerRef.current) { clearTimeout(joinTimerRef.current); joinTimerRef.current = null }
        }
        for (const m of r.out) await send(m)
        if (cer.part3Done && !round3SeenRef.current) onRound3()
        if (cer.part3Done && !cer.complete) setWaiting(cer.waitingFor())
        if (cer.complete && !part3DoneRef.current) void finishVault()
        return true
      }

      // ---- #388: receive the per-vault access secret S the creator sealed to this seat ----
      if (parsed.type === 'vsec') {
        const cer = ceremonyRef.current
        if (!cer) return true
        // Only the creator's signed box counts; until one opens, this member cannot save (doSave).
        const r = cer.takeSecret(msg.from, parsed.to, parsed.box, parsed.sig)
        if (r.secret) { accessSecretRef.current = r.secret; setHasSecret(true) }
        return r.applied
      }

      // ---- rejoin (signing after restore): re-seat by declared seat, not by fresh tags ----
      if (parsed.type === 'rejoin') {
        // A vault being created has no seats to rejoin: its seats are the ceremony's alone.
        if (ceremonyRef.current) return true
        // A device that reloads rejoins with a FRESH ephemeral tag but the SAME seat, so a rejoin
        // that names an OCCUPIED seat evicts its holder. Only the seat's own share-holder may do
        // that (#392): the announcement is signed with the share and bound to seat+vault+tag, so a
        // captured one cannot be replayed under another tag. An UNPROVEN rejoin may still take an
        // EMPTY seat (an older build, and #399 covers that residual) but never evicts - which is
        // the A4 seat-hijack this path was still open to after #401 closed it for the background
        // signer (#424).
        // `signingMaterial()` THROWS when there is neither a live DKG nor a restored vault - a
        // rejoin can arrive before either exists. Not being able to verify is not the same as
        // verifying: it counts as unproven, which is the safe side (it can seat an empty seat,
        // never evict).
        let proven = false
        try {
          proven = rejoinIsProven(signingMaterial(), parsed.seat, msg.from, parsed.sig)
        } catch {
          proven = false // no material yet: cannot verify, so not proven
        }
        const heldBy = seatHolder(seatByTagRef.current, msg.from, parsed.seat)
        if (heldBy !== undefined) {
          if (!proven) return true // occupied + unproven -> never evict
          seatByTagRef.current.delete(heldBy) // proven takeover: the share-holder, reloaded
        }
        seatByTagRef.current.set(msg.from, parsed.seat)
        seatTableRef.current = [...seatByTagRef.current.entries()].map(([tag, seat]) => ({
          tag,
          encPub: new Uint8Array(),
          id: identifierBytes(seat),
        }))
        setSignSeatCount(new Set(seatByTagRef.current.values()).size)
        return true
      }

      // ---- signing over the relay (Marco 4): all bytes below are public. The ceremony state and
      // its sreq|s1|sp|s2|signed handlers live in the shared SigningMachine (issue #50). ----
      if (
        parsed.type === 'sreq' ||
        parsed.type === 's1' ||
        parsed.type === 'sp' ||
        parsed.type === 's2' ||
        parsed.type === 'signed'
      ) {
        return machine.handle(parsed, msg.from)
      }
      return true
      } catch {
        addLog(tt('net.log.msgFailed'))
        setError(tt('net.err.stepFailed'))
        return true // consume so the fixpoint never re-throws the same message
      }
    },
    [addLog, onRound3, finishVault, send, tt, machine],
  )

  // Idempotent fixpoint, serialized against itself: apply every message whose preconditions
  // are met, starting the DKG once the roster is full, until no further progress is possible.
  const advance = useCallback(async () => {
    if (advancingRef.current) {
      rerunRef.current = true
      return
    }
    advancingRef.current = true
    try {
      do {
        rerunRef.current = false
        let progressed = true
        while (progressed) {
          progressed = false
          const cer = ceremonyRef.current
          if (cer && !startedDkgRef.current) {
            const commit = cer.trySeat()
            if (cer.started) {
              seatByTagRef.current = cer.seatByTag
              seatTableRef.current = cer.seatTable.map((r) => ({ tag: r.tag, encPub: r.encPub, id: identifierBytes(r.seat) }))
              mySeatRef.current = cer.mySeat
              dkgRef.current = cer.session
              startedDkgRef.current = true
              setPhase('dkg')
              addLog(tt('net.log.seated', { seat: cer.mySeat, total: cer.config!.n }))
              for (const m of commit) await send(m)
              progressed = true
            }
          }
          for (const msg of allMsgsRef.current) {
            if (consumedRef.current.has(msg.seq)) continue
            const applied = await applyMsg(msg)
            if (applied) {
              consumedRef.current.add(msg.seq)
              progressed = true
            }
          }
        }
        // The drain is done: let the machine act on the whole of it, not on each message (#399).
        await machineRef.current?.afterDrain()
      } while (rerunRef.current)
    } finally {
      advancingRef.current = false
      setRosterCount(ceremonyRef.current?.rosterSize ?? 0)
    }
  }, [addLog, applyMsg, send, tt])

  // The members read the code to each other and every listed person matched: round 2.
  const doConfirm = useCallback(async () => {
    const cer = ceremonyRef.current
    if (!cer?.code) return
    const r = cer.confirmCode(cer.code)
    if (!r.ok) return
    setPhase('dkg')
    for (const m of r.out) await send(m)
    addLog(tt('net.log.round2', { count: r.out.length }))
    // No watchdog that says "reload" from here: the others may still be reading the code with each
    // person. After a few minutes a warning says not to use or fund the vault until it finishes.
    slowFinishTimerRef.current = setTimeout(() => {
      if (!ceremonyRef.current?.complete) setSlowFinish(true)
    }, 180000)
    void advance()
  }, [addLog, advance, send, tt])

  const doMismatch = useCallback(() => ceremonyRef.current?.rejectCode(), [])

  const onMessage = useCallback(
    (m: RelayMsg) => {
      ceremonyRef.current?.noteSeq(m.seq)
      allMsgsRef.current.push(m)
      void advance()
    },
    [advance],
  )

  const begin = useCallback(
    async (asRole: 'create' | 'join', code: string, total: number, threshold: number, pin: string) => {
      if (startGuardRef.current) return
      startGuardRef.current = true
      try {
        // An app the coordinator calls outdated says so before any member waits on it, creating or
        // joining alike. No answer, or no minimum stated: go on (the registration still refuses).
        if (!creationAllowed(CREATION_PROTOCOL, await coordinatorCreationMin())) {
          setError(tt('net.err.updateRequired'))
          startGuardRef.current = false
          return
        }
        await ensureWasm()
        deviceKeyRef.current = new DeviceKey()
        accessSecretRef.current = null
        myTagRef.current = ephemeralTag()
        // The invite is what members share; the relay room is derived from it AND the PIN, both
        // required (ADR-0007 I4, as amended), and the room id is also bound into the members' code.
        const roomId = await deriveRoom(code, pin)
        const cer = new DkgCeremony(myTagRef.current, deviceKeyRef.current, roomId)
        cer.onAbort = (why) => {
          setError(tt(ABORT_MESSAGE[why], { name: cer.config?.cn || pe('quem convidou você', 'whoever invited you') }))
          setPhase('error')
          savePassRef.current = '' // the passphrase is held only for a backup that will not be built
          sessionRef.current?.stop() // a stopped ceremony leaves the room: it signs nothing there
        }
        cer.onLog = (what, seat) => addLog(tt(`net.log.${what}`, { seat }))
        cer.onCode = (c, names) => {
          // People take time to read a code to each other: the watchdog waits for them.
          if (ceremonyTimerRef.current) clearTimeout(ceremonyTimerRef.current)
          setCode({ code: c, names, mySeat: cer.mySeat, vaultName: cer.config?.vn ?? '' })
          setPhase('confirm')
        }
        ceremonyRef.current = cer
        setRoom(code)
        setPhase('roster')
        const sess = new RelaySession(roomId, myTagRef.current, onMessage, (p) => setPeers(p))
        sessionRef.current = sess
        sess.start()
        ceremonyTimerRef.current = setTimeout(() => {
          if (!part3DoneRef.current && !ceremonyRef.current?.aborted) {
            setError(tt('net.err.timeout'))
          }
        }, 90000)
        // Fail-fast hint for a joiner who never hears the host's config (non-fatal; the ceremony
        // still runs, and a slow-but-valid host clears it when config arrives).
        setJoinSlow(false)
        if (joinTimerRef.current) clearTimeout(joinTimerRef.current)
        if (asRole === 'join') {
          joinTimerRef.current = setTimeout(() => {
            if (!configRef.current && !part3DoneRef.current) setJoinSlow(true)
          }, 15000)
        }
        // The creator declares the group size/threshold; everyone announces their enc key.
        if (asRole === 'create') {
          configRef.current = { n: total, t: threshold, g: governanceRef.current, cn: myNameRef.current.trim().slice(0, 64) || undefined, vn: vaultNameRef.current.trim().slice(0, 64) || undefined }
          cer.setOwnConfig(configRef.current)
          await sess.send(JSON.stringify({ type: 'config', v: DKG_VERSION, ...configRef.current } satisfies Msg))
        }
        await sess.send(
          JSON.stringify({ type: 'hello', v: DKG_VERSION, encPub: b64(deviceKeyRef.current.publicBytes()), name: myNameRef.current.trim() || undefined } satisfies Msg),
        )
        addLog(tt('net.log.joined'))
        void advance()
      } catch (e) {
        setError(String(e))
        setPhase('error')
      }
    },
    [addLog, advance, onMessage, pe, tt],
  )

  // Signing after restore: a restored device joins a SIGNING-only relay room. No DKG runs (the vault
  // already exists); each device announces its ORIGINAL seat so the seating matches the KeyPackages.
  const beginSign = useCallback(
    async (code: string) => {
      const r = restoredRef.current
      if (!r) return
      if (startGuardRef.current) return
      startGuardRef.current = true
      try {
        await ensureWasm()
        myTagRef.current = ephemeralTag()
        configRef.current = { n: r.n, t: r.t }
        mySeatRef.current = r.seat
        part3DoneRef.current = true // the vault exists; never run DKG in this session
        startedDkgRef.current = true
        seatByTagRef.current = new Map([[myTagRef.current, r.seat]])
        seatTableRef.current = [
          { tag: myTagRef.current, encPub: new Uint8Array(), id: identifierBytes(r.seat) },
        ]
        setSignSeatCount(1)
        setRoom(code)
        setPhase('signsession')
        const sess = new RelaySession(code, myTagRef.current, onMessage, (p) => setPeers(p))
        sessionRef.current = sess
        sess.start()
        // Signed, so peers can tell a real reload from an outsider claiming the seat (#424).
        const sig = signRejoin(r.keyPackage, r.seat, hex(r.groupVk), myTagRef.current)
        await sess.send(JSON.stringify({ type: 'rejoin', seat: r.seat, sig } satisfies Msg))
        addLog(tt('net.log.joined'))
        void advance()
      } catch (e) {
        setError(String(e))
        setPhase('error')
      }
    },
    [addLog, advance, onMessage, tt],
  )


  // Proposals: /net only lists them (to sign the ready ones); proposing/voting is in the PWA.
  const loadProposals = useCallback(async () => {
    setProposals(await listProposals(groupVk))
  }, [groupVk])

  // Execute a ready proposal: the browsers sign over the relay and the helper broadcasts. This
  // moves real funds, so it is gated by an explicit confirmation (a single click never sends, §7).
  const execProp = useCallback(
    async (id: string) => {
      if (sendingRef.current) return // a send is already in flight from this device; ignore re-entry
      const ok = typeof window === 'undefined' || window.confirm(
        pe(
          'Executar este pagamento aprovado? As duas abas vão assinar e a transação vai para a rede.',
          'Execute this approved payment? Both tabs will sign and the transaction goes to the network.',
        ),
      )
      if (!ok) return
      sendingRef.current = true
      setSendingId(id)
      setPropMsg(pe('Executando: as abas assinam pelo relay…', 'Executing: the tabs sign over the relay…'))
      try {
        const r = await executeProposal({
          vault: groupVk,
          proposalId: id,
          relayBase: relayBase(),
          room,
          dryRun: false,
          // #288, same rule as the app's signing panel: firing a broadcast is a governance write.
          proof: await writeProof(groupVk, 'send', id),
        })
        // What the reply means is one rule (readReply, send-outcome.ts), the same as the signing
        // panel's, and what /net says for it is netReplyText (send-preflight.ts).
        const said = netReplyText(readReply(r))
        setPropMsg(pe(said.pt, said.en))
        if (said.stop) return
        void loadProposals()
      } finally {
        sendingRef.current = false
        setSendingId(null)
      }
    },
    [groupVk, room, pe, loadProposals],
  )

  // Auto-load the proposals once the vault is known (helper configured + group key set).
  useEffect(() => {
    if (helperConfigured() && groupVk) void loadProposals()
  }, [groupVk, loadProposals])

  // Export the accounting ledger (the vault's confirmed governed payments) as a CSV download.
  // ---- on-device persistence handlers (Marco 5), all additive to the flow above ----

  const refreshSaved = useCallback(async () => {
    try {
      setSavedVaults(await listVaults())
    } catch {
      /* listing failure is non-fatal - just show no saved vaults */
    }
  }, [])
  refreshSavedRef.current = refreshSaved

  // Save the completed vault: encrypt this device's share (+ the public material a future signing
  // step needs) under a passphrase and store it. Reads live refs; does not alter ceremony state.
  const doSave = useCallback(async () => {
    if (!storageAvailable()) {
      setSaveErr(L.unavailable)
      return
    }
    if (savePass.length < 8) return
    const dkg = dkgRef.current
    // A member may save its share as soon as its own round 3 is done; only the address waits for
    // every member (see finishVault).
    if (!dkg || !ceremonyRef.current?.part3Done || ceremonyRef.current?.aborted) return
    if (!ceremonyRef.current.isCreator && !accessSecretRef.current) return // wait for S (see hasSecret)
    setSaveState('saving')
    setSaveErr('')
    try {
      const gvk = dkg.groupVk()
      const cfg = configRef.current
      // The secret bundle (encrypted at rest): the share plus the public bytes a restored device
      // would need to sign again (pubkeys, seat, config). Public metadata rides outside, in clear.
      const bundle = new TextEncoder().encode(
        JSON.stringify({
          kp: b64(dkg.keyPackage()),
          pubkeys: b64(dkg.pubkeys()),
          deviceSecret: b64(deviceKeyRef.current?.secretBytes() ?? new Uint8Array()),
          seat: mySeatRef.current,
          n: cfg?.n ?? 0,
          t: cfg?.t ?? 0,
        }),
      )
      const nm = ceremonyRef.current?.config?.vn || undefined
      const gov: Governance = cfg?.g ?? governanceRef.current
      const mine = ceremonyRef.current?.nameOf(myTagRef.current) || myNameRef.current.trim() || undefined
      // The roster is member NAMES in seat order (identity is the name), NOT the throwaway relay
      // tags: each seat's name exactly as it was bound into the code the members confirmed; the
      // tag only if a member announced none. (Was storing raw p-… tags, which then showed as
      // member names on the vault card / Members list and in the vault export.)
      const roster = seatTableRef.current.map((s) => ceremonyRef.current?.nameOf(s.tag) || s.tag)
      // Who set up the vault (the device that generated the invite); rides the config broadcast so
      // every device agrees. A real fixed fact, unlike the per-ceremony FROST coordinator role.
      const creator = cfg?.cn || undefined
      const vaultId = hex(gvk)
      // No address yet: it exists only once every member saved, and finishVault records it then.
      const addr = ''
      // Checked again here: a stop can arrive while the passphrase is being stretched.
      if (ceremonyRef.current?.aborted) { setSaveState('idle'); return }
      // Pending until every member saved (finishVault): no screen shows or adopts an address for it
      // before then (`vaultIsFinished`, read by getVault and its backfill).
      await saveVault(vaultId, { name: nm, governance: gov, myName: mine, creatorName: creator, groupKey: gvk, address: addr, roster, sealedShare: bundle, accessSecret: accessSecretRef.current ?? undefined, pending: true, threshold: cfg?.t, total: cfg?.n, cp: CREATION_PROTOCOL }, savePass)
      // Also keep the just-created share unlocked in memory for this session, so the operator can
      // sign from the app immediately without re-entering the passphrase (the access model).
      setUnlockedShare(vaultId, { name: nm, governance: gov, myName: mine, creatorName: creator, groupKey: gvk, address: addr, roster, sealedShare: bundle, createdAt: 0, accessSecret: accessSecretRef.current ?? undefined })
      savedRef.current = { vaultId, meta: { name: nm, governance: gov, myName: mine, creatorName: creator, groupKey: gvk, address: addr, roster, sealedShare: bundle, createdAt: 0, accessSecret: accessSecretRef.current ?? undefined } }
      // Kept only until the backup is built, once every member saved and the address exists.
      savePassRef.current = savePass
      // Saved: only now does this device tell the others it finished.
      const cer = ceremonyRef.current!
      for (const m of cer.markSaved()) await send(m)
      if (cer.complete && !part3DoneRef.current) void finishVault()
      else setWaiting(cer.waitingFor())
      setSaveState('saved')
      setSavePass('')
      await refreshSaved()
    } catch (e) {
      setSaveState('idle')
      setSaveErr(L.saveErr + String(e))
    }
  }, [savePass, L, refreshSaved, send, finishVault])

  const doBackupDownload = useCallback(() => {
    if (backup) { downloadText(backup.name, backup.json); setBackupTaken(true) }
  }, [backup])
  const doBackupCopy = useCallback(async () => {
    if (!backup) return
    try {
      await navigator.clipboard.writeText(backup.json)
      setBackupCopied(true)
      setBackupTaken(true)
      setTimeout(() => setBackupCopied(false), 1500)
    } catch { /* clipboard blocked; the download button still works */ }
  }, [backup])

  // Restore a saved vault: unlock with the passphrase, bring the vault identity back into view
  // WITHOUT redoing the DKG. The secret material is held in memory (restoredRef) for a future
  // signing-after-restore step; the live relay/ceremony refs are left untouched.
  // Bring a decrypted vault into the 'restored' phase (no DKG redo). Shared by the passphrase path
  // (doRestore) and the access-gate path (a share already unlocked at /unlock, held in session.ts).
  const applyLoaded = useCallback((v: VaultLoaded) => {
    const share = decodeBundle(v)
    restoredRef.current = share
    setGroupVk(hex(v.groupKey))
    setRestoredRoster(v.roster)
    if (share.n) setN(share.n)
    if (share.t) setT(share.t)
    setPhase('restored')
  }, [])

  const doRestore = useCallback(
    async (id: string) => {
      const pass = restorePass[id] ?? ''
      if (!pass) return
      setRestoreBusy(id)
      setRestoreErr('')
      try {
        applyLoaded(await loadVault(id, pass))
        setRestorePass((m) => ({ ...m, [id]: '' }))
      } catch (e) {
        setRestoreErr(L.restoreErr + String(e))
      } finally {
        setRestoreBusy('')
      }
    },
    [restorePass, L, applyLoaded],
  )

  // Access gate: if this device's share was already unlocked at /unlock (session store), restore
  // straight into the signing-ready state, no second passphrase prompt.
  useEffect(() => {
    // The embedded CREATE modal must always show the "new vault" form — never auto-restore the
    // currently selected/unlocked vault (that hijacked "Create" into the "vault restored" view when
    // logged in, forcing a cache clear). Auto-restore stays on the standalone /net page only.
    if (embedded) return
    if (phase !== 'idle') return
    const id = getSelectedVault()
    if (!id) return
    const v = getUnlockedShare(id)
    if (v) applyLoaded(v)
  }, [phase, applyLoaded, embedded])

  // Embedded create modal: once the share is protected (saved), do NOT jump straight to the app -
  // the create-done step now shows a backup card first (download/copy the portable copy), and the
  // operator opens the vault from there. Only auto-open if there was nothing to back up.
  useEffect(() => {
    if (embedded && finished && !backup) openDashboard()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [embedded, finished, backup])

  const doDelete = useCallback(
    async (id: string) => {
      try {
        await deleteVault(id)
        clearUnlockedShare(id) // drop the in-memory share when the vault leaves this device
        await refreshSaved()
      } catch {
        /* deletion failure is non-fatal */
      }
    },
    [refreshSaved],
  )

  // Leaving now would lose this creation (creation-guard): tell the host, warn on reload, and ask
  // before an explicit or stray close.
  const busy = creationBusy(phase, finished, !!ceremonyRef.current?.aborted, saveState === 'saved')
  // The backup copy offered at the end has not been downloaded or copied yet.
  const [backupTaken, setBackupTaken] = useState(false)
  const backupPending = !!backup && !backupTaken
  const [leaving, setLeaving] = useState(false)
  const leaveRef = useRef<HTMLDivElement>(null)
  const allowUnloadRef = useRef(false) // the app's own reload, offered on purpose, does not warn
  // Each attempt to close (Esc, backdrop) means what `closeIntent` says: during a creation it opens
  // the question (and the next one answers "keep creating"); once finished it opens the new vault,
  // exactly as the dialog's own button does; otherwise the dialog closes.
  // Only attempts made while THIS screen is open count: the host's counter keeps its value across
  // dialogs, and a fresh screen must not read the last dialog's close as its own.
  const seenAsk = useRef(leaveAsk)
  useEffect(() => {
    if (!leaveAsk || leaveAsk === seenAsk.current) return
    seenAsk.current = leaveAsk
    const intent = closeIntent({ busy, finished, backupPending })
    if (intent === 'ask' || intent === 'ask-backup') setLeaving((l) => !l)
    else if (intent === 'open-vault') openDashboard()
    else onLeave?.()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [leaveAsk])
  const cancelRef = useRef<HTMLButtonElement>(null)
  const wasLeaving = useRef(false)
  useEffect(() => {
    if (leaving) leaveRef.current?.scrollIntoView({ block: 'start' })
    else if (wasLeaving.current) cancelRef.current?.focus() // "keep creating": focus returns where it was
    wasLeaving.current = leaving
  }, [leaving])
  useEffect(() => {
    if (!busy) return
    const warn = (e: BeforeUnloadEvent) => {
      if (allowUnloadRef.current) return
      e.preventDefault(); e.returnValue = ''
    }
    window.addEventListener('beforeunload', warn)
    return () => window.removeEventListener('beforeunload', warn)
  }, [busy])

  // An invite link opens the join form inside the vaults dialog (Vaults opens it). There it fills the
  // invite, focuses the PIN (the one thing left to type) and leaves the address bar and history at
  // once (this tab's history; the browser's own history keeps the first URL, and the PIN is what
  // guards the room): the invite is a secret of the room (CLAUDE.md §6.3, the exception in ADR-0007).
  // An older link to the standalone screen (#/net?join=) is sent to the same dialog. A bad code is
  // filled as given, so the form says what is wrong with it in place.
  // Known from the first render, so focus lands once: on the PIN when the link's invite is whole,
  // on the invite field (which then says what is wrong) when it is not.
  const [inviteFromLink, setInviteFromLink] = useState(() => !!embedded && joinParam(window.location.hash) !== null)
  const joinPinRef = useRef<HTMLInputElement>(null)
  const joinInviteRef = useRef<HTMLInputElement>(null)
  const joinNameRef = useRef<HTMLInputElement>(null)
  const linkFocused = useRef(false)
  useEffect(() => {
    // Once, when the code from the link has arrived: moving focus later would pull it out of a
    // field the member is typing in.
    if (!inviteFromLink || linkFocused.current || joinCode === '') return
    linkFocused.current = true
    // The first field that still needs the member: a bad invite, else the name (it always starts
    // empty; the PIN comes after it).
    if (!parseInvite(joinCode)) joinInviteRef.current?.focus()
    else joinNameRef.current?.focus()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [inviteFromLink, joinCode === '' ? 0 : 1])
  useEffect(() => {
    const raw = joinParam(window.location.hash)
    if (raw === null) return
    if (!embedded) { nav(`/vaults?join=${encodeURIComponent(raw)}`, { replace: true }); return }
    setJoinCode(parseInvite(raw) ?? raw)
    setShowJoin(true)
    setInviteFromLink(true)
    const path = window.location.hash.split('?')[0] || '#/vaults'
    window.history.replaceState(window.history.state, '', `${window.location.pathname}${window.location.search}${path}`)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // Load the list of saved vaults once, so the idle screen can offer to restore one.
  useEffect(() => {
    void refreshSaved()
  }, [refreshSaved])

  useEffect(() => {
    return () => {
      sessionRef.current?.stop()
      savePassRef.current = ''
      if (ceremonyTimerRef.current) clearTimeout(ceremonyTimerRef.current)
      if (joinTimerRef.current) clearTimeout(joinTimerRef.current)
      if (slowFinishTimerRef.current) clearTimeout(slowFinishTimerRef.current)
    }
  }, [])

  // Derive the vault fingerprint from the group verifying key once the vault exists (same identity
  // Settings fingerprints, so the codes line up across devices and screens).
  useEffect(() => {
    if (!groupVk) { setFp(null); return }
    let on = true
    void vaultFingerprint(groupVk).then((c) => { if (on) setFp(c) }).catch(() => { /* WebCrypto unavailable */ })
    return () => { on = false }
  }, [groupVk])


  // ---- render ----

  // A stopped creation has its own screen: why, and how to start again.
  if (phase === 'error' && ceremonyRef.current?.aborted) {
    return (
      <Shell error="" embedded={embedded}>
        <StopPanel message={error} pe={pe} />
      </Shell>
    )
  }

  // Create modal (embedded), idle: two separate views - CREATE or JOIN - toggled, never both at
  // once, each purpose-built and on brand. Each participant gives their OWN name (travels in the
  // relay hello, so everyone's member list shows real names). DKG logic unchanged.
  if (phase === 'idle' && embedded && showJoin) {
    return (
      <Shell error={error} embedded>
        <span className="rd-eyebrow">{pe('ENTRAR NUM COFRE', 'JOIN A VAULT')}</span>
        <h2 className="cv-title">{pe('Entrar com um convite', 'Join with an invite')}</h2>
        <p className="cv-lead">{inviteFromLink
          ? pe('O convite veio do link. Diga o seu nome e digite o PIN que você recebeu por outro caminho para entrar no cofre com os outros aparelhos.', 'The invite came from your link. Enter your name and type the PIN you received another way to join the vault with the other devices.')
          : pe('Você recebeu um convite e, por outro caminho, um PIN. Diga o seu nome, cole o convite e digite o PIN para entrar no cofre com os outros aparelhos.', 'You received an invite and, another way, a PIN. Enter your name, paste the invite and type the PIN to join the vault with the other devices.')}</p>
        <div className="cv-field cv-name">
          <label className="cv-k" htmlFor="cv-join-name">{pe('Seu nome (aparece pros membros)', 'Your name (shown to the members)')}</label>
          <input id="cv-join-name" ref={joinNameRef} required className="cv-nameinput" type="text" maxLength={30} placeholder={pe('ex.: Bob', 'e.g. Bob')}
            value={myName} onChange={(e) => { setMyName(e.target.value); myNameRef.current = e.target.value }} autoFocus={!inviteFromLink} />
        </div>
        <div className="cv-field cv-name">
          <label className="cv-k" htmlFor="cv-join-invite">{pe('Convite (link ou código)', 'Invite (link or code)')}</label>
          <input id="cv-join-invite" ref={joinInviteRef} required aria-invalid={!!joinCode.trim() && !parseInvite(joinCode)} className="cv-nameinput" style={{ fontFamily: 'var(--font-mono)', textAlign: 'center' }}
            autoCapitalize="characters" autoCorrect="off" spellCheck={false} aria-describedby="cv-join-invite-hint"
            placeholder={pe('cole o link ou o código', 'paste the link or the code')} value={joinCode} onChange={(e) => setJoinCode(e.target.value)} />
          <span className="cv-govnote" id="cv-join-invite-hint" role="status">
            {joinCode.trim() && !parseInvite(joinCode) ? pe('Isso não parece um convite completo: confira se colou tudo.', 'That does not look like a whole invite: check you pasted all of it.') : ''}
          </span>
          {inviteFromLink && parseInvite(joinCode) && (
            <span className="cv-govnote" id="cv-join-from-link">{pe('Preenchido pelo link do convite.', 'Filled from your invite link.')}</span>
          )}
        </div>
        <div className="cv-field cv-name">
          <label className="cv-k" htmlFor="cv-join-pin">{pe('PIN da sala (veio separado do convite)', 'Room PIN (it came apart from the invite)')}</label>
          <input id="cv-join-pin" ref={joinPinRef} aria-describedby={inviteFromLink ? 'cv-join-from-link' : undefined} className="cv-nameinput" type="text" maxLength={20} required autoComplete="off" autoCorrect="off" spellCheck={false}
            value={pin} onChange={(e) => setPin(e.target.value)} />
        </div>
        {(() => {
          const missing = [
            !myName.trim() && pe('o seu nome', 'your name'),
            !parseInvite(joinCode) && pe('o convite', 'the invite'),
            !pin.trim() && pe('o PIN', 'the PIN'),
          ].filter(Boolean) as string[]
          // Always in the page, emptied when nothing is missing: a live region inserted together with
          // its text is often not announced.
          return (
            <p className="cv-govnote" id="cv-join-why" role="status">
              {missing.length > 0 ? pe(`Para entrar, falta: ${missing.join(', ')}.`, `To join, fill in ${missing.join(', ')}.`) : ''}
            </p>
          )
        })()}
        <button className="rd-enter primary cv-primary" aria-describedby="cv-join-why" disabled={!myName.trim() || !parseInvite(joinCode) || !pin.trim()}
          onClick={() => { setRole('join'); void begin('join', parseInvite(joinCode)!, n, t, pin) }}>
          {pe('Entrar no cofre', 'Join the vault')}
        </button>
        <button type="button" className="cv-linkbtn" onClick={() => setShowJoin(false)}>
          ← {pe('Criar um cofre novo', 'Create a new vault')}
        </button>
      </Shell>
    )
  }
  if (phase === 'idle' && embedded) {
    const approveWord = t === 1 ? pe('aprovar', 'approves') : pe('aprovarem', 'approve')
    const memberWord = n === 1 ? pe('membro', 'member') : pe('membros', 'members')
    const trustSentence = pe(
      `Dinheiro só sai quando ${t} de ${n} ${memberWord} ${approveWord}. Ninguém envia sozinho.`,
      `Money moves only when ${t} of ${n} ${memberWord} ${approveWord}. No one sends alone.`,
    )
    return (
      <Shell error={error} embedded>
        <div className="cv-steps" aria-hidden="true">
          <span className={'cv-stepdot' + (createStep >= 1 ? ' on' : '')} />
          <span className={'cv-stepdot' + (createStep >= 2 ? ' on' : '')} />
        </div>

        {createStep === 1 && (
          <>
            <span className="rd-eyebrow">{pe('PASSO 1 DE 2 · NOME', 'STEP 1 OF 2 · NAME')}</span>
            <h2 className="cv-title">{pe('Como se chama o cofre?', 'What’s the vault called?')}</h2>
            <p className="cv-lead">{pe('Um nome pra vocês reconhecerem. Dá pra mudar depois.', 'A name you’ll recognize. You can change it later.')}</p>
            <div className="cv-field cv-name">
              <label className="cv-k" htmlFor="cv-vault-name">{pe('Nome do cofre', 'Vault name')}</label>
              <input id="cv-vault-name" className="cv-nameinput" type="text" maxLength={40} autoFocus
                placeholder={pe('ex.: Tesouraria do coletivo', 'e.g. Collective treasury')}
                value={vaultName}
                onChange={(e) => { setVaultName(e.target.value); vaultNameRef.current = e.target.value }} />
            </div>
            <div className="cv-field cv-name">
              <label className="cv-k" htmlFor="cv-create-name">{pe('Seu nome (aparece pros membros)', 'Your name (shown to the members)')}</label>
              <input id="cv-create-name" required className="cv-nameinput" type="text" maxLength={30}
                placeholder={pe('ex.: Alice', 'e.g. Alice')}
                value={myName}
                onChange={(e) => { setMyName(e.target.value); myNameRef.current = e.target.value }} />
            </div>
            <p className="cv-govnote" id="cv-create-why" role="status">
              {!myName.trim() ? pe('Para seguir, diga o seu nome: os outros membros vão vê-lo.', 'To go on, fill in your name: the other members will see it.') : ''}
            </p>
            <button className="rd-enter primary cv-primary" disabled={!myName.trim()} aria-describedby="cv-create-why" onClick={() => setCreateStep(2)}>
              {pe('Continuar →', 'Continue →')}
            </button>
            <button type="button" className="cv-linkbtn" onClick={() => setShowJoin(true)}>
              {pe('Tenho um convite? Entrar', 'Have an invite? Join')}
            </button>
          </>
        )}

        {createStep === 2 && (
          <>
            <button type="button" className="cv-back" onClick={() => setCreateStep(1)}>{pe('← Voltar', '← Back')}</button>
            <span className="rd-eyebrow">{pe('PASSO 2 DE 2 · REGRA', 'STEP 2 OF 2 · RULE')}</span>
            <h2 className="cv-title">{pe('Quem precisa aprovar?', 'Who needs to approve?')}</h2>
            <p className="cv-lead">{pe('Quantas pessoas, e quantas assinam pra mover dinheiro.', 'How many people, and how many sign to move money.')}</p>

            <div className="cv-controls">
              <div className="cv-field">
                <span className="cv-k">{pe('Dispositivos', 'Devices')}</span>
                <div className="cv-stepper">
                  <button type="button" className="cv-step" disabled={n <= 2} aria-label={pe('menos aparelhos', 'fewer devices')}
                    onClick={() => { const v = n - 1; setN(v); if (t > v) setT(v) }}>−</button>
                  <span className="cv-num">{n}</span>
                  <button type="button" className="cv-step" disabled={n >= 5} aria-label={pe('mais aparelhos', 'more devices')}
                    onClick={() => setN(n + 1)}>+</button>
                </div>
              </div>
              <div className="cv-field">
                <span className="cv-k">{pe('Quórum para assinar', 'Signing quorum')}</span>
                <div className="cv-stepper">
                  {/* Never below 2: the threshold library refuses a quorum of 1, and the sentence
                      under this control promises that no one sends alone. */}
                  <button type="button" className="cv-step" disabled={t <= 2} aria-label={pe('quórum menor', 'lower quorum')}
                    onClick={() => setT(t - 1)}>−</button>
                  <span className="cv-num">{t} <em>{pe('de', 'of')} {n}</em></span>
                  <button type="button" className="cv-step" disabled={t >= n} aria-label={pe('quórum maior', 'higher quorum')}
                    onClick={() => setT(t + 1)}>+</button>
                </div>
              </div>
            </div>

            <div className="cv-trust">{trustSentence}</div>

            {n === t && (
              <div className="cv-warn" role="note">
                <span className="cv-warn-tag">{pe('Sem margem de recuperação', 'No recovery margin')}</span>
                {pe(
                  `Se um aparelho for perdido, os fundos ficam presos, sem como recuperar. Recomendamos ${t} de ${t + 1}.`,
                  `If one device is lost, the funds are locked, with no way to recover. We recommend ${t} of ${t + 1}.`,
                )}
              </div>
            )}

            <button type="button" className="cv-adv" aria-expanded={advOpen} onClick={() => setAdvOpen((v) => !v)}>
              {advOpen ? '⌄' : '›'} {pe('Avançado (governança)', 'Advanced (governance)')}
            </button>
            {advOpen && (
              <>
                <div className="cv-field cv-gov">
                  <span className="cv-k">{pe('Governança', 'Governance')}</span>
                  <div className="cv-seg" role="radiogroup" aria-label={pe('Governança', 'Governance')}>
                    <button type="button" role="radio" aria-checked={governance === 'quorum'}
                      className={'cv-segbtn' + (governance === 'quorum' ? ' on' : '')}
                      onClick={() => { setGovernance('quorum'); governanceRef.current = 'quorum' }}>
                      {pe('Sob quórum', 'Quorum-gated')}
                    </button>
                    <button type="button" role="radio" aria-checked={governance === 'open'}
                      className={'cv-segbtn' + (governance === 'open' ? ' on' : '')}
                      onClick={() => { setGovernance('open'); governanceRef.current = 'open' }}>
                      {pe('Aberto', 'Open')}
                    </button>
                  </div>
                  <span className="cv-govnote">{governance === 'quorum'
                    ? pe('Mudar nomes e beneficiários é decisão do grupo. Mover fundos sempre exige o quórum.',
                         'Changing names and beneficiaries is a group decision. Moving funds always needs the quorum.')
                    : pe('Qualquer membro edita nomes e beneficiários. Mover fundos sempre exige o quórum.',
                         'Any member edits names and beneficiaries. Moving funds always needs the quorum.')}</span>
                </div>

              </>
            )}

            <div className="cv-field cv-gov">
              <label className="cv-k" htmlFor="cv-create-pin">{pe('PIN da sala', 'Room PIN')}</label>
              <input id="cv-create-pin" className="cv-nameinput" type="text" maxLength={20} required autoComplete="off" autoCorrect="off" spellCheck={false}
                aria-describedby="cv-create-pin-help" value={pin} onChange={(e) => setPin(e.target.value)} />
              <span className="cv-govnote" id="cv-create-pin-help">{pe(
                'Invente um PIN (por exemplo, de 4 a 6 dígitos). Você vai dizê-lo a cada membro numa ligação, nunca junto com o convite. Sem o PIN, quem só tem o convite não acha a sala.',
                'Make up a PIN (for example, 4 to 6 digits). You will tell it to each member on a call, never together with the invite. Without the PIN, whoever only has the invite cannot find the room.')}</span>
            </div>

            <button className="rd-enter primary cv-primary" disabled={!pin.trim()}
              onClick={() => { setRole('create'); void begin('create', newInviteCode(), n, t, pin) }}>
              {pe('Gerar convite', 'Generate invite')}
            </button>
          </>
        )}
      </Shell>
    )
  }

  if (phase === 'idle') {
    return (
      <Shell error={error} embedded={embedded} onDashboard={groupVk ? openDashboard : undefined}>
        <h1 className="net-h1">{tt('net.idle.title')}</h1>
        <p className="net-lead">{ttr('net.idle.lead')}</p>
        <p className="net-lead" style={{ fontSize: '.85rem', opacity: 0.8 }}>{ttr('net.idle.purpose')}</p>

        <div className="net-cards">
          <div className="net-card">
            <h3>{tt('net.idle.createTitle')}</h3>
            <p>{tt('net.idle.createDesc')}</p>
            <label className="net-row">
              {tt('net.idle.devices')}
              <select value={n} onChange={(e) => { const v = Number(e.target.value); setN(v); if (t > v) setT(v) }}>
                <option value={2}>2</option>
                <option value={3}>3</option>
              </select>
            </label>
            <label className="net-row">
              {tt('net.idle.quorum')}
              <select value={t} onChange={(e) => setT(Number(e.target.value))}>
                {Array.from({ length: n }, (_, i) => i + 1).map((v) => (
                  <option key={v} value={v}>{tt('net.idle.quorumOption', { v, n })}</option>
                ))}
              </select>
            </label>
            <label className="net-row">
              {pe('PIN de admissão', 'Admission PIN')}
              <input className="net-input" type="text" maxLength={20} required value={pin} onChange={(e) => setPin(e.target.value)} />
            </label>
            <button
              className="net-btn primary"
              disabled={!pin.trim()}
              onClick={() => { setRole('create'); void begin('create', newInviteCode(), n, t, pin) }}
            >
              {tt('net.idle.generateInvite')}
            </button>
          </div>

          <div className="net-card">
            <h3>{tt('net.idle.joinTitle')}</h3>
            <p>{tt('net.idle.joinDesc')}</p>
            <input
              className="net-input"
              aria-label={pe('Convite (link ou código)', 'Invite (link or code)')}
              autoCapitalize="characters" autoCorrect="off" spellCheck={false}
              placeholder={tt('net.idle.joinPlaceholder')}
              value={joinCode}
              onChange={(e) => setJoinCode(e.target.value)}
            />
            <input className="net-input" type="text" maxLength={20} required placeholder={pe('PIN', 'PIN')}
              aria-label={pe('PIN da sala', 'Room PIN')} autoComplete="off" autoCorrect="off" spellCheck={false}
              value={pin} onChange={(e) => setPin(e.target.value)} />
            <button
              className="net-btn"
              disabled={!parseInvite(joinCode) || !pin.trim()}
              onClick={() => { setRole('join'); void begin('join', parseInvite(joinCode)!, n, t, pin) }}
            >
              {tt('net.idle.joinBtn')}
            </button>
          </div>
        </div>

        {savedVaults.length > 0 && (
          <div className="net-card" style={{ marginTop: 16 }}>
            <h3>{L.restoreTitle}</h3>
            {restoreErr && <div className="net-error" role="alert">{restoreErr}</div>}
            {savedVaults.map((v) => (
              <div key={v.id} className="net-row" style={{ flexWrap: 'wrap', gap: 8 }}>
                <code style={{ flex: '1 1 100%', wordBreak: 'break-all', fontSize: '0.8em' }}>{v.id}</code>
                <input
                  className="net-input"
                  type="password"
                  style={{ flex: '1 1 auto', margin: 0 }}
                  placeholder={L.restorePlaceholder}
                  value={restorePass[v.id] ?? ''}
                  onChange={(e) => setRestorePass((m) => ({ ...m, [v.id]: e.target.value }))}
                />
                <button
                  className="net-btn"
                  disabled={restoreBusy === v.id || !(restorePass[v.id] ?? '')}
                  onClick={() => void doRestore(v.id)}
                >
                  {restoreBusy === v.id ? L.unlocking : L.unlockBtn}
                </button>
                <button className="net-btn" onClick={() => void doDelete(v.id)}>{L.deleteBtn}</button>
              </div>
            ))}
          </div>
        )}

        <p className="net-tip">{ttr('net.idle.tip')}</p>
      </Shell>
    )
  }

  if (phase === 'restored') {
    return (
      <Shell error={error} embedded={embedded} onDashboard={groupVk ? openDashboard : undefined}>
        <h1 className="net-h1">{L.restoredTitle}</h1>
        <p className="net-lead">{L.restoredLead}</p>
        <div className="net-vk">{groupVk}</div>
        {restoredRoster.length > 0 && (
          <p className="net-tip">{L.rosterLabel} {restoredRoster.join(', ')}</p>
        )}
        <p className="net-tip">{L.restoredNote}</p>

        <button className="net-btn primary" style={{ marginTop: 8 }} onClick={openDashboard}>
          {pe('Abrir o cofre (Dashboard) →', 'Open the vault (Dashboard) →')}
        </button>

        <div className="net-card" style={{ marginTop: 16 }}>
          <h3>{pe('Assinar com este cofre', 'Sign with this vault')}</h3>
          <p>{pe('Reingresse com os outros membros numa sessão de assinatura pelo relay.', 'Rejoin the other members in a signing session over the relay.')}</p>
          <button className="net-btn primary" onClick={() => void beginSign(newRoomCode())}>
            {pe('Iniciar sessão (criar código)', 'Start a session (create a code)')}
          </button>
          <div style={{ marginTop: 12, display: 'flex', gap: 8 }}>
            <input
              className="net-input"
              placeholder={pe('código da sessão', 'session code')}
              value={signRoomInput}
              onChange={(e) => setSignRoomInput(e.target.value.trim())}
            />
            <button
              className="net-btn"
              disabled={signRoomInput.length < 4}
              onClick={() => void beginSign(signRoomInput)}
            >
              {pe('Entrar', 'Join')}
            </button>
          </div>
        </div>

        <button className="net-btn" style={{ marginTop: 16 }} onClick={() => setPhase('idle')}>
          {L.backBtn}
        </button>
      </Shell>
    )
  }

  const total = configRef.current?.n ?? n
  const quorum = configRef.current?.t ?? t
  // The save step's status line: who is left to save, then the registration; empty otherwise.
  const saveWait = saveState !== 'saved' ? ''
    : waiting.length > 0 ? saveWaitText(total, waiting, pe)
    : !backup && hostedState === 'registering' ? pe('Registrando o cofre…', 'Registering the vault…')
    : ''

  // Shared signing controls, used by the just-created vault ('done') and by a restored device that
  // rejoined a signing session ('signsession'). `canStart` gates the button on quorum presence.
  const renderSign = () => (
    <div className="net-sign">
      {signPhase === 'none' && !signWhat && (
        <p className="net-lead" style={{ marginTop: 20 }}>
          {pe(
            'Cofre pronto para assinar. Aguardando um pedido de pagamento do operador pelo relay; quando chegar, cada dispositivo lê da própria transação o que ela paga antes de assinar.',
            'Vault ready to sign. Waiting for a payment request from the operator over the relay; when it arrives, each device reads from the transaction itself what it pays before signing.',
          )}
        </p>
      )}
      {/* Shown on a refusal too, which is when the member is asked to compare it (#610). This
          route does not know the vault's own receivers, so it names no output change. The heading
          says what the block is and nothing more: this route's `error` covers relay drops and
          timeouts too, so it cannot tell a refusal from a failure. */}
      {signWhat && (
        <div className="net-what" style={{ marginTop: 16, padding: '10px 14px', border: '1px solid var(--line)', borderRadius: 8 }}>
          <strong>{pe('O que este dispositivo leu da transação', 'What this device read from the transaction')}</strong>
          {readingRows(signWhat, () => false).map((r, i) => (
            <div key={i}>
              {fmtZecExact(r.zat / 1e8)} ZEC <span aria-hidden="true">→</span>{' '}
              <code>{r.to.kind === 'address' ? shortId(r.to.addr) : pe('um endereço que a transação não informa', 'an address this transaction does not name')}</code>
            </div>
          ))}
          <div>{pe('Taxa da rede', 'Network fee')}: {fmtZecExact(signWhat.feeZat / 1e8)} ZEC</div>
          <div style={{ fontSize: '.82rem', opacity: 0.75, marginTop: 4 }}>
            {pe(
              'Cada dispositivo lê da própria transação o que ela paga e a taxa, e recusa uma que não bate com o que diz pagar, antes de contribuir com a sua parte da assinatura.',
              'Each device reads from the transaction itself what it pays and its fee, and refuses one that does not match what it claims to pay, before contributing its share of the signature.',
            )}
          </div>
        </div>
      )}
      {signPhase === 'signing' && <p className="net-lead" style={{ marginTop: 20 }}>{tt('net.sign.signing')}</p>}
      {signPhase === 'signed' && (
        <>
          <p className="net-lead" style={{ marginTop: 20 }}>
            {signOk ? tt('net.sign.validPrefix') : tt('net.sign.invalidPrefix')} {ttr('net.sign.signedBody')}
          </p>
          <div className="net-vk">{signature}</div>
          <p className="net-lead" style={{ fontSize: '.82rem', opacity: 0.8, marginTop: 10 }}>
            {pe(
              'Assinatura válida sob o alpha da própria transação (o mecanismo de gasto Orchard real), verificada sob ak+alpha. A assinatura agregada volta ao operador pelo relay, que a injeta na PCZT e transmite - nenhum dispositivo transmite sozinho, e o operador nunca vê uma parte da chave.',
              'Valid signature under the transaction’s own alpha (the real Orchard spend mechanism), verified under ak+alpha. The aggregate signature is returned to the operator over the relay, who injects it into the PCZT and broadcasts - no single device broadcasts alone, and the operator never sees a key share.',
            )}
          </p>
        </>
      )}
      {helperConfigured() && groupVk && (
        <div className="net-card" style={{ marginTop: 16 }}>
          <h3>{pe('Propostas prontas para assinar', 'Proposals ready to sign')}</h3>
          <p className="net-tip">
            {pe(
              'Propor e aprovar pagamentos é no app (Dashboard). Quando uma proposta bate o quórum, ela aparece aqui: as abas assinam e o cofre transmite. O coordenador nunca vê uma parte da chave.',
              'Proposing and approving payments happens in the app (Dashboard). When a proposal reaches quorum it shows here: the tabs sign and the vault broadcasts. The coordinator never sees a key share.',
            )}
          </p>
          <button className="net-btn" onClick={() => void loadProposals()}>
            {pe('Atualizar', 'Refresh')}
          </button>
          {propMsg && (
            <p className="net-tip" style={{ marginTop: 8, wordBreak: 'break-all' }}>{propMsg}</p>
          )}
          {(() => {
            const ready = (proposals ?? []).filter((p) => p.state === 'ready')
            if (proposals && ready.length === 0) {
              return (
                <p className="net-tip" style={{ marginTop: 8 }}>
                  {pe('Nenhuma proposta pronta para assinar.', 'No proposals ready to sign.')}
                </p>
              )
            }
            return (
              <ul className="net-trail">
                {ready.map((p) => (
                  <li key={p.id}>
                    <div className="net-trail-head">
                      <span className="net-tag">{pe('pronta', 'ready')}</span>
                      <span className="net-trail-when">
                        {fmtZec(p.amount_zat)} ZEC → <code>{shortId(p.to)}</code>
                      </span>
                    </div>
                    <div className="net-trail-row">
                      <span className="net-trail-label">{pe('aprovações', 'approvals')}</span>
                      <code>
                        {p.approvals.length}/{p.threshold || '?'}
                      </code>
                    </div>
                    <div className="net-trail-row" style={{ marginTop: 4 }}>
                      <button
                        className="net-btn primary"
                        disabled={!room || sendingId !== null}
                        aria-busy={sendingId === p.id}
                        onClick={() => void execProp(p.id)}
                      >
                        {sendingId === p.id
                          ? pe('Enviando…', 'Sending…')
                          : room
                          ? pe('Assinar e enviar', 'Sign & send')
                          : pe('Inicie uma sessão de assinatura', 'Start a signing session')}
                      </button>
                    </div>
                  </li>
                ))}
              </ul>
            )
          })()}
        </div>
      )}
    </div>
  )

  // Embedded (create modal): clean, purpose-built rendering for the gathering / running / done
  // phases - seats filling, a running indicator, and a done step that just protects the device and
  // opens the Dashboard (the address/QR/proposals/ceremony all live in the app now).
  if (embedded && (phase === 'roster' || phase === 'confirm' || phase === 'dkg' || phase === 'done')) {
    return (
      <Shell error={error} embedded>
        {!busy && leaving && backupPending && (
          <div className="cv-warn" role="group" aria-labelledby="cv-leave-q" aria-describedby="cv-leave-why" ref={leaveRef}>
            <p id="cv-leave-q"><strong>{pe('Abrir o cofre sem guardar uma cópia?', 'Open the vault without saving a copy?')}</strong></p>
            <p id="cv-leave-why">{pe('A cópia cifrada é o que permite recuperar o seu pedaço se este aparelho se perder. Você também pode exportá-la depois, nos Ajustes.', 'The encrypted copy is how you recover your part if this device is lost. You can also export it later, in Settings.')}</p>
            <div className="cv-invite-actions">
              <button type="button" className="rd-enter primary cv-primary" autoFocus onClick={() => { setLeaving(false); doBackupDownload() }}>{pe('Baixar o arquivo', 'Download the file')}</button>
              <button type="button" className="cv-stop" onClick={() => { setLeaving(false); openDashboard() }}>{pe('Abrir sem a cópia', 'Open without it')}</button>
            </div>
          </div>
        )}
        {busy && (leaving ? (
          <div className="cv-warn" role="group" aria-labelledby="cv-leave-q" aria-describedby="cv-leave-why" ref={leaveRef}>
            {phase === 'done' ? (
              <>
                <p id="cv-leave-q"><strong>{pe('Sair sem guardar?', 'Leave without saving?')}</strong></p>
                <p id="cv-leave-why">{pe('O seu pedaço da chave ainda não foi guardado neste aparelho. Sem ele você não poderá aprovar pagamentos deste cofre, e ele não será terminado.', 'Your part of the key is not saved on this device yet. Without it you cannot approve payments from this vault, and it will not be finished.')}</p>
              </>
            ) : (
              <>
                <p id="cv-leave-q"><strong>{pe('Cancelar a criação deste cofre?', 'Cancel creating this vault?')}</strong></p>
                <p id="cv-leave-why">{pe('O seu pedaço da chave será perdido, este cofre não será criado, e os outros terão de começar de novo.', 'Your part of the key will be lost, this vault will not be created, and the others will have to start again.')}</p>
              </>
            )}
            <div className="cv-invite-actions">
              <button type="button" className="rd-enter primary cv-primary" autoFocus onClick={() => setLeaving(false)}>{pe('Continuar criando', 'Keep creating')}</button>
              <button type="button" className="cv-stop" onClick={() => { setLeaving(false); onLeave?.() }}>{pe('Cancelar e perder o meu pedaço', 'Cancel and lose my part')}</button>
            </div>
          </div>
        ) : (
          <button type="button" className="cv-cancel" ref={cancelRef} onClick={() => setLeaving(true)}>{pe('Cancelar criação', 'Cancel creation')}</button>
        ))}
        {phase === 'roster' && (
          <>
            <span className="rd-eyebrow">{pe('REUNINDO OS APARELHOS', 'GATHERING DEVICES')}</span>
            <h2 className="cv-title">{role === 'create' ? pe('Compartilhe o convite', 'Share the invite') : pe('Entrando no cofre', 'Joining the vault')}</h2>
            {role === 'create' && (
              <>
                <p className="cv-lead">{pe('Envie o convite para os outros aparelhos. O cofre nasce quando todos entrarem e conferirem o código.', 'Send the invite to the other devices. The vault is born once they all join and check the code.')}</p>
                <InviteCard code={room} pin={pin} pe={pe} />
              </>
            )}
            <div className="cv-seats">
              {Array.from({ length: total }, (_, i) => (
                <span key={i} className={'cv-seat' + (i < rosterCount ? ' on' : '')} />
              ))}
            </div>
            <p className="cv-seatlabel" role="status">{rosterCount} {pe('de', 'of')} {total} {pe('conectados', 'connected')}</p>
            {role === 'join' && joinSlow && (
              <div className="cv-trust" role="status" style={{ marginTop: 14 }}>{pe(
                'Ainda não encontramos o cofre. Confira o convite e o PIN (o PIN vem separado do convite), ou aguarde os outros aparelhos entrarem.',
                'We haven’t found the vault yet. Check the invite and the PIN (the PIN comes separately from the invite), or wait for the other devices to join.')}
                <button type="button" className="cv-stop" style={{ marginTop: 10 }} onClick={() => { allowUnloadRef.current = true; window.location.reload() }}>
                  {pe('Trocar o convite ou o PIN', 'Change the invite or the PIN')}
                </button>
              </div>
            )}
          </>
        )}
        {phase === 'confirm' && code && (
          <CodeCheck code={code.code} names={code.names} vaultName={code.vaultName} mySeat={code.mySeat} onConfirm={() => void doConfirm()} onMismatch={doMismatch} pe={pe} />
        )}
        {phase === 'dkg' && (
          <div className="cv-loading" role="status">
            <div className="cv-spinner" aria-hidden="true" />
            <h2 className="cv-title">{pe('Criando a chave em conjunto', 'Creating the key together')}</h2>
            <p className="cv-lead">{pe('Cada aparelho faz o seu pedaço da chave; a chave inteira nunca é montada. Se você já confirmou o código, espere os outros confirmarem também. Não feche esta janela.', 'Each device makes its own piece of the key; the whole key is never put together. If you already confirmed the code, wait for the others to confirm too. Do not close this window.')}</p>
            {waiting.length > 0 && (
              <p className="cv-seatlabel">{pe(`Esperando terminar: ${waiting.join(', ')}`, `Waiting for these to finish: ${waiting.join(', ')}`)}</p>
            )}
            {slowFinish && (
              <div className="cv-warn" role="alert">{pe(
                'Está demorando: alguém pode não ter recebido a sua parte. Não use nem deposite neste cofre até ele terminar para todos. Se não terminar, comecem de novo com um novo convite.',
                'This is taking long: someone may not have received their part. Do not use or fund this vault until it finishes for everyone. If it does not, start again with a new invite.')}</div>
            )}
          </div>
        )}
        {phase === 'done' && saveState === 'saved' && backup && (
          <>
            <span className="rd-eyebrow">{pe('FAÇA O BACKUP', 'BACK IT UP')}</span>
            <h2 className="cv-title">{pe('Guarde uma cópia do cofre', 'Save a copy of the vault')}</h2>
            <p className="cv-lead">{pe('Este arquivo é a sua cópia portátil do cofre, cifrada com a frase-senha que você acabou de criar. Guarde em outro aparelho ou num gerenciador de senhas. Sem ele, perder este aparelho pode custar o seu acesso.', 'This file is your portable copy of the vault, encrypted with the passphrase you just created. Keep it on another device or in a password manager. Without it, losing this device can cost you access.')}</p>
            <div className="cv-backup">
              <div className="cv-backup-file mono">
                <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                  <path d="M14 3v4a1 1 0 0 0 1 1h4" /><path d="M17 21H7a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h7l5 5v11a2 2 0 0 1-2 2z" />
                </svg>
                <span className="cv-backup-name">{backup.name}</span>
              </div>
              <div className="cv-backup-btns">
                <button type="button" className="rd-enter primary cv-primary" onClick={doBackupDownload}>
                  {pe('Baixar arquivo', 'Download file')}
                </button>
                <button type="button" className="btn ghost" onClick={() => void doBackupCopy()}>
                  {backupCopied ? tt('members.fpCopied') : pe('Copiar', 'Copy')}
                </button>
              </div>
            </div>
            {!backup.complete && (
              // Silence here is what the fix is FOR. The vault registers and its read key lands
              // asynchronously, so this copy can be written before the viewing key exists to fetch -
              // and a backup that quietly restores the seat and not the vault leaves a member holding
              // real spend authority over money they cannot see. Saying so costs a trip to Settings.
              <p className="cv-warn" role="status">
                {pe(
                  'Esta cópia saiu incompleta: falta a chave de visualização do cofre, então ela restaura o seu assento mas não o cofre. Guarde este arquivo mesmo assim e, com o cofre aberto, tire outra em Ajustes → Exportar.',
                  'This copy came out incomplete: it is missing the vault\'s viewing key, so it restores your seat but not the vault. Keep this file anyway, then take another from Settings → Export once the vault is open.',
                )}
              </p>
            )}
            <button type="button" className="cv-linkbtn" onClick={openDashboard}>
              {pe('Já guardei, abrir o cofre →', 'Saved it, open the vault →')}
            </button>
          </>
        )}
        {phase === 'done' && !(saveState === 'saved' && backup) && (
          <>
            <span className="rd-eyebrow">{pe('GUARDE O SEU PEDAÇO', 'SAVE YOUR PART')}</span>
            <h2 className="cv-title">{pe('O seu pedaço da chave está pronto', 'Your part of the key is ready')}</h2>
            <p className="cv-lead">{pe('Proteja-o neste aparelho com uma frase-senha. O endereço do cofre aparece quando todos os membros tiverem guardado o seu; antes disso, não há onde depositar.', 'Protect it on this device with a passphrase. The vault’s address appears once every member has saved theirs; until then there is nowhere to deposit.')}</p>
            {fp && (
              <div className="fp-card" role="note" aria-label={tt('members.fpTitle')} style={{ marginBottom: 16 }}>
                <div className="fp-head">
                  <span className="klab">{tt('members.fpTitle')}</span>
                  <CopyButton value={fp} />
                </div>
                <div className="fp-code mono">{fp}</div>
                <div className="fp-help dim">{ttr('ceremony.fpHelp')}</div>
              </div>
            )}
            <div className="cv-join">
              <PassphraseField inputClassName="cv-input" autoFocus
                placeholder={pe('Frase-senha (mínimo 8 caracteres)', 'Passphrase (at least 8 characters)')}
                value={savePass} onChange={setSavePass} />
              {saveErr && <p className="set-err">{saveErr}</p>}
              <button className="rd-enter primary cv-primary" disabled={savePass.length < 8 || saveState !== 'idle' || !hasSecret}
                onClick={() => void doSave()}>
                {!hasSecret ? (secretSlow
                  ? pe('A chave de acesso não chegou. Peça a quem criou para conferir a conexão, ou comecem de novo.', 'The access key has not arrived. Ask the creator to check their connection, or start again.')
                  : pe('Esperando a chave de acesso de quem criou…', 'Waiting for the access key from the creator…'))
                  : saveState === 'saving' ? pe('Guardando…', 'Saving…')
                  : saveState === 'saved' ? pe('Guardado neste aparelho ✓', 'Saved on this device ✓')
                  : pe('Proteger o cofre →', 'Protect the vault →')}
              </button>
              <WaitLine busy={!!saveWait}>{saveWait}</WaitLine>

            </div>
          </>
        )}
      </Shell>
    )
  }

  return (
    <Shell error={error} embedded={embedded} onDashboard={finished ? openDashboard : undefined}>
      {role === 'create' && phase === 'roster' && (
        <>
          <h1 className="net-h1">{tt('net.invite.title')}</h1>
          <p className="net-lead">{tt('net.invite.lead')}</p>
          <InviteCard code={room} pin={pin} pe={pe} />
        </>
      )}
      {role === 'join' && phase === 'roster' && (
        <>
          <h1 className="net-h1">{tt('net.joining.title')}</h1>
          <div className="net-code">{formatInvite(room)}</div>
        </>
      )}
      {phase === 'confirm' && code && (
        <CodeCheck code={code.code} names={code.names} vaultName={code.vaultName} mySeat={code.mySeat} onConfirm={() => void doConfirm()} onMismatch={doMismatch} pe={pe} />
      )}
      {phase === 'dkg' && <h1 className="net-h1">{tt('net.creating.title')}</h1>}
      {phase === 'done' && <h1 className="net-h1">{tt('net.done.title')}</h1>}

      <div className="net-status">
        <span className="net-pill">{tt('net.status.connected', { peers })}</span>
        {phase !== 'signsession' && (
          <span className="net-pill">{tt('net.status.announced', { count: rosterCount, total })}</span>
        )}
        <span className="net-pill">{tt('net.status.quorum', { quorum, total })}</span>
      </div>

      {phase === 'roster' && rosterCount < total && (
        <p className="net-lead">{tt('net.status.waiting', { count: total - rosterCount })}</p>
      )}

      {phase === 'done' && (
        <div className="net-done">
          <p className="net-lead">{ttr('net.done.lead')}</p>
          <div className="net-vk">{groupVk}</div>
          <p className="net-tip">{tt('net.done.tip')}</p>

          {finished && hostedState === 'registered' && (
            <button className="net-btn primary" style={{ marginTop: 12 }} onClick={openDashboard}>
              {pe('Abrir o cofre (Dashboard) →', 'Open the vault (Dashboard) →')}
            </button>
          )}

          {hostedState !== 'idle' && (
            <div className="net-card" style={{ marginTop: 16 }}>
              <h3>{pe('Endereço do cofre', 'Vault address')}</h3>
              {hostedState === 'registering' && (
                <p className="net-tip">
                  {pe(
                    'Registrando o cofre no coordenador (cego às partes)…',
                    'Registering the vault with the coordinator (blind to shares)…',
                  )}
                </p>
              )}
              {hostedState === 'registered' && (
                <>
                  <p>
                    {pe(
                      'O coordenador derivou o endereço Orchard deste cofre a partir da chave do grupo (só material público, nenhuma parte saiu do dispositivo). Receba fundos aqui:',
                      'The coordinator derived this vault’s Orchard address from the group key (public material only, no share left the device). Receive funds here:',
                    )}
                  </p>
                  <div
                    className="net-qr"
                    role="img"
                    aria-label={pe('QR do endereço do cofre', 'Vault address QR')}
                    dangerouslySetInnerHTML={{ __html: encodeQR(`zcash:${hostedAddress}`, 'svg') }}
                  />
                  <div className="net-vk">{hostedAddress}</div>
                  <button
                    className="net-btn"
                    onClick={() => void navigator.clipboard?.writeText(hostedAddress)}
                  >
                    {pe('Copiar endereço', 'Copy address')}
                  </button>

                  <div style={{ marginTop: 16 }}>
                    <button
                      className="net-btn"
                      disabled={balanceBusy}
                      onClick={() => {
                        setBalanceBusy(true)
                        void vaultBalance(groupVk).then((b) => {
                          setBalance((prev) => (b === WALLET_BUSY ? prev : b
                            ? { spend: zatToZec(b.orchard_spendable_zat), total: zatToZec(b.total_zat) }
                            : null))
                          setBalanceBusy(false)
                        })
                      }}
                    >
                      {balanceBusy
                        ? pe('Sincronizando…', 'Syncing…')
                        : pe('Ver saldo', 'Check balance')}
                    </button>
                    {balance && (
                      <p className="net-tip" style={{ marginTop: 8 }}>
                        {pe('Recebido', 'Received')}: <strong>{balance.total} ZEC</strong>
                        {' · '}
                        {pe('disponível', 'spendable')}: <strong>{balance.spend} ZEC</strong>
                      </p>
                    )}
                  </div>
                </>
              )}
              {hostedState === 'failed' && !error && (
                <p className="net-tip">
                  {pe(
                    'O cofre foi criado neste dispositivo, mas o coordenador não respondeu. O cofre segue válido e local; tente registrar mais tarde para receber e enviar.',
                    'The vault was created on this device, but the coordinator did not respond. The vault is still valid and local; try registering later to receive and send.',
                  )}
                </p>
              )}
            </div>
          )}

          <div className="net-card" style={{ marginTop: 16 }}>
            <h3>{L.saveTitle}</h3>
            <p>{L.saveHint}</p>
            {saveState === 'saved' ? (
              <>
                <p className="net-tip">{L.saved}</p>
                <WaitLine busy={!finished && waiting.length > 0}>{!finished && waiting.length > 0 ? saveWaitText(total, waiting, pe) : ''}</WaitLine>
              </>
            ) : (
              <>
                {saveErr && <div className="net-error" role="alert">{saveErr}</div>}
                <input
                  className="net-input"
                  type="password"
                  placeholder={L.savePlaceholder}
                  value={savePass}
                  onChange={(e) => setSavePass(e.target.value)}
                />
                <button
                  className="net-btn"
                  disabled={saveState === 'saving' || savePass.length < 8 || !hasSecret}
                  onClick={() => void doSave()}
                >
                  {saveState === 'saving' ? L.saving : L.saveBtn}
                </button>
              </>
            )}
          </div>

          {renderSign()}
        </div>
      )}

      {phase === 'signsession' && (
        <div className="net-done">
          <h1 className="net-h1">{pe('Sessão de assinatura', 'Signing session')}</h1>
          <p className="net-lead">
            {pe(
              'Cofre restaurado neste dispositivo. Reingressando com os outros membros para assinar; nenhum DKG roda de novo.',
              'Vault restored on this device. Rejoining with the other members to sign; no DKG runs again.',
            )}
          </p>
          <div className="net-vk">{groupVk}</div>
          <p className="net-tip">{pe('Código da sessão (compartilhe com os membros)', 'Session code (share with the members)')}:</p>
          <div className="net-code" onClick={() => navigator.clipboard?.writeText(room)} title={tt('net.invite.clickCopy')}>{room}</div>
          <p className="net-tip" style={{ marginTop: 12 }}>{pe('Membros na sessão', 'Members in session')}: {signSeatCount} / {quorum}</p>
          {signSeatCount < quorum && (
            <p className="net-lead">{pe('Aguardando o quórum reingressar…', 'Waiting for the quorum to rejoin…')}</p>
          )}
          {renderSign()}
        </div>
      )}

      <div className="net-log">
        {log.map((line, i) => (
          <div key={i} className="net-log-row"><span>›</span> {line}</div>
        ))}
      </div>
    </Shell>
  )
}
