// One device's side of the vault creation ceremony over the relay. Lifted out of NetVault so the
// rules that decide who gets a seat, and what this device does with each message, live in one
// place with no React, and can be driven by a test the way the relay drives a device.
//
// The cryptographic half lives in WASM (`CreationSession`, `konclave-wasm` `creation`): every key,
// name and round-1 package the DKG uses enters there, is bound into one transcript, and becomes the
// code the members read to each other. Round 2 runs only after `confirmCode` with that code, and
// WASM seals each package itself to the key in the transcript. This class decides what is offered
// to WASM and when; it never holds a round-2 package in the clear and never seals to a key itself.
//
// The rules, each enforced here and nowhere else:
// - The relay's order decides. Messages arrive in `seq` order from 1 with no gap (`noteSeq`).
// - Every device speaks version 2: a config or hello without it, or a message of the previous
//   version, stops the ceremony (an old build cannot take part, and says so).
// - The first `config` names the vault (its name, quorum, governance) and its creator. Another that differs, or one that is not
//   a valid vault (t of n), stops it.
// - The first `hello` per tag is that tag's key. Another key for the same tag, or for this device's
//   own tag, stops it. The seats are the first n distinct tags by `seq`; a device beyond them is
//   told it is not in this vault, and a hello beyond them stops everyone else.
// - Each seat commits once, then reveals once; WASM checks each reveal against its commitment.
// - Before the code is confirmed, anything inconsistent stops the ceremony. After it is confirmed,
//   everything that matters is already bound, so a late anomaly is only logged.
// - The creator is the sender of the first config, must hold a seat, and its seat is bound into the
//   code, so every device that confirms agrees on who mints the vault secret.
// - The vault secret is taken only from the creator's seat, only after round 3, only with the
//   creator's share signature over it, once; a second, different one stops the ceremony.
// - A device says it finished (signed with its new share) only after it saved its share; the vault
//   is complete only when every seat has, and only then is it registered or its address shown, so
//   no one funds a vault a member does not hold.
// A stop is final: nothing is sealed or sent after it, and the vault is not saved.
import { CreationSession, DeviceKey } from './wasm-pkg/konclave_wasm.js'
import { b64, unb64, bytesEqual } from './net'
import { bytesToHex } from './bytes'
import { signVaultSecret, vaultSecretIsProven, signCreated, createdIsProven } from './room-auth'
import type { Governance } from './storage'
import { CREATION_PROTOCOL } from './creation-protocol'

export const DKG_VERSION = CREATION_PROTOCOL

export type DkgConfig = { n: number; t: number; g?: Governance; cn?: string; vn?: string }

export type DkgMsg =
  | ({ type: 'config'; v?: number } & DkgConfig)
  | { type: 'hello'; v?: number; encPub: string; name?: string }
  | { type: 'commit'; c: string }
  | { type: 'reveal'; r1: string; nonce: string }
  | { type: 'r2'; to: number; box: string }
  // A seat finished round 3: a signature by its new share over the vault.
  | { type: 'done'; sig: string }
  // The previous version's round 1. Its presence means a device on an old build is in the room.
  | { type: 'r1'; pkg: string }

/** Why a ceremony stopped. Final: nothing is sealed or sent after it.
 *  `conflict`: two claims for one place (a tag, a seat, the config, a commitment); `extra`: more
 *  devices than seats; `excluded`: this device arrived after the seats were taken; `gap`: this device did not see every message of the room, in order;
 *  `version`: a device on another version; `failed`: a ceremony step failed; `mismatch`: the
 *  members said the codes did not match; `secret`: the vault's access secret arrived twice, differently. */
export type DkgAbort = 'conflict' | 'extra' | 'excluded' | 'gap' | 'version' | 'failed' | 'mismatch' | 'secret'

export interface SeatRow {
  tag: string
  encPub: Uint8Array
  seat: number
}

/** What applying one message did: `applied: false` means "not yet, offer it again later". */
export interface Applied {
  applied: boolean
  out: DkgMsg[]
}

// Before the config says how many seats there are, a roster stops growing here, so a flood cannot
// grow it without bound. Also the largest vault WASM accepts.
const MAX_SEATS = 32
const MAX_NAME = 64

/** A quorum the signing library accepts: frost-core refuses `min_signers < 2` (#589). Shared with the
 * screen so the floor is written once. */
export const quorumIsPossible = (t: number, n: number) =>
  Number.isInteger(n) && Number.isInteger(t) && t >= 2 && t <= n && n >= 2 && n <= MAX_SEATS

const validConfig = (c: DkgConfig) =>
  quorumIsPossible(c.t, c.n)
  && (c.g === undefined || c.g === 'quorum' || c.g === 'open')
  && (c.cn === undefined || (typeof c.cn === 'string' && c.cn.length <= MAX_NAME))
  && (c.vn === undefined || (typeof c.vn === 'string' && c.vn.length <= MAX_NAME))

const sameConfig = (a: DkgConfig, b: DkgConfig) => a.n === b.n && a.t === b.t && a.g === b.g && a.cn === b.cn && a.vn === b.vn

export class DkgCeremony {
  readonly myTag: string
  private readonly deviceKey: DeviceKey
  private readonly myEncPub: Uint8Array
  private readonly room: string
  config: DkgConfig | null = null
  aborted: DkgAbort | null = null
  session: CreationSession | null = null
  private readonly roster = new Map<string, Uint8Array>() // tag -> encPub, in relay order
  private readonly names = new Map<string, string>()
  seatByTag = new Map<string, number>()
  seatTable: SeatRow[] = []
  mySeat = 0
  /** Seated (this device has a seat and has committed). */
  started = false
  /** The seats were counted and this device is not among them. */
  excluded = false
  private revealed = false
  private readonly reveals = new Set<number>()
  /** The code the members compare, once every seat has revealed. */
  code: string | null = null
  confirmed = false
  part2Done = false
  part3Done = false
  private readonly r2Seen = new Map<number, string>() // seat -> the box taken from it
  private readonly doneSeats = new Set<number>() // seats that proved they finished
  private creatorTag: string | null = null
  private lastSeq = 0
  private secretBox: string | null = null
  /** Called when a ceremony aborts, once, with the reason. */
  onAbort?: (why: DkgAbort) => void
  /** Called once, when the code is ready to compare. */
  onCode?: (code: string, names: string[]) => void
  /** Progress worth showing in the ceremony log. */
  onLog?: (what: 'r2From' | 'cantOpen' | 'anomaly', seat: number) => void

  constructor(myTag: string, deviceKey: DeviceKey, room: string) {
    this.myTag = myTag
    this.deviceKey = deviceKey
    this.myEncPub = deviceKey.publicBytes()
    this.room = room
  }

  get rosterSize(): number {
    return this.roster.size
  }

  nameOf(tag: string): string | undefined {
    return this.names.get(tag)
  }

  seatOf(tag: string): number | undefined {
    return this.seatByTag.get(tag)
  }

  /** The members' names in seat order, as bound into the code. */
  seatNames(): string[] {
    return this.seatTable.map((r) => this.names.get(r.tag) ?? '')
  }

  /** The creator's own config, set locally before it is posted. */
  setOwnConfig(c: DkgConfig): void {
    this.config = c
    this.creatorTag = this.myTag
  }

  get isCreator(): boolean {
    return this.creatorTag === this.myTag
  }

  private abort(why: DkgAbort): void {
    if (this.aborted) return
    this.aborted = why
    this.onAbort?.(why)
  }

  /** Before the code is confirmed an anomaly stops the ceremony; after, it is only logged. */
  private anomaly(why: DkgAbort): void {
    if (this.confirmed) this.onLog?.('anomaly', 0)
    else this.abort(why)
  }

  /** Report every message of the room, in arrival order. Anything but 1, 2, 3… is a gap. */
  noteSeq(seq: number): void {
    if (seq !== this.lastSeq + 1) this.anomaly('gap')
    this.lastSeq = Math.max(this.lastSeq, seq)
  }

  /** Apply one ceremony message from the relay. */
  apply(from: string, m: DkgMsg): Applied {
    const done: Applied = { applied: true, out: [] }
    if (this.aborted || this.excluded) return done
    try {
      switch (m.type) {
        case 'r1':
          this.anomaly('version')
          return done
        case 'config':
          this.onConfig(from, m)
          return done
        case 'hello':
          this.onHello(from, m)
          return done
        case 'commit':
          return this.onCommit(from, m.c)
        case 'reveal':
          return this.onReveal(from, m.r1, m.nonce)
        case 'r2':
          return this.onR2(from, m.to, m.box)
        case 'done':
          return this.onDone(from, m.sig)
      }
    } catch {
      this.anomaly('failed') // a malformed message: a stop before the code is confirmed, a note after
      return done
    }
  }

  private onConfig(from: string, m: DkgConfig & { v?: number }): void {
    if (m.v !== DKG_VERSION) return this.anomaly('version')
    const c = { n: m.n, t: m.t, g: m.g, cn: m.cn, vn: m.vn }
    if (!validConfig(c)) return this.anomaly('conflict')
    if (this.creatorTag === null) {
      // A config under this device's own tag that this device did not set is not the creator's.
      if (from === this.myTag) return this.anomaly('conflict')
      this.config = c
      this.creatorTag = from
    } else if (from !== this.creatorTag || !sameConfig(this.config!, c)) {
      this.anomaly('conflict')
    }
  }

  private onHello(from: string, m: { v?: number; encPub: string; name?: string }): void {
    if (m.v !== DKG_VERSION) return this.anomaly('version')
    const key = unb64(m.encPub)
    const known = this.roster.get(from)
    if (known) {
      if (!bytesEqual(known, key)) this.anomaly('conflict')
      return // the same device announcing again
    }
    if (from === this.myTag && !bytesEqual(key, this.myEncPub)) return this.anomaly('conflict')
    if (this.config && this.roster.size >= this.config.n) {
      if (from === this.myTag) {
        this.excluded = true
        return this.abort('excluded') // this device is not in this vault
      }
      return this.anomaly('extra')
    }
    if (!this.config && this.roster.size >= MAX_SEATS) return
    this.roster.set(from, key)
    this.names.set(from, (m.name ?? '').slice(0, MAX_NAME))
  }

  /** Seat everyone once the roster is full: returns this device's commitment, if seated. */
  trySeat(): DkgMsg[] {
    const cfg = this.config
    if (this.aborted || this.excluded || !cfg || this.started || this.roster.size < cfg.n) return []
    if (this.roster.size > cfg.n) {
      this.abort('extra')
      return []
    }
    // The first n distinct tags by relay order (the Map keeps insertion order, and messages are
    // applied in `seq` order), numbered by sorted tag.
    const tags = [...this.roster.keys()].sort()
    this.seatByTag = new Map(tags.map((tag, i) => [tag, i + 1]))
    this.seatTable = tags.map((tag, i) => ({ tag, encPub: this.roster.get(tag)!, seat: i + 1 }))
    this.mySeat = this.seatByTag.get(this.myTag) ?? 0
    if (this.creatorTag === null || !this.seatByTag.has(this.creatorTag)) {
      this.abort('conflict') // the creator holds a seat in its own vault; anything else is not this vault
      return []
    }
    if (this.mySeat === 0) {
      this.excluded = true
      this.abort('excluded') // the seats were taken before this device's hello was counted
      return []
    }
    try {
      this.session = new CreationSession(this.deviceKey, this.mySeat, cfg.n, cfg.t)
    } catch {
      this.abort('failed')
      return []
    }
    this.started = true
    return [{ type: 'commit', c: b64(this.session.myCommitment()) }]
  }

  private onCommit(from: string, c: string): Applied {
    if (!this.started) return { applied: false, out: [] } // wait until seated
    const seat = this.seatByTag.get(from)
    if (seat === undefined) return { applied: true, out: [] } // not a seat of this vault
    // WASM refuses a second commitment for a seat, and this seat's announcement if it is not ours.
    try {
      this.session!.addMember(seat, this.roster.get(from)!, this.names.get(from) ?? '', unb64(c))
    } catch {
      this.anomaly('conflict')
      return { applied: true, out: [] }
    }
    if (this.session!.allCommitted() && !this.revealed) {
      this.revealed = true
      return { applied: true, out: [{ type: 'reveal', r1: b64(this.session!.myRound1()), nonce: b64(this.session!.myNonce()) }] }
    }
    return { applied: true, out: [] }
  }

  private onReveal(from: string, r1: string, nonce: string): Applied {
    if (!this.started || !this.session!.allCommitted()) return { applied: false, out: [] }
    const seat = this.seatByTag.get(from)
    if (seat === undefined) return { applied: true, out: [] }
    try {
      this.session!.addReveal(seat, unb64(r1), unb64(nonce)) // checked against its commitment
    } catch {
      this.anomaly('conflict')
      return { applied: true, out: [] }
    }
    this.reveals.add(seat)
    if (this.reveals.size === this.config!.n && this.code === null) {
      const creatorSeat = this.seatByTag.get(this.creatorTag!)!
      this.code = this.session!.freeze(new TextEncoder().encode(this.room), this.config!.g ?? '', this.config!.vn ?? '', this.config!.cn ?? '', creatorSeat)
      this.onCode?.(this.code, this.seatNames())
    }
    return { applied: true, out: [] }
  }

  /** The members read the code to each other and it matched: run round 2. Refused, with nothing
   *  sent, for any other code. */
  confirmCode(code: string): { ok: boolean; out: DkgMsg[] } {
    if (this.aborted || !this.session || this.code === null || this.part2Done) return { ok: false, out: [] }
    try {
      this.session.confirm(code)
    } catch {
      return { ok: false, out: [] }
    }
    this.confirmed = true
    try {
      const boxes = this.session.part2() as Uint8Array[]
      this.part2Done = true
      return {
        ok: true,
        out: boxes.map((b) => ({ type: 'r2' as const, to: (b[0]! << 8) | b[1]!, box: b64(b.slice(2)) })),
      }
    } catch {
      this.abort('failed')
      return { ok: false, out: [] }
    }
  }

  /** A member said the codes did not match. */
  rejectCode(): void {
    this.abort('mismatch')
  }

  private onR2(from: string, to: number, box: string): Applied {
    if (!this.part2Done) return { applied: false, out: [] } // can't open before my round 2
    if (to !== this.mySeat) return { applied: true, out: [] } // addressed to someone else
    const seat = this.seatByTag.get(from)
    if (seat === undefined) return { applied: true, out: [] }
    const seen = this.r2Seen.get(seat)
    if (seen !== undefined) {
      if (seen !== box) this.onLog?.('anomaly', seat)
      return { applied: true, out: [] }
    }
    let complete: boolean
    try {
      complete = this.session!.addRound2(seat, unb64(box))
    } catch (e) {
      // Every share is checked before it is kept, so a bad box is just not this seat's and the
      // honest one can still arrive; only a failure of round 3 itself ends the ceremony.
      if (String(e).includes('round 3 failed')) this.abort('failed')
      else this.onLog?.('cantOpen', seat)
      return { applied: true, out: [] }
    }
    this.r2Seen.set(seat, box)
    this.onLog?.('r2From', seat)
    if (complete) this.part3Done = true
    return { applied: true, out: [] }
  }

  /** This device saved its share: now, and only now, it tells the others it finished. So the vault
   *  is complete (and gets an address) only once every member holds its share on its device. */
  markSaved(): DkgMsg[] {
    if (this.aborted || !this.part3Done || this.doneSeats.has(this.mySeat)) return []
    this.doneSeats.add(this.mySeat)
    const s = this.session!
    return [{ type: 'done', sig: signCreated(s.keyPackage(), this.mySeat, bytesToHex(s.groupVk())) }]
  }

  private onDone(from: string, sig: string): Applied {
    if (!this.part3Done) return { applied: false, out: [] } // judged against this device's own round 3
    const seat = this.seatByTag.get(from)
    if (seat === undefined || seat === this.mySeat) return { applied: true, out: [] }
    const s = this.session!
    if (createdIsProven({ groupVk: s.groupVk(), pubkeys: s.pubkeys() }, seat, sig)) this.doneSeats.add(seat)
    else this.onLog?.('anomaly', seat)
    return { applied: true, out: [] }
  }

  /** Every seat saved its share and proved it: only now may the vault be registered or shown. */
  get complete(): boolean {
    return this.part3Done && this.config !== null && this.doneSeats.size === this.config.n
  }

  /** The names of the seats that have not yet proven they finished. */
  waitingFor(): string[] {
    return this.seatTable.filter((r) => !this.doneSeats.has(r.seat)).map((r) => this.names.get(r.tag) || `#${r.seat}`)
  }

  /** The creator, after round 3: the vault secret sealed and signed to every other seat. */
  sealSecretToOthers(secret: Uint8Array): { to: number; box: string; sig: string }[] {
    if (this.aborted || !this.isCreator || !this.part3Done) return []
    const s = this.session!
    const vk = bytesToHex(s.groupVk())
    return this.seatTable
      .filter((r) => r.seat !== this.mySeat)
      .map((r) => {
        const box = b64(s.sealToSeat(r.seat, secret))
        return { to: r.seat, box, sig: signVaultSecret(s.keyPackage(), this.mySeat, r.seat, vk, box) }
      })
  }

  /** The vault secret the creator sealed to this seat: only from the creator's seat, only after
   *  round 3, only with the creator's share signature over this box, and only the first one; a
   *  second, different one stops the ceremony. `applied: false` means "too early, offer it again".
   *  The creator itself never takes one: it mints its own. */
  takeSecret(from: string, to: number, box: string, sig?: string): { applied: boolean; secret: Uint8Array | null } {
    const none = { applied: true, secret: null }
    if (this.aborted || this.isCreator || to !== this.mySeat || from !== this.creatorTag) return none
    if (!this.part3Done) return { applied: false, secret: null }
    const creatorSeat = this.seatByTag.get(from)
    if (creatorSeat === undefined) return none
    const s = this.session!
    if (!vaultSecretIsProven({ groupVk: s.groupVk(), pubkeys: s.pubkeys() }, creatorSeat, this.mySeat, box, sig)) return none
    if (this.secretBox !== null) {
      if (box !== this.secretBox) this.abort('secret')
      return none
    }
    try {
      const secret = s.openFromSeat(creatorSeat, unb64(box))
      this.secretBox = box
      return { applied: true, secret }
    } catch {
      return none
    }
  }
}
