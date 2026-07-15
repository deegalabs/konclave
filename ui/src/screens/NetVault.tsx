import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react'
import init, {
  DkgSession,
  DeviceKey,
  Coordinator,
  sealTo,
  identifierBytes,
  participantRound1,
  participantRound2,
  verifyRedpallas,
} from '../wasm-pkg/konclave_wasm.js'
import wasmUrl from '../wasm-pkg/konclave_wasm_bg.wasm?url'
import { RelaySession, newRoomCode, ephemeralTag, b64, unb64, bytesEqual, type RelayMsg } from '../net'
import { useT, useTr, useI18n } from '../i18n'
import { Letterhead } from '../components'
import {
  saveVault,
  loadVault,
  listVaults,
  deleteVault,
  storageAvailable,
  type VaultPublic,
} from '../storage'
import '../redesign.css'
import '../net.css'

// The konclave.app network, made visible: two (or three) browser contexts create ONE vault by
// a real DKG over the blind relay. Each keeps its own share; the round-2 secret pieces are
// sealed to their recipient, so the relay only ever carries public material or ciphertext.
// This is the "I created / I invited / I entered the code" flow, running for real across tabs.

type Phase = 'idle' | 'roster' | 'dkg' | 'done' | 'error' | 'restored'

// Local, dependency-free labels for the on-device persistence UI (Marco 5). These are ADDITIVE
// to the /net flow, so rather than touch the shared i18n dictionaries we key a small table by the
// active locale. No em dashes in copy.
const PERSIST_LABELS = {
  'pt-BR': {
    saveTitle: 'Guardar neste dispositivo',
    saveHint: 'Cifra a sua parte do cofre com uma frase-senha, para nao perder o cofre ao recarregar a pagina.',
    savePlaceholder: 'Frase-senha (minimo 8 caracteres)',
    saveBtn: 'Guardar cofre',
    saving: 'Guardando...',
    saved: 'Cofre guardado neste dispositivo, cifrado.',
    saveErr: 'Nao foi possivel guardar o cofre: ',
    unavailable: 'Este navegador nao permite guardar o cofre (sem IndexedDB/WebCrypto).',
    restoreTitle: 'Cofres guardados neste dispositivo',
    restorePlaceholder: 'Frase-senha',
    unlockBtn: 'Abrir',
    deleteBtn: 'Apagar',
    unlocking: 'Abrindo...',
    restoreErr: 'Nao foi possivel abrir o cofre: ',
    restoredTitle: 'Cofre restaurado',
    restoredLead: 'A sua parte do cofre foi restaurada deste dispositivo, sem refazer a criacao.',
    restoredNote: 'Para assinar, os membros precisam se reconectar a uma sala de assinatura (proximo passo).',
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
    restoredNote: 'To sign, the members must reconnect to a signing room (the next step).',
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
  // signing (Marco 4): all public material — commitments, signing package, seed, shares, sig.
  | { type: 'sreq'; msg: string }
  | { type: 's1'; commit: string }
  | { type: 'sp'; signers: number[]; sp: string; seed: string; msg: string }
  | { type: 's2'; share: string }
  | { type: 'signed'; sig: string; ok: boolean }

// The demo message the vault signs. A real vault signs a transaction's sig_digest here; this
// is a fixed test string so we can prove the DKG-born shares sign together. No funds, no chain.
const DEMO_MSG = new TextEncoder().encode('konclave: assinatura de teste (nao vai pra rede)')

function hex(bytes: Uint8Array): string {
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('')
}

function Shell({ error, children }: { error: string; children: ReactNode }) {
  const t = useT()
  return (
    <div className="rd net-wrap">
      <Letterhead right={<span className="net-tag">{t('net.tag')}</span>} />
      <div className="demo-frame">
        <span className="demo-eyebrow"><span className="dot" aria-hidden="true" />{t('demo.live')}</span>
        <p className="demo-note">{t('demo.note')}</p>
      </div>
      {error && <div className="net-error">{error}</div>}
      {children}
    </div>
  )
}

export default function NetVault() {
  const tt = useT()
  const ttr = useTr()
  const { locale } = useI18n()
  const L = PERSIST_LABELS[locale]
  const [phase, setPhase] = useState<Phase>('idle')
  const [role, setRole] = useState<'create' | 'join'>('create')
  const [room, setRoom] = useState('')
  const [joinCode, setJoinCode] = useState('')
  const [n, setN] = useState(2)
  const [t, setT] = useState(2)
  const [peers, setPeers] = useState(0)
  const [rosterCount, setRosterCount] = useState(0)
  const [log, setLog] = useState<string[]>([])
  const [groupVk, setGroupVk] = useState('')
  const [error, setError] = useState('')
  const [signPhase, setSignPhase] = useState<'none' | 'signing' | 'signed'>('none')
  const [signature, setSignature] = useState('')
  const [signOk, setSignOk] = useState(false)

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
  // restore so a future signing-after-restore step has the bytes; not yet wired to the relay.
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
  const seedRef = useRef<Uint8Array | null>(null)
  const sentS2Ref = useRef(false)
  const signSharesSeenRef = useRef<Set<number>>(new Set())
  const sigDoneRef = useRef(false)
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
    setGroupVk(hex(dkg.groupVk()))
    setPhase('done')
    addLog(tt('net.log.round3'))
  }, [addLog, tt])

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

      // ---- signing over the relay (Marco 4): all bytes below are public ----
      if (parsed.type === 'sreq') {
        if (!part3DoneRef.current) return false // no vault yet
        if (!signStartedRef.current) {
          signStartedRef.current = true
          signMsgRef.current = unb64(parsed.msg)
          setSignPhase('signing')
          const r1 = participantRound1(dkgRef.current!.keyPackage())
          myNoncesRef.current = r1.nonces()
          await send({ type: 's1', commit: b64(r1.commitment()) })
          addLog(tt('net.log.signCommit'))
        }
        return true
      }
      if (parsed.type === 's1') {
        if (!signStartedRef.current) return false
        const seat = seatByTagRef.current.get(msg.from)
        if (seat === undefined) return false
        signCommitsRef.current.set(seat, unb64(parsed.commit))
        const t = configRef.current?.t ?? 0
        if (mySeatRef.current === 1 && signCommitsRef.current.size >= t && !spSentRef.current) {
          const chosen = [...signCommitsRef.current.keys()].sort((a, b) => a - b).slice(0, t)
          const coord = new Coordinator(
            dkgRef.current!.groupVk(),
            dkgRef.current!.pubkeys(),
            signMsgRef.current,
          )
          for (const s of chosen) coord.addCommitment(identifierBytes(s), signCommitsRef.current.get(s)!)
          coord.prepare()
          coordRef.current = coord
          spRef.current = coord.signingPackage()
          seedRef.current = coord.seed()
          spSentRef.current = true
          await send({
            type: 'sp',
            signers: chosen,
            sp: b64(spRef.current),
            seed: b64(seedRef.current),
            msg: b64(signMsgRef.current),
          })
          addLog(tt('net.log.signCoord', { seats: chosen.join(', ') }))
        }
        return true
      }
      if (parsed.type === 'sp') {
        spRef.current = unb64(parsed.sp)
        seedRef.current = unb64(parsed.seed)
        signMsgRef.current = unb64(parsed.msg)
        if (parsed.signers.includes(mySeatRef.current) && !sentS2Ref.current && myNoncesRef.current) {
          const share = participantRound2(
            spRef.current,
            myNoncesRef.current,
            dkgRef.current!.keyPackage(),
            seedRef.current,
          )
          sentS2Ref.current = true
          await send({ type: 's2', share: b64(share) })
          addLog(tt('net.log.signShare'))
        }
        return true
      }
      if (parsed.type === 's2') {
        if (mySeatRef.current !== 1) return true // only the coordinator aggregates
        if (!coordRef.current) return false
        const seat = seatByTagRef.current.get(msg.from)
        if (seat === undefined) return false
        if (signSharesSeenRef.current.has(seat)) return true
        coordRef.current.addShare(identifierBytes(seat), unb64(parsed.share))
        signSharesSeenRef.current.add(seat)
        const t = configRef.current?.t ?? 0
        if (signSharesSeenRef.current.size >= t && !sigDoneRef.current) {
          sigDoneRef.current = true
          const sig = coordRef.current.aggregate()
          const ok = coordRef.current.verify(sig)
          await send({ type: 'signed', sig: b64(sig), ok })
          addLog(tt('net.log.signAggregate'))
        }
        return true
      }
      if (parsed.type === 'signed') {
        const sig = unb64(parsed.sig)
        let ok = parsed.ok
        try {
          if (spRef.current && seedRef.current) {
            ok = verifyRedpallas(dkgRef.current!.groupVk(), spRef.current, seedRef.current, signMsgRef.current, sig)
          }
        } catch {
          /* keep the coordinator's result if local verify throws */
        }
        setSignature(hex(sig))
        setSignOk(ok)
        setSignPhase('signed')
        addLog(ok ? tt('net.log.verifyOk') : tt('net.log.verifyFail'))
        return true
      }
      return true
      } catch {
        addLog(tt('net.log.msgFailed'))
        setError(tt('net.err.stepFailed'))
        return true // consume so the fixpoint never re-throws the same message
      }
    },
    [addLog, doPart2, doPart3, send, tt],
  )

  const startSign = useCallback(async () => {
    await send({ type: 'sreq', msg: b64(DEMO_MSG) })
  }, [send])

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
  const doRestore = useCallback(
    async (id: string) => {
      const pass = restorePass[id] ?? ''
      if (!pass) return
      setRestoreBusy(id)
      setRestoreErr('')
      try {
        const v = await loadVault(id, pass)
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
        setRestorePass((m) => ({ ...m, [id]: '' }))
        setPhase('restored')
      } catch (e) {
        setRestoreErr(L.restoreErr + String(e))
      } finally {
        setRestoreBusy('')
      }
    },
    [restorePass, L],
  )

  const doDelete = useCallback(
    async (id: string) => {
      try {
        await deleteVault(id)
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

  if (phase === 'idle') {
    return (
      <Shell error={error}>
        <h1 className="net-h1">{tt('net.idle.title')}</h1>
        <p className="net-lead">{ttr('net.idle.lead')}</p>

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
      <Shell error={error}>
        <h1 className="net-h1">{L.restoredTitle}</h1>
        <p className="net-lead">{L.restoredLead}</p>
        <div className="net-vk">{groupVk}</div>
        {restoredRoster.length > 0 && (
          <p className="net-tip">{L.rosterLabel} {restoredRoster.join(', ')}</p>
        )}
        <p className="net-tip">{L.restoredNote}</p>
        <button className="net-btn" style={{ marginTop: 16 }} onClick={() => setPhase('idle')}>
          {L.backBtn}
        </button>
      </Shell>
    )
  }

  const total = configRef.current?.n ?? n
  const quorum = configRef.current?.t ?? t

  return (
    <Shell error={error}>
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
        <span className="net-pill">{tt('net.status.announced', { count: rosterCount, total })}</span>
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

          <div className="net-sign">
            {signPhase === 'none' && (
              <>
                <p className="net-lead" style={{ marginTop: 20 }}>{ttr('net.sign.prompt')}</p>
                <button className="net-btn primary" onClick={() => void startSign()}>
                  {tt('net.sign.btn')}
                </button>
              </>
            )}
            {signPhase === 'signing' && <p className="net-lead" style={{ marginTop: 20 }}>{tt('net.sign.signing')}</p>}
            {signPhase === 'signed' && (
              <>
                <p className="net-lead" style={{ marginTop: 20 }}>
                  {signOk ? tt('net.sign.validPrefix') : tt('net.sign.invalidPrefix')} {ttr('net.sign.signedBody')}
                </p>
                <div className="net-vk">{signature}</div>
              </>
            )}
          </div>
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
