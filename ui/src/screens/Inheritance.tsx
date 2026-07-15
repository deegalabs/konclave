import { useMemo, useState } from 'react'
import { Link } from 'react-router-dom'
import { useI18n } from '../i18n'
import { Letterhead } from '../components'
import '../net.css'
import '../inheritance.css'

// -------------------------------------------------------------------------------------------
// TS mirror of orchestrator/src/inheritance.rs — the pure dead-man's-switch policy engine.
// Reproduced faithfully so this screen is a live, client-side visualization of the SAME logic
// the Rust core runs (no backend call). All times are in seconds, mirroring the unix timestamps
// the Rust functions take. Kept as small pure functions so the mapping stays one-to-one.
// -------------------------------------------------------------------------------------------

/** Where the switch stands right now (mirrors Rust `SwitchState`). */
type SwitchState = 'Active' | 'Pending' | 'Released'

/** The policy attached to a vault to arm the switch (mirrors Rust `InheritancePolicy`). */
type InheritancePolicy = { lapseSecs: number; graceSecs: number; heirAddress: string }

/** Mirrors `InheritancePolicy::new` — rejects nonsensical values so a misconfigured switch can
 *  never arm. Returns the policy or an error KEY (resolved to copy by the caller). */
function newPolicy(
  lapseSecs: number,
  graceSecs: number,
  heirAddress: string,
): { policy: InheritancePolicy } | { errKey: 'errLapse' | 'errGrace' | 'errHeir' } {
  if (!(lapseSecs > 0)) return { errKey: 'errLapse' }
  if (graceSecs < 0) return { errKey: 'errGrace' }
  if (heirAddress.trim() === '') return { errKey: 'errHeir' }
  return { policy: { lapseSecs, graceSecs, heirAddress } }
}

/** Mirrors `evaluate`. A `lastHeartbeat` in the future (clock skew) reads as "just now"
 *  (Active) because the silence is clamped at zero — never a reason to arm early. */
function evaluate(policy: InheritancePolicy, lastHeartbeat: number, now: number): SwitchState {
  const silent = Math.max(0, now - lastHeartbeat) // saturating_sub
  if (silent < policy.lapseSecs) return 'Active'
  if (silent < policy.lapseSecs + policy.graceSecs) return 'Pending'
  return 'Released'
}

/** Mirrors `release_authorized` — only in the Released state; a lapse still in grace is not
 *  enough, so a brief outage never leaks the vault. */
function releaseAuthorized(policy: InheritancePolicy, lastHeartbeat: number, now: number): boolean {
  return evaluate(policy, lastHeartbeat, now) === 'Released'
}

/** Mirrors `secs_until_release` — seconds until the switch would move to Released (0 if already
 *  there). Lets the UI show a live countdown. */
function secsUntilRelease(policy: InheritancePolicy, lastHeartbeat: number, now: number): number {
  const deadline = lastHeartbeat + policy.lapseSecs + policy.graceSecs
  return Math.max(0, deadline - now)
}

const DAY = 86_400

// -------------------------------------------------------------------------------------------
// Local, locale-aware copy (PT-BR + EN). No shared i18n keys touched — same house pattern as
// Receive.tsx / WasmSigner's neighbours.
// -------------------------------------------------------------------------------------------

const TXT = {
  'pt-BR': {
    eyebrow: 'Demo ao vivo do motor de politica',
    title: 'Heranca / interruptor de vida',
    lead: 'O dono envia batimentos de "prova de vida". Se ele ficar em silencio alem da janela configurada, mais um periodo de carencia cancelavel, o quorum passa a estar autorizado a liberar o cofre para o herdeiro. A liberacao e um pagamento comum assinado pelo quorum (reusa o caminho FROST) - a novidade e so a politica: quem decide que o dono se foi, e quando.',
    caption: 'Espelho fiel de orchestrator/src/inheritance.rs, rodando no navegador.',
    cfgTitle: 'Politica',
    lapse: 'Janela de silencio (lapso)',
    grace: 'Carencia (cancelavel)',
    heir: 'Endereco do herdeiro',
    days: 'dias',
    heartbeat: 'Enviar prova de vida (batimento)',
    heartbeatHint: 'Zera o relogio: o silencio volta a zero.',
    simTitle: 'Simular a passagem do tempo',
    simHint: 'Arraste ou pule dias para ver o interruptor mudar sem esperar.',
    elapsed: 'Silencio simulado',
    stateActive: 'Ativo',
    statePending: 'Em carencia',
    stateReleased: 'Liberavel',
    descActive: 'O dono esta presente (batimento recente). Os fundos seguem travados no quorum normal.',
    descPending: 'O dono passou do lapso, mas a carencia ainda corre. Um batimento agora reverte tudo.',
    descReleased: 'Lapso e carencia venceram. O quorum ja pode propor a liberacao ao herdeiro.',
    untilRelease: 'Ate ficar liberavel',
    untilPending: 'Ate entrar em carencia',
    now: 'liberavel agora',
    authorized: 'Liberacao autorizada ao quorum',
    notAuthorized: 'Liberacao ainda nao autorizada',
    zoneLapse: 'lapso',
    zoneGrace: 'carencia',
    zoneReleased: 'liberavel',
    hbMark: 'batimento',
    footnote: 'Nada aqui move fundos. E uma visualizacao da politica; a liberacao real seria uma proposta de pagamento comum, aprovada pelo quorum, assinada por FROST.',
    back: 'Voltar ao inicio',
    errLapse: 'A janela de silencio precisa ser maior que zero.',
    errGrace: 'A carencia nao pode ser negativa.',
    errHeir: 'E preciso um endereco de herdeiro para armar a heranca.',
    unit_d: 'd',
    unit_h: 'h',
    unit_m: 'min',
    unit_s: 's',
  },
  en: {
    eyebrow: 'Live demo of the policy engine',
    title: 'Inheritance / dead-mans-switch',
    lead: 'The owner sends "proof-of-life" heartbeats. If they ever go silent past the configured window, plus a cancellable grace period, the quorum becomes authorized to release the vault to a named heir. The release is an ordinary quorum-signed payment (it reuses the FROST send path) - the novelty is only the policy: who decides the owner is gone, and when.',
    caption: 'A faithful mirror of orchestrator/src/inheritance.rs, running in the browser.',
    cfgTitle: 'Policy',
    lapse: 'Silence window (lapse)',
    grace: 'Grace period (cancellable)',
    heir: 'Heir address',
    days: 'days',
    heartbeat: 'Send proof-of-life (heartbeat)',
    heartbeatHint: 'Resets the clock: the silence returns to zero.',
    simTitle: 'Simulate the passage of time',
    simHint: 'Drag or jump days to watch the switch move without waiting.',
    elapsed: 'Simulated silence',
    stateActive: 'Active',
    statePending: 'In grace',
    stateReleased: 'Releasable',
    descActive: 'The owner is present (a recent heartbeat). Funds stay locked to the normal quorum.',
    descPending: 'The owner is past the lapse, but the grace is still running. A heartbeat now reverts it.',
    descReleased: 'Lapse and grace have both passed. The quorum may now propose the release to the heir.',
    untilRelease: 'Until releasable',
    untilPending: 'Until grace begins',
    now: 'releasable now',
    authorized: 'Release authorized to the quorum',
    notAuthorized: 'Release not yet authorized',
    zoneLapse: 'lapse',
    zoneGrace: 'grace',
    zoneReleased: 'releasable',
    hbMark: 'heartbeat',
    footnote: 'Nothing here moves funds. It is a visualization of the policy; a real release would be an ordinary payment proposal, approved by the quorum, signed by FROST.',
    back: 'Back to start',
    errLapse: 'The lapse window must be greater than zero.',
    errGrace: 'The grace period cannot be negative.',
    errHeir: 'An heir address is required to arm inheritance.',
    unit_d: 'd',
    unit_h: 'h',
    unit_m: 'm',
    unit_s: 's',
  },
} as const

export default function Inheritance() {
  const { locale } = useI18n()
  const T = TXT[locale] ?? TXT.en

  // Policy controls (days for demo legibility; converted to seconds for the pure engine).
  // Defaults mirror the Rust test policy: 30-day lapse, 7-day grace.
  const [lapseDays, setLapseDays] = useState(30)
  const [graceDays, setGraceDays] = useState(7)
  const [heir, setHeir] = useState('u1heir7q3x...demo')
  // The simulation: the heartbeat is at t=0, "now" is `elapsedSecs` of silence after it.
  const [elapsedSecs, setElapsedSecs] = useState(0)

  const lapseSecs = Math.round(lapseDays * DAY)
  const graceSecs = Math.round(graceDays * DAY)

  const built = useMemo(
    () => newPolicy(lapseSecs, graceSecs, heir),
    [lapseSecs, graceSecs, heir],
  )
  const policy = 'policy' in built ? built.policy : null
  const policyErr = 'errKey' in built ? T[built.errKey] : null

  // Evaluate the mirror at (heartbeat=0, now=elapsedSecs).
  const state: SwitchState = policy ? evaluate(policy, 0, elapsedSecs) : 'Active'
  const authorized = policy ? releaseAuthorized(policy, 0, elapsedSecs) : false
  const untilRelease = policy ? secsUntilRelease(policy, 0, elapsedSecs) : 0
  // Also expose the moment grace begins, so the countdown label can be truthful in each phase.
  const untilPending = policy ? Math.max(0, lapseSecs - elapsedSecs) : 0

  const totalSecs = lapseSecs + graceSecs
  // The slider runs a little past the release deadline so a visitor can rest on Released.
  const sliderMaxDays = Math.max(1, lapseDays + graceDays) + 5
  const elapsedDays = elapsedSecs / DAY

  const jump = (days: number) => setElapsedSecs((s) => Math.max(0, Math.min(sliderMaxDays * DAY, s + days * DAY)))
  const heartbeat = () => setElapsedSecs(0)

  const stateClass = state === 'Active' ? 'active' : state === 'Pending' ? 'pending' : 'released'
  const stateLabel = state === 'Active' ? T.stateActive : state === 'Pending' ? T.statePending : T.stateReleased
  const stateDesc = state === 'Active' ? T.descActive : state === 'Pending' ? T.descPending : T.descReleased

  // Timeline geometry (as % of total). Guard against a zero total (only when grace = lapse = 0,
  // which the policy validator already forbids, but keep it safe).
  const lapsePct = totalSecs > 0 ? (lapseSecs / totalSecs) * 100 : 100
  const gracePct = totalSecs > 0 ? (graceSecs / totalSecs) * 100 : 0
  const markerPct = totalSecs > 0 ? Math.min(100, (elapsedSecs / totalSecs) * 100) : 100

  const fmt = (secs: number): string => {
    if (secs <= 0) return `0${T.unit_s}`
    const d = Math.floor(secs / DAY)
    const h = Math.floor((secs % DAY) / 3600)
    const m = Math.floor((secs % 3600) / 60)
    const s = Math.floor(secs % 60)
    if (d > 0) return h > 0 ? `${d}${T.unit_d} ${h}${T.unit_h}` : `${d}${T.unit_d}`
    if (h > 0) return m > 0 ? `${h}${T.unit_h} ${m}${T.unit_m}` : `${h}${T.unit_h}`
    if (m > 0) return `${m}${T.unit_m} ${s}${T.unit_s}`
    return `${s}${T.unit_s}`
  }

  // The headline countdown depends on the phase: while Active we count to grace; once Pending we
  // count to release; once Released it reads "now".
  const countLabel = state === 'Active' ? T.untilPending : T.untilRelease
  const countValue = state === 'Released' ? T.now : state === 'Active' ? fmt(untilPending) : fmt(untilRelease)

  return (
    <div className="rd demo-page">
      <Letterhead />
      <div className="inh-wrap">
        <span className="demo-eyebrow"><span className="dot" aria-hidden="true" />{T.eyebrow}</span>
        <h1 className="inh-title">{T.title}</h1>
        <p className="inh-lead">{T.lead}</p>
        <p className="demo-caption">{T.caption}</p>

        {/* --- State stamp + live countdown ------------------------------------------------ */}
        <div className="inh-state">
          <div className={'inh-stamp ' + stateClass} role="status" aria-live="polite">{stateLabel}</div>
          <div className="inh-count">
            <span className="inh-count-lab">{countLabel}</span>
            <span className="inh-count-val">{countValue}</span>
          </div>
        </div>
        <p className="inh-desc">{stateDesc}</p>
        <div className={'inh-auth ' + (authorized ? 'yes' : 'no')}>
          {authorized ? T.authorized : T.notAuthorized}
        </div>

        {/* --- Timeline -------------------------------------------------------------------- */}
        <div className="inh-timeline" aria-hidden="true">
          <div className="inh-track">
            <span className="inh-zone lapse" style={{ width: `${lapsePct}%` }}>
              <span className="inh-zone-lab">{T.zoneLapse}</span>
            </span>
            <span className="inh-zone grace" style={{ width: `${gracePct}%` }}>
              <span className="inh-zone-lab">{T.zoneGrace}</span>
            </span>
            <span className="inh-zone released">
              <span className="inh-zone-lab">{T.zoneReleased}</span>
            </span>
            <span className={'inh-marker ' + stateClass} style={{ left: `${markerPct}%` }} />
          </div>
          <div className="inh-ticks">
            <span>{T.hbMark} · 0{T.unit_d}</span>
            <span>{lapseDays}{T.unit_d}</span>
            <span>{lapseDays + graceDays}{T.unit_d}</span>
          </div>
        </div>

        {/* --- Simulate time --------------------------------------------------------------- */}
        <div className="inh-sim">
          <div className="inh-sim-head">
            <span className="inh-sec-title">{T.simTitle}</span>
            <span className="inh-elapsed">{T.elapsed}: <b>{fmt(elapsedSecs)}</b></span>
          </div>
          <p className="inh-sim-hint">{T.simHint}</p>
          <input
            className="inh-range"
            type="range"
            min={0}
            max={sliderMaxDays}
            step={0.25}
            value={Math.min(elapsedDays, sliderMaxDays)}
            onChange={(e) => setElapsedSecs(Number(e.target.value) * DAY)}
            aria-label={T.elapsed}
          />
          <div className="inh-jumps">
            <button type="button" className="net-btn" onClick={() => jump(1)}>+1{T.unit_d}</button>
            <button type="button" className="net-btn" onClick={() => jump(7)}>+7{T.unit_d}</button>
            <button type="button" className="net-btn" onClick={() => jump(30)}>+30{T.unit_d}</button>
            <button type="button" className="net-btn primary" onClick={heartbeat}>{T.heartbeat}</button>
          </div>
          <p className="inh-sim-hint">{T.heartbeatHint}</p>
        </div>

        {/* --- Policy controls ------------------------------------------------------------- */}
        <div className="inh-cfg">
          <span className="inh-sec-title">{T.cfgTitle}</span>
          <div className="inh-fields">
            <label className="inh-field">
              <span className="inh-flab">{T.lapse}</span>
              <span className="inh-num">
                <input
                  className="net-input inh-inp"
                  type="number"
                  min={1}
                  value={lapseDays}
                  onChange={(e) => setLapseDays(Math.max(0, Number(e.target.value)))}
                />
                <span className="inh-unit">{T.days}</span>
              </span>
            </label>
            <label className="inh-field">
              <span className="inh-flab">{T.grace}</span>
              <span className="inh-num">
                <input
                  className="net-input inh-inp"
                  type="number"
                  min={0}
                  value={graceDays}
                  onChange={(e) => setGraceDays(Math.max(0, Number(e.target.value)))}
                />
                <span className="inh-unit">{T.days}</span>
              </span>
            </label>
          </div>
          <label className="inh-field">
            <span className="inh-flab">{T.heir}</span>
            <input
              className="net-input inh-heir"
              type="text"
              value={heir}
              spellCheck={false}
              onChange={(e) => setHeir(e.target.value)}
            />
          </label>
          {policyErr && <div className="net-error" role="alert">{policyErr}</div>}
        </div>

        <p className="inh-foot">{T.footnote}</p>
        <div className="demo-back"><Link className="net-back" to="/intro">{T.back}</Link></div>
      </div>
    </div>
  )
}
