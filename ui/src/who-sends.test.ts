/// <reference types="node" />
// Who sends (#626), against sequences of what members actually do: sign, close the signing panel and
// open it again, reload, with clocks that disagree. Every case runs real shares and real signatures
// over the real BackgroundSession (signer-sim.ts). The named cases are the counterexamples the review
// of the fix found; the property test runs fixed seeds, so a failure is a case anyone can replay.
//
// What must hold (signer-sim `check`): a device named the sender sends (its panel's send memory,
// send-attempt.ts, is the rule the simulator runs); two devices never both name themselves within a window; a
// device that reads a signature live never names a signer whose own open session names nobody; two
// live readers never name different senders within a window; and once a quorum signs after the
// window of the last sender named, someone is named (#334).
import { readFileSync } from 'node:fs'
import { beforeAll, describe, expect, it } from 'vitest'
import init, { DkgSession, identifierBytes } from './wasm-pkg/konclave_wasm.js'
import { bytesEqual } from './net'
import { ARM_TTL_MS } from './signing-gate'
import { check, randomCase, sim, type Ev } from './signer-sim'

beforeAll(async () => {
  await init(readFileSync(new URL('./wasm-pkg/konclave_wasm_bg.wasm', import.meta.url)))
})

function dkg(T: number, N: number) {
  const ids = Array.from({ length: N }, (_, i) => identifierBytes(i + 1))
  const sessions = ids.map((id) => new DkgSession(id, N, T))
  const r1 = sessions.map((s) => s.round1Package())
  sessions.forEach((s, i) => r1.forEach((pkg, j) => { if (i !== j) s.addRound1(ids[j]!, pkg) }))
  sessions.forEach((s) => s.part2())
  sessions.forEach((s, i) => {
    for (let k = 0; k < s.round2Count(); k++) {
      const j = ids.findIndex((id) => bytesEqual(id, s.round2Recipient(k)))
      sessions[j]!.addRound2(ids[i]!, s.round2Package(k))
    }
  })
  sessions.forEach((s) => s.part3())
  const groupVk = sessions[0]!.groupVk(), pubkeys = sessions[0]!.pubkeys()
  return sessions.map((s) => () => ({ keyPackage: s.keyPackage(), groupVk, pubkeys }))
}
const MATS = new Map<string, ReturnType<typeof dkg>>()
const mats = (T: number, N: number) => {
  const k = `${T}/${N}`
  if (!MATS.has(k)) MATS.set(k, dkg(T, N))
  return MATS.get(k)!
}
const MIN = 60_000
const ev = (list: Array<[number, number, Ev['kind']]>): Ev[] => list.map(([t, dev, kind]) => ({ t, dev, kind }))

describe('who sends: the cases the review found (#626)', () => {
  const CASES: Array<{ name: string; T: number; N: number; skews: number[]; openAt: number[]; evs: Ev[] }> = [
    { name: 'C1: 2-of-3 in sync, the named sender closes its panel, a third opens at 20.1 min', T: 2, N: 3,
      skews: [0, 0, 0], openAt: [0, 0, 1206000],
      evs: ev([[0, 0, 'arm'], [570000, 1, 'arm'], [573000, 1, 'close'], [630000, 0, 'arm'], [1206000, 2, 'open'], [1212000, 2, 'arm']]) },
    { name: '#9230: 2-of-3, clocks 11 to 37 s fast, a member reopens', T: 2, N: 3,
      skews: [17569, 11268, 37039], openAt: [0, 0, 0],
      evs: ev([[38638, 2, 'arm'], [430584, 1, 'arm'], [509655, 0, 'arm'], [546000, 1, 'close'], [1061897, 2, 'arm'], [1264920, 1, 'open'], [1492349, 1, 'arm'], [1503060, 1, 'close'], [1642440, 1, 'open']]) },
    { name: '#4065: 2-of-3, clocks up to 55 s slow, reloads', T: 2, N: 3,
      skews: [-37905, -55186, 9018], openAt: [0, 0, 0],
      evs: ev([[5213, 0, 'arm'], [578159, 1, 'arm'], [631560, 1, 'reload'], [723538, 0, 'arm'], [1181808, 1, 'arm'], [1226640, 1, 'reload'], [1454497, 0, 'arm']]) },
    { name: '#870: 2-of-2, clocks 78 s apart, reloads', T: 2, N: 2,
      skews: [24989, -52945], openAt: [0, 0],
      evs: ev([[14490, 1, 'arm'], [313375, 0, 'arm'], [407880, 0, 'reload'], [742521, 1, 'arm'], [1053043, 0, 'arm'], [1168680, 0, 'reload'], [1431648, 1, 'arm']]) },
  ]
  for (const c of CASES) {
    it(c.name, async () => {
      const o = await sim(c.T, c.N, c.skews, c.openAt, c.evs, mats(c.T, c.N))
      expect(check(o, ARM_TTL_MS, c.T, Math.max(...c.skews.map(Math.abs))), o.log.join('\n')).toEqual([])
    })
  }

  it('a signature given inside the window still counts toward sending a vanished sender\'s payment', async () => {
    // 2-of-2 in sync. d1 at 0; d2 at 0.7 min is named, sends, closes its panel at 0.8, and the send
    // fails at 5 with the panel closed, so no withdrawal reaches the room. d1's own window closes at
    // 10 and d1 signs again at 10.05, inside the window of that quorum. d2 reopens at 11, clicks Try
    // again and signs at 11.1: it is named, about ten minutes after the stall, not twenty, AND it
    // sends.
    const o = await sim(2, 2, [0, 0], [0, 0], ev([[0, 0, 'arm'], [0.7 * MIN, 1, 'arm'], [0.8 * MIN, 1, 'close'], [5 * MIN, 1, 'unarm'], [10.05 * MIN, 0, 'arm'], [11 * MIN, 1, 'open'], [11.1 * MIN, 1, 'arm']]), mats(2, 2))
    expect(check(o, ARM_TTL_MS, 2), o.log.join('\n')).toEqual([])
    expect(o.self.map((s) => [s.dev, s.fired])).toEqual([[1, true], [1, true]])
    expect(o.self[1]!.tRelay).toBe(11.1 * MIN) // named on its own signature at 11.1 min
  })

  it('a sender whose send failed with the panel open sends again when named again', async () => {
    // 2-of-2 in sync. d2 is named at 0.7 and its send fails at 1 with the panel open: the signatures
    // are withdrawn. d1 signs again at 10.05 (its own window, kept by the other device's withdrawal),
    // d2 at 11, last: named, and its panel sends.
    const o = await sim(2, 2, [0, 0], [0, 0], ev([[0, 0, 'arm'], [0.7 * MIN, 1, 'arm'], [1 * MIN, 1, 'unarm'], [10.05 * MIN, 0, 'arm'], [11 * MIN, 1, 'arm']]), mats(2, 2))
    expect(check(o, ARM_TTL_MS, 2), o.log.join('\n')).toEqual([])
    expect(o.self.map((s) => [s.dev, s.fired])).toEqual([[1, true], [1, true]])
  })

  it('after a withdrawal every device can sign again at once, and the next quorum sends', async () => {
    // 2-of-2 in sync. d2 is named at 0.7 and its send fails at 1 with the panel open: the withdrawal
    // ends every device's signature for the payment, so d1 signs again at 1.5 (not after its own
    // ten minutes) and d2 at 2: named, and it sends.
    const o = await sim(2, 2, [0, 0], [0, 0], ev([[0, 0, 'arm'], [0.7 * MIN, 1, 'arm'], [1 * MIN, 1, 'unarm'], [1.5 * MIN, 0, 'arm'], [2 * MIN, 1, 'arm']]), mats(2, 2))
    expect(check(o, ARM_TTL_MS, 2), o.log.join('\n')).toEqual([])
    expect(o.self.map((s) => [s.dev, s.tRelay / MIN, s.fired])).toEqual([[1, 0.7, true], [1, 2, true]])
  })

  it('a sender whose send is still running or done never signs again on the same page', async () => {
    // d2 is named at 0.7 and closes its panel at 0.8 with the send going on. Reopening shows the run
    // or its result, with no Sign button, so d2 is not named again whatever d1 does.
    const o = await sim(2, 2, [0, 0], [0, 0], ev([[0, 0, 'arm'], [0.7 * MIN, 1, 'arm'], [0.8 * MIN, 1, 'close'], [10.05 * MIN, 0, 'arm'], [11 * MIN, 1, 'open'], [11.1 * MIN, 1, 'arm']]), mats(2, 2))
    expect(o.self.map((s) => [s.dev, s.fired])).toEqual([[1, true]])
  })

  it('a member who signs again while the send may still run is not a second sender (H1)', async () => {
    // 2-of-3 in sync. d1 at 0; d2 at 8.5 is named and sends. d1's own window closes at 10 and d1
    // signs again at 10.2: inside the window of the quorum that named d2, so nobody else is named.
    // (After that window a new completion may name someone, which is how a vanished sender's payment
    // gets sent, #334; the sender then checks the payment first, send-preflight.test.ts.)
    const o = await sim(2, 3, [0, 0, 0], [0, 0, 0], ev([[0, 0, 'arm'], [8.5 * MIN, 1, 'arm'], [10.2 * MIN, 0, 'arm'], [12 * MIN, 2, 'arm']]), mats(2, 3))
    expect(o.self.map((s) => s.dev)).toEqual([1])
    expect(check(o, ARM_TTL_MS, 2)).toEqual([])
  })

  it('a member who signs again after a stall is named, with signatures dated after the window', async () => {
    // The other side of H1: once the window of the last completion has passed, signatures given
    // after it close the quorum again (the named sender of the first round vanished, #334).
    const o = await sim(2, 2, [0, 0], [0, 0], ev([[0, 0, 'arm'], [700, 1, 'arm'], [700 + 1000, 1, 'close'], [5 * MIN, 1, 'unarm'], [11 * MIN, 0, 'arm'], [11.5 * MIN, 1, 'open'], [11.6 * MIN, 1, 'arm']]), mats(2, 2))
    expect(check(o, ARM_TTL_MS, 2)).toEqual([])
    expect(o.self.map((s) => s.dev)).toEqual([1, 1])
  })

  // Liveness with more signatures than the quorum (#626 review, round 3). A completion used to need a
  // seat new to the tally bringing it to exactly t, so with t + 1 signatures standing, or a seat
  // signing again over its own, nobody was named again while every screen counted a full quorum.
  it('2-of-3: the third member signs after the sender vanished, and the next signature past the window names (N1c)', async () => {
    const o = await sim(2, 3, [0, 0, 0], [0, 0, 0], ev([[0, 0, 'arm'], [0.5 * MIN, 1, 'arm'], [0.6 * MIN, 1, 'close'], [0.7 * MIN, 2, 'arm'], [5 * MIN, 1, 'unarm'], [10.01 * MIN, 0, 'arm'], [10.55 * MIN, 1, 'open'], [10.6 * MIN, 1, 'arm'], [10.71 * MIN, 2, 'arm']]), mats(2, 3))
    expect(check(o, ARM_TTL_MS, 2), o.log.join('\n')).toEqual([])
    expect(o.self.map((s) => [s.dev, s.tRelay / MIN])).toEqual([[1, 0.5], [1, 10.6]])
  })

  it('2-of-3: everyone signs again once, and the first past the window names (S1)', async () => {
    const o = await sim(2, 3, [0, 0, 0], [0, 0, 5 * MIN], ev([[0, 0, 'arm'], [0.2 * MIN, 1, 'arm'], [0.3 * MIN, 1, 'close'], [4 * MIN, 1, 'unarm'], [5 * MIN, 2, 'open'], [5.05 * MIN, 2, 'arm'], [10.05 * MIN, 0, 'arm'], [10.2 * MIN, 1, 'open'], [10.25 * MIN, 1, 'arm']]), mats(2, 3))
    expect(check(o, ARM_TTL_MS, 2), o.log.join('\n')).toEqual([])
    expect(o.self.map((s) => [s.dev, s.tRelay / MIN])).toEqual([[1, 0.2], [1, 10.25]])
  })

  it('2-of-2 with reloads: a seat signing again over its own standing signature names, past the window (N3)', async () => {
    const o = await sim(2, 2, [0, 0], [0, 0], ev([[0, 0, 'arm'], [0.5 * MIN, 1, 'arm'], [0.6 * MIN, 1, 'reload'], [5 * MIN, 0, 'reload'], [5.1 * MIN, 0, 'arm'], [6.1 * MIN, 1, 'arm'], [11 * MIN, 0, 'reload'], [11.1 * MIN, 0, 'arm']]), mats(2, 2))
    expect(check(o, ARM_TTL_MS, 2), o.log.join('\n')).toEqual([])
    expect(o.self.map((s) => [s.dev, s.tRelay / MIN])).toEqual([[1, 0.5], [0, 11.1]])
  })
})

describe('who sends: fixed-seed sequences (#626)', () => {
  // 60 per shape in CI; WHO_SENDS_SEEDS runs a deeper search by hand.
  const SEEDS = Number(process.env.WHO_SENDS_SEEDS ?? 60)
  // The review searched 243,000 sequences; these are a fixed slice of the same space, run every time.
  for (const [T, N] of [[2, 2], [2, 3], [3, 4]] as const) {
    it(`${T}-of-${N}: clocks within two minutes of each other, panels opened, closed and reloaded, one sender per window`, async () => {
      for (let seed = 1; seed <= SEEDS; seed++) {
        // Each clock within 59 s of the relay's, so any two within ARM_SKEW_MS of each other; further
        // apart is a known limit, pinned in background-session.test.ts.
        const c = randomCase(seed * 7919 + T * 31 + N, N, 59_000)
        const o = await sim(T, N, c.skews, c.openAt, c.evs, mats(T, N), c.fate)
        expect(check(o, ARM_TTL_MS, T, 59_000), `seed ${seed}\n${o.log.join('\n')}`).toEqual([])
      }
    }, 120_000)
  }
})
