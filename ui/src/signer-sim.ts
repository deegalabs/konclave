// Test harness for who sends (#626), from the review that found its counterexamples. Drives N real
// BackgroundSessions over one in-memory room, each device with its own clock, and records, for every
// signature in the room, whom each open session named. A device may close its session and open a new
// one (new tag), as the signing panel does, or reload (which also loses its own signing window).
// Never imported by the app.
import { BackgroundSession } from './background-session'
import { ARM_TTL_MS } from './signing-gate'
import { endSend, newSendAttempt, takeSend, type SendAttempt } from './send-attempt'

export type Mat = () => { keyPackage: Uint8Array; groupVk: Uint8Array; pubkeys: Uint8Array }
/** open: start a session (reads the room back). close: the panel closes, the session stops; the
 *  page keeps what the panel holds (its send memory, its result). reload: close + open, and the page
 *  forgets all of it, the device's own window included. arm: the owner signs. unarm: the send this
 *  device fired ended with nothing sent, as the panel's `fail()` handles it: the send memory is
 *  released (`endSend`), the member clicks "Try again", the device's own window is cleared, and only
 *  with the panel open is the signature withdrawn from the room. */
export type Ev = { t: number; dev: number; kind: 'arm' | 'open' | 'unarm' | 'close' | 'reload' }
export interface Naming { seq: number; fromDev: number; fromTag: string; at: number; tRelay: number; named: Record<string, string | null> }
export interface SimOut {
  /** Every time a device's session named itself; `fired` is whether its panel then sent. */
  self: Array<{ dev: number; tag: string; at: number; tRelay: number; seq: number; fired: boolean }>
  namings: Naming[]
  unarmSeqs: number[]
  /** tag -> [opened, closed) relay ms */
  life: Record<string, [number, number]>
  log: string[]
  /** Signings where the screen's "would my signature send?" disagreed with what it did. */
  would: string[]
}

const T0 = 1_700_000_000_000

/** What a named sender does next: returns follow-up events (decided by the caller's policy). */
export type OnSelf = (dev: number, tRelay: number) => Ev[]

export async function sim(T: number, N: number, skews: number[], openAt: number[], evs: Ev[], mats: Mat[], onSelf?: OnSelf): Promise<SimOut> {
  let NOW = T0
  const rel = () => NOW - T0
  const bus: Array<{ seq: number; from: string; data: string; tRelay: number }> = []
  let seq = 0
  type D = { tag: string; s: BackgroundSession; delivered: number; lastNamed: string | null; touched: boolean }
  const devs: Array<D | null> = Array.from({ length: N }, () => null)
  const tagOwner = new Map<string, number>()
  const out: SimOut = { self: [], namings: [], unarmSeqs: [], life: {}, log: [], would: [] }
  const byseq = new Map<number, Naming>()
  const ownArmedAt: Array<number | null> = Array.from({ length: N }, () => null)
  // What the page holds across closing and reopening the panel: the send memory, and whether a send's
  // run or result is on screen (no Sign button then).
  const attempt: SendAttempt[] = Array.from({ length: N }, () => newSendAttempt())
  const shown: boolean[] = Array.from({ length: N }, () => false)
  let gen = 0
  let queue: Ev[] = []
  const make = (i: number): D => {
    const tag = `d${i + 1}.${gen++}`
    tagOwner.set(tag, i)
    out.life[tag] = [rel(), Infinity]
    const d: D = { tag, s: null as unknown as BackgroundSession, delivered: 0, lastNamed: null, touched: false }
    d.s = new BackgroundSession({
      myTag: tag,
      mySeat: i + 1,
      decideApproval: () => 'match',
      signingMaterial: mats[i]!,
      threshold: () => T,
      send: async (data) => { bus.push({ seq: seq++, from: tag, data, tRelay: rel() }); return true },
      gate: () => true,
      now: () => NOW + (skews[i] ?? 0),
      onArmed: (_seats, trig) => { d.lastNamed = trig; d.touched = true },
    })
    d.s.setProposal('p1') // the panel is open on this payment before the room is read (useBackgroundSigner)
    return d
  }
  const deliver = async (i: number) => {
    const d = devs[i]
    if (!d) return
    const hist = d.delivered === 0
    while (d.delivered < bus.length) {
      const m = bus[d.delivered++]!
      d.touched = false
      d.lastNamed = null
      await d.s.onMessage(m.from, m.data, hist)
      const p = JSON.parse(m.data) as { type?: string; at?: number }
      if (p.type === 'unarmed' && !out.unarmSeqs.includes(m.seq)) out.unarmSeqs.push(m.seq)
      if (p.type !== 'armed') continue
      let n = byseq.get(m.seq)
      if (!n) {
        n = { seq: m.seq, fromDev: tagOwner.get(m.from)!, fromTag: m.from, at: p.at!, tRelay: m.tRelay, named: {} }
        byseq.set(m.seq, n)
        out.namings.push(n)
      }
      n.named[d.tag] = d.touched ? d.lastNamed : null
      if (d.touched && d.lastNamed === d.tag) {
        // The panel's effect: fire once per attempt (send-attempt.ts).
        const fired = takeSend(attempt[i]!, 'p1')
        out.self.push({ dev: i, tag: d.tag, at: p.at!, tRelay: m.tRelay, seq: m.seq, fired })
        out.log.push(`${(rel() / 60000).toFixed(3)} ${d.tag} named itself (seq ${m.seq})${fired ? '' : ' and did not send'}`)
        if (!fired) continue
        shown[i] = true
        for (const e of onSelf?.(i, m.tRelay) ?? []) queue.push(e)
        queue.sort((a, b) => a.t - b.t)
      }
    }
  }
  queue = [...evs].sort((a, b) => a.t - b.t)
  for (let i = 0; i < N; i++) if ((openAt[i] ?? 0) <= 0) devs[i] = make(i)
  while (queue.length) {
    const e = queue.shift()!
    NOW = T0 + e.t
    const own = NOW + (skews[e.dev] ?? 0)
    const d = devs[e.dev]
    if (e.kind === 'open') {
      if (d) continue
      devs[e.dev] = make(e.dev)
      out.log.push(`${(e.t / 60000).toFixed(3)} d${e.dev + 1} opens as ${devs[e.dev]!.tag}`)
    } else if (e.kind === 'close' || e.kind === 'reload') {
      if (!d) continue
      out.life[d.tag]![1] = rel()
      devs[e.dev] = null
      out.log.push(`${(e.t / 60000).toFixed(3)} ${d.tag} closes`)
      if (e.kind === 'reload') {
        ownArmedAt[e.dev] = null // a reload loses the device's own window (VaultSigner state)
        attempt[e.dev] = newSendAttempt()
        shown[e.dev] = false
        devs[e.dev] = make(e.dev)
        out.log.push(`${(e.t / 60000).toFixed(3)} d${e.dev + 1} reloads as ${devs[e.dev]!.tag}`)
      }
    } else if (e.kind === 'arm') {
      if (!d) continue
      // A device that sends has a result or a run on screen: no Sign button until it withdraws.
      if (shown[e.dev]) continue
      // No Sign button while its own window is open (VaultSigner, own clock).
      const a = ownArmedAt[e.dev]
      if (a != null && own - a <= ARM_TTL_MS) continue
      ownArmedAt[e.dev] = own
      out.log.push(`${(e.t / 60000).toFixed(3)} ${d.tag} signs (at ${((own - T0) / 60000).toFixed(3)})`)
      // What the screen would say ("Sign and send" or not), asked just before the signature, must be
      // what the signature then does on this device.
      const would = d.s.wouldComplete(own)
      const before = out.self.length
      await d.s.arm('p1', own)
      NOW += 100
      for (let i = 0; i < N; i++) await deliver(i)
      const did = out.self.slice(before).some((x) => x.tag === d.tag)
      if (would !== did) out.would.push(`${d.tag} at ${(e.t / 60000).toFixed(3)}: would ${would}, did ${did}`)
      continue
    } else {
      // fail(): the panel stays mounted while closed, so this runs either way.
      endSend(attempt[e.dev]!, 'p1', 'not-sent')
      shown[e.dev] = false // the member reads the failure and clicks "Try again"
      // unarmActive clears this device's own window either way: fail() calls the one from the render
      // that started the send, where the payment was still open.
      ownArmedAt[e.dev] = null
      if (!d) {
        // With the panel closed there is no session, so no withdrawal reaches the room.
        out.log.push(`${(e.t / 60000).toFixed(3)} d${e.dev + 1}'s send fails with the panel closed`)
        continue
      }
      out.log.push(`${(e.t / 60000).toFixed(3)} ${d.tag} withdraws`)
      await d.s.unarm('p1')
    }
    NOW += 100
    for (let i = 0; i < N; i++) await deliver(i)
  }
  return out
}

/** BLOCKED: a device's session named it the sender and its panel did not send, because a send of
 *          this payment had already run on the page: nobody sends while every screen counts a
 *          full quorum. A device only signs with no send of its own running or shown, so every
 *          naming must fire.
 *  DOUBLE: two self-namings whose completing signatures are within the window (by `at`), with no
 *          withdrawal between them in the room.
 *  STALL:  a session that read a signature LIVE named its signer, the signer's session was open
 *          and named nobody.
 *  DIFFER: two LIVE namings of different tags within the window, no withdrawal between.
 *  LIVE:   (with `t`) a signature dated after the window of the last naming arrived with `t` seats
 *          standing (signed since that naming and since the last withdrawal, none expired by the newest
 *          signature), and nobody was named: the payment of a vanished sender waits with a quorum
 *          signed (#334). Read from the room alone. The window is counted from the completing
 *          signature plus twice `skewMs`, the furthest any other signature of that quorum can be dated
 *          after it. */
export function check(o: SimOut, ttl: number, t?: number, skewMs = 0): string[] {
  const v: string[] = o.would.map((w) => `WOULD: ${w}`)
  for (const x of o.self) if (!x.fired) v.push(`BLOCKED: ${x.tag} named itself (seq ${x.seq}, relay ${(x.tRelay / 60000).toFixed(3)} min) and did not send`)
  const unarmBetween = (a: number, b: number) => o.unarmSeqs.some((u) => u > Math.min(a, b) && u < Math.max(a, b))
  for (let a = 0; a < o.self.length; a++) {
    for (let b = a + 1; b < o.self.length; b++) {
      const x = o.self[a]!, y = o.self[b]!
      if (Math.abs(y.at - x.at) <= ttl && !unarmBetween(x.seq, y.seq)) v.push(`DOUBLE: ${x.tag} named itself (seq ${x.seq}, relay ${(x.tRelay / 60000).toFixed(3)} min) and ${y.tag} named itself (seq ${y.seq}, relay ${(y.tRelay / 60000).toFixed(3)} min)`)
    }
  }
  const live: Array<{ seq: number; at: number; tag: string; by: string }> = []
  for (const n of o.namings) {
    const readersLive = Object.keys(n.named).filter((tag) => o.life[tag]![0] <= n.tRelay)
    const namedLive = readersLive.filter((tag) => n.named[tag] !== null)
    for (const tag of namedLive) live.push({ seq: n.seq, at: n.at, tag: n.named[tag]!, by: tag })
    const ownerSaid = n.named[n.fromTag]
    if (namedLive.length && ownerSaid === null) v.push(`STALL at seq ${n.seq} (signature by ${n.fromTag}, relay ${(n.tRelay / 60000).toFixed(3)} min): named live by ${namedLive.join(',')}, but ${n.fromTag} named nobody`)
  }
  for (let a = 0; a < live.length; a++) {
    for (let b = a + 1; b < live.length; b++) {
      const x = live[a]!, y = live[b]!
      if (x.tag !== y.tag && Math.abs(x.at - y.at) <= ttl && !unarmBetween(x.seq, y.seq)) v.push(`DIFFER: ${x.by} named ${x.tag} at seq ${x.seq}, ${y.by} named ${y.tag} at seq ${y.seq}`)
    }
  }
  if (t !== undefined) {
    let since = -1
    let windowEnd = -Infinity
    let newest = -Infinity
    let reported = false
    const latest = new Map<number, number>()
    for (const n of [...o.namings].sort((a, b) => a.seq - b.seq)) {
      if (o.unarmSeqs.some((u) => u > since && u < n.seq)) {
        since = Math.max(...o.unarmSeqs.filter((u) => u < n.seq))
        windowEnd = -Infinity
        latest.clear()
        reported = false
      }
      newest = Math.max(newest, n.at)
      latest.set(n.fromDev, Math.max(latest.get(n.fromDev) ?? -Infinity, n.at))
      if (Object.values(n.named).some((x) => x !== null)) {
        since = n.seq
        windowEnd = n.at + 2 * skewMs + ttl
        latest.clear()
        reported = false
        continue
      }
      const standing = [...latest.values()].filter((at) => newest - at <= ttl)
      if (!reported && n.at > windowEnd && newest - n.at <= ttl && standing.length >= t) {
        reported = true
        v.push(`LIVE: ${standing.length} seats standing when seq ${n.seq} arrived after the window (signature by ${n.fromTag}, relay ${(n.tRelay / 60000).toFixed(3)} min), and nobody was named`)
      }
    }
  }
  return v
}

/** A reproducible pseudo-random sequence of what members do over 35 minutes, for the property test:
 *  signing, signing again when the button returns, closing and reopening the panel, reloading, with
 *  every clock within `skewMs` of the relay's. The seed makes a failure a fixed case anyone can replay. */
export function randomCase(seed: number, N: number, skewMs: number): { skews: number[]; openAt: number[]; evs: Ev[]; fate: OnSelf } {
  let a = seed >>> 0
  const rnd = () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
  const skews = Array.from({ length: N }, () => Math.round((rnd() * 2 - 1) * skewMs))
  const openAt = Array.from({ length: N }, () => (rnd() < 0.3 ? Math.round(rnd() * 30 * 60_000) : 0))
  const evs: Ev[] = []
  const count = 8 + Math.floor(rnd() * 12)
  for (let k = 0; k < count; k++) {
    const r = rnd()
    const kind: Ev['kind'] = r < 0.6 ? 'arm' : r < 0.72 ? 'close' : r < 0.86 ? 'open' : r < 0.95 ? 'reload' : 'unarm'
    evs.push({ t: Math.round(rnd() * 35 * 60_000), dev: Math.floor(rnd() * N), kind })
  }
  for (let i = 0; i < N; i++) if (openAt[i]! > 0) evs.push({ t: openAt[i]!, dev: i, kind: 'open' })
  // Members sign again when the button comes back, which the panel invites once a member's own
  // window ends ("After that it stops counting and you sign again").
  for (const e of evs.filter((x) => x.kind === 'arm')) {
    for (let t = e.t; rnd() < 0.7;) {
      t += ARM_TTL_MS + Math.round((0.05 + rnd() * 2) * 60_000)
      if (t > 60 * 60_000) break
      evs.push({ t, dev: e.dev, kind: 'arm' })
    }
  }
  // What the named sender does next: stays (sends, and its screen shows the result); closes the
  // panel and its send fails while it is closed, then reopens (no withdrawal reaches the room);
  // vanishes before the send ends, by reloading or closing the tab (#334); or fails with the panel
  // open and withdraws every signature.
  const fate = (dev: number, tRelay: number): Ev[] => {
    const r = rnd()
    if (r < 0.3) return []
    if (r < 0.6) {
      const failAt = tRelay + 6000 + Math.round(rnd() * 4 * 60_000)
      return [{ t: tRelay + 6000, dev, kind: 'close' }, { t: failAt, dev, kind: 'unarm' }, { t: failAt + Math.round(rnd() * 8 * 60_000), dev, kind: 'open' }]
    }
    if (r < 0.8) return [{ t: tRelay + 6000, dev, kind: 'reload' }]
    return [{ t: tRelay + 30_000, dev, kind: 'unarm' }]
  }
  return { skews, openAt, evs, fate }
}
