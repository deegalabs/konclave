// Transport client for the blind mailbox (orchestrator/src/relay.rs) - the konclave.xyz
// network. A device POSTs an OPAQUE message into a room; the others in the room poll and
// receive it. This client knows nothing about ceremonies: it just moves strings. Whatever
// is sensitive is public-by-design (FROST material) or already sealed to a recipient before
// it reaches here (DKG round-2 packages) - so the relay carrying these bytes stays blind.
//
// Same-origin `/api/relay/*` in production (the local bridge serves this bundle and the
// relay); proxied to :4762 in `npm run dev`. When the relay is hosted (Marco 6) this base
// points at the public relay instead - the shape does not change.

const ENV = import.meta.env as Record<string, string | undefined>
const BASE: string = ENV.VITE_API_BASE ?? ''
// A hosted relay overrides the base; empty = the local bridge (same origin). Exported so the
// Architecture-B send can tell the (server-side) helper WHICH relay the browsers are on - the
// helper must publish its sign-request into the same room, so this must be a URL it can reach
// (a hosted relay, not the local bridge).
export const RELAY_BASE: string = ENV.VITE_RELAY_BASE ?? BASE

// ---- relay selection (#213) ----
// The relay is the rendezvous: every device in a vault (and the helper) must reach the SAME relay
// to find each other. The user can choose WHICH blind relay to use; the default 'ours' is the
// built-in RELAY_BASE, so behavior is unchanged until a relay is actively picked. 'custom' points
// at a self-hosted relay. A curated multi-relay directory (pick the nearest) is the future network.
export type RelayMode = 'ours' | 'custom'
const RELAY_MODE_KEY = 'konclave.relay.mode'
const RELAY_URL_KEY = 'konclave.relay.url'

function relayLs(key: string): string | null {
  try { return localStorage.getItem(key) } catch { return null }
}

/** The chosen relay mode (defaults to the built-in 'ours'). */
export function getRelayMode(): RelayMode {
  return relayLs(RELAY_MODE_KEY) === 'custom' ? 'custom' : 'ours'
}

/** The user-provided self-hosted relay URL (for 'custom' mode), trailing slash trimmed. */
export function getCustomRelay(): string {
  return (relayLs(RELAY_URL_KEY) ?? '').trim().replace(/\/+$/, '')
}

/** Persist the relay choice. Callers reload if any cached state depends on it. */
export function setRelay(mode: RelayMode, url?: string): void {
  try {
    localStorage.setItem(RELAY_MODE_KEY, mode)
    if (url !== undefined) localStorage.setItem(RELAY_URL_KEY, url.trim().replace(/\/+$/, ''))
  } catch { /* storage unavailable - the choice applies this session only */ }
}

/** The EFFECTIVE relay base for the current choice; falls back to the built-in RELAY_BASE. */
export function relayBase(): string {
  if (getRelayMode() === 'custom') {
    const u = getCustomRelay()
    if (u) return u
  }
  return RELAY_BASE
}

// The bridge's CSRF token (window.__KONCLAVE_SESSION__), needed on POST to the LOCAL relay.
// A hosted public relay ignores it; sending it anyway is harmless.
const SESSION: string =
  (typeof window !== 'undefined' && (window as { __KONCLAVE_SESSION__?: string }).__KONCLAVE_SESSION__) || ''

/** One message as it sits in a room. `data` is opaque to the relay and to this client. */
export type RelayMsg = { seq: number; from: string; data: string }

/** Post an opaque message into `room`. Returns the assigned seq + current peer count. */
export async function relayPost(
  room: string,
  from: string,
  data: string,
): Promise<{ seq: number; peers: number } | null> {
  try {
    const res = await fetch(`${relayBase()}/api/relay/${encodeURIComponent(room)}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Konclave-Session': SESSION },
      body: JSON.stringify({ from, data }),
    })
    if (!res.ok) return null
    return (await res.json()) as { seq: number; peers: number }
  } catch {
    return null
  }
}

/** Poll `room` for everything after `since`. `from` marks this device present (peer count). */
export async function relayPoll(
  room: string,
  since: number,
  from: string,
): Promise<{ messages: RelayMsg[]; next: number; peers: number } | null> {
  try {
    const qs = `since=${since}&from=${encodeURIComponent(from)}`
    const res = await fetch(`${relayBase()}/api/relay/${encodeURIComponent(room)}?${qs}`, {
      method: 'GET',
    })
    if (!res.ok) return null
    return (await res.json()) as { messages: RelayMsg[]; next: number; peers: number }
  } catch {
    return null
  }
}

/**
 * A live subscription to a room: polls on an interval, hands each NEW message to `onMessage`
 * (in seq order, exactly once), and reports peer-count changes. Cursor (`since`) advances
 * as messages arrive, so a caught-up device never re-processes a message. Call `stop()` to
 * end the loop (e.g. on unmount or when the ceremony completes).
 *
 * Every message says whether it came from the room's HISTORY (the first poll, i.e. everything
 * posted before this device joined) or arrived live. The signing room needs both answers at once
 * (#354, #356):
 *
 * - The arming tally is REBUILT from history by design - a device that reloads mid-payment has to
 *   learn who already signed, which is why those messages are scoped by proposal and expire on the
 *   wire (#324, #326). Cutting history off starves it: two devices sit at "1 of 2" forever with
 *   both members present and no error.
 * - The FROST ceremony wants the opposite. A finished payment's `sreq` and round-1 commitments
 *   replayed into a fresh ceremony are what FROST rejects as "the participant's commitment is
 *   incorrect", and it survived reloads because the poison lived in the room, not in memory.
 *
 * So the split is not made here. This class only reports WHERE a message came from; the session
 * decides what that means per message type, because only it knows which are replay-safe.
 */
export class RelaySession {
  readonly room: string
  readonly from: string
  private readonly onMessage: (m: RelayMsg, historical: boolean) => void
  private readonly onPeers?: (n: number) => void
  private readonly intervalMs: number
  /** True until the first poll has been delivered: everything in it predates this device joining. */
  private firstPoll = true
  private since = 0
  private timer: ReturnType<typeof setTimeout> | null = null
  private stopped = false
  private peers = 0

  constructor(
    room: string,
    from: string,
    onMessage: (m: RelayMsg, historical: boolean) => void,
    onPeers?: (n: number) => void,
    intervalMs = 700,
  ) {
    this.room = room
    this.from = from
    this.onMessage = onMessage
    this.onPeers = onPeers
    this.intervalMs = intervalMs
  }

  /** Begin polling. Idempotent: a second call is a no-op while running. */
  start(): void {
    if (this.timer || this.stopped) return
    const tick = async () => {
      if (this.stopped) return
      const r = await relayPoll(this.room, this.since, this.from)
      if (r) {
        if (r.peers !== this.peers) {
          this.peers = r.peers
          this.onPeers?.(r.peers)
        }
        const historical = this.firstPoll
        for (const m of r.messages) {
          if (m.seq > this.since) this.since = m.seq
          try {
            this.onMessage(m, historical)
          } catch {
            /* a bad message must not kill the loop */
          }
        }
        this.firstPoll = false
      }
      if (!this.stopped) this.timer = setTimeout(tick, this.intervalMs)
    }
    void tick()
  }

  /** Send an opaque message into this room, tagged as coming from this device. */
  async send(data: string): Promise<boolean> {
    const r = await relayPost(this.room, this.from, data)
    return r !== null
  }

  stop(): void {
    this.stopped = true
    if (this.timer) {
      clearTimeout(this.timer)
      this.timer = null
    }
  }
}

/** A short, human-friendly room code (the "invite code" a guest types on their device). */
export function newRoomCode(): string {
  // Ambiguity-free alphabet (no 0/O/1/I). Not a secret - the security is in the crypto that
  // rides the room, not in the room's name. 8 chars is easy to read aloud / paste.
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'
  const bytes = new Uint8Array(8)
  crypto.getRandomValues(bytes)
  return Array.from(bytes, (b) => alphabet[b % alphabet.length]).join('')
}

/**
 * The effective relay room for a ceremony, from the shared invite `code` and an optional `pin`
 * (issue #65 / ADR-0007 I4 - authenticated admission). With NO pin the room IS the code (the
 * backward-compatible bearer model). With a pin, the room is a 128-bit key derived from both, so a
 * device that has only the code lands in a DIFFERENT (empty) room and never meets the members -
 * the pin, shared out of band and separately from the code, gates admission and can never leak to
 * the relay (only the derived room id transits). Deterministic: every device with the same
 * (code, pin) computes the same room.
 */
export async function deriveRoom(code: string, pin: string): Promise<string> {
  const p = pin.trim()
  if (!p) return code
  const data = new TextEncoder().encode(`konclave-room ${code} ${p}`)
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', data))
  return Array.from(digest.slice(0, 16), (b) => b.toString(16).padStart(2, '0')).join('') // 128-bit hex room id
}

/** A throwaway per-session pseudonym for the `from` tag (never a real identity). */
export function ephemeralTag(): string {
  const bytes = new Uint8Array(6)
  crypto.getRandomValues(bytes)
  return 'p-' + Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('')
}

// base64 codecs for the opaque `data` string the relay carries (canonical home: bytes.ts).
export { b64, unb64 } from './bytes'

/** Compare two byte arrays for equality (identifier matching). */
export function bytesEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false
  return true
}
