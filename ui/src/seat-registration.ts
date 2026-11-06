// Whether the coordinator REFUSED to register this device for its seat, per vault (#821).
//
// A refused registration is not a slow one. The seat then has no device on record, so a payment
// cannot be sealed to it and its votes cannot be checked: this device cannot sign or vote, and
// before this nothing on screen said so (the refusal went to the console). Only a refusal is kept
// here (an answer in the 4xx range); a coordinator that did not answer is retried on the next
// unlock and is not a reason to alarm anyone.
import { useSyncExternalStore } from 'react'

/** The message key for a refusal, from what the coordinator said. */
export type SeatRefusalKey = 'registration.seatTaken' | 'registration.seatRefused'

const refused = new Map<string, SeatRefusalKey>()
const listeners = new Set<() => void>()
const notify = () => { for (const l of listeners) l() }

/** The key for the coordinator's refusal text: a seat held by another device has its own words. */
export function seatRefusalKey(error: string | undefined): SeatRefusalKey {
  return /another device/i.test(error ?? '') ? 'registration.seatTaken' : 'registration.seatRefused'
}

export function noteSeatRefused(vaultId: string, key: SeatRefusalKey): void {
  refused.set(vaultId, key)
  notify()
}

export function noteSeatRegistered(vaultId: string): void {
  if (refused.delete(vaultId)) notify()
}

export function seatRefusal(vaultId: string | null): SeatRefusalKey | null {
  return vaultId ? refused.get(vaultId) ?? null : null
}

function subscribe(l: () => void): () => void {
  listeners.add(l)
  return () => { listeners.delete(l) }
}

/** The refusal for `vaultId`, kept current as registrations land. */
export function useSeatRefusal(vaultId: string | null): SeatRefusalKey | null {
  return useSyncExternalStore(subscribe, () => seatRefusal(vaultId), () => null)
}
