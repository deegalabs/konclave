/**
 * @konclave/frost — a reusable browser primitive for FROST threshold signatures on Zcash.
 *
 * This is a thin, typed, ergonomic wrapper over Konclave's WebAssembly core
 * (`konclave-wasm`). It exposes four capabilities, all running entirely in the browser
 * with the secret key share NEVER leaving the device:
 *
 *   1. DKG      — a real Distributed Key Generation across N devices (no trusted dealer),
 *                 producing one FROST vault whose key is never reconstituted.
 *   2. Signing  — a rerandomized-redpallas (Orchard-compatible) FROST group signature,
 *                 each device signing with only its own piece.
 *   3. Sealing  — an ECIES confidential channel (X25519 -> HKDF-SHA256 -> XChaCha20-Poly1305)
 *                 so a blind relay only ever carries public material or ciphertext.
 *   4. Recovery — the Repairable Threshold Scheme (RTS): a quorum of helpers rebuilds a lost
 *                 member's share without touching the group key.
 *
 * HONESTY NOTE. Konclave does NOT reimplement the cryptography. The primitives here are the
 * Zcash Foundation's `reddsa`/`frost` (rerandomized redpallas) and the `orchard` crate,
 * compiled to WebAssembly. This SDK is the human/integration layer: a clean surface a wallet
 * can call. All credit for the crypto goes to the Zcash Foundation.
 *
 * TRANSPORT-AGNOSTIC. This SDK moves only bytes. It does not open sockets. You choose how the
 * public/sealed wire bytes travel between devices (a relay, WebRTC, QR codes, copy-paste).
 * Konclave ships a blind-relay transport as a separate, optional concern.
 *
 * @packageDocumentation
 */

import initWasm, {
  TestVault,
  Coordinator,
  participantRound1,
  participantRound2,
  type InitInput,
} from 'konclave-wasm'

// --- Re-export the full wasm surface, unchanged, with the real signatures --------------------
// These are the exact classes/functions from `konclave-wasm`; we re-export so consumers have a
// single import site and never have to reason about the wasm-pkg layout.
export {
  /** A device's stateful DKG session. Round 1 runs on construction; SecretPackages never leave it. */
  DkgSession,
  /** Accumulates public wire material and produces + verifies the group signature. */
  Coordinator,
  /** A device's long-term X25519 keypair for the confidential channel (round-2 sealing). */
  DeviceKey,
  /** A recovery helper: computes per-recipient deltas, then sums received deltas into a sigma. */
  RecoveryHelper,
  /** The recovering member: combines helpers' sigmas into a repaired, group-validated KeyPackage. */
  RecoveryCombiner,
  /** Test-only trusted-dealer 2-of-3, so you can drive a ceremony end-to-end without a DKG. */
  TestVault,
  /** Participant round-1 output: nonces stay local; the commitment goes to the coordinator. */
  Round1,
  /** Participant device, round 1: from local key-package bytes -> a Round1 (nonces + commitment). */
  participantRound1,
  /** Participant device, round 2: sign with the local nonces + seed -> this device's share bytes. */
  participantRound2,
  /** Seal plaintext to a recipient's 32-byte public key; `aad` binds sender/recipient context. */
  sealTo,
  /** Verify a group signature against the vault's key — every device confirms the result itself. */
  verifyRedpallas,
  /** Deterministic 1-based identifier bytes, so every device agrees on who is who with no registry. */
  identifierBytes,
  /** Browser self-test: runs a full FROST ceremony. Returns "OK: ..." or "ERR: ...". */
  selftest,
} from 'konclave-wasm'

export type { InitInput, InitOutput, SyncInitInput } from 'konclave-wasm'

// --- init() ----------------------------------------------------------------------------------

let readyPromise: Promise<unknown> | null = null

/**
 * The accepted forms for locating the `.wasm` binary. Most callers pass a URL string or a URL
 * object; bundlers (Vite, webpack) can hand you a URL via `new URL('...konclave_wasm_bg.wasm', import.meta.url)`
 * or a `?url` import. You may also pass a `Response`, `BufferSource`, or a precompiled `WebAssembly.Module`.
 */
export type WasmSource = InitInput

/**
 * Load and initialize the WebAssembly module. Idempotent: safe to call from many places; the
 * module is instantiated exactly once and subsequent calls await the same instance.
 *
 * You MUST provide where the `.wasm` binary lives. It is intentionally not bundled with this
 * SDK (it is ~450 KB). The binary ships with the `konclave-wasm` package as
 * `konclave_wasm_bg.wasm` — see the README for the three common ways to point at it.
 *
 * @param wasm - a URL/Response/bytes/Module locating `konclave_wasm_bg.wasm`.
 *
 * @example
 * // Vite / modern bundler
 * import wasmUrl from 'konclave-wasm/konclave_wasm_bg.wasm?url'
 * await init(wasmUrl)
 *
 * @example
 * // Plain browser / any runtime that can resolve a URL
 * await init(new URL('./konclave_wasm_bg.wasm', import.meta.url))
 */
export async function init(wasm: WasmSource): Promise<void> {
  if (!readyPromise) {
    // The wasm-bindgen default export accepts a bare InitInput (URL/Response/bytes/Module).
    readyPromise = initWasm(wasm)
  }
  await readyPromise
}

/** True once {@link init} has completed at least once. */
export function isReady(): boolean {
  return readyPromise !== null
}

// --- Byte / wire helpers ---------------------------------------------------------------------
// Every value that crosses between devices is a Uint8Array of public (or already-sealed) bytes.
// These helpers encode them for whatever string-based transport you use (JSON over a relay,
// a QR code, copy-paste). They are pure and carry no secrets of their own.

/** Encode bytes as standard base64 (for an opaque wire string). */
export function toBase64(bytes: Uint8Array): string {
  let s = ''
  for (const b of bytes) s += String.fromCharCode(b)
  return btoa(s)
}

/** Decode a base64 wire string back to bytes. */
export function fromBase64(s: string): Uint8Array {
  const bin = atob(s)
  const out = new Uint8Array(bin.length)
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i)
  return out
}

/** Encode bytes as lowercase hex (handy for showing a group verifying key to a human). */
export function toHex(bytes: Uint8Array): string {
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('')
}

/** Decode a hex string back to bytes. Throws on odd length or a non-hex character. */
export function fromHex(hex: string): Uint8Array {
  if (hex.length % 2 !== 0) throw new Error('fromHex: odd-length string')
  const out = new Uint8Array(hex.length / 2)
  for (let i = 0; i < out.length; i++) {
    const byte = Number.parseInt(hex.slice(i * 2, i * 2 + 2), 16)
    if (Number.isNaN(byte)) throw new Error('fromHex: non-hex character')
    out[i] = byte
  }
  return out
}

/** Constant-length equality check for two byte arrays (e.g. matching identifiers). */
export function bytesEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false
  let diff = 0
  for (let i = 0; i < a.length; i++) diff |= a[i]! ^ b[i]!
  return diff === 0
}

// --- Convenience: a fully local self-check ceremony ------------------------------------------

/** The outcome of {@link localTestCeremony}. */
export interface CeremonyResult {
  /** The 64-byte aggregated group signature. */
  signature: Uint8Array
  /** Whether the signature verifies against the vault's group key (should always be true). */
  verified: boolean
  /** Wall-clock milliseconds the ceremony took (rough; for smoke-testing your integration). */
  ms: number
}

/**
 * Run a complete 2-of-3 rerandomized-redpallas FROST ceremony entirely in-process, using a
 * test trusted-dealer vault. This is a smoke test / example: it proves the wasm loaded and that
 * signing + verification work in your environment. It does NOT touch the network or a real vault.
 *
 * Call {@link init} first.
 *
 * The production flow is the same shape (round1 -> coordinator prepares -> round2 -> aggregate ->
 * verify) but each participant runs on a different device and the bytes travel over your transport;
 * see the README's signing example and `examples/sign.ts`.
 *
 * @param message - the bytes to sign. In production this is a transaction's sighash; here it is
 *                  arbitrary. Defaults to a fixed demo string.
 */
export function localTestCeremony(
  message: Uint8Array = new TextEncoder().encode('@konclave/frost self-check'),
): CeremonyResult {
  const t0 = typeof performance !== 'undefined' ? performance.now() : Date.now()

  // Trusted-dealer stand-in for two unlocked device shares (seats 0 and 1 of a 2-of-3).
  const vault = new TestVault()

  // Round 1 — each device keeps its nonces local, sends only its commitment.
  const a = participantRound1(vault.key_package(0))
  const b = participantRound1(vault.key_package(1))

  // The coordinator collects the public commitments and builds the signing package + seed.
  const coord = new Coordinator(vault.groupVk(), vault.pubkeys(), message)
  coord.addCommitment(vault.id(0), a.commitment())
  coord.addCommitment(vault.id(1), b.commitment())
  coord.prepare()
  const sp = coord.signingPackage()
  const seed = coord.seed()

  // Round 2 — each device signs with ITS OWN nonces; only the share crosses.
  coord.addShare(vault.id(0), participantRound2(sp, a.nonces(), vault.key_package(0), seed))
  coord.addShare(vault.id(1), participantRound2(sp, b.nonces(), vault.key_package(1), seed))

  // Aggregate the shares into one group signature, then verify it.
  const signature = coord.aggregate()
  const verified = coord.verify(signature)

  const now = typeof performance !== 'undefined' ? performance.now() : Date.now()
  return { signature, verified, ms: Math.round(now - t0) }
}
