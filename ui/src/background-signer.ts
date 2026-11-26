// The app-level background signer (issue #49, Stage 3). It lets a send run FROM THE DASHBOARD:
// the device stays unlocked, a BackgroundSigner listens on the vault's own signing room, and when
// an (approved) payment's sign-request arrives it drives the shared SigningMachine to a signature
// - no "go to /net", no re-login. /net keeps its own once-per-session flow unchanged.
//
// Separation of concerns, on purpose:
//   • SigningMachine  = the FROST ceremony (mechanism).
//   • BackgroundSigner = drives it over the relay + a GOVERNANCE GATE (mechanism + policy hook).
//   • `gate`          = the policy itself, injected by the caller: whether THIS device contributes
//                       its share to THIS payment. A vault can be "auto-sign" or "sign only after I
//                       approve", and a governance proposal can change that - all of it lives in the
//                       caller's `gate`, so the signer never has to know the governance model.

import { SigningMachine, parseSignWire, type SigningDeps } from './signing-machine'
import { parseSignRequest } from './net-sign'
import { unb64 } from './net'

const toHex = (b: Uint8Array) => Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('')

/** A vault's own signing room: a deterministic id derived from its group verifying key, DOMAIN
 *  SEPARATED from the DKG/create room so a signing session never collides with a creation session.
 *  Every device that holds the vault computes the same room with no coordination; the relay only
 *  ever sees this hash and the public/sealed ceremony bytes, so it stays blind. */
export async function signingRoom(groupKeyHex: string): Promise<string> {
  const data = new TextEncoder().encode('konclave-sign ' + groupKeyHex.trim().toLowerCase())
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', data))
  return toHex(digest.slice(0, 16)) // 128-bit hex room id
}

/** The signing room for a MIGRATED vault (#388): derived from the per-vault secret S, not the public
 *  group key, so an id-only outsider can neither compute nor observe it. Domain-separated from the
 *  group-key room (`-s` prefix) so a vault never collides with its own legacy room. Only vaults where
 *  every device holds S use it, so all signers still land on the same room. */
export async function signingRoomFromSecret(secret: Uint8Array): Promise<string> {
  const data = new TextEncoder().encode('konclave-sign-s ' + toHex(secret))
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', data))
  return toHex(digest.slice(0, 16)) // 128-bit hex room id
}

// --- singleton guard: one active signer per vault seat per device (two tabs must not double-sign) ---
// In-process guard (one JS context / tab). Across tabs, `acquireSignerAcrossTabs` below wraps it
// with a Web Lock (navigator.locks) keyed the same way; this registry is the unit-testable core.
const activeVaults = new Set<string>()

/** Try to become THE background signer for `vaultId` in this context. Returns false if one is
 *  already active (the caller should not start a second) - release() when the signer stops. */
export function acquireSigner(vaultId: string): boolean {
  if (activeVaults.has(vaultId)) return false
  activeVaults.add(vaultId)
  return true
}
export function releaseSigner(vaultId: string): void {
  activeVaults.delete(vaultId)
}
export function isSignerActive(vaultId: string): boolean {
  return activeVaults.has(vaultId)
}

/** A signer's hold on its vault seat in this browser (#285). */
export interface SignerLock {
  /** true once this tab is THE signer for the seat; false if it was released first. */
  granted: Promise<boolean>
  /** Idempotent. Frees the in-process guard in this very call (so the same tab can re-seat at
   *  once), withdraws a request still waiting, and lets a held lock go. */
  release(): void
}

const isAbort = (e: unknown) => (e as { name?: string } | null)?.name === 'AbortError'

/**
 * Become the background signer for one seat of one vault, across every tab and window of this
 * browser. Two tabs of the same member signing the same seat would each seat and contribute from
 * different nonces, so only one may run: the others WAIT in the browser's lock queue (`onBusy`
 * says so, for the panel to show) and take over when the first one stops. This is a product lock,
 * not a cryptographic one.
 *
 * null: this tab already runs (or awaits) a signer for the seat. With no lock manager (an insecure
 * context, an old browser), or one that fails, the in-process guard alone decides, as before #285.
 */
export function acquireSignerAcrossTabs(
  vaultId: string,
  seat: number,
  opts: { locks?: LockManager | null; onBusy?: () => void } = {},
): SignerLock | null {
  const key = `${vaultId.trim().toLowerCase()}-${seat}`
  if (!acquireSigner(key)) return null
  const locks = opts.locks === undefined ? globalThis.navigator?.locks : opts.locks
  let released = false
  let letGo: () => void = () => {}
  const held = new Promise<void>((resolve) => { letGo = resolve })
  const abort = new AbortController()
  const release = () => {
    if (released) return
    released = true
    releaseSigner(key)
    abort.abort()
    letGo()
  }
  if (!locks) return { granted: Promise.resolve(true), release }
  const name = `konclave-sign-${key}`
  const hold = (got: (lock: boolean) => void) => async (lock: Lock | null) => {
    got(!!lock)
    if (lock) await held
  }
  let seenBusy = false
  const granted = (async () => {
    try {
      // First without waiting, to know whether another tab has it and say so; then in the queue.
      // No `signal` here: the Web Locks API refuses one together with `ifAvailable`
      // (NotSupportedError), and this answers at once anyway; `held` lets it go on release().
      const free = await new Promise<boolean>((resolve, reject) => {
        locks.request(name, { ifAvailable: true }, hold(resolve)).catch(reject)
      })
      if (!free) {
        if (released) return false
        seenBusy = true
        opts.onBusy?.()
        await new Promise<boolean>((resolve, reject) => {
          locks.request(name, { signal: abort.signal }, hold(resolve)).catch(reject)
        })
      }
      return !released
    } catch (e) {
      // Withdrawn by release(): not an error.
      if (released || isAbort(e)) return false
      // Another tab was seen holding it: never fall back to a second signer for the seat.
      if (seenBusy) return false
      // Any other failure: the in-process guard decides, as before #285. Said, never silent (the
      // lock's name carries the vault id, so it is not logged).
      const why = (e as { name?: string } | null)?.name
      console.warn('signer: the browser lock failed; only this tab is guarded', why)
      return true
    }
  })()
  return { granted, release }
}

/** Governance gate: return true to let THIS device contribute its share to the payment identified
 *  by `sighash`. The policy (per-vault auto/manual, per-proposal approval, changeable by a
 *  governance proposal) lives in the caller. Returning false leaves the request PENDING (not
 *  rejected) so a later approval + retry() can proceed - that is the manual-approval path. */
export type GovernanceGate = (ctx: { sighash: string }) => boolean | Promise<boolean>

export interface BackgroundSignerDeps extends SigningDeps {
  gate: GovernanceGate
}

export class BackgroundSigner {
  private readonly machine: SigningMachine
  private readonly gate: GovernanceGate
  private readonly msgs: { seq: number; from: string; data: string }[] = []
  private readonly consumed = new Set<number>()
  /** Never reset: a number a drain kept from before a `rearm` must not name a message after it. */
  private seq = 0
  /** Moved on by `rearm`. A drain that comes back from an await into a later generation stops: what
   *  it held belongs to the payment before. */
  private gen = 0
  private pumping = false
  private rerun = false

  constructor(deps: BackgroundSignerDeps) {
    const { gate, ...machineDeps } = deps
    this.gate = gate
    this.machine = new SigningMachine(machineDeps)
  }

  /** Feed one relay message from the vault's signing room, then drive the ceremony to a fixpoint.
   *  Call this from the relay subscription (RelaySession.onMessage). */
  async feed(from: string, data: string): Promise<void> {
    this.msgs.push({ seq: this.seq++, from, data })
    await this.pump()
  }

  /** Re-drive without new input - e.g. after the owner approves a proposal, so a previously
   *  gate-pending request now proceeds (the manual-approval path). */
  async retry(): Promise<void> {
    await this.pump()
  }

  /** True once the current ceremony finished (every spend). */
  isDone(): boolean {
    return this.machine.isDone()
  }

  /** Reset for a NEXT payment. The buffered history is dropped with the state, and a drain still
   *  out on an await when this runs keeps nothing it held (`gen`), so no message of one payment is
   *  read into the next. The room may be the same: one per vault, not one per payment. */
  rearm(): void {
    this.gen++
    this.machine.rearm()
    this.msgs.length = 0
    this.consumed.clear()
  }

  // Idempotent fixpoint over the buffered messages, serialized against itself (mirrors NetVault's
  // advance): apply every message whose preconditions are met until no further progress is possible.
  // A gate that returns false leaves its message PENDING (skipped this pass, re-evaluated later).
  private async pump(): Promise<void> {
    if (this.pumping) {
      this.rerun = true
      return
    }
    this.pumping = true
    try {
      do {
        this.rerun = false
        const gen = this.gen
        let progressed = true
        drain: while (progressed) {
          progressed = false
          for (const m of this.msgs) {
            if (this.gen !== gen) break drain
            if (this.consumed.has(m.seq)) continue
            // A helper sign-request (coordinator kickoff): gate on the payment's sighash.
            const req = parseSignRequest(m.data)
            if (req) {
              if (!(await this.gate({ sighash: req.sighash }))) continue // pending, not rejected
              if (this.gen !== gen) break drain
              const taken = await this.machine.tryHelperRequest(m.data)
              if (this.gen !== gen) break drain
              if (taken) {
                this.consumed.add(m.seq)
                progressed = true
              }
              continue
            }
            // One reader for room messages: what is not a signing message is set aside here.
            const parsed = parseSignWire(m.data)
            if (!parsed) {
              this.consumed.add(m.seq) // e.g. DKG chatter
              continue
            }
            // An `sreq` makes THIS device contribute its share: gate participation on the sighash.
            if (parsed.type === 'sreq') {
              if (!(await this.gate({ sighash: toHex(unb64(parsed.msg)) }))) continue // pending
              if (this.gen !== gen) break drain
            }
            const handled = await this.machine.handle(parsed, m.from)
            if (this.gen !== gen) break drain
            if (handled) {
              this.consumed.add(m.seq)
              progressed = true
            }
          }
        }
        // What was consumed is not read again: drop it so neither list grows between rearms.
        if (this.gen === gen) {
          for (let i = this.msgs.length - 1; i >= 0; i--) {
            if (this.consumed.delete(this.msgs[i]!.seq)) this.msgs.splice(i, 1)
          }
        }
        // Nothing left to process. Give the machine its one chance to act on what the whole drain
        // delivered rather than on what each message delivered (#399) - the commitment that reaches
        // threshold usually arrives alone, so a coordinator that waited for a proven seat has
        // nothing to wake it otherwise.
        // A drain cut short by a rearm says nothing about the next payment: the rerun reads it afresh.
        if (this.gen === gen) await this.machine.afterDrain()
      } while (this.rerun)
    } finally {
      this.pumping = false
    }
  }
}
