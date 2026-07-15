// Transport client for the blind mailbox (orchestrator/src/relay.rs) — the konclave.app
// network. A device POSTs an OPAQUE message into a room; the others in the room poll and
// receive it. This client knows nothing about ceremonies: it just moves strings. Whatever
// is sensitive is public-by-design (FROST material) or already sealed to a recipient before
// it reaches here (DKG round-2 packages) — so the relay carrying these bytes stays blind.
//
// Same-origin `/api/relay/*` in production (the local bridge serves this bundle and the
// relay); proxied to :4762 in `npm run dev`. When the relay is hosted (Marco 6) this base
// points at the public relay instead — the shape does not change.

const ENV = import.meta.env as Record<string, string | undefined>
const BASE: string = ENV.VITE_API_BASE ?? ''
// A hosted relay overrides the base; empty = the local bridge (same origin).
const RELAY_BASE: string = ENV.VITE_RELAY_BASE ?? BASE

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
    const res = await fetch(`${RELAY_BASE}/api/relay/${encodeURIComponent(room)}`, {
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
    const res = await fetch(`${RELAY_BASE}/api/relay/${encodeURIComponent(room)}?${qs}`, {
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
 */
export class RelaySession {
  readonly room: string
  readonly from: string
  private readonly onMessage: (m: RelayMsg) => void
  private readonly onPeers?: (n: number) => void
  private readonly intervalMs: number
  private since = 0
  private timer: ReturnType<typeof setTimeout> | null = null
  private stopped = false
  private peers = 0

  constructor(
    room: string,
    from: string,
    onMessage: (m: RelayMsg) => void,
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
        for (const m of r.messages) {
          if (m.seq > this.since) this.since = m.seq
          try {
            this.onMessage(m)
          } catch {
            /* a bad message must not kill the loop */
          }
        }
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
  // Ambiguity-free alphabet (no 0/O/1/I). Not a secret — the security is in the crypto that
  // rides the room, not in the room's name. 8 chars is easy to read aloud / paste.
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'
  const bytes = new Uint8Array(8)
  crypto.getRandomValues(bytes)
  return Array.from(bytes, (b) => alphabet[b % alphabet.length]).join('')
}

/** A throwaway per-session pseudonym for the `from` tag (never a real identity). */
export function ephemeralTag(): string {
  const bytes = new Uint8Array(6)
  crypto.getRandomValues(bytes)
  return 'p-' + Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('')
}

/** Encode bytes as base64 for the opaque `data` string the relay carries. */
export function b64(bytes: Uint8Array): string {
  let s = ''
  for (const byte of bytes) s += String.fromCharCode(byte)
  return btoa(s)
}

/** Decode a base64 wire string back to bytes. */
export function unb64(s: string): Uint8Array {
  const bin = atob(s)
  const out = new Uint8Array(bin.length)
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i)
  return out
}

/** Compare two byte arrays for equality (identifier matching). */
export function bytesEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false
  return true
}
