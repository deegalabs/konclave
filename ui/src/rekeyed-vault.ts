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

// ---- the vector's viewing key ----
//
// The device checks what each spend is worth with the vault's viewing key (`readForSigning`), and
// that key is the vault's by its `ak`, which is the group key. The vector's notes belong to the
// wallet that made it, whose key is not the seeded vault's group key (the vault above was made for
// the vector by rewriting each spend's `rk` only). So a ceremony over this vector cannot pass the
// device's own check of the key against its package, and the Rust tests (`action_bound_vectors.rs`,
// `action_bound_reader.rs`) are where that check and the binding are tested, with the vector's real key.
//
// What a ceremony test here can state is only that the key, when there is one, reaches the reading,
// and that without one a payment that spends a note is refused. `VECTOR_VIEWING_KEY` is the
// stand-in a harness's `viewingKey` returns; `standingInForTheVectorsKey` swaps it, at the one wasm
// call, for the real key of the vector's wallet and the group key that goes with it; the receivers a
// harness records are `VECTOR_RECEIVERS`, the ones that key derives.
// Any other value passes through untouched, so a test of a key that is wrong still reaches the reading.
export const VECTOR_VIEWING_KEY = 'the viewing key of the vector’s own wallet'
const VECTOR_UFVK =
  'uview17m7prjp6js08xagnqdegr79zcewtjpte5xdard7rmtwycrw4gwfte4utrm953aua0yaht4xvmnctystks45cl84ctfy3msly3qk68x697alztvl7jw3uyykxe7se2q494rxkxdfwgnx5yh58cvw0ut3037fuky7f5tpa5psn3qqede75ep3k94c7qj9pl'
const VECTOR_AK = '0a05787d30adc74909647d026a9034bf86399363ba230189cd187869d2935e1b'
/** The receivers the vector's wallet derives, as a device records them: what a harness's `ourReceivers` returns. */
export const VECTOR_RECEIVERS = [
  'eb843eb1c03fb58b1f844c511913d20c16a1d61df9cd2b826c0f7d6d82b7746c91b64bb0117134c34fec8b',
  '8dfd0a5e0d0d13315253b5906588e4f0bdabc07a1d91648ea5731d0e97d14fc38376da78a267f9a2dc190b',
]

type Reading = (pczt: Uint8Array, receivers: string[] | null | undefined, ufvk: string | null | undefined, groupVk: Uint8Array) => string
export function standingInForTheVectorsKey(real: Reading): Reading {
  return (pczt, receivers, ufvk, groupVk) =>
    ufvk === VECTOR_VIEWING_KEY ? real(pczt, receivers, VECTOR_UFVK, unhex(VECTOR_AK)) : real(pczt, receivers, ufvk, groupVk)
}
