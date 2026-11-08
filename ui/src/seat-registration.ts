// Whether the coordinator REFUSED to register this device for its seat, per vault (#821). On a
// protocol-3 vault a refusal may carry the coordinator's code (any status it sent one with, a 503
// included); the code is what disarms the signer, and the shell words it.
//
// A refused registration is not a slow one. The seat then has no device on record, so a payment
// cannot be sealed to it and its votes cannot be checked: this device cannot sign or vote, and
// before this nothing on screen said so (the refusal went to the console). Only a refusal is kept
// here (an answer in the 4xx range); a coordinator that did not answer is retried on the next
// unlock and is not a reason to alarm anyone.
import { useSyncExternalStore } from 'react'

/** The message key for a refusal, from what the coordinator said. */
export type SeatRefusalKey = 'registration.seatTaken' | 'registration.seatRefused'

/** One refusal per vault: the words to show, and the coordinator's code when it sent one (protocol 3).
 *  The ONE store of a refused seat: the dashboard banner, the shell's message and the signer's arming
 *  all read it, so a refusal cannot be shown in one place and forgotten in another. */
const refused = new Map<string, { key: SeatRefusalKey; code?: string }>()
const listeners = new Set<() => void>()
const notify = () => { for (const l of listeners) l() }

/** The key for the coordinator's refusal text: a seat held by another device has its own words. */
export function seatRefusalKey(error: string | undefined): SeatRefusalKey {
  return /another device/i.test(error ?? '') ? 'registration.seatTaken' : 'registration.seatRefused'
}

export function noteSeatRefused(vaultId: string, key: SeatRefusalKey, code?: string): void {
  // A later refusal without a code (a 401, a 429, a 400) never erases the coordinator's code from an
  // earlier one: the code is what keeps the signer from arming, and only a registration clears it.
  const kept = code ?? refused.get(vaultId)?.code
  refused.set(vaultId, kept ? { key, code: kept } : { key })
  notify()
}

export function noteSeatRegistered(vaultId: string): void {
  if (refused.delete(vaultId)) notify()
}

export function seatRefusal(vaultId: string | null): SeatRefusalKey | null {
  return vaultId ? refused.get(vaultId)?.key ?? null : null
}

/** The coordinator's code for this vault's refusal, when it sent one: a seat it did not take cannot
 *  open what is sealed to the vault, so the signer does not arm on it, and the shell says so. */
export function seatRefusalCode(vaultId: string | null | undefined): string | undefined {
  return vaultId ? refused.get(vaultId)?.code : undefined
}

function subscribe(l: () => void): () => void {
  listeners.add(l)
  return () => { listeners.delete(l) }
}

/** What the dashboard banner says: a refusal WITHOUT the coordinator's code. A coded one has its own
 *  sentence in the shell (`Layout`, from `useSeatRefusalCode`), which may say the opposite (a 503 "try
 *  later"), so the two are never shown together. */
export function bannerRefusal(vaultId: string | null): SeatRefusalKey | null {
  if (!vaultId) return null
  const r = refused.get(vaultId)
  return r && !r.code ? r.key : null
}

/** The banner's refusal for `vaultId` ([`bannerRefusal`]), kept current as registrations land. */
export function useSeatRefusal(vaultId: string | null): SeatRefusalKey | null {
  return useSyncExternalStore(subscribe, () => bannerRefusal(vaultId), () => null)
}

/** The coordinator's code for `vaultId`'s refusal ([`seatRefusalCode`]), kept current: the shell's
 *  message updates the moment a registration that ran after an unlock is refused, not on the next
 *  navigation. */
export function useSeatRefusalCode(vaultId: string | null): string | undefined {
  return useSyncExternalStore(subscribe, () => seatRefusalCode(vaultId), () => undefined)
}
