import { useState } from 'react'
import { Link } from 'react-router-dom'
import init, {
  TestVault,
  RecoveryHelper,
  RecoveryCombiner,
  participantRound1,
  participantRound2,
  Coordinator,
} from '../wasm-pkg/konclave_wasm.js'
import wasmUrl from '../wasm-pkg/konclave_wasm_bg.wasm?url'
import { useI18n } from '../i18n'
import { Letterhead } from '../components'
import '../redesign.css'
import '../net.css'
import '../recovery.css'

// konclave.app proof: social recovery (the Repairable Threshold Scheme) run entirely in the
// browser. A member loses their device; a quorum of the OTHER members rebuilds that member's
// share from public group data plus their own shares. The group key is never touched, no single
// helper ever holds the lost share, and the rebuilt share is byte-identical to the one that was
// lost. Same live-demo surface as /signer: honest crypto, no server, no secret leaves the tab.

const TXT = {
  'pt-BR': {
    live: 'Demo ao vivo',
    title: 'Recuperação social de um membro',
    caption: 'RTS (Repairable Threshold Scheme) · redpallas · in-browser',
    lead: 'Um membro perdeu o dispositivo e a parte dele. Um quórum dos outros membros reconstrói essa parte, sem nunca remontar a chave do grupo e sem que nenhum ajudante veja a parte perdida.',
    note: 'Prova real, no seu navegador. As partes que assinam ficam locais; só material de recuperação público cruza entre os ajudantes. A chave do grupo permanece intocada.',
    btn: 'Rodar recuperação',
    running: 'Recuperando…',
    back: 'Voltar',
    steps: [
      'Cofre 2-de-3 de demonstração criado (dealer confiável no lugar das partes já destravadas).',
      'O membro 3 perdeu o dispositivo. A parte dele desapareceu.',
      '2 ajudantes calcularam os deltas por ajudante (rodada 1).',
      'Ajudantes trocaram os deltas; cada um somou os seus em um sigma (rodada 2).',
      'O dispositivo em recuperação combinou os sigmas na parte reparada (rodada 3).',
      'Verificado: a parte reparada é idêntica byte a byte à perdida e bate com a parte pública do grupo.',
      'Assinou um 2-de-3 com {ajudante 1, membro 3 reparado}: a assinatura confere.',
    ],
    rec: {
      lost: 'Membro perdido (id)',
      group: 'Chave do grupo (intocada)',
      repaired: 'Parte reparada (impressão)',
      identical: 'Idêntica byte a byte',
      yes: 'sim',
      no: 'não',
    },
    ok: (ms: number) =>
      `Parte reconstruída e conferida em ${ms} ms. A chave do grupo nunca foi remontada; a parte reparada assina um quórum válido.`,
    fail: 'A recuperação não conferiu: a parte reparada não bate com o grupo.',
    error: (m: string) => `Falha na recuperação: ${m}`,
  },
  en: {
    live: 'Live demo',
    title: 'Social recovery of a member',
    caption: 'RTS (Repairable Threshold Scheme) · redpallas · in-browser',
    lead: 'A member lost their device and their share. A quorum of the other members rebuilds that share, never reassembling the group key and never letting any single helper see the lost share.',
    note: 'A real proof, in your browser. The signing shares stay local; only public recovery material crosses between helpers. The group key stays untouched.',
    btn: 'Run recovery',
    running: 'Recovering…',
    back: 'Back',
    steps: [
      'Built a demo 2-of-3 vault (trusted-dealer standing in for the unlocked shares).',
      'Member 3 lost their device. Its share is gone.',
      '2 helpers each computed per-helper deltas (round 1).',
      'Helpers exchanged deltas; each summed its own into a sigma (round 2).',
      'The recovering device combined the sigmas into the repaired share (round 3).',
      'Checked: the repaired share is byte-identical to the lost one and matches the group’s public share.',
      'Signed a 2-of-3 with {helper 1, repaired member 3}: the signature verifies.',
    ],
    rec: {
      lost: 'Lost member (id)',
      group: 'Group key (untouched)',
      repaired: 'Repaired share (fingerprint)',
      identical: 'Byte-identical',
      yes: 'yes',
      no: 'no',
    },
    ok: (ms: number) =>
      `Share rebuilt and checked in ${ms} ms. The group key was never reassembled; the repaired share signs a verifying quorum.`,
    fail: 'Recovery did not check out: the repaired share does not match the group.',
    error: (m: string) => `Recovery failed: ${m}`,
  },
} as const

type Records = {
  lost: string
  group: string
  repaired: string
  identical: boolean
}
type Outcome = { ok: boolean; msg: string; records: Records | null } | null

const hex = (u: Uint8Array) => Array.from(u, (b) => b.toString(16).padStart(2, '0')).join('')
const short = (h: string) => (h.length > 20 ? `${h.slice(0, 12)}…${h.slice(-8)}` : h)
const bytesEq = (a: Uint8Array, b: Uint8Array) =>
  a.length === b.length && a.every((x, i) => x === b[i])

export default function Recovery() {
  const { locale } = useI18n()
  const T = TXT[locale] ?? TXT.en
  const [outcome, setOutcome] = useState<Outcome>(null)
  const [done, setDone] = useState(0) // how many narrative steps to show
  const [busy, setBusy] = useState(false)

  async function run() {
    setBusy(true)
    setOutcome(null)
    setDone(0)
    try {
      const t0 = performance.now()
      await init(wasmUrl)

      // A demo 2-of-3 vault. The key packages stand in for each device's unlocked share.
      const v = new TestVault()
      setDone(1)

      // Member index 2 lost their device. A quorum of the OTHER two members will rebuild it.
      const lostIndex = 2
      const lostId = v.id(lostIndex)
      const helperIdx = [0, 1]
      setDone(2)

      // Round 1: each helper registers the helper set (itself included) and computes one delta
      // per helper. Only public recovery material is produced; the helper's share stays local.
      const seats = helperIdx.map((idx) => {
        const idBytes = v.id(idx)
        const h = new RecoveryHelper(v.key_package(idx), lostId)
        for (const j of helperIdx) h.addHelper(v.id(j))
        return { idBytes, idHex: hex(idBytes), h }
      })
      for (const s of seats) s.h.computeDeltas()
      setDone(3)

      // Exchange deltas: route each delta to its recipient helper, then each helper sums the
      // deltas it received into a sigma (round 2). No helper ever holds the lost share.
      for (const s of seats) {
        const n = s.h.deltaCount()
        for (let i = 0; i < n; i++) {
          const recipHex = hex(s.h.deltaRecipient(i))
          const target = seats.find((x) => x.idHex === recipHex)
          if (target) target.h.addIncomingDelta(s.h.delta(i))
        }
      }
      setDone(4)

      // Round 3: the recovering device combines the sigmas into the repaired KeyPackage. The
      // combiner validates the result against the group's public share and throws on a mismatch.
      const combiner = new RecoveryCombiner(lostId, v.pubkeys())
      for (const s of seats) combiner.addSigma(s.h.sigma())
      const repairedKp = combiner.keyPackage()
      setDone(5)

      // The repaired share should be exactly the one that was lost: byte-for-byte identical.
      const identical = bytesEq(repairedKp, v.key_package(lostIndex))
      setDone(6)

      // Final proof: the repaired share signs. Run a 2-of-3 with {helper 0, repaired member}.
      const message = new TextEncoder().encode('konclave: a repaired share signs again (demo)')
      const s0 = { id: v.id(0), kp: v.key_package(0) }
      const sr = { id: lostId, kp: repairedKp }
      const r0 = participantRound1(s0.kp)
      const rr = participantRound1(sr.kp)
      const coord = new Coordinator(v.groupVk(), v.pubkeys(), message)
      coord.addCommitment(s0.id, r0.commitment())
      coord.addCommitment(sr.id, rr.commitment())
      coord.prepare()
      const sp = coord.signingPackage()
      const seed = coord.seed()
      coord.addShare(s0.id, participantRound2(sp, r0.nonces(), s0.kp, seed))
      coord.addShare(sr.id, participantRound2(sp, rr.nonces(), sr.kp, seed))
      const sig = coord.aggregate()
      const verified = coord.verify(sig)
      setDone(7)

      const ms = Math.round(performance.now() - t0)
      const records: Records = {
        lost: short(hex(lostId)),
        group: short(hex(v.groupVk())),
        repaired: short(hex(repairedKp)),
        identical,
      }
      const ok = verified && identical
      setOutcome({ ok, msg: ok ? T.ok(ms) : T.fail, records })
    } catch (e) {
      setOutcome({ ok: false, msg: T.error(e instanceof Error ? e.message : String(e)), records: null })
    }
    setBusy(false)
  }

  return (
    <div className="rd rec">
      <Letterhead />
      <div className="rec-main">
        <div className="rec-col">
          <span className="demo-eyebrow">
            <span className="dot" aria-hidden="true" />
            {T.live}
          </span>
          <h1 className="demo-title">{T.title}</h1>
          <p className="demo-caption">{T.caption}</p>
          <p className="demo-lead">{T.lead}</p>
          <p className="demo-note">{T.note}</p>

          <button className="btn ok" style={{ marginTop: 22 }} onClick={() => void run()} disabled={busy}>
            {busy ? T.running : T.btn}
          </button>

          {done > 0 && (
            <ol className="rec-steps" aria-live="polite">
              {T.steps.slice(0, done).map((s, i) => (
                <li key={i} className="rec-step">
                  <span className="rec-step-n" aria-hidden="true">
                    {i + 1}
                  </span>
                  <span className="rec-step-text">{s}</span>
                </li>
              ))}
            </ol>
          )}

          {outcome?.records && (
            <div className="rec-records">
              <div className="rec-record">
                <span className="rec-record-k">{T.rec.lost}</span>
                <span className="rec-record-v">{outcome.records.lost}</span>
              </div>
              <div className="rec-record">
                <span className="rec-record-k">{T.rec.group}</span>
                <span className="rec-record-v">{outcome.records.group}</span>
              </div>
              <div className="rec-record">
                <span className="rec-record-k">{T.rec.repaired}</span>
                <span className="rec-record-v">{outcome.records.repaired}</span>
              </div>
              <div className="rec-record">
                <span className="rec-record-k">{T.rec.identical}</span>
                <span className="rec-record-v">
                  {outcome.records.identical ? `✓ ${T.rec.yes}` : T.rec.no}
                </span>
              </div>
            </div>
          )}

          {outcome && (
            <div className={'demo-result ' + (outcome.ok ? 'ok' : 'bad')}>
              {outcome.ok ? '✓ ' : '✗ '}
              {outcome.msg}
            </div>
          )}

          <div className="demo-back">
            <Link className="rd-link" to="/intro">
              {T.back}
            </Link>
          </div>
        </div>
      </div>
    </div>
  )
}
