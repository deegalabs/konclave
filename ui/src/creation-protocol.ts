// The creation protocol this app speaks: the one number the ceremony's messages (`DKG_VERSION`), the
// relay room's name and the coordinator registration all read. 2 is the creation core of v0.12.0, in
// which every member confirms the vault before anything secret is exchanged; the earlier flow had no
// number (and its room was named without one).
//
// The coordinator refuses a registration that does not carry it, so a vault made by an outdated
// cached app never gets an address. Self-declared on purpose: it stops honest members on an old
// bundle, not a modified client, which could already create anything.
import { helperConfigured } from './helper'
import { addressText } from './approved-payment'

export const CREATION_PROTOCOL = 2

/** Whether this app may start a creation or a join, given the coordinator's minimum (null when it
 *  states none, or could not be asked: the registration itself still refuses an outdated client). */
export function creationAllowed(own: number, min: number | null): boolean {
  return min === null || min <= own
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

/** Whether a vault's record is one whose registration with the coordinator can be finished from this
 *  device: made by the creation that records the quorum, holding no address, with a coordinator to
 *  register with. By fact, with or without `pending` (a member who answered the old "did everyone
 *  save" card has `pending: false` and still no address). Registering a vault the coordinator
 *  already holds is idempotent, so the wide reading costs nothing. The one place this is decided. */
export function resumable(r: { cp?: number; threshold?: number; total?: number; address?: unknown; pending?: boolean }): boolean {
  return isCurrentFlow(r) && !addressText(r.address) && helperConfigured()
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
