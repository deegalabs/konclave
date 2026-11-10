// The creation protocol this app speaks: the one number the ceremony's messages (`DKG_VERSION`), the
// relay room's name and the coordinator registration all read. 2 is the creation core of v0.12.0, in
// which every member confirms the vault before anything secret is exchanged; the earlier flow had no
// number (and its room was named without one).
// 3 (v0.18.0) pins the vault at creation. 4 reads the room PIN in one canonical form (the app-made
// PIN, its check digit, spaces ignored), which changes the room a PIN derives, so it is a new number.
//
// The coordinator refuses a registration that does not carry it, so a vault made by an outdated
// cached app never gets an address. Self-declared on purpose: it stops honest members on an old
// bundle, not a modified client, which could already create anything.
import { helperConfigured } from './helper'
import { addressText } from './approved-payment'

export const CREATION_PROTOCOL = 4

/** The first protocol whose vaults are pinned at creation (the viewing code, the receivers derived on
 *  the device, the coordinator's pinned registration). This file and the registration read it; the other
 *  "from protocol 3" rules still write the 3, and stay correct for every later protocol. */
export const FIRST_PINNING_PROTOCOL = 3

/** What this app does about the coordinator's minimum. From protocol 3 it starts only on a coordinator
 *  that announces at least this app's own protocol: a lower number, or no answer, is `blocked`, never a
 *  silent fall back. One function, so the screen does not choose the reason. */
export function creationVerdict(own: number, min: number | null): 'ok' | 'blocked' | 'update' {
  if (min !== null && Number.isInteger(min) && min > own) return 'update'
  if (own >= FIRST_PINNING_PROTOCOL) return min !== null && Number.isInteger(min) && min >= own ? 'ok' : 'blocked'
  return min === null || min <= own ? 'ok' : 'update'
}

export function creationAllowed(own: number, min: number | null): boolean {
  return creationVerdict(own, min) === 'ok'
}

/** A registration refused because this app is too old for the coordinator, as opposed to any other
 *  failure (which keeps its own message). */
export function isUpdateRequired(f: { status: number; updateRequired?: boolean } | null): boolean {
  return !!f?.updateRequired
}

/** The creation protocol a vault was made with, from this device's record of it: the one recorded at
 *  creation, or 2 for a record that keeps the members' confirmed quorum, which v0.12.0 (the first app
 *  to speak 2) wrote and earlier apps did not. Undefined for a record of the old flow, which reads as
 *  it always did. Never the app's own number. */
export function protocolOfRecord(r: { cp?: number; threshold?: number; total?: number }): number | undefined {
  if (r.cp !== undefined) return r.cp
  return r.threshold !== undefined ? 2 : undefined
}

/** Whether a member still has the viewing code to compare before this vault's address is shown. */
export function mustCompareCode(r: { cp?: number; receiversState?: string; viewingFingerprint?: string; codeCompared?: boolean } | undefined): boolean {
  return !!r && (r.cp ?? 0) >= FIRST_PINNING_PROTOCOL && r.receiversState === 'verified' && !!r.viewingFingerprint && !r.codeCompared
}

/** The address a device may show for its record. Protocol 3: only what it verified, on a finished
 *  vault whose code the member compared, never what a record merely holds. Older vaults: what the record holds. */
export function verifiedAddress(r: { cp?: number; threshold?: number; total?: number; address?: unknown; receiversState?: string; pending?: boolean; viewingFingerprint?: string; codeCompared?: boolean }): string {
  if ((protocolOfRecord(r) ?? 0) < FIRST_PINNING_PROTOCOL) return addressText(r.address)
  return r.receiversState === 'verified' && !r.pending && !mustCompareCode(r) ? addressText(r.address) : ''
}

/** Whether a vault's record is one whose registration with the coordinator can be finished from this
 *  device: made by the creation that records the quorum, holding no address, with a coordinator to
 *  register with. By fact, with or without `pending` (a member who answered the old "did everyone
 *  save" card has `pending: false` and still no address). Registering a vault the coordinator
 *  already holds is idempotent, so the wide reading costs nothing. The one place this is decided. */
export function resumable(r: { cp?: number; threshold?: number; total?: number; address?: unknown; pending?: boolean; abandoned?: string; receiversState?: string }): boolean {
  // Protocol 3: pending is what says it is unfinished, since the address may be written before it ends.
  const unfinished = (r.cp ?? 0) >= FIRST_PINNING_PROTOCOL ? !!r.pending : !addressText(r.address)
  // A refusal over receivers it already holds is the repair's; one with none can simply try again.
  const refused = r.receiversState === 'refused' && !!addressText(r.address)
  return isCurrentFlow(r) && !r.abandoned && !refused && unfinished && helperConfigured()
}

/** Whether a record is one of the current creation flow: it names the protocol it was made with AND
 *  keeps the quorum its members confirmed. The one definition `resumable`, the card's old-flow
 *  warning and the registration itself all read. */
export function isCurrentFlow(r: { cp?: number; threshold?: number; total?: number }): boolean {
  return protocolOfRecord(r) !== undefined && r.threshold !== undefined && r.total !== undefined
}

/** Whether the coordinator in use now is the one a record was made against. A record that kept no
 *  coordinator (made before it was recorded) cannot say, and counts as the same. */
export function sameCoordinator(recorded: string | undefined, now: string): boolean {
  return !recorded || recorded === now
}
