import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react'
import { Link } from 'react-router-dom'
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
import '../redesign.css'
import '../net.css'

// The konclave.app network, made visible: two (or three) browser contexts create ONE vault by
// a real DKG over the blind relay. Each keeps its own share; the round-2 secret pieces are
// sealed to their recipient, so the relay only ever carries public material or ciphertext.
// This is the "I created / I invited / I entered the code" flow, running for real across tabs.

type Phase = 'idle' | 'roster' | 'dkg' | 'done' | 'error'

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
  return (
    <div className="rd net-wrap">
      <div className="net-top">
        <Link to="/intro" className="net-back">← Konclave</Link>
        <span className="net-tag">rede · relay cego</span>
      </div>
      {error && <div className="net-error">{error}</div>}
      {children}
    </div>
  )
}

export default function NetVault() {
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

  const addLog = useCallback((line: string) => setLog((l) => [...l, line]), [])

  const send = useCallback(async (m: Msg) => {
    // A dropped relay POST would silently deadlock the ceremony. Retry a few times, and if the
    // relay is truly unreachable, surface it instead of hanging forever (§8: message lost / relay down).
    const body = JSON.stringify(m)
    for (let attempt = 0; attempt < 3; attempt++) {
      if (await sessionRef.current?.send(body)) return
      await new Promise((r) => setTimeout(r, 400))
    }
    setError('Não consegui falar com o relay (a rede caiu). Recarregue as duas abas e refaça.')
  }, [])

  // Seat everyone deterministically by sorting their tags — every device computes the same
  // seating with no central assigner (the invite code names the room, not the seats).
  const computeSeating = useCallback(() => {
    const tags = [...rosterRef.current.keys()].sort()
    seatByTagRef.current = new Map(tags.map((tag, i) => [tag, i + 1]))
    seatTableRef.current = tags.map((tag, i) => ({
      tag,
      encPub: rosterRef.current.get(tag)!,
      id: identifierBytes(i + 1),
    }))
    mySeatRef.current = seatByTagRef.current.get(myTagRef.current) ?? 0
  }, [])

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
    addLog(`round 2: enviei ${count} pacote(s) secreto(s), cada um lacrado ao destinatário`)
  }, [addLog, send])

  const doPart3 = useCallback(() => {
    const dkg = dkgRef.current!
    dkg.part3()
    part3DoneRef.current = true
    setGroupVk(hex(dkg.groupVk()))
    setPhase('done')
    addLog('round 3: combinei tudo — meu pedaço da chave ficou aqui, o cofre nasceu')
  }, [addLog])

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
        addLog(`recebi o round 1 do assento ${seat}`)
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
          addLog(`aviso: não consegui abrir o pacote do assento ${seat}`)
          return true
        }
        dkgRef.current!.addRound2(identifierBytes(seat), opened)
        r2SeenRef.current.add(seat)
        addLog(`recebi e abri o pacote secreto do assento ${seat}`)
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
          addLog('assinatura: enviei meu compromisso (round 1)')
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
          addLog(`coordenei o pacote de assinatura (assentos ${chosen.join(', ')})`)
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
          addLog('assinatura: assinei com o meu pedaço (round 2)')
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
          addLog('coordenei a agregação: a assinatura foi montada')
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
        addLog(ok ? 'conferi a assinatura no meu aparelho: VÁLIDA' : 'a assinatura não validou aqui')
        return true
      }
      return true
      } catch {
        addLog('aviso: uma mensagem da cerimônia falhou e foi ignorada')
        setError('Uma etapa da cerimônia falhou. Se as abas travarem, recarregue e refaça.')
        return true // consume so the fixpoint never re-throws the same message
      }
    },
    [addLog, doPart2, doPart3, send],
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
              addLog(`sou o assento ${mySeatRef.current} de ${cfg.n} — round 1 enviado`)
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
  }, [addLog, applyMsg, computeSeating, send])

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
        // The creator declares the group size/threshold; everyone announces their enc key.
        if (asRole === 'create') {
          configRef.current = { n: total, t: threshold }
          await sess.send(JSON.stringify({ type: 'config', n: total, t: threshold } satisfies Msg))
        }
        await sess.send(
          JSON.stringify({ type: 'hello', encPub: b64(deviceKeyRef.current.publicBytes()) } satisfies Msg),
        )
        addLog('entrei na sala e anunciei minha chave de cifra')
        void advance()
      } catch (e) {
        setError(String(e))
        setPhase('error')
      }
    },
    [addLog, advance, onMessage],
  )

  useEffect(() => {
    return () => sessionRef.current?.stop()
  }, [])

  // ---- render ----

  if (phase === 'idle') {
    return (
      <Shell error={error}>
        <h1 className="net-h1">Criar um cofre em rede</h1>
        <p className="net-lead">
          Duas ou mais abas (ou aparelhos) criam <b>um</b> cofre juntas, por um DKG de verdade pelo
          relay cego. Cada uma sai com o seu pedaço da chave. A chave inteira nunca é montada, e o
          relay só vê material público ou já cifrado.
        </p>

        <div className="net-cards">
          <div className="net-card">
            <h3>Criar</h3>
            <p>Você abre o cofre e gera um código de convite.</p>
            <label className="net-row">
              Dispositivos
              <select value={n} onChange={(e) => { const v = Number(e.target.value); setN(v); if (t > v) setT(v) }}>
                <option value={2}>2</option>
                <option value={3}>3</option>
              </select>
            </label>
            <label className="net-row">
              Quórum
              <select value={t} onChange={(e) => setT(Number(e.target.value))}>
                {Array.from({ length: n }, (_, i) => i + 1).map((v) => (
                  <option key={v} value={v}>{v} de {n}</option>
                ))}
              </select>
            </label>
            <button
              className="net-btn primary"
              onClick={() => { setRole('create'); void begin('create', newRoomCode(), n, t) }}
            >
              Gerar convite
            </button>
          </div>

          <div className="net-card">
            <h3>Entrar</h3>
            <p>Você recebeu um código. Cole aqui, no seu aparelho.</p>
            <input
              className="net-input"
              placeholder="ex.: KX7M4PQR"
              value={joinCode}
              onChange={(e) => setJoinCode(e.target.value.toUpperCase().trim())}
            />
            <button
              className="net-btn"
              disabled={joinCode.length < 8}
              onClick={() => { setRole('join'); void begin('join', joinCode, n, t) }}
            >
              Entrar com o código
            </button>
          </div>
        </div>
        <p className="net-tip">
          Para testar agora: clique em <b>Gerar convite</b>, copie o código, abra esta mesma página em
          outra aba e cole em <b>Entrar</b>. As duas abas farão o cofre juntas.
        </p>
      </Shell>
    )
  }

  const total = configRef.current?.n ?? n
  const quorum = configRef.current?.t ?? t

  return (
    <Shell error={error}>
      {role === 'create' && phase === 'roster' && (
        <>
          <h1 className="net-h1">Convite gerado</h1>
          <p className="net-lead">Passe este código para os outros. Eles entram por ele, no aparelho deles.</p>
          <div className="net-code" onClick={() => navigator.clipboard?.writeText(room)} title="clique para copiar">
            {room}
          </div>
        </>
      )}
      {role === 'join' && phase === 'roster' && (
        <>
          <h1 className="net-h1">Entrando no cofre…</h1>
          <div className="net-code">{room}</div>
        </>
      )}
      {phase === 'dkg' && <h1 className="net-h1">Criando o cofre em rede…</h1>}
      {phase === 'done' && <h1 className="net-h1">Cofre criado 🔐</h1>}

      <div className="net-status">
        <span className="net-pill">{peers} conectado(s)</span>
        <span className="net-pill">{rosterCount} de {total} anunciados</span>
        <span className="net-pill">quórum {quorum} de {total}</span>
      </div>

      {phase === 'roster' && rosterCount < total && (
        <p className="net-lead">Esperando {total - rosterCount} aparelho(s) entrar(em) na sala…</p>
      )}

      {phase === 'done' && (
        <div className="net-done">
          <p className="net-lead">
            Identidade do cofre (a chave pública do grupo). <b>As duas abas mostram exatamente este
            valor</b> — prova de que criaram o mesmo cofre, cada uma guardando só o seu pedaço, sem o
            relay nunca ter visto uma parte da chave.
          </p>
          <div className="net-vk">{groupVk}</div>
          <p className="net-tip">Confira: a outra aba tem a mesma linha. O DKG rodou pela rede, o relay ficou cego.</p>

          <div className="net-sign">
            {signPhase === 'none' && (
              <>
                <p className="net-lead" style={{ marginTop: 20 }}>
                  Agora o cofre pode <b>assinar</b>. Clique abaixo para o cofre autorizar um pagamento
                  de teste: cada aba assina com o seu pedaço, e a assinatura se monta na rede.
                </p>
                <button className="net-btn primary" onClick={() => void startSign()}>
                  Assinar um pagamento de teste
                </button>
              </>
            )}
            {signPhase === 'signing' && <p className="net-lead" style={{ marginTop: 20 }}>Assinando entre os aparelhos…</p>}
            {signPhase === 'signed' && (
              <>
                <p className="net-lead" style={{ marginTop: 20 }}>
                  {signOk ? 'Assinatura válida ✓.' : 'A assinatura não validou.'} O cofre autorizou o
                  pagamento de teste, cada aba assinando com o seu pedaço, sem a chave inteira nunca
                  ser montada. <b>É uma assinatura de teste: não vai pra rede, não move fundos.</b>
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
