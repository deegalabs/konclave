// Unlocking with a passkey, when the device can (#446 option C).
//
// The vault's read secret `S` lives in memory and dies with the page, so a reload asks for the
// passphrase again. This wraps `S` under a key the authenticator derives (the WebAuthn PRF
// extension), so a reload costs a touch instead of typing.
//
// Three rules, and each of them came from measuring rather than assuming:
//
//  1. THE PASSPHRASE IS THE ROOT, ALWAYS. A PRF credential is per-origin and per-device: a lost
//     device, cleared browser data, or a browser without the extension leaves the wrap unopenable.
//     Without the passphrase we would have invented a new way to lose a vault, which is #434's
//     lesson. This is a shortcut, never a door.
//
//  2. PER DEVICE. The WebAuthn spec guarantees NOTHING about PRF output staying stable when a
//     passkey syncs, and Apple's own forums carry open reports (June/July 2026) where Mac -> iPhone
//     matches while iPhone -> Mac differs. The asymmetry is the trap: a casual two-device test
//     passes in one direction. So a wrap made here is only ever opened here, and the stored record
//     is never treated as portable.
//
//  3. EVERY FAILURE IS SILENT. No authenticator, no PRF, a cancelled prompt, a changed output - all
//     of it returns "no", and the caller asks for the passphrase exactly as it does today. The
//     downside is bounded at zero: it either saves typing or it does not, and it can never lose
//     anything.
//
// Detection reads `results.first`, not `enabled`: Firefox returns `{}` where Chrome returns
// `enabled: false`, so the presence of output is the only portable signal.

import { bytesToHex, hexToBytes } from './bytes'

/** What this device stored for a vault. Local only: never exported, never synced, never a backup. */
export interface PrfWrap {
  /** The credential to assert against, base64url as WebAuthn gives it. */
  credentialId: string
  /** The PRF salt, hex. Random per vault, so two vaults on one device derive different keys. */
  salt: string
  /** AES-GCM iv, hex. */
  iv: string
  /** `S`, encrypted under the PRF-derived key. Hex. */
  cipher: string
}

/** The slice of `navigator.credentials` used here, so tests can drive it without a browser. */
export interface Authenticator {
  create(o: CredentialCreationOptions): Promise<Credential | null>
  get(o: CredentialRequestOptions): Promise<Credential | null>
}

type PrfResults = { prf?: { results?: { first?: ArrayBuffer } } }

/** Is a PRF unlock even possible here? Cheap and synchronous; the real answer comes from enrolling. */
export function prfPossible(auth?: Authenticator): boolean {
  return !!auth && typeof PublicKeyCredential !== 'undefined'
}

/** The 32 bytes an assertion produced, or null. Reads `results.first` because that is the only
 *  signal every browser agrees on. */
function prfOutput(c: Credential | null): Uint8Array | null {
  const r = (c as PublicKeyCredential | null)?.getClientExtensionResults?.() as PrfResults | undefined
  const first = r?.prf?.results?.first
  return first ? new Uint8Array(first) : null
}

async function keyFrom(out: Uint8Array): Promise<CryptoKey> {
  // HKDF over the PRF output rather than using it raw: the browser already hashes our salt into it,
  // and a distinct label keeps this key from being interchangeable with anything else derived here.
  const base = await crypto.subtle.importKey('raw', out.slice().buffer, 'HKDF', false, ['deriveKey'])
  return crypto.subtle.deriveKey(
    { name: 'HKDF', hash: 'SHA-256', salt: new Uint8Array(0), info: new TextEncoder().encode('konclave-prf-wrap-v1') },
    base,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt'],
  )
}

/**
 * Enrol this device: create a PRF credential and wrap `S` under what it derives.
 *
 * Returns `null` on ANY failure, including the member cancelling. An enrolment that half-worked
 * must never be stored: a wrap we cannot open is worse than no wrap, because it looks like a way in.
 */
export async function enrolPrf(
  auth: Authenticator,
  vaultId: string,
  secret: Uint8Array,
  rpId: string,
  userLabel: string,
): Promise<PrfWrap | null> {
  try {
    const salt = crypto.getRandomValues(new Uint8Array(32))
    const created = await auth.create({
      publicKey: {
        challenge: crypto.getRandomValues(new Uint8Array(32)),
        rp: { id: rpId, name: 'Konclave' },
        // `.slice().buffer` for the same reason `bufOf` exists in storage.ts: TS 5.7's
        // Uint8Array<ArrayBufferLike> does not satisfy the DOM BufferSource type, a real
        // ArrayBuffer does.
        user: { id: hexToBytes(vaultId.slice(0, 64)).slice().buffer, name: userLabel, displayName: userLabel },
        pubKeyCredParams: [{ type: 'public-key', alg: -7 }, { type: 'public-key', alg: -257 }],
        authenticatorSelection: { userVerification: 'required', residentKey: 'required' },
        extensions: { prf: {} } as AuthenticationExtensionsClientInputs,
      },
    })
    const cred = created as PublicKeyCredential | null
    if (!cred) return null

    // The output is generally NOT available at create(), so this asserts immediately to get it.
    // Doing it here rather than at first use means a device that cannot actually produce output
    // never stores a wrap it could not open.
    const asserted = await auth.get({
      publicKey: {
        challenge: crypto.getRandomValues(new Uint8Array(32)),
        rpId,
        allowCredentials: [{ type: 'public-key', id: cred.rawId }],
        userVerification: 'required',
        extensions: { prf: { eval: { first: salt } } } as AuthenticationExtensionsClientInputs,
      },
    })
    const out = prfOutput(asserted)
    if (!out || out.length === 0) return null

    const iv = crypto.getRandomValues(new Uint8Array(12))
    const cipher = new Uint8Array(
      await crypto.subtle.encrypt({ name: 'AES-GCM', iv: iv.slice().buffer }, await keyFrom(out), secret.slice().buffer),
    )
    return {
      credentialId: b64url(new Uint8Array(cred.rawId)),
      salt: bytesToHex(salt),
      iv: bytesToHex(iv),
      cipher: bytesToHex(cipher),
    }
  } catch {
    return null
  }
}

/**
 * Open a wrap made on THIS device. Returns `null` on anything at all: no authenticator, a cancelled
 * prompt, a credential that is gone, PRF output that changed (a synced passkey on another device),
 * or a tampered blob. The caller falls through to the passphrase.
 */
export async function openPrf(
  auth: Authenticator,
  wrap: PrfWrap,
  rpId: string,
): Promise<Uint8Array | null> {
  try {
    const asserted = await auth.get({
      publicKey: {
        challenge: crypto.getRandomValues(new Uint8Array(32)),
        rpId,
        allowCredentials: [{ type: 'public-key', id: unb64url(wrap.credentialId).slice().buffer }],
        userVerification: 'required',
        extensions: { prf: { eval: { first: hexToBytes(wrap.salt) } } } as AuthenticationExtensionsClientInputs,
      },
    })
    const out = prfOutput(asserted)
    if (!out) return null
    const plain = await crypto.subtle.decrypt(
      { name: 'AES-GCM', iv: hexToBytes(wrap.iv).slice().buffer },
      await keyFrom(out),
      hexToBytes(wrap.cipher).slice().buffer,
    )
    return new Uint8Array(plain)
  } catch {
    // Includes the case that matters most: different PRF output produces a key that fails GCM
    // authentication. That is a wrap made on another device, and it must read as "ask for the
    // passphrase", never as an error the member has to interpret.
    return null
  }
}

function b64url(b: Uint8Array): string {
  return btoa(String.fromCharCode(...b)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}
function unb64url(s: string): Uint8Array {
  const b = atob(s.replace(/-/g, '+').replace(/_/g, '/'))
  return Uint8Array.from(b, (c) => c.charCodeAt(0))
}
