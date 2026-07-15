/**
 * Example: a 2-of-3 rerandomized-redpallas FROST signature, produced entirely in WebAssembly.
 *
 * This mirrors Konclave's in-app proof (ui/src/screens/WasmSigner.tsx), but through the SDK's
 * clean surface. It uses a test trusted-dealer vault so the whole ceremony runs in ONE process
 * and you can see every step. In a real deployment each `participant*` call runs on a DIFFERENT
 * device and the byte blobs (commitment, signing package, seed, share) travel over your chosen
 * transport (a blind relay, WebRTC, QR codes) — the SECRET share and nonces never move.
 *
 * Run (after `npm install` and providing the wasm binary — see the README):
 *   npx tsx examples/sign.ts
 *
 * You must point `init()` at the `.wasm` file that ships with `konclave-wasm`. The line below
 * resolves it relative to the installed package; adjust the URL for your setup if needed.
 */

import { createRequire } from 'node:module'
import { readFileSync } from 'node:fs'
import {
  init,
  TestVault,
  Coordinator,
  participantRound1,
  participantRound2,
  verifyRedpallas,
  toHex,
} from '../src/index.js'

async function main(): Promise<void> {
  // 1) Locate and load the wasm binary. In a browser you would pass a URL (e.g. a Vite `?url`
  //    import or `new URL('...konclave_wasm_bg.wasm', import.meta.url)`). Under Node we read the
  //    bytes from the installed `konclave-wasm` package and hand them straight to init().
  const require = createRequire(import.meta.url)
  const wasmPath = require.resolve('konclave-wasm/konclave_wasm_bg.wasm')
  await init(readFileSync(wasmPath))

  // 2) The message to sign. In production this is a Zcash transaction's sighash (ZIP-244
  //    sig_digest); here it is an arbitrary demo string.
  const message = new TextEncoder().encode('konclave: an Orchard sighash would go here (demo)')

  // 3) A trusted-dealer 2-of-3 vault, standing in for three unlocked device shares. The real
  //    product creates the vault by DKG (see the README's DKG example); the ceremony below is
  //    identical either way.
  const vault = new TestVault()

  // 4) Round 1 — two devices each produce a nonce/commitment pair. NONCES STAY LOCAL; only the
  //    commitment is public and goes to the coordinator.
  const deviceA = participantRound1(vault.key_package(0))
  const deviceB = participantRound1(vault.key_package(1))

  // 5) The coordinator (any participant, holds no secret) gathers the public commitments and
  //    builds the signing package + rerandomizer seed — both public.
  const coord = new Coordinator(vault.groupVk(), vault.pubkeys(), message)
  coord.addCommitment(vault.id(0), deviceA.commitment())
  coord.addCommitment(vault.id(1), deviceB.commitment())
  coord.prepare()
  const signingPackage = coord.signingPackage()
  const seed = coord.seed()

  // 6) Round 2 — each device signs with ITS OWN nonces. Only the resulting share crosses the wire.
  coord.addShare(vault.id(0), participantRound2(signingPackage, deviceA.nonces(), vault.key_package(0), seed))
  coord.addShare(vault.id(1), participantRound2(signingPackage, deviceB.nonces(), vault.key_package(1), seed))

  // 7) Aggregate the two shares into one group signature.
  const signature = coord.aggregate()

  // 8) Verify — independently. Every device can confirm the signature against the group key
  //    without trusting the coordinator's word. All inputs here are public.
  const ok = verifyRedpallas(vault.groupVk(), signingPackage, seed, message, signature)

  console.log(`signature (${signature.length} bytes): ${toHex(signature)}`)
  console.log(`verified: ${ok ? 'yes' : 'NO'}`)
  if (!ok) process.exitCode = 1
}

main().catch((err) => {
  console.error(err)
  process.exitCode = 1
})
