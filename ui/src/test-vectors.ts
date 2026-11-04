// Test only. The real-WASM vectors in this repo are testnet PCZTs, and a signing device now checks a
// transaction's expiry against the mainnet window its own clock allows. NU6.3's branch id is the same
// on both networks, so a vector whose expiry field alone is moved into that window is a transaction a
// mainnet device accepts: the sighash, recomputed by the device, covers the new expiry, and every
// other check runs on the vector as it is. Real mainnet fixtures replace this once captured.

import { vi } from 'vitest'

import { VECTOR_EXPIRY, vectorWithExpiry } from './demo-vector'

// The byte patch lives with the vector, because /lab/background-signer moves the expiry too. WHICH
// expiry stays here: an oracle written out independently of the epoch table (konclave-seal::epochs),
// which the app reads through WASM and the tests check it against (lab-vault.test.ts). This file is
// test only, and the only place outside the table that names the anchor.
export { VECTOR_EXPIRY }

const ANCHOR_HEIGHT = 3_428_143
const ANCHOR_UNIX = 1_785_247_643

/** The expiry an honest mainnet builder would set now: the estimated tip plus 40. */
export function honestExpiry(nowMs = Date.now()): number {
  return ANCHOR_HEIGHT + Math.floor((nowMs / 1000 - ANCHOR_UNIX) / 75) + 40
}

/** `pczt` with its expiry moved to `expiry` (default: an honest one now). */
export function withExpiry(pczt: Uint8Array, expiry = honestExpiry()): Uint8Array {
  return vectorWithExpiry(pczt, expiry)
}

/** The instant the tests that sign a vector run at: 2026-10-26 12:00 UTC, well inside the NU6.3 epoch
 *  and before the NU7 activation (block 3,543,405, about 6 November 2026). WASM reads the clock
 *  (`Date.now()`) to decide which transactions this device accepts, and a NU6.3 vector is, correctly,
 *  refused once that clock is past the activation; left on the real clock these tests would all fail on
 *  the same day. `honestExpiry` and the device then agree for ever, because they read the same instant. */
export const PINNED_NOW_MS = Date.UTC(2026, 9, 26, 12, 0, 0)

/** Fakes `Date` only (timers stay real) and sets it to [`PINNED_NOW_MS`]. Pair with `unpinClock`. */
export function pinClock(): void {
  vi.useFakeTimers({ toFake: ['Date'] })
  vi.setSystemTime(PINNED_NOW_MS)
}

export function unpinClock(): void {
  vi.useRealTimers()
}
