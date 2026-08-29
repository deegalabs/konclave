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

import { SigningMachine, type SigningDeps, type SignWireMsg } from './signing-machine'
import { parseSignRequest } from './net-sign'
import { unb64 } from './net'

const SIGN_TYPES = new Set(['sreq', 's1', 'sp', 's2', 'signed'])
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

// --- singleton guard: one active signer per vault per device (two tabs must not double-sign) ---
// In-process guard (one JS context / tab). Across tabs, production wraps this with the Web Locks
// API (navigator.locks) keyed by the vault; this registry is the unit-testable core.
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
  private seq = 0
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

  /** Reset for a NEXT payment. Contract: the caller moves to a FRESH signing room per payment, so
   *  the buffered message history is dropped with the state (no cross-payment k collisions). */
  rearm(): void {
    this.machine.rearm()
    this.msgs.length = 0
    this.consumed.clear()
    this.seq = 0
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
        let progressed = true
        while (progressed) {
          progressed = false
          for (const m of this.msgs) {
            if (this.consumed.has(m.seq)) continue
            // A helper sign-request (coordinator kickoff): gate on the payment's sighash.
            const req = parseSignRequest(m.data)
            if (req) {
              if (!(await this.gate({ sighash: req.sighash }))) continue // pending, not rejected
              if (await this.machine.tryHelperRequest(m.data)) {
                this.consumed.add(m.seq)
                progressed = true
              }
              continue
            }
            let parsed: { type?: string; msg?: string }
            try {
              parsed = JSON.parse(m.data) as { type?: string; msg?: string }
            } catch {
              this.consumed.add(m.seq)
              continue
            }
            // An `sreq` makes THIS device contribute its share: gate participation on the sighash.
            if (parsed.type === 'sreq' && parsed.msg) {
              if (!(await this.gate({ sighash: toHex(unb64(parsed.msg)) }))) continue // pending
            }
            if (parsed.type && SIGN_TYPES.has(parsed.type)) {
              if (await this.machine.handle(parsed as SignWireMsg, m.from)) {
                this.consumed.add(m.seq)
                progressed = true
              }
            } else {
              this.consumed.add(m.seq) // not a signing message (e.g. DKG chatter) - ignore
            }
          }
        }
      } while (this.rerun)
    } finally {
      this.pumping = false
    }
  }
}
