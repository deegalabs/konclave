/// <reference types="node" />
// The vault creation ceremony (version 2) driven over an in-memory relay, as the relay drives real
// devices: honest devices agree on one code and, once it is confirmed, create one vault; anything
// inconsistent before the code is confirmed stops the ceremony and nothing secret is sent.
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'
import { beforeAll, describe, expect, it } from 'vitest'
import init, { DeviceKey, CreationSession, sealTo } from './wasm-pkg/konclave_wasm.js'
import { DkgCeremony, DKG_VERSION, quorumIsPossible, type DkgConfig, type DkgMsg } from './dkg-ceremony'
import { b64, unb64, bytesEqual } from './net'
import { codeAt } from './source-scan'
import { signVaultSecret } from './room-auth'
import { bytesToHex } from './bytes'

beforeAll(async () => {
  await init(readFileSync(new URL('./wasm-pkg/konclave_wasm_bg.wasm', import.meta.url)))
})

const ROOM = 'room-under-test'

interface Wire { seq: number; from: string; m: DkgMsg }

class Relay {
  msgs: Wire[] = []
  post(from: string, m: DkgMsg) {
    this.msgs.push({ seq: this.msgs.length + 1, from, m })
  }
}

interface Device { c: DkgCeremony; key: DeviceKey; consumed: Set<number>; name: string }

function device(tag: string, name: string): Device {
  const key = new DeviceKey()
  return { c: new DkgCeremony(tag, key, ROOM, name), key, consumed: new Set(), name }
}

const hello = (d: Device): DkgMsg => ({ type: 'hello', v: DKG_VERSION, encPub: b64(d.key.publicBytes()), name: d.name })

/** The NetVault drain loop, reduced to the ceremony: seat when ready, apply in relay order. */
function drain(relay: Relay, devices: Device[]) {
  let progressed = true
  while (progressed) {
    progressed = false
    for (const d of devices) {
      for (const m of d.c.trySeat()) { relay.post(d.c.myTag, m); progressed = true }
      for (const w of relay.msgs) {
        if (d.consumed.has(w.seq)) continue
        const r = d.c.apply(w.from, w.m)
        if (!r.applied) continue
        d.consumed.add(w.seq)
        d.c.noteSeq(w.seq)
        progressed = true
        for (const m of r.out) relay.post(d.c.myTag, m)
      }
    }
  }
}

/** The people: each confirms only if every seated device shows the same code. */
function confirmAll(relay: Relay, devices: Device[]) {
  const codes = new Set(devices.map((d) => d.c.code))
  if (codes.size !== 1 || codes.has(null)) return false
  for (const d of devices) {
    const r = d.c.confirmCode(d.c.code!)
    expect(r.ok).toBe(true)
    for (const m of r.out) relay.post(d.c.myTag, m)
  }
  drain(relay, devices)
  for (const d of devices) for (const m of d.c.markSaved()) relay.post(d.c.myTag, m) // each saves its share
  drain(relay, devices)
  return true
}

function start(n = 3, t = 2) {
  const relay = new Relay()
  const names = ['Ana', 'Bia', 'Caio', 'Duda', 'Edu']
  const ds = names.slice(0, n).map((nm, i) => device(`p-${String.fromCharCode(97 + i)}`, nm))
  const cfg = { n, t }
  ds[0]!.c.setOwnConfig(cfg)
  relay.post(ds[0]!.c.myTag, { type: 'config', v: DKG_VERSION, ...cfg })
  return { relay, ds }
}

const posted = (relay: Relay, type: DkgMsg['type']) => relay.msgs.filter((w) => w.m.type === type)

describe('vault creation, version 2', () => {
  it('honest devices agree on one code and, once it is confirmed, create one vault', () => {
    for (const [n, t] of [[2, 2], [3, 2], [5, 3]] as const) {
      const { relay, ds } = start(n, t)
      for (const d of ds) relay.post(d.c.myTag, hello(d))
      drain(relay, ds)
      expect(posted(relay, 'r2')).toEqual([]) // nothing secret before the code is confirmed
      expect(ds.every((d) => d.c.code && d.c.code === ds[0]!.c.code)).toBe(true)
      expect(ds[0]!.c.seatNames().slice().sort()).toEqual(ds.map((d) => d.name).sort())
      expect(confirmAll(relay, ds)).toBe(true)
      for (const d of ds) {
        expect(d.c.aborted).toBeNull()
        expect(d.c.part3Done).toBe(true)
        expect(bytesEqual(d.c.session!.groupVk(), ds[0]!.c.session!.groupVk())).toBe(true)
      }
    }
  })

  it('a wrong code unlocks nothing and sends nothing', () => {
    const { relay, ds } = start()
    for (const d of ds) relay.post(d.c.myTag, hello(d))
    drain(relay, ds)
    expect(ds[0]!.c.confirmCode('000-000-000')).toEqual({ ok: false, out: [] })
    expect(ds[0]!.c.confirmed).toBe(false)
    expect(posted(relay, 'r2')).toEqual([])
  })

  it('a member saying the codes differ stops the ceremony', () => {
    const { relay, ds } = start()
    for (const d of ds) relay.post(d.c.myTag, hello(d))
    drain(relay, ds)
    ds[1]!.c.rejectCode()
    expect(ds[1]!.c.aborted).toBe('mismatch')
    expect(ds[1]!.c.confirmCode(ds[1]!.c.code!)).toEqual({ ok: false, out: [] })
  })

  it('a second key announced for a seat stops the ceremony before anything is committed', () => {
    const { relay, ds } = start()
    const [a, b, c] = ds as [Device, Device, Device]
    relay.post(a.c.myTag, hello(a))
    relay.post(b.c.myTag, hello(b))
    relay.post(b.c.myTag, hello(c))
    relay.post(c.c.myTag, hello(c))
    drain(relay, ds)
    expect(a.c.aborted).toBe('conflict')
    expect(b.c.aborted).toBe('conflict')
    expect(posted(relay, 'commit')).toEqual([])
  })

  it('the same device announcing twice is not a conflict', () => {
    const { relay, ds } = start()
    relay.post(ds[0]!.c.myTag, hello(ds[0]!))
    for (const d of ds) relay.post(d.c.myTag, hello(d))
    drain(relay, ds)
    expect(confirmAll(relay, ds)).toBe(true)
  })

  it('a name that the app cuts at 64 units through an emoji still creates the vault', () => {
    // The app announces `ceremony.myName`: trimmed and cut at 64 UTF-16 units, so a 65-unit name whose
    // last character is an emoji is cut between the two halves of the pair.
    const long = `${'a'.repeat(63)}\u{1F600}`
    const relay = new Relay()
    const ds = [long, 'Bia', 'Caio'].map((nm, i) => device(`p-${String.fromCharCode(97 + i)}`, nm))
    ds[0]!.c.setOwnConfig({ n: 3, t: 2 })
    relay.post(ds[0]!.c.myTag, { type: 'config', v: DKG_VERSION, n: 3, t: 2 })
    // The hello as NetVault builds it: from the ceremony's own name, not the raw field.
    for (const d of ds) relay.post(d.c.myTag, { ...hello(d), name: d.c.myName || undefined } as DkgMsg)
    drain(relay, ds)
    expect(ds.every((d) => d.c.aborted === null), 'no device stopped').toBe(true)
    expect(confirmAll(relay, ds)).toBe(true)
    for (const d of ds) expect(d.c.part3Done).toBe(true)
  })

  it('a hello for this seat under another name stops creation', () => {
    // A hello under this device's own tag, with its own key and a name its owner did not type,
    // ahead of the real hello: the device refuses it.
    const { relay, ds } = start()
    const [a, b, c] = ds as [Device, Device, Device]
    relay.post(a.c.myTag, { ...hello(a), name: 'Another name' } as DkgMsg)
    for (const d of [a, b, c]) relay.post(d.c.myTag, hello(d))
    drain(relay, ds)
    expect(a.c.aborted).toBe('conflict')
    expect(posted(relay, 'r2')).toEqual([])
  })

  it('a hello under this device\'s own tag with another key stops it', () => {
    const { relay, ds } = start()
    relay.post(ds[1]!.c.myTag, hello(ds[0]!))
    drain(relay, [ds[1]!])
    expect(ds[1]!.c.aborted).toBe('conflict')
  })

  it('a device arriving after the seats are taken is told it is not in the vault, and the others stop', () => {
    const { relay, ds } = start()
    const late = device('p-0', 'Late')
    for (const d of ds) relay.post(d.c.myTag, hello(d))
    relay.post(late.c.myTag, hello(late))
    drain(relay, [...ds, late])
    expect(late.c.aborted).toBe('excluded')
    expect(ds[0]!.c.aborted).toBe('extra')
    expect(posted(relay, 'r2')).toEqual([])
  })

  it('a device that counts the seats before its own hello arrives is told it is not in the vault', () => {
    const { relay, ds } = start()
    for (const d of ds) relay.post(d.c.myTag, hello(d))
    const late = device('p-z', 'Late')
    drain(relay, [late]) // the room is full before this device's own hello reaches it
    relay.post(late.c.myTag, hello(late))
    drain(relay, [late])
    expect(late.c.aborted).toBe('excluded')
  })

  it('after the code is confirmed, a late hello or a gap is logged, not a stop', () => {
    const { relay, ds } = start()
    for (const d of ds) relay.post(d.c.myTag, hello(d))
    drain(relay, ds)
    const logged: string[] = []
    ds[0]!.c.onLog = (what) => logged.push(what)
    for (const d of ds) for (const m of d.c.confirmCode(d.c.code!).out) relay.post(d.c.myTag, m)
    relay.post('p-late', hello(device('p-late', 'Late')))
    ds[0]!.c.noteSeq(999)
    drain(relay, ds)
    expect(ds[0]!.c.aborted).toBeNull()
    expect(ds[0]!.c.part3Done).toBe(true)
    expect(logged).toContain('anomaly')
  })

  it('every device seats the same members, whatever batches it read', () => {
    const { relay, ds } = start()
    for (const d of ds) relay.post(d.c.myTag, hello(d))
    const early = relay.msgs.slice()
    relay.msgs = []
    for (const w of early) { relay.msgs.push(w); drain(relay, [ds[1]!]) }
    drain(relay, ds)
    expect(ds[1]!.c.seatTable.map((r) => r.tag)).toEqual(ds[0]!.c.seatTable.map((r) => r.tag))
    expect(ds[2]!.c.seatTable.map((r) => r.tag)).toEqual(ds[0]!.c.seatTable.map((r) => r.tag))
  })

  it('a device that read more hellos than seats before the config seats nobody', () => {
    const relay = new Relay()
    const devs = ['p-a', 'p-b', 'p-c', 'p-d'].map((tag) => device(tag, tag))
    for (const d of devs) relay.post(d.c.myTag, hello(d))
    relay.post('p-a', { type: 'config', v: DKG_VERSION, n: 3, t: 2 })
    drain(relay, [devs[1]!])
    expect(devs[1]!.c.aborted).toBe('extra')
    expect(devs[1]!.c.started).toBe(false)
  })

  it('a config from anyone but the creator, a different one, or an invalid one, stops it', () => {
    for (const bad of [{ n: 3, t: 1 }, { n: 3, t: 4 }]) {
      const { relay, ds } = start()
      relay.post(ds[1]!.c.myTag, { type: 'config', v: DKG_VERSION, ...bad })
      drain(relay, [ds[1]!])
      expect(ds[1]!.c.aborted).toBe('conflict')
    }
  })

  it('a quorum of 1 from the creator never reaches the session (#589)', () => {
    // The signing library refuses min_signers < 2; before this, the config passed and the refusal
    // came only once every member had gathered, as an unhandled throw.
    for (const bad of [{ n: 2, t: 1 }, { n: 3, t: 1 }, { n: 3, t: 4 }]) {
      const relay = new Relay()
      const ds = [device('p-a', 'Ana'), device('p-b', 'Bia'), device('p-c', 'Caio')].slice(0, bad.n)
      relay.post(ds[0]!.c.myTag, { type: 'config', v: DKG_VERSION, ...bad }) // as a creator would
      for (const d of ds.slice(1)) relay.post(d.c.myTag, hello(d))
      drain(relay, ds.slice(1))
      for (const d of ds.slice(1)) {
        expect(d.c.aborted).toBe('conflict')
        expect(d.c.session).toBeNull()
      }
    }
    expect(quorumIsPossible(1, 3)).toBe(false)
    expect(quorumIsPossible(2, 2)).toBe(true)
    expect(quorumIsPossible(3, 2)).toBe(false)
    expect(quorumIsPossible(2, 3)).toBe(true)
  })

  it('a device of the previous version in the room stops it', () => {
    for (const m of [
      { type: 'r1', pkg: 'AA==' },
      { type: 'hello', encPub: b64(new DeviceKey().publicBytes()) },
      { type: 'config', n: 3, t: 2 },
    ] as DkgMsg[]) {
      const { relay, ds } = start()
      relay.post('p-old', m)
      drain(relay, [ds[1]!])
      expect(ds[1]!.c.aborted).toBe('version')
    }
  })

  it('a second, different commitment from a seat stops it', () => {
    const { relay, ds } = start()
    for (const d of ds) relay.post(d.c.myTag, hello(d))
    drain(relay, [ds[0]!]) // a seats and commits, then waits
    relay.post(ds[1]!.c.myTag, { type: 'commit', c: b64(new Uint8Array(32).fill(1)) })
    relay.post(ds[1]!.c.myTag, { type: 'commit', c: b64(new Uint8Array(32).fill(2)) })
    drain(relay, [ds[0]!])
    expect(ds[0]!.c.aborted).toBe('conflict')
  })

  it('a reveal that does not match its commitment stops it', () => {
    const { relay, ds } = start()
    for (const d of ds) relay.post(d.c.myTag, hello(d))
    // Caio's reveal is swapped for another device's round 1.
    const other = new CreationSession(new DeviceKey(), 3, 3, 2, 'Caio')
    const orig = relay.post.bind(relay)
    relay.post = (from, m) => orig(from, m.type === 'reveal' && from === ds[2]!.c.myTag
      ? { type: 'reveal', r1: b64(other.myRound1()), nonce: m.nonce } : m)
    drain(relay, ds)
    expect(ds[0]!.c.aborted).toBe('conflict')
    expect(posted(relay, 'r2')).toEqual([])
  })

  it('a device that misses a message of the room before confirming stops', () => {
    const { ds } = start()
    ds[0]!.c.noteSeq(1)
    ds[0]!.c.noteSeq(3)
    expect(ds[0]!.c.aborted).toBe('gap')
  })

  it('the vault secret is taken only from the creator, signed, after round 3, once; the creator takes none', () => {
    const { relay, ds } = start()
    const [a, b, c] = ds as [Device, Device, Device]
    for (const d of ds) relay.post(d.c.myTag, hello(d))
    drain(relay, ds)
    const secret = new Uint8Array(32).fill(7)
    expect(a.c.sealSecretToOthers(secret)).toEqual([]) // not before round 3
    confirmAll(relay, ds)
    const boxes = a.c.sealSecretToOthers(secret)
    const toB = boxes.find((x) => x.to === b.c.mySeat)!
    // Unsigned, or signed for another seat, or from a non-creator: refused.
    expect(b.c.takeSecret(a.c.myTag, toB.to, toB.box).secret).toBeNull()
    const toC = boxes.find((x) => x.to === c.c.mySeat)!
    expect(b.c.takeSecret(a.c.myTag, toB.to, toB.box, toC.sig).secret).toBeNull()
    expect(b.c.takeSecret(c.c.myTag, toB.to, toB.box, toB.sig).secret).toBeNull()
    // From the creator, signed: taken. The same box again: ignored.
    expect(b.c.takeSecret(a.c.myTag, toB.to, toB.box, toB.sig).secret).toEqual(secret)
    expect(b.c.takeSecret(a.c.myTag, toB.to, toB.box, toB.sig).secret).toBeNull()
    expect(b.c.aborted).toBeNull()
    // A second, different box the creator signed: stops.
    const again = a.c.sealSecretToOthers(new Uint8Array(32).fill(8)).find((x) => x.to === b.c.mySeat)!
    b.c.takeSecret(a.c.myTag, again.to, again.box, again.sig)
    expect(b.c.aborted).toBe('secret')
    // The creator never takes one.
    expect(a.c.takeSecret(a.c.myTag, a.c.mySeat, toB.box, toB.sig).secret).toBeNull()
  })

  it('the vault secret is not taken before this device finishes round 3', () => {
    const { relay, ds } = start()
    for (const d of ds) relay.post(d.c.myTag, hello(d))
    drain(relay, ds)
    expect(ds[1]!.c.takeSecret(ds[0]!.c.myTag, ds[1]!.c.mySeat, 'AA==', 'aa')).toEqual({ applied: false, secret: null })
  })

  it('a config under this device\'s own tag that it did not set stops it', () => {
    const { relay, ds } = start()
    relay.msgs = [] // the relay serves Bia her own config first
    relay.post(ds[1]!.c.myTag, { type: 'config', v: DKG_VERSION, n: 3, t: 2 })
    drain(relay, [ds[1]!])
    expect(ds[1]!.c.aborted).toBe('conflict')
  })

  it('a creator that holds no seat stops it', () => {
    const relay = new Relay()
    const ds = ['p-a', 'p-b', 'p-c'].map((t) => device(t, t))
    relay.post('p-ghost', { type: 'config', v: DKG_VERSION, n: 3, t: 2 }) // never says hello
    for (const d of ds) relay.post(d.c.myTag, hello(d))
    drain(relay, ds)
    expect(ds.every((d) => d.c.aborted === 'conflict')).toBe(true)
    expect(posted(relay, 'commit')).toEqual([])
  })

  it('every device that confirms agrees on who the creator is', () => {
    const { relay, ds } = start()
    for (const d of ds) relay.post(d.c.myTag, hello(d))
    drain(relay, ds)
    expect(ds.filter((d) => d.c.isCreator).length).toBe(1)
  })

  it('after the code is confirmed, a malformed message is noted, not a stop', () => {
    const { relay, ds } = start()
    for (const d of ds) relay.post(d.c.myTag, hello(d))
    drain(relay, ds)
    for (const d of ds) d.c.confirmCode(d.c.code!)
    relay.post('p-x', { type: 'hello', v: DKG_VERSION, encPub: '%%%not base64%%%' })
    drain(relay, [ds[0]!])
    expect(ds[0]!.c.aborted).toBeNull()
  })

  it('a round-2 box that is not the sender\'s share is refused, and the honest one still completes the vault', () => {
    const { relay, ds } = start()
    for (const d of ds) relay.post(d.c.myTag, hello(d))
    drain(relay, ds)
    const [a, b] = ds as [Device, Device]
    // Anyone can seal to Bia's public key under Ana's label. The forged box carries a real round-2
    // package, from another vault creation, for Bia's seat; it arrives before Ana's real box.
    const aad = new Uint8Array([...new TextEncoder().encode('konclave-dkg-v2 r2 '), 0, a.c.mySeat, 0, b.c.mySeat])
    const other = start()
    for (const d of other.ds) other.relay.post(d.c.myTag, hello(d))
    drain(other.relay, other.ds)
    const box = other.ds[0]!.c.confirmCode(other.ds[0]!.c.code!).out
      .find((m) => m.type === 'r2' && m.to === other.ds[1]!.c.mySeat) as { box: string }
    const pkg = other.ds[1]!.key.open(unb64(box.box), new Uint8Array([...new TextEncoder().encode('konclave-dkg-v2 r2 '), 0, other.ds[0]!.c.mySeat, 0, other.ds[1]!.c.mySeat]))
    const forged = b64(sealTo(b.key.publicBytes(), pkg, aad))
    for (const d of ds.slice(1)) for (const m of d.c.confirmCode(d.c.code!).out) relay.post(d.c.myTag, m)
    relay.post(a.c.myTag, { type: 'r2', to: b.c.mySeat, box: forged })
    for (const m of a.c.confirmCode(a.c.code!).out) relay.post(a.c.myTag, m)
    drain(relay, ds)
    expect(b.c.aborted).toBeNull()
    expect(b.c.part3Done).toBe(true)
  })

  it('a vault secret a member other than the creator seals and signs with its own share is refused', () => {
    const { relay, ds } = start()
    const [, b, c] = ds as [Device, Device, Device]
    for (const d of ds) relay.post(d.c.myTag, hello(d))
    drain(relay, ds)
    confirmAll(relay, ds)
    const s = c.c.session!
    const box = b64(s.sealToSeat(b.c.mySeat, new Uint8Array(32).fill(4)))
    const sig = signVaultSecret(s.keyPackage(), c.c.mySeat, b.c.mySeat, bytesToHex(s.groupVk()), box)
    expect(b.c.takeSecret(c.c.myTag, b.c.mySeat, box, sig).secret).toBeNull()
    expect(c.c.sealSecretToOthers(new Uint8Array(32))).toEqual([]) // and it offers none
  })

  it('the same config from another tag, or a different one from the creator, stops it', () => {
    for (const [from, cfg] of [['p-b', { n: 3, t: 2 }], ['p-a', { n: 3, t: 3 }]] as const) {
      const { relay, ds } = start()
      relay.post(from, { type: 'config', v: DKG_VERSION, ...cfg })
      drain(relay, [ds[2]!])
      expect(ds[2]!.c.aborted).toBe('conflict')
    }
  })

  it('before the config, the roster stops growing at its cap; names are cut to their limit', () => {
    const relay = new Relay()
    const d = device('p-me', 'me')
    for (let i = 0; i < 40; i++) relay.post(`p-${String(i).padStart(3, '0')}`, { type: 'hello', v: DKG_VERSION, encPub: b64(new DeviceKey().publicBytes()), name: 'x'.repeat(100) })
    drain(relay, [d])
    expect(d.c.rosterSize).toBe(32)
    expect(d.c.nameOf('p-000')!.length).toBe(64)
  })

  it('a stopped ceremony takes nothing more', () => {
    const { relay, ds } = start()
    relay.post(ds[0]!.c.myTag, hello(ds[0]!))
    drain(relay, [ds[1]!])
    ds[1]!.c.rejectCode()
    const before = ds[1]!.c.rosterSize
    relay.post(ds[1]!.c.myTag, hello(ds[1]!))
    relay.post(ds[2]!.c.myTag, hello(ds[2]!))
    drain(relay, [ds[1]!])
    expect(ds[1]!.c.rosterSize).toBe(before)
    expect(ds[1]!.c.trySeat()).toEqual([])
  })

  it('round-2 boxes: the same box twice is quiet, a different one after is noted, another seat\'s is ignored', () => {
    const { relay, ds } = start()
    for (const d of ds) relay.post(d.c.myTag, hello(d))
    drain(relay, ds)
    const logs: string[] = []
    ds[1]!.c.onLog = (what) => logs.push(what)
    confirmAll(relay, ds)
    const toB = relay.msgs.find((w) => w.m.type === 'r2' && w.from === ds[0]!.c.myTag && w.m.to === ds[1]!.c.mySeat)!
    const toC = relay.msgs.find((w) => w.m.type === 'r2' && w.from === ds[0]!.c.myTag && w.m.to === ds[2]!.c.mySeat)!
    logs.length = 0
    ds[1]!.c.apply(toB.from, toB.m)
    expect(logs).toEqual([])
    ds[1]!.c.apply(toC.from, toC.m) // addressed to Caio
    expect(logs).toEqual([])
    ds[1]!.c.apply(toB.from, { ...toB.m, box: (toC.m as { box: string }).box, to: ds[1]!.c.mySeat } as DkgMsg)
    expect(logs).toContain('anomaly')
  })

  it('the vault is complete only when every seat proved it finished; a withheld box keeps it incomplete for everyone', () => {
    const { relay, ds } = start()
    const [a, b, c] = ds as [Device, Device, Device]
    for (const d of ds) relay.post(d.c.myTag, hello(d))
    drain(relay, ds)
    // Ana's round-2 box to Bia never arrives (dropped by the relay, or withheld).
    for (const d of ds) {
      for (const m of d.c.confirmCode(d.c.code!).out) {
        if (d === a && m.type === 'r2' && m.to === b.c.mySeat) continue
        relay.post(d.c.myTag, m)
      }
    }
    drain(relay, ds)
    for (const d of ds) for (const m of d.c.markSaved()) relay.post(d.c.myTag, m)
    drain(relay, ds)
    expect(a.c.part3Done).toBe(true)
    expect(b.c.part3Done).toBe(false)
    expect(b.c.markSaved()).toEqual([]) // Bia has no share to save
    expect([a.c.complete, b.c.complete, c.c.complete]).toEqual([false, false, false])
    expect(a.c.waitingFor()).toEqual(['Bia'])
  })

  it('a completion proof that is not signed by that seat\'s new share does not count', () => {
    const { relay, ds } = start()
    for (const d of ds) relay.post(d.c.myTag, hello(d))
    drain(relay, ds)
    const orig = relay.post.bind(relay)
    relay.post = (from, m) => orig(from, m.type === 'done' && from === ds[2]!.c.myTag ? { type: 'done', sig: '00'.repeat(64) } : m)
    for (const d of ds) for (const m of d.c.confirmCode(d.c.code!).out) relay.post(d.c.myTag, m)
    drain(relay, ds)
    for (const d of ds) for (const m of d.c.markSaved()) relay.post(d.c.myTag, m)
    drain(relay, ds)
    expect(ds[0]!.c.part3Done).toBe(true)
    expect(ds[0]!.c.complete).toBe(false)
    expect(ds[0]!.c.waitingFor()).toEqual(['Caio'])
  })

  it('a config whose creator name is not a short text is refused', () => {
    const { relay, ds } = start()
    relay.msgs = []
    relay.post('p-a', { type: 'config', v: DKG_VERSION, n: 3, t: 2, cn: 'x'.repeat(65) })
    drain(relay, [ds[1]!])
    expect(ds[1]!.c.aborted).toBe('conflict')
  })

  it('an invalid first config, even from the creator, stops it', () => {
    for (const bad of [{ n: 1, t: 1 }, { n: 3, t: 0 }, { n: 3, t: 4 }, { n: 33, t: 2 }, { n: 2.5, t: 2 }, { n: 3, t: 1.5 },
      { n: 3, t: 2, g: 'anarchy' }, { n: 3, t: 2, cn: 7 }, { n: 3, t: 2, cn: ['x'] }, { n: 3, t: 2, vn: 'x'.repeat(65) }, { n: 3, t: 2, vn: ['x'] }] as unknown as DkgConfig[]) {
      const { relay, ds } = start()
      relay.msgs = []
      relay.post('p-a', { type: 'config', v: DKG_VERSION, ...bad })
      drain(relay, [ds[1]!])
      expect(ds[1]!.c.aborted, JSON.stringify(bad)).toBe('conflict')
    }
  })

  it('a second config from the creator that differs in any field stops it', () => {
    for (const diff of [{ n: 4 }, { g: 'open' as const }, { cn: 'someone else' }, { vn: 'another name' }]) {
      const { relay, ds } = start()
      relay.post('p-a', { type: 'config', v: DKG_VERSION, n: 3, t: 2, ...diff })
      drain(relay, [ds[1]!])
      expect(ds[1]!.c.aborted, JSON.stringify(diff)).toBe('conflict')
    }
  })

  it('a stopped device neither hands out nor takes the vault secret', () => {
    const { relay, ds } = start()
    const [a, b] = ds as [Device, Device]
    for (const d of ds) relay.post(d.c.myTag, hello(d))
    drain(relay, ds)
    confirmAll(relay, ds)
    const toB = a.c.sealSecretToOthers(new Uint8Array(32).fill(6)).find((x) => x.to === b.c.mySeat)!
    b.c.rejectCode()
    expect(b.c.takeSecret(a.c.myTag, toB.to, toB.box, toB.sig).secret).toBeNull()
    a.c.rejectCode()
    expect(a.c.sealSecretToOthers(new Uint8Array(32))).toEqual([])
  })

  it('a creator in a seat other than the first completes the vault', () => {
    const relay = new Relay()
    const ds = [device('p-c', 'Caio'), device('p-a', 'Ana'), device('p-b', 'Bia')] // creator sorts last
    ds[0]!.c.setOwnConfig({ n: 3, t: 2 })
    relay.post('p-c', { type: 'config', v: DKG_VERSION, n: 3, t: 2 })
    for (const d of ds) relay.post(d.c.myTag, hello(d))
    drain(relay, ds)
    expect(ds[0]!.c.mySeat).toBe(3)
    expect(confirmAll(relay, ds)).toBe(true)
    expect(ds.every((d) => d.c.complete)).toBe(true)
  })

  it('every device learns the vault name the creator chose', () => {
    const relay = new Relay()
    const ds = [device('p-a', 'Ana'), device('p-b', 'Bia'), device('p-c', 'Caio')]
    const cfg = { n: 3, t: 2, vn: 'Tesouraria' }
    ds[0]!.c.setOwnConfig(cfg)
    relay.post('p-a', { type: 'config', v: DKG_VERSION, ...cfg })
    for (const d of ds) relay.post(d.c.myTag, hello(d))
    drain(relay, ds)
    expect(ds.map((d) => d.c.config?.vn)).toEqual(['Tesouraria', 'Tesouraria', 'Tesouraria'])
  })

  it('a device says it finished only after it saved; a lost proof never stops a member saving its share', () => {
    const { relay, ds } = start(2, 2)
    const [a, b] = ds as [Device, Device]
    for (const d of ds) relay.post(d.c.myTag, hello(d))
    drain(relay, ds)
    for (const d of ds) for (const m of d.c.confirmCode(d.c.code!).out) relay.post(d.c.myTag, m)
    drain(relay, ds)
    expect(relay.msgs.filter((w) => w.m.type === 'done')).toEqual([]) // nobody saved yet
    expect([a.c.part3Done, b.c.part3Done]).toEqual([true, true]) // both may save now
    // Ana saves; her proof is lost on the way to Bia. Bia saves anyway, and Ana completes.
    a.c.markSaved()
    for (const m of b.c.markSaved()) relay.post(b.c.myTag, m)
    drain(relay, ds)
    expect(a.c.complete).toBe(true)
    expect(b.c.complete).toBe(false) // Bia shows no address, but she holds her share
  })

  it('a completion proof that arrives before this device\'s own round 3 is kept for later, not lost', () => {
    const { relay, ds } = start(2, 2)
    const [a, b] = ds as [Device, Device]
    for (const d of ds) relay.post(d.c.myTag, hello(d))
    drain(relay, ds)
    const aOut = a.c.confirmCode(a.c.code!).out
    const bOut = b.c.confirmCode(b.c.code!).out
    for (const m of bOut) a.c.apply(b.c.myTag, m)
    const [done] = a.c.markSaved() as [DkgMsg]
    // A relay delivers Ana's proof to Bia before Ana's round-2 box: not judged yet, offered again.
    expect(b.c.apply(a.c.myTag, done)).toEqual({ applied: false, out: [] })
    for (const m of aOut) b.c.apply(a.c.myTag, m)
    expect(b.c.apply(a.c.myTag, done).applied).toBe(true)
    b.c.markSaved()
    expect(b.c.complete).toBe(true)
  })
})

describe('sealing during vault creation has one implementation', () => {
  it('no app code seals to a key or drives the previous DKG itself', () => {
    // The round-2 packages and the vault secret are sealed inside WASM (CreationSession), to the
    // keys bound into the code. A caller of sealTo, or of the previous DkgSession, would be a
    // second, unchecked answer to "whose key does this secret go to".
    const SRC = new URL('.', import.meta.url).pathname
    const files = (dir: string, out: string[] = []): string[] => {
      for (const name of readdirSync(dir)) {
        const p = join(dir, name)
        if (statSync(p).isDirectory()) { if (name !== 'wasm-pkg') files(p, out); continue }
        if (/\.(ts|tsx)$/.test(name) && !/\.test\.tsx?$/.test(name)) out.push(p)
      }
      return out
    }
    const offenders = files(SRC)
      .filter((p) => /import\s*\{[^}]*\b(sealTo|DkgSession)\b[^}]*\}\s*from\s*['"][^'"]*wasm-pkg/.test(codeAt(p)))
      .map((p) => relative(SRC, p))
    expect(offenders).toEqual([])
  })
})

describe('NetVault routes the creation ceremony through DkgCeremony', () => {
  // NetVault has no test harness of its own; these pin the places it must defer to the ceremony,
  // so removing one is a red test rather than a silent gap.
  const nv = codeAt(new URL('./screens/NetVault.tsx', import.meta.url).pathname)
  it('reports every relay message to the ceremony, in order', () => {
    expect(nv).toMatch(/\(m: RelayMsg\) => \{\s*ceremonyRef\.current\?\.noteSeq\(m\.seq\)/)
  })
  it('refuses to save a stopped ceremony, right before saving', () => {
    expect(nv).toMatch(/if \(ceremonyRef\.current\?\.aborted\)[^\n]*return \}\s*await saveVault\(/)
  })
  it('a stopped ceremony offers no vault to sign with and leaves the room', () => {
    expect(nv).toMatch(/hasVault: \(\) => part3DoneRef\.current && !ceremonyRef\.current\?\.aborted/)
    expect(nv).toMatch(/cer\.onAbort = [\s\S]{0,300}?sessionRef\.current\?\.stop\(\)/)
  })
  it('lets a member save once its own round 3 is done, and registers only once every member saved', () => {
    expect(nv).toMatch(/if \(!dkg \|\| !ceremonyRef\.current\?\.part3Done \|\| ceremonyRef\.current\?\.aborted\) return/)
    expect(nv).toMatch(/for \(const m of cer\.markSaved\(\)\) await send\(m\)/)
    expect(nv).toMatch(/if \(cer\.complete && !part3DoneRef\.current\) void finishVault\(\)/)
    expect(nv).not.toMatch(/registerVault\([^)]*\)[\s\S]{0,40}onRound3/)
  })
  it('saves the vault as pending, clears it only when every member saved, and the modal waits for that', () => {
    expect(nv).toMatch(/pending: true, threshold: cfg\?\.t, total: cfg\?\.n, cp: CREATION_PROTOCOL \}, savePass\)/)
    expect(nv).toMatch(/const finished = !helperConfigured\(\) \|\| !!addr[\s\S]{0,200}pending: false/)
    expect(nv).toMatch(/if \(embedded && finished && !backup\) openDashboard\(\)/)
  })
  it('finishVault reads the coordinator\'s answer through the one deposit rule, and backs up only a finished vault', () => {
    // The deposit rule now lives in the one registration function, which the creation calls.
    expect(codeAt(new URL('./conclude-registration.ts', import.meta.url).pathname)).toMatch(/depositAddress\(\{ ...rec, pending: false \}, addressText\(v\.address\), \{ threshold: v\.threshold, total: v\.total \}\)/)
    expect(nv).toMatch(/await concludeRegistration\(saved\.vaultId\)/)
    expect(nv).toMatch(/if \(saved && pass && finished\) \{/)
  })
  it('a member saves only once it holds the vault\'s access secret', () => {
    expect(nv).toMatch(/if \(!ceremonyRef\.current\.isCreator && !accessSecretRef\.current\) return/)
    expect((nv.match(/\|\| !hasSecret/g) ?? []).length).toBe(2) // both save buttons
  })
  it('drops the passphrase when the ceremony stops or the screen closes', () => {
    expect(nv).toMatch(/cer\.onAbort = [\s\S]{0,400}?savePassRef\.current = ''/)
    expect(nv).toMatch(/sessionRef\.current\?\.stop\(\)\s*savePassRef\.current = ''/)
  })
  it('a vault left unfinished is finished only by the member, in two steps, from the vault list', () => {
    const vl = codeAt(new URL('./screens/Vaults.tsx', import.meta.url).pathname)
    expect(vl).toMatch(/finishing !== v\.id \?[\s\S]{0,1200}?disabled=\{finishArmed !== v\.id\}[\s\S]{0,300}?updateVaultMeta\(v\.id, \{ pending: false \}\)/)
  })
  it('lets no rejoin touch the seats while a vault is being created', () => {
    expect(nv).toMatch(/parsed\.type === 'rejoin'\) \{\s*if \(ceremonyRef\.current\) return true/)
  })
})
