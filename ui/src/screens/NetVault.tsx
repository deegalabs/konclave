import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react'
import { useNavigate } from 'react-router-dom'
import { setSelectedVault, getSelectedVault } from '../api'
import { getUnlockedShare, clearUnlockedShare } from '../session'
import init, {
  DkgSession,
  DeviceKey,
  Coordinator,
  sealTo,
  identifierBytes,
  participantRound1,
  participantRound2WithRandomizer,
  extractRandomizers,
  describeOutputs,
} from '../wasm-pkg/konclave_wasm.js'
import wasmUrl from '../wasm-pkg/konclave_wasm_bg.wasm?url'
import { RelaySession, newRoomCode, ephemeralTag, b64, unb64, bytesEqual, RELAY_BASE, type RelayMsg } from '../net'
import { parseSignRequest, buildSignResponse, hexToBytes as hexBytes, bytesToHex, type SignRequest } from '../net-sign'
import { useT, useTr, useI18n } from '../i18n'
import { Letterhead } from '../components'
import {
  saveVault,
  loadVault,
  listVaults,
  deleteVault,
  storageAvailable,
  type VaultPublic,
  type VaultLoaded,
} from '../storage'
import {
  helperConfigured,
  registerVault,
  vaultBalance,
  listProposals,
  executeProposal,
  type Proposal,
} from '../helper'
import { zatToZec } from '../format'
import encodeQR from '@paulmillr/qr'
import '../redesign.css'
import '../net.css'

// The konclave.app network, made visible: two (or three) browser contexts create ONE vault by
// a real DKG over the blind relay. Each keeps its own share; the round-2 secret pieces are
// sealed to their recipient, so the relay only ever carries public material or ciphertext.
// This is the "I created / I invited / I entered the code" flow, running for real across tabs.

type Phase = 'idle' | 'roster' | 'dkg' | 'done' | 'error' | 'restored' | 'signsession'

// Local, dependency-free labels for the on-device persistence UI (Marco 5). These are ADDITIVE
// to the /net flow, so rather than touch the shared i18n dictionaries we key a small table by the
// active locale. No em dashes in copy.
const PERSIST_LABELS = {
  'pt-BR': {
    saveTitle: 'Guardar neste dispositivo',
    saveHint: 'Cifra a sua parte do cofre com uma frase-senha, para não perder o cofre ao recarregar a página.',
    savePlaceholder: 'Frase-senha (mínimo 8 caracteres)',
    saveBtn: 'Guardar cofre',
    saving: 'Guardando...',
    saved: 'Cofre guardado neste dispositivo, cifrado.',
    saveErr: 'Não foi possível guardar o cofre: ',
    unavailable: 'Este navegador não permite guardar o cofre (sem IndexedDB/WebCrypto).',
    restoreTitle: 'Cofres guardados neste dispositivo',
    restorePlaceholder: 'Frase-senha',
    unlockBtn: 'Abrir',
    deleteBtn: 'Apagar',
    unlocking: 'Abrindo...',
    restoreErr: 'Não foi possível abrir o cofre: ',
    restoredTitle: 'Cofre restaurado',
    restoredLead: 'A sua parte do cofre foi restaurada deste dispositivo, sem refazer a criação.',
    restoredNote: 'Para assinar, reingresse com os membros numa sessão de assinatura abaixo.',
    rosterLabel: 'Participantes registrados:',
    backBtn: 'Voltar',
  },
  en: {
    saveTitle: 'Save on this device',
    saveHint: 'Encrypts your share of the vault with a passphrase, so a page reload does not lose the vault.',
    savePlaceholder: 'Passphrase (at least 8 characters)',
    saveBtn: 'Save vault',
    saving: 'Saving...',
    saved: 'Vault saved on this device, encrypted.',
    saveErr: 'Could not save the vault: ',
    unavailable: 'This browser cannot save the vault (no IndexedDB/WebCrypto).',
    restoreTitle: 'Vaults saved on this device',
    restorePlaceholder: 'Passphrase',
    unlockBtn: 'Open',
    deleteBtn: 'Delete',
    unlocking: 'Opening...',
    restoreErr: 'Could not open the vault: ',
    restoredTitle: 'Vault restored',
    restoredLead: 'Your share of the vault was restored from this device, without redoing creation.',
    restoredNote: 'To sign, rejoin the members in a signing session below.',
    rosterLabel: 'Registered participants:',
    backBtn: 'Back',
  },
} as const

// Wire messages (JSON inside the relay's opaque `data`; the relay never parses them).
type Msg =
  | { type: 'config'; n: number; t: number }
  | { type: 'hello'; encPub: string }
  | { type: 'r1'; pkg: string }
  | { type: 'r2'; to: number; box: string }
  // rejoin (signing after restore): a restored device announces its ORIGINAL seat (its KeyPackage's
  // identifier is bound to it), so a signing session re-seats by declared seat, not by fresh tags.
  | { type: 'rejoin'; seat: number }
  // signing (Marco 4): all public material — the proven PCZT to verify, the sighash to sign,
  // commitments, signing package, seed, shares, sig.
  | { type: 'sreq'; msg: string; pczt: string }
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
  // letterhead / frame — the Dialog is the chrome. Same DKG flow, different container.
  if (embedded) {
    return (
      <div className="rd net-embedded">
        {error && <div className="net-error">{error}</div>}
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
      {error && <div className="net-error">{error}</div>}
      {children}
    </div>
  )
}

// Parse EVERY real Orchard spend the proven PCZT must sign. `extractRandomizers` returns 36-byte
// records — a u32 little-endian action index followed by the 32-byte alpha — one per real spend.
// A single-spend tx yields one record (its alpha === the old `.slice(4, 36)`); a multi-note tx
// yields several, each a separate ceremony. Indices come straight from the PCZT the device signs,
// so the response maps each signature to the exact on-chain spend the helper's `into_sigs` expects.
function alphasFromPczt(pczt: Uint8Array): { index: number; alpha: Uint8Array }[] {
  const rand = extractRandomizers(pczt)
  const out: { index: number; alpha: Uint8Array }[] = []
  for (let off = 0; off + 36 <= rand.length; off += 36) {
    const index = rand[off]! | (rand[off + 1]! << 8) | (rand[off + 2]! << 16) | (rand[off + 3]! << 24)
    out.push({ index: index >>> 0, alpha: rand.slice(off + 4, off + 36) })
  }
  return out
}

export default function NetVault({ embedded }: { embedded?: boolean } = {}) {
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
  const L = PERSIST_LABELS[locale]
  const [phase, setPhase] = useState<Phase>('idle')
  const [role, setRole] = useState<'create' | 'join'>('create')
  const [room, setRoom] = useState('')
  const [joinCode, setJoinCode] = useState('')
  const [n, setN] = useState(2)
  const [t, setT] = useState(2)
  const [showJoin, setShowJoin] = useState(false) // embedded create modal: Join is a secondary reveal
  const [peers, setPeers] = useState(0)
  const [rosterCount, setRosterCount] = useState(0)
  const [log, setLog] = useState<string[]>([])
  const [groupVk, setGroupVk] = useState('')
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
  const [signPhase, setSignPhase] = useState<'none' | 'signing' | 'signed'>('none')
  const [signature, setSignature] = useState('')
  const [signOk, setSignOk] = useState(false)
  // What this device is about to sign, read on-device from the proven PCZT (describeOutputs).
  const [signWhat, setSignWhat] = useState<{ zec: string; addr: string } | null>(null)
  // Signing-after-restore: how many devices (by declared seat) have rejoined the signing session.
  const [signSeatCount, setSignSeatCount] = useState(0)
  const [signRoomInput, setSignRoomInput] = useState('')

  // --- on-device persistence (Marco 5) — additive, does not touch the DKG/relay/ceremony ---
  const [savePass, setSavePass] = useState('')
  const [saveState, setSaveState] = useState<'idle' | 'saving' | 'saved'>('idle')
  const [saveErr, setSaveErr] = useState('')
  const [savedVaults, setSavedVaults] = useState<VaultPublic[]>([])
  const [restorePass, setRestorePass] = useState<Record<string, string>>({})
  const [restoreBusy, setRestoreBusy] = useState('')
  const [restoreErr, setRestoreErr] = useState('')
  const [restoredRoster, setRestoredRoster] = useState<string[]>([])
  // Restored secret material, kept only in memory (never surfaced to JSON logs). Present after a
  // restore; `beginSign` wires it into a signing-only relay session (the device re-announces its
  // original seat via `rejoin`, then signs with these bytes — no DKG redo).
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
  const dkgRef = useRef<DkgSession | null>(null)

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
  const myTagRef = useRef('')
  const configRef = useRef<{ n: number; t: number } | null>(null)
  const rosterRef = useRef<Map<string, Uint8Array>>(new Map()) // tag -> encPub
  const seatByTagRef = useRef<Map<string, number>>(new Map()) // tag -> 1-based seat
  const seatTableRef = useRef<{ tag: string; encPub: Uint8Array; id: Uint8Array }[]>([])
  const mySeatRef = useRef(0)
  const startedDkgRef = useRef(false)
  const part2DoneRef = useRef(false)
  const part3DoneRef = useRef(false)
  const r1SeenRef = useRef<Set<number>>(new Set())
  const r2SeenRef = useRef<Set<number>>(new Set())
  const allMsgsRef = useRef<RelayMsg[]>([])
  const consumedRef = useRef<Set<number>>(new Set())
  const startGuardRef = useRef(false)
  const advancingRef = useRef(false)
  const rerunRef = useRef(false)
  // --- signing (Marco 4) ---
  const signStartedRef = useRef(false)
  const signMsgRef = useRef<Uint8Array>(new Uint8Array())
  const myNoncesRef = useRef<Uint8Array | null>(null)
  const signCommitsRef = useRef<Map<number, Uint8Array>>(new Map())
  const coordRef = useRef<Coordinator | null>(null)
  const spSentRef = useRef(false)
  const spRef = useRef<Uint8Array | null>(null)
  // The Orchard randomizer (alpha) of the real spend, read from the PCZT each device receives.
  // The live ceremony signs under THIS alpha (the real Orchard mechanism), not a self-derived seed.
  const signAlphaRef = useRef<Uint8Array | null>(null)
  const sentS2Ref = useRef(false)
  const signSharesSeenRef = useRef<Set<number>>(new Set())
  const sigDoneRef = useRef(false)
  // Architecture B: when a helper (orchestrator net_send, blind to spending) publishes a real
  // sign-request into the room, the coordinator drives the ceremony over ITS sighash+alpha+PCZT,
  // and the aggregate signature is posted back RAW for the helper to inject and broadcast.
  const helperReqRef = useRef<SignRequest | null>(null)
  // Multi-spend: a real tx may consume several notes, each a separate FROST spend (own alpha, same
  // sighash). These drive the ceremonies SEQUENTIALLY over the relay, spend by spend. For a
  // single-spend tx there is exactly one, so the flow is identical to the previous single ceremony.
  const signSpendsRef = useRef<{ index: number; alpha: Uint8Array }[]>([]) // all real spends, in order
  const signCurRef = useRef(0) // 0-based position of the spend being signed right now
  const signSigsRef = useRef<{ index: number; sig: string }[]>([]) // accumulated per-spend signatures
  const startedSpendsRef = useRef<Set<number>>(new Set()) // beginSpend fires once per position
  // Ceremony watchdog: fires if the vault isn't created in time (a peer never joined, a
  // message was lost) — surfaces an error instead of hanging on "Criando…" forever (§8).
  const ceremonyTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)

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

  // Seat everyone deterministically by sorting their tags — every device computes the same
  // seating with no central assigner (the invite code names the room, not the seats).
  const computeSeating = useCallback(() => {
    // Admission control: cap the roster at n by sorted tag, so a late/extra peer can never
    // shift everyone else's seats (which would misroute round-2 packages). Beyond n, this
    // device is unseated (mySeat = 0) and shows "room full" instead of corrupting the vault.
    const n = configRef.current?.n ?? 2
    const tags = [...rosterRef.current.keys()].sort().slice(0, n)
    seatByTagRef.current = new Map(tags.map((tag, i) => [tag, i + 1]))
    seatTableRef.current = tags.map((tag, i) => ({
      tag,
      encPub: rosterRef.current.get(tag)!,
      id: identifierBytes(i + 1),
    }))
    mySeatRef.current = seatByTagRef.current.get(myTagRef.current) ?? 0
    if (mySeatRef.current === 0) {
      setError(tt('net.err.roomFull'))
    }
  }, [tt])

  const doPart2 = useCallback(async () => {
    const dkg = dkgRef.current!
    dkg.part2()
    part2DoneRef.current = true
    const mySeat = mySeatRef.current
    const count = dkg.round2Count()
    for (let i = 0; i < count; i++) {
      const recipId = dkg.round2Recipient(i)
      const seat = seatTableRef.current.find((s) => bytesEqual(s.id, recipId))
      if (!seat) continue
      const recipSeat = seatByTagRef.current.get(seat.tag)!
      const aad = new TextEncoder().encode(`${mySeat}->${recipSeat}`)
      const sealed = sealTo(seat.encPub, dkg.round2Package(i), aad)
      await send({ type: 'r2', to: recipSeat, box: b64(sealed) })
    }
    addLog(tt('net.log.round2', { count }))
  }, [addLog, send, tt])

  const doPart3 = useCallback(() => {
    const dkg = dkgRef.current!
    dkg.part3()
    part3DoneRef.current = true
    if (ceremonyTimerRef.current) clearTimeout(ceremonyTimerRef.current)
    const vk = hex(dkg.groupVk())
    setGroupVk(vk)
    setPhase('done')
    addLog(tt('net.log.round3'))
    // Register the finished vault with the hosted blind helper (public group key only — no share
    // crosses). Fire-and-forget: `/net` works with or without a helper, so a failure just leaves
    // the vault local-only. Idempotent, so every device registering the same group key is fine.
    if (helperConfigured()) {
      setHostedState('registering')
      // Pass the vault's quorum (t of n) so proposals inherit it (see helper::VaultRegistration).
      const cfg = configRef.current
      void registerVault(vk, `net-${vk.slice(0, 8)}`, cfg?.t ?? 0, cfg?.n ?? 0).then((v) => {
        if (v) {
          setHostedAddress(v.address)
          setHostedState('registered')
        } else {
          setHostedState('failed')
        }
      })
    }
  }, [addLog, tt])

  // Start (or advance to) the ceremony for spend position `k`: reset the per-round state, pick that
  // spend's alpha, generate FRESH nonces (never reused across signatures), and broadcast this
  // device's commitment tagged with `k`. Fires once per position (guarded), on every device.
  const beginSpend = useCallback(
    async (k: number) => {
      if (startedSpendsRef.current.has(k)) return
      startedSpendsRef.current.add(k)
      signCurRef.current = k
      signAlphaRef.current = signSpendsRef.current[k]?.alpha ?? null
      signCommitsRef.current = new Map()
      spSentRef.current = false
      spRef.current = null
      sentS2Ref.current = false
      signSharesSeenRef.current = new Set()
      sigDoneRef.current = false
      coordRef.current = null
      const r1 = participantRound1(signingMaterial().keyPackage)
      myNoncesRef.current = r1.nonces()
      await send({ type: 's1', commit: b64(r1.commitment()), k })
      const n = signSpendsRef.current.length
      addLog(n > 1 ? `~ signing spend ${k + 1}/${n}` : tt('net.log.signCommit'))
    },
    [send, signingMaterial, addLog, tt],
  )

  const applyMsg = useCallback(
    async (msg: RelayMsg): Promise<boolean> => {
      let parsed: Msg
      try {
        parsed = JSON.parse(msg.data) as Msg
      } catch {
        return true // unparseable — consume and ignore
      }
      // A throwing handler (a malformed package from a peer) must NOT poison the fixpoint: if it
      // never marked the message consumed, advance() would re-apply and re-throw it forever. Catch,
      // surface, and consume it (§8: corrupted/missing material stays a clear failure, not a hang).
      try {
      // Architecture B: a helper's raw sign-request carries `kind`, not `type`. Detect it before
      // the Msg dispatch. The coordinator (seat 1) kicks the ceremony over the helper's real PCZT;
      // once the aggregate signature is ready (the `s2` handler below) it is posted back RAW.
      const helperReq = parseSignRequest(msg.data)
      if (helperReq) {
        helperReqRef.current = helperReq
        // The coordinator kicks off the ceremony over the helper's real PCZT. `sreq` carries the
        // sighash + PCZT; each device reads ALL real spends' alphas from that PCZT and signs them one
        // ceremony at a time, so single- and multi-note transactions take the same path.
        if (mySeatRef.current === 1 && !sigDoneRef.current && helperReq.spends.length >= 1) {
          await send({
            type: 'sreq',
            msg: b64(hexBytes(helperReq.sighash)),
            pczt: b64(hexBytes(helperReq.pcztHex)),
          })
        }
        return true
      }
      if (parsed.type === 'config') {
        if (!configRef.current) {
          configRef.current = { n: parsed.n, t: parsed.t }
          setN(parsed.n)
          setT(parsed.t)
        }
        return true
      }
      if (parsed.type === 'hello') {
        rosterRef.current.set(msg.from, unb64(parsed.encPub))
        return true
      }
      if (parsed.type === 'r1') {
        if (!startedDkgRef.current) return false // wait until seated
        const seat = seatByTagRef.current.get(msg.from)
        if (seat === undefined) return false
        if (seat === mySeatRef.current) return true // my own — ignore
        if (r1SeenRef.current.has(seat)) return true
        dkgRef.current!.addRound1(identifierBytes(seat), unb64(parsed.pkg))
        r1SeenRef.current.add(seat)
        addLog(tt('net.log.r1From', { seat }))
        const need = (configRef.current?.n ?? 0) - 1
        if (r1SeenRef.current.size >= need && !part2DoneRef.current) await doPart2()
        return true
      }
      if (parsed.type === 'r2') {
        if (!part2DoneRef.current) return false // can't open/aggregate before my round 2
        if (parsed.to !== mySeatRef.current) return true // addressed to someone else
        const seat = seatByTagRef.current.get(msg.from)
        if (seat === undefined) return false
        if (r2SeenRef.current.has(seat)) return true
        const aad = new TextEncoder().encode(`${seat}->${mySeatRef.current}`)
        let opened: Uint8Array
        try {
          opened = deviceKeyRef.current!.open(unb64(parsed.box), aad)
        } catch {
          addLog(tt('net.log.cantOpen', { seat }))
          return true
        }
        dkgRef.current!.addRound2(identifierBytes(seat), opened)
        r2SeenRef.current.add(seat)
        addLog(tt('net.log.r2From', { seat }))
        const need = (configRef.current?.n ?? 0) - 1
        if (r2SeenRef.current.size >= need && !part3DoneRef.current) doPart3()
        return true
      }

      // ---- rejoin (signing after restore): re-seat by declared seat, not by fresh tags ----
      if (parsed.type === 'rejoin') {
        // A device that reloads rejoins with a FRESH ephemeral tag but the SAME seat. Drop any
        // stale tag for that seat first, so each seat has exactly one presence: the count is
        // distinct SEATS (never > n), and the seat table has no duplicate seats to break signing.
        for (const [tag, seat] of seatByTagRef.current.entries()) {
          if (seat === parsed.seat && tag !== msg.from) seatByTagRef.current.delete(tag)
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

      // ---- signing over the relay (Marco 4): all bytes below are public ----
      if (parsed.type === 'sreq') {
        if (!part3DoneRef.current) return false // no vault yet
        if (!signStartedRef.current) {
          signStartedRef.current = true
          signMsgRef.current = unb64(parsed.msg)
          const pczt = unb64(parsed.pczt)
          // Every device reads ALL real Orchard spends (index + alpha) from the proven PCZT it holds
          // — it signs only what it can independently see. One ceremony per spend, in order.
          signSpendsRef.current = alphasFromPczt(pczt)
          signSigsRef.current = []
          startedSpendsRef.current = new Set()
          // "What am I signing?" — confirm what the tx pays before contributing any signature.
          try {
            const outs = JSON.parse(describeOutputs(pczt)) as {
              address: string | null
              value: number | null
            }[]
            const recip = outs.find((o) => o.address !== null)
            if (recip && recip.address && recip.value != null) {
              setSignWhat({ zec: fmtZec(recip.value), addr: recip.address })
              addLog(`~ ${fmtZec(recip.value)} ZEC -> ${shortId(recip.address)}`)
            }
          } catch {
            /* if the PCZT can't be read, the UI simply shows no preview; the ceremony still runs */
          }
          setSignPhase('signing')
          await beginSpend(0) // the first (and, for a single-spend tx, the only) ceremony
        }
        return true
      }
      if (parsed.type === 's1') {
        if (!signStartedRef.current) return false
        // Spend-tagged: a message for a LATER spend waits (re-applied after we advance); an EARLIER
        // one is stale and dropped. Keeps N sequential ceremonies from crossing over the relay.
        if (parsed.k !== signCurRef.current) return parsed.k > signCurRef.current ? false : true
        const seat = seatByTagRef.current.get(msg.from)
        if (seat === undefined) return false
        signCommitsRef.current.set(seat, unb64(parsed.commit))
        const t = configRef.current?.t ?? 0
        if (mySeatRef.current === 1 && signCommitsRef.current.size >= t && !spSentRef.current) {
          const chosen = [...signCommitsRef.current.keys()].sort((a, b) => a - b).slice(0, t)
          const mat = signingMaterial()
          const coord = new Coordinator(mat.groupVk, mat.pubkeys, signMsgRef.current)
          for (const s of chosen) coord.addCommitment(identifierBytes(s), signCommitsRef.current.get(s)!)
          coord.prepare()
          coordRef.current = coord
          spRef.current = coord.signingPackage()
          spSentRef.current = true
          await send({
            type: 'sp',
            signers: chosen,
            sp: b64(spRef.current),
            msg: b64(signMsgRef.current),
            k: signCurRef.current,
          })
          addLog(tt('net.log.signCoord', { seats: chosen.join(', ') }))
        }
        return true
      }
      if (parsed.type === 'sp') {
        if (!signStartedRef.current) return false
        if (parsed.k !== signCurRef.current) return parsed.k > signCurRef.current ? false : true
        spRef.current = unb64(parsed.sp)
        signMsgRef.current = unb64(parsed.msg)
        if (
          parsed.signers.includes(mySeatRef.current) &&
          !sentS2Ref.current &&
          myNoncesRef.current &&
          signAlphaRef.current
        ) {
          const share = participantRound2WithRandomizer(
            spRef.current,
            myNoncesRef.current,
            signingMaterial().keyPackage,
            signAlphaRef.current, // the current spend's alpha (set by beginSpend)
          )
          sentS2Ref.current = true
          await send({ type: 's2', share: b64(share), k: signCurRef.current })
          addLog(tt('net.log.signShare'))
        }
        return true
      }
      if (parsed.type === 's2') {
        if (!signStartedRef.current) return false
        if (mySeatRef.current !== 1) return true // only the coordinator aggregates
        if (parsed.k !== signCurRef.current) return parsed.k > signCurRef.current ? false : true
        if (!coordRef.current) return false
        const seat = seatByTagRef.current.get(msg.from)
        if (seat === undefined) return false
        if (signSharesSeenRef.current.has(seat)) return true
        coordRef.current.addShare(identifierBytes(seat), unb64(parsed.share))
        signSharesSeenRef.current.add(seat)
        const t = configRef.current?.t ?? 0
        if (signSharesSeenRef.current.size >= t && !sigDoneRef.current && signAlphaRef.current) {
          sigDoneRef.current = true
          const sig = coordRef.current.aggregateWithRandomizer(signAlphaRef.current)
          const ok = coordRef.current.verifyWithRandomizer(signAlphaRef.current, sig)
          // Broadcast this spend's signature tagged with `k`; every device records it and either
          // advances to the next spend or finalizes (the `signed` handler). The Architecture B
          // response for the WHOLE set is posted once, at the last spend.
          await send({ type: 'signed', sig: b64(sig), ok, k: signCurRef.current })
          addLog(tt('net.log.signAggregate'))
        }
        return true
      }
      if (parsed.type === 'signed') {
        if (!signStartedRef.current) return false
        if (parsed.k !== signCurRef.current) return parsed.k > signCurRef.current ? false : true
        const sig = unb64(parsed.sig)
        let ok = parsed.ok
        try {
          if (signAlphaRef.current) {
            // Every device re-checks under ak+alpha (a fresh Coordinator just to verify).
            const mat = signingMaterial()
            ok = new Coordinator(mat.groupVk, mat.pubkeys, signMsgRef.current).verifyWithRandomizer(
              signAlphaRef.current,
              sig,
            )
          }
        } catch {
          /* keep the coordinator's result if local verify throws */
        }
        // Record this spend's signature under its on-chain index (dedup — the fixpoint may retry).
        const spend = signSpendsRef.current[signCurRef.current]
        if (spend && !signSigsRef.current.some((s) => s.index === spend.index)) {
          signSigsRef.current.push({ index: spend.index, sig: bytesToHex(sig) })
        }
        const total = signSpendsRef.current.length
        const isLast = signCurRef.current >= total - 1
        if (!isLast) {
          // More spends to sign: every device advances to the next ceremony (fresh nonces, next alpha).
          setSignPhase('signing')
          await beginSpend(signCurRef.current + 1)
          return true
        }
        // Last spend done: show the result and (Architecture B) hand the FULL set of signatures back
        // to the helper RAW so it can inject every one and broadcast.
        setSignature(hex(sig))
        setSignOk(ok)
        setSignPhase('signed')
        addLog(ok ? tt('net.log.verifyOk') : tt('net.log.verifyFail'))
        const req = helperReqRef.current
        if (req && mySeatRef.current === 1 && signSigsRef.current.length === total) {
          const resp = buildSignResponse(signSigsRef.current)
          await sessionRef.current?.send(resp)
          addLog(`-> ${total} signature(s) handed to the helper`)
          helperReqRef.current = null
        }
        return true
      }
      return true
      } catch {
        addLog(tt('net.log.msgFailed'))
        setError(tt('net.err.stepFailed'))
        return true // consume so the fixpoint never re-throws the same message
      }
    },
    [addLog, doPart2, doPart3, send, tt, signingMaterial, beginSpend],
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
          const cfg = configRef.current
          if (cfg && rosterRef.current.size >= cfg.n && !startedDkgRef.current) {
            computeSeating()
            if (mySeatRef.current > 0) {
              dkgRef.current = new DkgSession(identifierBytes(mySeatRef.current), cfg.n, cfg.t)
              startedDkgRef.current = true
              setPhase('dkg')
              addLog(tt('net.log.seated', { seat: mySeatRef.current, total: cfg.n }))
              await send({ type: 'r1', pkg: b64(dkgRef.current.round1Package()) })
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
      } while (rerunRef.current)
    } finally {
      advancingRef.current = false
      setRosterCount(rosterRef.current.size)
    }
  }, [addLog, applyMsg, computeSeating, send, tt])

  const onMessage = useCallback(
    (m: RelayMsg) => {
      allMsgsRef.current.push(m)
      void advance()
    },
    [advance],
  )

  const begin = useCallback(
    async (asRole: 'create' | 'join', code: string, total: number, threshold: number) => {
      if (startGuardRef.current) return
      startGuardRef.current = true
      try {
        await init(wasmUrl)
        deviceKeyRef.current = new DeviceKey()
        myTagRef.current = ephemeralTag()
        setRoom(code)
        setPhase('roster')
        const sess = new RelaySession(code, myTagRef.current, onMessage, (p) => setPeers(p))
        sessionRef.current = sess
        sess.start()
        ceremonyTimerRef.current = setTimeout(() => {
          if (!part3DoneRef.current) {
            setError(tt('net.err.timeout'))
          }
        }, 90000)
        // The creator declares the group size/threshold; everyone announces their enc key.
        if (asRole === 'create') {
          configRef.current = { n: total, t: threshold }
          await sess.send(JSON.stringify({ type: 'config', n: total, t: threshold } satisfies Msg))
        }
        await sess.send(
          JSON.stringify({ type: 'hello', encPub: b64(deviceKeyRef.current.publicBytes()) } satisfies Msg),
        )
        addLog(tt('net.log.joined'))
        void advance()
      } catch (e) {
        setError(String(e))
        setPhase('error')
      }
    },
    [addLog, advance, onMessage, tt],
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
        await init(wasmUrl)
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
        await sess.send(JSON.stringify({ type: 'rejoin', seat: r.seat } satisfies Msg))
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
      const ok = typeof window === 'undefined' || window.confirm(
        pe(
          'Executar este pagamento aprovado? As duas abas vão assinar e a transação vai para a rede.',
          'Execute this approved payment? Both tabs will sign and the transaction goes to the network.',
        ),
      )
      if (!ok) return
      setPropMsg(pe('Executando: as abas assinam pelo relay…', 'Executing: the tabs sign over the relay…'))
      const r = await executeProposal({
        vault: groupVk,
        proposalId: id,
        relayBase: RELAY_BASE,
        room,
        dryRun: false,
      })
      if (!r) {
        setPropMsg(pe('Falha ao executar (proposta não pronta ou sem assinaturas a tempo).', 'Execute failed (proposal not ready or no signatures in time).'))
        return
      }
      setPropMsg(
        r.txid
          ? `${pe('Transmitido. txid:', 'Broadcast. txid:')} ${r.txid}`
          : pe('Executado.', 'Executed.'),
      )
      void loadProposals()
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
      /* listing failure is non-fatal — just show no saved vaults */
    }
  }, [])

  // Save the completed vault: encrypt this device's share (+ the public material a future signing
  // step needs) under a passphrase and store it. Reads live refs; does not alter ceremony state.
  const doSave = useCallback(async () => {
    if (!storageAvailable()) {
      setSaveErr(L.unavailable)
      return
    }
    if (savePass.length < 8) return
    const dkg = dkgRef.current
    if (!dkg) return
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
      const roster = seatTableRef.current.map((s) => s.tag)
      await saveVault(hex(gvk), { groupKey: gvk, address: '', roster, sealedShare: bundle }, savePass)
      setSaveState('saved')
      setSavePass('')
      await refreshSaved()
    } catch (e) {
      setSaveState('idle')
      setSaveErr(L.saveErr + String(e))
    }
  }, [savePass, L, refreshSaved])

  // Restore a saved vault: unlock with the passphrase, bring the vault identity back into view
  // WITHOUT redoing the DKG. The secret material is held in memory (restoredRef) for a future
  // signing-after-restore step; the live relay/ceremony refs are left untouched.
  // Bring a decrypted vault into the 'restored' phase (no DKG redo). Shared by the passphrase path
  // (doRestore) and the access-gate path (a share already unlocked at /unlock, held in session.ts).
  const applyLoaded = useCallback((v: VaultLoaded) => {
    const bundle = JSON.parse(new TextDecoder().decode(v.sealedShare)) as {
      kp: string
      pubkeys: string
      seat: number
      n: number
      t: number
    }
    restoredRef.current = {
      keyPackage: unb64(bundle.kp),
      pubkeys: unb64(bundle.pubkeys),
      groupVk: v.groupKey,
      seat: bundle.seat,
      n: bundle.n,
      t: bundle.t,
    }
    setGroupVk(hex(v.groupKey))
    setRestoredRoster(v.roster)
    if (bundle.n) setN(bundle.n)
    if (bundle.t) setT(bundle.t)
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
    if (phase !== 'idle') return
    const id = getSelectedVault()
    if (!id) return
    const v = getUnlockedShare(id)
    if (v) applyLoaded(v)
  }, [phase, applyLoaded])

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

  // Load the list of saved vaults once, so the idle screen can offer to restore one.
  useEffect(() => {
    void refreshSaved()
  }, [refreshSaved])

  useEffect(() => {
    return () => {
      sessionRef.current?.stop()
      if (ceremonyTimerRef.current) clearTimeout(ceremonyTimerRef.current)
    }
  }, [])

  // ---- render ----

  if (phase === 'idle' && embedded) {
    // Clean, purpose-built create modal (redesign): device/quorum steppers, Create as the focus,
    // Join as a secondary reveal, no restore clutter. Matches the app's rd-* modal design. The DKG
    // logic (begin/setN/setT) is unchanged.
    return (
      <Shell error={error} embedded>
        <span className="rd-eyebrow">{pe('CRIAR COFRE EM REDE', 'CREATE A NETWORKED VAULT')}</span>
        <h2 className="cv-title">{pe('Novo cofre', 'New vault')}</h2>
        <p className="cv-lead">
          {pe(
            'Dois ou mais aparelhos criam um cofre juntos, por DKG real. Cada um sai com o seu pedaço da chave; a chave inteira nunca é montada.',
            'Two or more devices create one vault together, by a real DKG. Each leaves with its own share; the whole key is never assembled.',
          )}
        </p>

        <div className="cv-controls">
          <div className="cv-field">
            <span className="cv-k">{pe('Dispositivos', 'Devices')}</span>
            <div className="cv-stepper">
              <button type="button" className="cv-step" disabled={n <= 2} aria-label={pe('menos', 'fewer')}
                onClick={() => { const v = n - 1; setN(v); if (t > v) setT(v) }}>−</button>
              <span className="cv-num">{n}</span>
              <button type="button" className="cv-step" disabled={n >= 5} aria-label={pe('mais', 'more')}
                onClick={() => setN(n + 1)}>+</button>
            </div>
          </div>
          <div className="cv-field">
            <span className="cv-k">{pe('Quórum para assinar', 'Signing quorum')}</span>
            <div className="cv-stepper">
              <button type="button" className="cv-step" disabled={t <= 1} aria-label={pe('menos', 'fewer')}
                onClick={() => setT(t - 1)}>−</button>
              <span className="cv-num">{t} <em>{pe('de', 'of')} {n}</em></span>
              <button type="button" className="cv-step" disabled={t >= n} aria-label={pe('mais', 'more')}
                onClick={() => setT(t + 1)}>+</button>
            </div>
          </div>
        </div>

        <button className="rd-enter primary cv-primary"
          onClick={() => { setRole('create'); void begin('create', newRoomCode(), n, t) }}>
          {pe('Gerar convite', 'Generate invite')}
        </button>

        {!showJoin ? (
          <button type="button" className="cv-linkbtn" onClick={() => setShowJoin(true)}>
            {pe('Tenho um convite — entrar', 'Have an invite? Join')}
          </button>
        ) : (
          <div className="cv-join">
            <input className="cv-input" placeholder={pe('Código do convite (ex.: KX7M4PQR)', 'Invite code (e.g. KX7M4PQR)')}
              value={joinCode} onChange={(e) => setJoinCode(e.target.value.toUpperCase().trim())} autoFocus />
            <button className="rd-enter" disabled={joinCode.length < 8}
              onClick={() => { setRole('join'); void begin('join', joinCode, n, t) }}>
              {pe('Entrar com o código', 'Join with the code')}
            </button>
          </div>
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
            <button
              className="net-btn primary"
              onClick={() => { setRole('create'); void begin('create', newRoomCode(), n, t) }}
            >
              {tt('net.idle.generateInvite')}
            </button>
          </div>

          <div className="net-card">
            <h3>{tt('net.idle.joinTitle')}</h3>
            <p>{tt('net.idle.joinDesc')}</p>
            <input
              className="net-input"
              placeholder={tt('net.idle.joinPlaceholder')}
              value={joinCode}
              onChange={(e) => setJoinCode(e.target.value.toUpperCase().trim())}
            />
            <button
              className="net-btn"
              disabled={joinCode.length < 8}
              onClick={() => { setRole('join'); void begin('join', joinCode, n, t) }}
            >
              {tt('net.idle.joinBtn')}
            </button>
          </div>
        </div>

        {savedVaults.length > 0 && (
          <div className="net-card" style={{ marginTop: 16 }}>
            <h3>{L.restoreTitle}</h3>
            {restoreErr && <div className="net-error">{restoreErr}</div>}
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

  // Shared signing controls, used by the just-created vault ('done') and by a restored device that
  // rejoined a signing session ('signsession'). `canStart` gates the button on quorum presence.
  const renderSign = () => (
    <div className="net-sign">
      {signPhase === 'none' && (
        <p className="net-lead" style={{ marginTop: 20 }}>
          {pe(
            'Cofre pronto para assinar. Aguardando um pedido de pagamento do operador pelo relay; quando chegar, cada dispositivo confere o destino e o valor antes de assinar.',
            'Vault ready to sign. Waiting for a payment request from the operator over the relay; when it arrives, each device confirms the destination and amount before signing.',
          )}
        </p>
      )}
      {signWhat && signPhase !== 'none' && (
        <div className="net-what" style={{ marginTop: 16, padding: '10px 14px', border: '1px solid var(--rd-line)', borderRadius: 8 }}>
          <strong>{pe('Você está assinando', 'You are signing')}</strong>: {signWhat.zec} ZEC → <code>{shortId(signWhat.addr)}</code>
          <div style={{ fontSize: '.82rem', opacity: 0.75, marginTop: 4 }}>
            {pe('Cada dispositivo confere o destino e o valor antes de contribuir com a sua parte da assinatura.', 'Each device confirms the destination and amount before contributing its share of the signature.')}
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
              'Assinatura válida sob o alpha da própria transação (o mecanismo de gasto Orchard real), verificada sob ak+alpha. A assinatura agregada volta ao operador pelo relay, que a injeta na PCZT e transmite — nenhum dispositivo transmite sozinho, e o operador nunca vê uma parte da chave.',
              'Valid signature under the transaction’s own alpha (the real Orchard spend mechanism), verified under ak+alpha. The aggregate signature is returned to the operator over the relay, who injects it into the PCZT and broadcasts — no single device broadcasts alone, and the operator never sees a key share.',
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
                        disabled={!room}
                        onClick={() => void execProp(p.id)}
                      >
                        {room
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

  return (
    <Shell error={error} embedded={embedded} onDashboard={groupVk ? openDashboard : undefined}>
      {role === 'create' && phase === 'roster' && (
        <>
          <h1 className="net-h1">{tt('net.invite.title')}</h1>
          <p className="net-lead">{tt('net.invite.lead')}</p>
          <div className="net-code" onClick={() => navigator.clipboard?.writeText(room)} title={tt('net.invite.clickCopy')}>
            {room}
          </div>
        </>
      )}
      {role === 'join' && phase === 'roster' && (
        <>
          <h1 className="net-h1">{tt('net.joining.title')}</h1>
          <div className="net-code">{room}</div>
        </>
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

          {hostedState === 'registered' && (
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
                          setBalance(
                            b
                              ? { spend: zatToZec(b.orchard_spendable_zat), total: zatToZec(b.total_zat) }
                              : null,
                          )
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
              {hostedState === 'failed' && (
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
              <p className="net-tip">{L.saved}</p>
            ) : (
              <>
                {saveErr && <div className="net-error">{saveErr}</div>}
                <input
                  className="net-input"
                  type="password"
                  placeholder={L.savePlaceholder}
                  value={savePass}
                  onChange={(e) => setSavePass(e.target.value)}
                />
                <button
                  className="net-btn"
                  disabled={saveState === 'saving' || savePass.length < 8}
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
