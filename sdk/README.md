# @konclave/frost

**A reusable browser primitive for FROST threshold signatures on Zcash.**

Add shielded multisig to any Zcash wallet or app. This SDK gives you real Distributed Key
Generation, threshold group signing on Orchard (rerandomized redpallas), an ECIES confidential
channel, and social recovery, all running in the browser, with the secret key share never
leaving the device.

It is a thin, typed wrapper over Konclave's WebAssembly core (`konclave-wasm`). You get clean
TypeScript classes and functions instead of raw wasm-bindgen glue.

> This maps directly onto a Zcash Community Grants priority: easy multisig tooling for shielded
> addresses, and FROST in user-facing wallets. Today, using FROST on Zcash means a CLI, several
> terminals, and copying hex by hand. This SDK is the missing library so a wallet can offer
> threshold custody as a normal feature.

## Honest positioning

Konclave does **not** reimplement the cryptography. The primitives are the Zcash Foundation's
`reddsa` / `frost` (rerandomized redpallas, Orchard-compatible) and the `orchard` crate,
compiled to WebAssembly. This SDK is the human and integration layer on top: a surface a wallet
can call. All credit for the crypto belongs to the Zcash Foundation. This package is a roadmap
of what the primitive can do, and it states plainly what it does and does not deliver (see
"Honest limits" at the end).

## Security model

- **The share never leaves the device.** Key generation (DKG), share storage, and signing all
  run locally in wasm. Only public material (commitments, the signing package, the rerandomizer
  seed, partial signatures) or already-sealed ciphertext ever crosses the wire.
- **No trusted dealer in production.** Vaults are created by a real DKG across devices. The group
  key is never reconstituted on any single machine.
- **Blind transport by design.** The round-2 DKG packages that are secret are sealed to their
  recipient with ECIES (X25519, HKDF-SHA256, XChaCha20-Poly1305) before they touch any relay, so
  a relay carries only ciphertext it cannot read.
- **Every device verifies for itself.** `verifyRedpallas` lets each participant confirm the group
  signature against the vault key, without trusting the coordinator.

## Install

```sh
npm install @konclave/frost konclave-wasm
```

`konclave-wasm` is the compiled WebAssembly core (the `wasm-pkg` artifact from Konclave). It
carries the `.wasm` binary. This SDK does not bundle that binary (it is around 450 KB); you point
`init()` at it.

> Building `konclave-wasm` yourself: from the Konclave repo, run
> `wasm-pack build --target web` in `konclave-wasm/`, then use the generated `pkg/` (the same
> files live at `ui/src/wasm-pkg/`: `konclave_wasm.js`, `konclave_wasm_bg.wasm`,
> `konclave_wasm.d.ts`). You can `npm install` that folder by path or publish it under the name
> `konclave-wasm`.

## Loading the wasm

You must tell `init()` where the `.wasm` binary lives. Three common ways:

```ts
// 1) Vite or another modern bundler: a URL import
import wasmUrl from 'konclave-wasm/konclave_wasm_bg.wasm?url'
import { init } from '@konclave/frost'
await init(wasmUrl)
```

```ts
// 2) Plain browser / any runtime that can resolve a URL relative to a module
import { init } from '@konclave/frost'
await init(new URL('./konclave_wasm_bg.wasm', import.meta.url))
```

```ts
// 3) Node (e.g. for tests): read the bytes and pass them
import { createRequire } from 'node:module'
import { readFileSync } from 'node:fs'
import { init } from '@konclave/frost'
const require = createRequire(import.meta.url)
await init(readFileSync(require.resolve('konclave-wasm/konclave_wasm_bg.wasm')))
```

`init()` is idempotent. Call it once at startup, or before your first ceremony; repeated calls
await the same instance.

## Quick self-check

After `init()`, confirm signing works in your environment with a fully local 2-of-3 ceremony:

```ts
import { init, localTestCeremony } from '@konclave/frost'

await init(wasmUrl)
const { signature, verified, ms } = localTestCeremony()
console.log(verified, signature.length, ms) // true 64 <n>
```

## Signing (a group signature across devices)

The ceremony has the same shape everywhere: round 1 (commitments), the coordinator prepares the
signing package, round 2 (partial signatures), aggregate, verify. In production each participant
call runs on a different device and the byte blobs travel over your transport. The secret share
and the nonces never move. Below it runs in one process against a test vault so you can see it
whole (this is `examples/sign.ts`, adapted from the in-app proof `WasmSigner.tsx`):

```ts
import {
  init, TestVault, Coordinator,
  participantRound1, participantRound2, verifyRedpallas, toHex,
} from '@konclave/frost'

await init(wasmUrl)

const message = new TextEncoder().encode('an Orchard sighash goes here')
const vault = new TestVault() // stands in for three unlocked device shares

// Round 1: nonces stay local; only commitments are public.
const a = participantRound1(vault.key_package(0))
const b = participantRound1(vault.key_package(1))

// Coordinator (holds no secret) builds the public signing package + seed.
const coord = new Coordinator(vault.groupVk(), vault.pubkeys(), message)
coord.addCommitment(vault.id(0), a.commitment())
coord.addCommitment(vault.id(1), b.commitment())
coord.prepare()
const sp = coord.signingPackage()
const seed = coord.seed()

// Round 2: each device signs with ITS OWN nonces; only the share crosses.
coord.addShare(vault.id(0), participantRound2(sp, a.nonces(), vault.key_package(0), seed))
coord.addShare(vault.id(1), participantRound2(sp, b.nonces(), vault.key_package(1), seed))

const sig = coord.aggregate()
const ok = verifyRedpallas(vault.groupVk(), sp, seed, message, sig)
console.log(ok, toHex(sig))
```

To wire this across devices, move each public blob (`commitment()`, `signingPackage()`, `seed()`,
each `addShare` payload) over your transport with `toBase64` / `fromBase64`. Use `identifierBytes(i)`
so every device agrees on who is seat `i` with no central registry.

The example above signs an arbitrary message on the **seed path** (`participantRound2` + `aggregate`
+ `verifyRedpallas`). That is the right surface for a generic redpallas signature, but it is **not**
what an Orchard spend needs. Read on.

## Signing a real Orchard spend (the rerandomized path)

An Orchard spend is authorized under a per-spend **rerandomizer** (`alpha`), not a generic seed. To
produce a signature a real transaction will accept on-chain, drive the ceremony over the PCZT (the
Partially Created Zcash Transaction the wallet builds and proves), using the rerandomized surface:
`pcztSighash`, `extractRandomizers`, `participantRound2WithRandomizer`,
`Coordinator.aggregateWithRandomizer`, `Coordinator.verifyWithRandomizer`, and `injectSigs`. This is
exactly the ceremony Konclave runs in `ui/src/signing-machine.ts`.

The shape per spend:

```ts
import {
  init, Coordinator, identifierBytes,
  participantRound1, participantRound2WithRandomizer,
  pcztSighash, extractRandomizers, describeOutputs, injectSigs,
} from '@konclave/frost'

await init(wasmUrl)

// The wallet hands each device the SAME proven PCZT bytes. Each device signs only what its own
// copy commits to - never a sighash received over the wire (the transaction-swap defence).
const pczt: Uint8Array = /* proven PCZT from your wallet (Konclave: the blind helper) */ undefined!

// 1) "What am I signing?" - confirm the outputs against the approved proposal BEFORE signing.
const outs = JSON.parse(describeOutputs(pczt)) as { address: string | null; value: number | null }[]
//    (address:null entries are change; values are zatoshis)

// 2) The message every device signs is the ZIP-244 sighash of ITS OWN PCZT.
const sighash = pcztSighash(pczt)

// 3) Each real Orchard spend has its own (index, alpha). One ceremony per record.
const rand = extractRandomizers(pczt) // flat 36-byte records: u32-LE index + 32-byte alpha
for (let off = 0; off + 36 <= rand.length; off += 36) {
  const index = rand[off]! | (rand[off + 1]! << 8) | (rand[off + 2]! << 16) | (rand[off + 3]! << 24)
  const alpha = rand.slice(off + 4, off + 36)

  // Round 1 (per device): nonces local, commitment public - as before.
  const a = participantRound1(myKeyPackage)
  // ...collect commitments from >= threshold devices...

  // Coordinator builds the signing package over the sighash.
  const coord = new Coordinator(groupVk, pubkeys, sighash)
  // coord.addCommitment(identifierBytes(seat), commitmentBytes)  // for each chosen seat
  coord.prepare()
  const sp = coord.signingPackage()

  // Round 2 (per device): sign with THIS spend's alpha, not a seed.
  const share = participantRound2WithRandomizer(sp, a.nonces(), myKeyPackage, alpha)
  // coord.addShare(identifierBytes(seat), shareBytes)  // for each chosen seat

  // Aggregate + verify UNDER the same alpha - the exact check the chain runs.
  const sig = coord.aggregateWithRandomizer(alpha)
  const ok = coord.verifyWithRandomizer(alpha, sig)
  // record (index, sig) for this spend
}

// 4) Inject every (index, 64-byte sig) into the PCZT; hand the signed PCZT back to the wallet.
//    `sigs` is a flat buffer of 68-byte records: u32-LE index + 64-byte signature.
const signedPczt = injectSigs(pczt, sighash, /* sigs */ undefined!)
```

The wallet then extracts and broadcasts the transaction from `signedPczt`. Building and proving the
PCZT and broadcasting the final transaction are the wallet's job (see "Honest limits"); this SDK
gives you the FROST surface to sign it correctly. Konclave's full multi-device driver over a blind
relay lives in `ui/src/signing-machine.ts`.

## DKG (create a vault across devices)

`DkgSession` runs a real Distributed Key Generation. Round 1 happens on construction; you then
exchange the wire bytes and call `part2()` and `part3()`. The secret packages never leave the
session. The round-2 packages that are secret must be sealed to their recipient (`sealTo` /
`DeviceKey`) before they touch the wire.

```ts
import {
  init, DkgSession, DeviceKey, sealTo, identifierBytes, toBase64, fromBase64,
} from '@konclave/frost'

await init(wasmUrl)

// Each device: a long-term encryption keypair for the confidential channel.
const deviceKey = new DeviceKey()
const myEncPub = deviceKey.publicBytes() // rides in the invite

// Seat this device (1-based). A 2-of-3 vault: max_signers = 3, min_signers = 2.
const mySeat = 1
const dkg = new DkgSession(identifierBytes(mySeat), 3, 2)

// Round 1: broadcast our public package; collect everyone else's.
const myRound1 = dkg.round1Package()          // send (public)
// ...for each peer p:  dkg.addRound1(identifierBytes(pSeat), theirRound1Bytes)

// Round 2: produce one SECRET package per recipient. Seal each to that recipient's enc key.
dkg.part2()
for (let i = 0; i < dkg.round2Count(); i++) {
  const recipientId = dkg.round2Recipient(i)  // whose seat this is for
  const aad = new TextEncoder().encode(`${mySeat}->recipientSeat`)
  const sealed = sealTo(recipientEncPub, dkg.round2Package(i), aad)
  // send toBase64(sealed) to that recipient over the (blind) relay
}
// ...on receipt of a package sealed to me:
//    const opened = deviceKey.open(fromBase64(sealedFromWire), aad)
//    dkg.addRound2(identifierBytes(senderSeat), opened)

// Round 3: combine into this device's share + the shared group key.
dkg.part3()
const groupVk = dkg.groupVk()      // every honest device derives the SAME value
const myKeyPackage = dkg.keyPackage() // this device's share; keep it local
```

The full driver (deterministic seating, relay plumbing, retries) lives in Konclave at
`ui/src/screens/NetVault.tsx` and the transport helper `ui/src/net.ts`. This SDK gives you the
crypto surface; the transport is yours to choose.

## Sealing (the confidential channel)

`DeviceKey` plus `sealTo` is a standalone ECIES box you can use for any device-to-device secret,
not just DKG round 2.

```ts
import { DeviceKey, sealTo } from '@konclave/frost'

const alice = new DeviceKey()
const bob = new DeviceKey()
const aad = new TextEncoder().encode('context that binds sender+recipient')

const sealed = sealTo(bob.publicBytes(), new TextEncoder().encode('secret'), aad)
const opened = bob.open(sealed, aad) // throws on a wrong key or any tampering
```

## Recovery (rebuild a lost share)

The Repairable Threshold Scheme: a quorum of helpers rebuilds a member's lost share from their
own KeyPackages and the group's public key package. The group key is untouched and the repaired
share matches the group's public share.

```ts
import { RecoveryHelper, RecoveryCombiner, identifierBytes } from '@konclave/frost'

const lostId = identifierBytes(2)

// Each helper (including registering itself in the helper set):
const helper = new RecoveryHelper(myKeyPackage, lostId)
helper.addHelper(identifierBytes(1))
helper.addHelper(identifierBytes(3))
helper.computeDeltas()               // round 1: one delta per helper
// exchange deltas (seal them to their recipient), then:
// helper.addIncomingDelta(openedDelta)
const sigma = helper.sigma()         // round 2: send to the recovering member

// The recovering member:
const combiner = new RecoveryCombiner(lostId, pubkeys)
// combiner.addSigma(sigmaFromEachHelper)
const repairedKeyPackage = combiner.keyPackage() // throws if it does not match the group
```

## API surface

`init`, `isReady`, `WasmSource`

Ceremony (seed path): `DkgSession`, `Coordinator`, `Round1`, `participantRound1`,
`participantRound2`, `verifyRedpallas`, `identifierBytes`, `TestVault`

Real Orchard spend (rerandomized path): `pcztSighash`, `extractRandomizers`,
`participantRound2WithRandomizer`, `Coordinator.aggregateWithRandomizer`,
`Coordinator.verifyWithRandomizer`, `describeOutputs`, `injectSigs`

Confidential channel: `DeviceKey`, `sealTo`

Recovery: `RecoveryHelper`, `RecoveryCombiner`

Convenience: `localTestCeremony`, `selftest`, and byte helpers `toBase64` / `fromBase64` /
`toHex` / `fromHex` / `bytesEqual`

All class and function signatures come straight from `konclave-wasm`; see
`konclave_wasm.d.ts` for the exact types.

## Honest limits

- This SDK signs; it does not build, prove, or broadcast. Constructing the PCZT, proving it, and
  broadcasting the final transaction are the wallet's job (Konclave does this with the Zcash
  Foundation's `zcash-devtool` / `konclave-signer` outside the browser). What the SDK now covers is
  the full FROST signing surface for a real Orchard spend: read the sighash and randomizers from a
  proven PCZT (`pcztSighash`, `extractRandomizers`), sign under each spend's alpha
  (`participantRound2WithRandomizer` + `aggregateWithRandomizer` / `verifyWithRandomizer`), and
  inject the signatures back (`injectSigs`). The seed path (`participantRound2` + `verifyRedpallas`)
  remains for generic redpallas signatures, but it is NOT what an on-chain Orchard spend accepts.
- Persisting a share on-device (encrypted IndexedDB, passkey unlock) is the consumer's
  responsibility. This SDK keeps the share in wasm memory for the life of the session.
- The transport is not included. Konclave ships a blind-relay transport separately; you may use
  any channel that moves opaque strings.

## License

Dual licensed under Apache-2.0 OR MIT, matching Konclave and the Zcash Foundation tools.
