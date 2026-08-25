// The governance policy for background signing (issue #49), as a pure function that produces the
// GovernanceGate the BackgroundSigner consumes. This is the "sign async/sync, configurable per vault
// and changeable by a proposal" layer: the vault carries a signing MODE, and a device only ever
// contributes its share to a payment its owner's quorum APPROVED.
//
//   • auto   - once the proposal is approved by quorum, this device signs automatically (no per-
//              payment click). Good for small, trusted, high-throughput vaults.
//   • manual - even after quorum approval, this device signs only when its owner EXPLICITLY arms
//              this specific payment. A single click never fires money; the owner confirms each one.
//
// The mode is a per-vault setting a governance proposal can change; the gate reads it live, so a
// change takes effect on the next payment. Approval and arming are looked up by the payment's
// sighash (the on-device binding - see H1), never by a mutable proposal label.

import type { GovernanceGate } from './background-signer'

export type SigningMode = 'auto' | 'manual'

/**
 * How long an arming counts. Consent to spend should not outlive the act that gave it: a device
 * left open on a signed payment would otherwise contribute its share to a request that arrives
 * hours later, with nobody watching. The window covers a whole legitimate ceremony with room to
 * spare (the coordinator builds and proves for a minute or two, then waits up to five for the
 * shares) and nothing beyond it. Past it, the device asks its owner to sign again.
 */
export const ARM_TTL_MS = 10 * 60 * 1000

/** Whether an arming made at `armedAt` still counts at `now`. Never armed (`null`) is never live,
 *  and a clock that jumped backwards reads as not-yet-armed rather than as armed forever. */
export function armIsLive(armedAt: number | null, now: number, ttlMs: number = ARM_TTL_MS): boolean {
  if (armedAt === null) return false
  const age = now - armedAt
  return age >= 0 && age <= ttlMs
}

export interface SigningGateInput {
  /** The vault's current signing mode (read live, so a governance change takes effect immediately). */
  mode: () => SigningMode
  /** Is the payment with this sighash approved by quorum (product: its proposal is Ready)? */
  isApproved: (sighash: string) => boolean
  /** In manual mode, has the owner explicitly armed THIS payment to sign? (ignored in auto mode) */
  isArmed: (sighash: string) => boolean
}

/**
 * Build the governance gate. A device NEVER signs an unapproved payment. Beyond that, `auto` signs
 * approved payments on its own; `manual` also requires the owner to arm the specific payment.
 * Returning false leaves the request PENDING (not rejected), so arming (or a later approval) plus a
 * retry proceeds - exactly the manual-approval path the BackgroundSigner supports.
 */
export function makeSigningGate(input: SigningGateInput): GovernanceGate {
  return ({ sighash }) => {
    if (!input.isApproved(sighash)) return false // unapproved: never sign
    return input.mode() === 'auto' ? true : input.isArmed(sighash)
  }
}
