// The signing gate's approval decision, as a pure, testable unit (#281).
//
// Production today (`VaultSigner.tsx`) injects `isApproved: () => true` and an `isArmed` that
// compares a mutable proposal-id label. This function is where that decision SHOULD live: given the
// approved proposal and the payment a sign-request actually carries (decoded from its PCZT), decide
// whether this device may contribute its share. It binds the signature to what was approved, not to
// a label the coordinator controls.

import { matchesApprovedPayment, type ApprovedLine, type PcztOutput } from './approved-payment'

export interface ApprovalContext {
  /** The lines the quorum approved (one for a payment, N for a payroll), with recipients already
   *  decoded to receiver-hex, comparable to the request's output recipients. */
  approved: ApprovedLine[]
  /** The vault's own receivers (external receive + internal change), hex-encoded, from a trusted
   *  source captured at vault creation. Used to tell change/self from a real external payment - the
   *  device cannot derive these, so they are supplied. */
  ourReceivers: string[]
  /** Manual mode requires the owner to have armed THIS request; auto mode does not. */
  mode: 'auto' | 'manual'
  /** In manual mode: has the owner armed, and is the arming still live? */
  armedAndLive: boolean
}

/** The request a device is being asked to sign: its outputs, decoded from the PCZT (canonicalized
 *  addresses), which is what it actually pays. */
export interface SignRequestOutputs {
  outputs: PcztOutput[]
}

/** May this device contribute its share to `req`? True only when the request pays exactly the
 *  approved payment (whatever its proposal label says) AND (auto mode, or the owner armed it).
 *  Content-bound, not label-bound: this is what stops a swapped destination from being signed. */
export function approvalGateDecision(ctx: ApprovalContext, req: SignRequestOutputs): boolean {
  if (!matchesApprovedPayment(req.outputs, ctx.approved, ctx.ourReceivers)) return false
  return ctx.mode === 'auto' ? true : ctx.armedAndLive
}
