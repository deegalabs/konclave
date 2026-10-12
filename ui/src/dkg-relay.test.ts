/// <reference types="node" />
// The creation ceremony against a relay that does not follow the protocol: it numbers and labels
// every message itself, and can show each device a different room. What must hold: the devices
// that were shown different rooms get different codes, so the people comparing them stop before
// anything secret is sent.
import { readFileSync } from 'node:fs'
import { beforeAll, describe, expect, it } from 'vitest'
import init, { DeviceKey, CreationSession } from './wasm-pkg/konclave_wasm.js'
import { DkgCeremony, DKG_VERSION, type DkgMsg } from './dkg-ceremony'
import { b64 } from './net'

beforeAll(async () => {
  await init(readFileSync(new URL('./wasm-pkg/konclave_wasm_bg.wasm', import.meta.url)))
})

const ROOM = 'room-under-test'
interface Wire { seq: number; from: string; m: DkgMsg }
type Rewrite = (viewer: string, w: { from: string; m: DkgMsg }) => { from: string; m: DkgMsg }[]

/** One room per device; `rewrite` decides what each view gets of every post. */
class SplitRelay {
  views = new Map<string, Wire[]>()
  private readonly rewrite: Rewrite
  constructor(tags: string[], rewrite: Rewrite) {
    this.rewrite = rewrite
    for (const t of tags) this.views.set(t, [])
  }
  post(from: string, m: DkgMsg) {
    for (const [viewer, list] of this.views) {
      for (const w of this.rewrite(viewer, { from, m })) list.push({ seq: list.length + 1, ...w })
    }
  }
  all(): Wire[] {
    return [...this.views.values()].flat()
  }
}

interface Device { c: DkgCeremony; key: DeviceKey; consumed: Set<number>; name: string }
const device = (tag: string, name: string): Device => {
  const key = new DeviceKey()
  return { c: new DkgCeremony(tag, key, ROOM), key, consumed: new Set(), name }
}
const hello = (d: Device): DkgMsg => ({ type: 'hello', v: DKG_VERSION, encPub: b64(d.key.publicBytes()), name: d.name })

/** Each device reads its own view. `postAs` lets a relay-run device post into chosen views only. */
function drain(relay: SplitRelay, devices: Device[], postAs = (d: Device, m: DkgMsg) => relay.post(d.c.myTag, m)) {
  let progressed = true
  while (progressed) {
    progressed = false
    for (const d of devices) {
      for (const m of d.c.trySeat()) { postAs(d, m); progressed = true }
      const view = relay.views.get(d.c.myTag) ?? []
      for (const w of view) {
        if (d.consumed.has(w.seq)) continue
        const r = d.c.apply(w.from, w.m)
        if (!r.applied) continue
        d.consumed.add(w.seq)
        d.c.noteSeq(w.seq)
        progressed = true
        for (const m of r.out) postAs(d, m)
      }
    }
  }
}

/** The rule the confirm screen gives people: read the code with EVERY listed person; confirm only
 *  if each of them reads back the same code. `people` maps a listed name to that person's device. */
function peopleConfirm(viewer: Device, people: Map<string, Device>): boolean {
  if (!viewer.c.code) return false
  return viewer.c.seatNames().every((name) => people.get(name)?.c.code === viewer.c.code)
}

function begin(rewrite: Rewrite, extraViews: string[] = []) {
  const [a, b, c] = [device('p-a', 'Ana'), device('p-b', 'Bia'), device('p-c', 'Caio')]
  const relay = new SplitRelay(['p-a', 'p-b', 'p-c', ...extraViews], rewrite)
  a.c.setOwnConfig({ n: 3, t: 2 })
  relay.post('p-a', { type: 'config', v: DKG_VERSION, n: 3, t: 2 })
  return { relay, a, b, c, people: new Map([['Ana', a], ['Bia', b], ['Caio', c]]) }
}

describe('a relay that shows each device a different room', () => {
  it('swapping a member\'s key in one view gives that view another code, and nothing is sent', () => {
    const relayKey = new DeviceKey()
    const { relay, a, b, c, people } = begin((viewer, w) =>
      viewer === 'p-a' && w.from === 'p-b' && w.m.type === 'hello'
        ? [{ from: w.from, m: { ...w.m, encPub: b64(relayKey.publicBytes()) } }]
        : [w])
    for (const d of [a, b, c]) relay.post(d.c.myTag, hello(d))
    drain(relay, [a, b, c])
    // Ana's room binds Bia's seat to a key Bia does not hold, so Ana's code is not Bia's or Caio's
    // (or Ana stops first, when Bia's commitment does not match the key Ana was shown).
    expect(b.c.code).not.toBeNull()
    expect(a.c.code === null || a.c.code !== b.c.code).toBe(true)
    expect(b.c.code).toBe(c.c.code)
    for (const d of [a, b, c]) expect(peopleConfirm(d, people)).toBe(false)
    expect(relay.all().filter((w) => w.m.type === 'r2')).toEqual([])
  })

  it('a relay that also forges a matching commitment for the swapped key still gives that view another code', () => {
    // The relay runs its own session for Bia's seat with its own key, and shows it only to Ana.
    const relayKey = new DeviceKey()
    let fake: CreationSession | null = null
    const fakeFor = (seat: number) => (fake ??= new CreationSession(relayKey, seat, 3, 2))
    const { relay, a, b, c, people } = begin((viewer, w) => {
      if (viewer !== 'p-a' || w.from !== 'p-b') return [w]
      const seat = a.c.seatOf('p-b')
      if (w.m.type === 'hello') return [{ from: w.from, m: { ...w.m, encPub: b64(relayKey.publicBytes()) } }]
      if (w.m.type === 'commit' && seat) return [{ from: w.from, m: { type: 'commit', c: b64(fakeFor(seat).myCommitment()) } }]
      if (w.m.type === 'reveal' && seat) return [{ from: w.from, m: { type: 'reveal', r1: b64(fakeFor(seat).myRound1()), nonce: b64(fakeFor(seat).myNonce()) } }]
      return [w]
    })
    for (const d of [a, b, c]) relay.post(d.c.myTag, hello(d))
    drain(relay, [a, b, c])
    expect(a.c.aborted).toBeNull() // nothing in Ana's room is inconsistent on its own
    expect(a.c.code).not.toBeNull()
    expect(a.c.code).not.toBe(b.c.code)
    for (const d of [a, b, c]) expect(peopleConfirm(d, people)).toBe(false)
    expect(relay.all().filter((w) => w.m.type === 'r2')).toEqual([])
  })

  it('showing one device another seated member as the creator gives it another code', () => {
    // In Bia's room the config comes from Caio's tag (same values); everyone else sees Ana's.
    const { relay, a, b, c, people } = begin((viewer, w) =>
      viewer === 'p-b' && w.m.type === 'config' && w.from === 'p-a' ? [{ from: 'p-c', m: w.m }] : [w])
    for (const d of [a, b, c]) relay.post(d.c.myTag, hello(d))
    drain(relay, [a, b, c])
    expect(a.c.code).not.toBeNull()
    expect(b.c.code).not.toBe(a.c.code)
    expect(a.c.code).toBe(c.c.code)
    for (const d of [a, b, c]) expect(peopleConfirm(d, people)).toBe(false)
  })

  it('showing one device another vault name gives it another code', () => {
    const { relay, a, b, c, people } = begin((viewer, w) =>
      viewer === 'p-b' && w.m.type === 'config' ? [{ from: w.from, m: { ...w.m, vn: 'Outro nome' } }] : [w])
    for (const d of [a, b, c]) relay.post(d.c.myTag, hello(d))
    drain(relay, [a, b, c])
    expect(a.c.code).not.toBeNull()
    expect(b.c.code).not.toBe(a.c.code)
    for (const d of [a, b, c]) expect(peopleConfirm(d, people)).toBe(false)
  })

  it('showing one device a different round 1 for a seat stops it or gives it another code', () => {
    // In Ana's room, Caio's commitment and reveal are another session's (same seat, its own round 1).
    let fake: CreationSession | null = null
    const fakeFor = (seat: number) => (fake ??= new CreationSession(new DeviceKey(), seat, 3, 2))
    const { relay, a, b, c, people } = begin((viewer, w) => {
      if (viewer !== 'p-a' || w.from !== 'p-c') return [w]
      const seat = a.c.seatOf('p-c')
      if (w.m.type === 'commit' && seat) return [{ from: w.from, m: { type: 'commit', c: b64(fakeFor(seat).myCommitment()) } }]
      if (w.m.type === 'reveal' && seat) return [{ from: w.from, m: { type: 'reveal', r1: b64(fakeFor(seat).myRound1()), nonce: b64(fakeFor(seat).myNonce()) } }]
      return [w]
    })
    for (const d of [a, b, c]) relay.post(d.c.myTag, hello(d))
    drain(relay, [a, b, c])
    expect(a.c.aborted !== null || a.c.code !== b.c.code).toBe(true)
    expect(b.c.code).toBe(c.c.code)
    for (const d of [a, b, c]) expect(peopleConfirm(d, people)).toBe(false)
    expect(relay.all().filter((w) => w.m.type === 'r2')).toEqual([])
  })

  it('a member the relay invents under a real member\'s name cannot pass the people\'s check', () => {
    // The relay keeps Bia out of Ana's and Caio's rooms and seats its own device named "Bia".
    const fakeBia = device('p-x', 'Bia')
    const { relay, a, b, c, people } = begin((viewer, w) => {
      if (w.from === 'p-b' && viewer !== 'p-b') return [] // real Bia is invisible to the others
      if (w.from === 'p-x' && viewer === 'p-b') return [] // and never sees the fake
      return [w]
    }, ['p-x'])
    for (const d of [a, c, b, fakeBia]) relay.post(d.c.myTag, hello(d))
    drain(relay, [a, b, c, fakeBia])
    // Ana and Caio agree with the fake: their code is the same, and lists "Bia".
    expect(a.c.code).not.toBeNull()
    expect(a.c.code).toBe(c.c.code)
    expect(a.c.seatNames()).toContain('Bia')
    // The real Bia never reached a code, so reading it with every listed person fails.
    expect(b.c.code).toBeNull()
    expect(peopleConfirm(a, people)).toBe(false)
    expect(peopleConfirm(c, people)).toBe(false)
  })
})
