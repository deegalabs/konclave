// The thin React layer for Stage 3 (issue #49): pipe a RelaySession on the vault's signing room
// into the tested BackgroundSession, so an unlocked vault SIGNS IN THE BACKGROUND. All the logic
// lives in the tested core (SigningMachine/BackgroundSigner/SigningSeats/BackgroundSession); this
// hook is only lifecycle glue - open the room on mount, seat, stop on unmount, and hold the
// singleton lock so two tabs never double-sign. The Dashboard will consume this; /lab validates it.

import { useCallback, useEffect, useRef, useState } from 'react'
import init from './wasm-pkg/konclave_wasm.js'
import wasmUrl from './wasm-pkg/konclave_wasm_bg.wasm?url'
import { RelaySession, relayPost, ephemeralTag } from './net'
import { getUnlockedShare } from './session'
import { decodeBundle } from './signing'
import { BackgroundSession } from './background-session'
import { signingRoom, signingRoomFromSecret, acquireSigner, releaseSigner, type GovernanceGate } from './background-signer'
import type { FailureCode } from './background-session'
import { registerDeviceKey } from './helper'
import { deviceCommsKey, devicePubHex } from './device-key'
import { unsealSignRequest } from './net-sign'

const hex = (b: Uint8Array) => Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('')

export interface BackgroundSignerState {
  ready: boolean // the session is seated and listening on the signing room
  room: string
  seatCount: number
  phase: 'idle' | 'signing' | 'signed'
  signature: { hex: string; ok: boolean } | null
  what: { zec: string; addr: string } | null
  error: string
  /** Seats that have explicitly signed the proposal now on screen. */
  armedSeats: number[]
  /** True once this device's own arming completed the quorum: it is the one that sends. */
  iSend: boolean
  /** Announce that this device's owner signed `proposal`. */
  arm: (proposal: string) => Promise<void>
  /** Withdraw every signature for `proposal` after a failed attempt: nothing moved, so the payment
   *  goes back to unsigned on every device instead of looking signed by devices that have gone.
   *  `code` tells the OTHER devices why, so they are not left on "sending" forever. */
  unarm: (proposal: string, code?: FailureCode) => Promise<void>
  /** An attempt failed elsewhere: the coarse reason, for a device that signed but did not send. */
  peerFailure: FailureCode | null
  /** Clear the peer failure once it has been read. */
  clearPeerFailure: () => void
  /** Point the signer at the payment now on screen (null when none). Changing payment starts a
   *  fresh tally AND drops any standing "this device sends" decision. */
  setProposal: (id: string | null) => void
  /** Re-drive after arming a manual-mode payment (a gate-pending request then proceeds). */
  retry: () => Promise<void>
  /** DEV/validation: publish a raw sign-request into the room (the helper does this in production). */
  inject: (requestJson: string) => Promise<void>
}

/**
 * Run a background signer for an UNLOCKED vault. `gate` is the governance policy (default: never
 * sign - the safe default; the caller supplies the real per-vault auto/manual + approval logic).
 * Returns null-ish state until the vault's share is unlocked in this session.
 */
export function useBackgroundSigner(
  // `nonce` lets the caller force a re-seat (e.g. after unlocking the share in-session) without
  // changing the vault id.
  vault: { id: string; nonce?: number } | null,
  gate: GovernanceGate = () => false,
): BackgroundSignerState {
  const [room, setRoom] = useState('')
  const [ready, setReady] = useState(false)
  const [seatCount, setSeatCount] = useState(0)
  const [phase, setPhase] = useState<'idle' | 'signing' | 'signed'>('idle')
  const [signature, setSignature] = useState<{ hex: string; ok: boolean } | null>(null)
  const [what, setWhat] = useState<{ zec: string; addr: string } | null>(null)
  const [error, setError] = useState('')
  const [armedSeats, setArmedSeats] = useState<number[]>([])
  const [iSend, setISend] = useState(false)
  const [peerFailure, setPeerFailure] = useState<FailureCode | null>(null)
  // The payment the signer is scoped to, so a change resets exactly once (and not on every render).
  const proposalRef = useRef<string | null>(null)
  // The last payment this hook's view was bound to. Like BackgroundSession.machineProposal it only
  // moves forward to a real payment, so closing the panel (id -> null) never wipes what is on it.
  const boundRef = useRef<string | null>(null)
  const setProposal = useCallback((id: string | null) => {
    if (proposalRef.current === id) return
    proposalRef.current = id
    // Drop the standing decision with the tally. Left set, a member who sent the LAST payment would
    // have the next one broadcast the instant it opened - no signature, no confirm.
    setISend(false)
    setArmedSeats([])
    setPeerFailure(null)
    // A DIFFERENT payment starts from nothing. The phase, the signature, the description and the
    // error all describe a ceremony that is over; carrying them across is how the panel opened on a
    // new payroll still showing the previous one as sent (#354).
    if (id !== null && id !== boundRef.current) {
      boundRef.current = id
      setPhase('idle')
      setSignature(null)
      setWhat(null)
      setError('')
    }
    sessionRef.current?.setProposal(id)
  }, [])
  const relayRef = useRef<RelaySession | null>(null)
  const sessionRef = useRef<BackgroundSession | null>(null)
  const roomRef = useRef('')
  const gateRef = useRef(gate)
  gateRef.current = gate

  const id = vault?.id ?? null
  const nonce = vault?.nonce
  useEffect(() => {
    if (!id) return
    const loaded = getUnlockedShare(id)
    if (!loaded) return // not unlocked in this session
    let stopped = false
    let acquired = false
    void (async () => {
      try {
        await init(wasmUrl)
        const b = decodeBundle(loaded)
        // This device's persistent comms identity (#63): derived from its share, used to register
        // with the helper (so it can seal SignRequests to us) and to OPEN the sealed request off the
        // relay. Best-effort and idempotent registration; never blocks signing, and an unsealed
        // request stays the compat fallback until every device registers.
        const deviceKey = deviceCommsKey(b.keyPackage)
        const myPub = devicePubHex(b.keyPackage)
        void registerDeviceKey(hex(loaded.groupKey), myPub)
        if (!acquireSigner(id)) {
          setError('another signer is already active for this vault on this device')
          return
        }
        acquired = true
        // #388: a migrated vault (every device holds S) meets in the S-room, so an id-only outsider
        // cannot compute or observe it. A pre-#388 vault (no S) stays on the group-key room. It is
        // all-or-nothing per vault (S is distributed to every seat at the DKG), so all signers agree.
        const r = loaded.accessSecret
          ? await signingRoomFromSecret(loaded.accessSecret)
          : await signingRoom(hex(loaded.groupKey))
        if (stopped) return
        roomRef.current = r
        setRoom(r)
        const myTag = ephemeralTag()
        // Who sends is decided by the room's ordered log, not by who clicked first: the device whose
        // arming completes the quorum is named the trigger, and every device computes the same name.
        // So two people signing at the same instant still produce exactly ONE send.
        const session = new BackgroundSession({
          myTag,
          mySeat: b.seat,
          signingMaterial: () => ({ keyPackage: b.keyPackage, groupVk: b.groupVk, pubkeys: b.pubkeys }),
          threshold: () => b.t,
          send: (data) => relayRef.current?.send(data) ?? Promise.resolve(false),
          gate: (ctx) => gateRef.current(ctx), // live gate, so a policy change takes effect
          onSeatCount: setSeatCount,
          onPhase: setPhase,
          onWhat: setWhat,
          onSignature: (h, ok) => setSignature({ hex: h, ok }),
          onFailed: setPeerFailure,
          onArmed: (seats, triggerTag) => {
            setArmedSeats(seats)
            if (triggerTag === myTag) setISend(true)
          },
          onError: setError,
        })
        sessionRef.current = session
        // The panel may have opened before this session existed; scope it now, or every signature
        // that arrives would be dropped as belonging to "no payment" and nobody could sign.
        session.setProposal(proposalRef.current)
        // History is read back (the arming tally is rebuilt from it), and each message says whether
        // it is history or live. The session decides per type: arming yes, ceremony no (#354, #356).
        // Open a sealed request (#63) before the session sees it; a plaintext request passes through.
        const relay = new RelaySession(r, myTag, (m, hist) =>
          void session.onMessage(m.from, unsealSignRequest(m.data, deviceKey, myPub), hist),
        )
        relayRef.current = relay
        relay.start()
        await session.start() // announce this device's seat
        if (!stopped) setReady(true)
      } catch (e) {
        setError(String(e))
      }
    })()
    return () => {
      stopped = true
      relayRef.current?.stop()
      relayRef.current = null
      sessionRef.current = null
      if (acquired) releaseSigner(id)
      setReady(false)
    }
  }, [id, nonce])

  return {
    ready,
    room,
    seatCount,
    armedSeats,
    iSend,
    arm: async (proposal: string) => { await sessionRef.current?.arm(proposal) },
    unarm: async (proposal: string, code?: FailureCode) => {
      setISend(false)
      await sessionRef.current?.unarm(proposal, code)
    },
    peerFailure,
    clearPeerFailure: () => setPeerFailure(null),
    setProposal,
    phase,
    signature,
    what,
    error,
    retry: async () => { await sessionRef.current?.retry() },
    inject: async (requestJson: string) => {
      if (roomRef.current) await relayPost(roomRef.current, 'lab-helper', requestJson)
    },
  }
}
