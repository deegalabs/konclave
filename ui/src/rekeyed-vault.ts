/// <reference types="node" />
// Seeded vaults and the repo's Ironwood vector rewritten for each one's group key, for the tests
// that run a ceremony over a real PCZT. A device now refuses a spend that is not under its own
// vault's key, so a vault made with fresh random keys cannot sign the vector's original one. The
// file is made by konclave-seal's tests (`rekeyed_fixture.rs`), which also pin the group keys.
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

interface Fixture { groupVk: string; pubkeys: string; keyPackages: string[]; pczt: string; rk0?: string; other?: string }

const file = new URL('../../konclave-wasm/tests/vectors/ironwood_single_spend.rekeyed.json', import.meta.url)
const all = JSON.parse(readFileSync(fileURLToPath(file), 'utf8')) as Record<string, Fixture>
const unhex = (h: string): Uint8Array => Uint8Array.from((h.match(/../g) ?? []).map((x) => parseInt(x, 16)))

/** The seeded vault of `t` of `n` (2 of 3 or 3 of 4), shaped like the DKG sessions the tests used. */
export function fixtureVault(t: number, n: number) {
  const f = all[`${t}of${n}`]
  if (!f) return null
  return {
    shares: f.keyPackages.map((k) => ({ keyPackage: () => unhex(k) })),
    groupVk: unhex(f.groupVk),
    pubkeys: unhex(f.pubkeys),
    pczt: () => unhex(f.pczt),
    rk0: () => unhex(f.rk0 ?? ''),
    other: () => unhex(f.other ?? ''),
  }
}

const v23 = () => fixtureVault(2, 3)!

/** The 2-of-3 vault, as `dkg2of3()` was in each test file. */
export function dkg2of3() {
  const { shares, groupVk, pubkeys } = v23()
  const [s0, s1, s2] = shares as [(typeof shares)[0], (typeof shares)[0], (typeof shares)[0]]
  return { s0, s1, s2, groupVk, pubkeys }
}

/** The Ironwood vector, built for the 2-of-3 vault. */
export const dkgProvenPczt = (): Uint8Array => v23().pczt()
/** Its group key: what a request builder passes to read the spends of `dkgProvenPczt()`. */
export const dkgVaultKey = (): Uint8Array => v23().groupVk
/** A second transaction (another payment) built for the same 2-of-3 vault: the Foundation's fixture,
 *  whose own expiry is `OTHER_EXPIRY`. */
export const dkgOtherPczt = (): Uint8Array => v23().other()
export const OTHER_EXPIRY = 4_164_831
/** The key the vector's first spend carries, so a test can give that spend an empty randomizer. */
export const dkgFirstSpendKey = (): Uint8Array => v23().rk0()
