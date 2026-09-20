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
//  3. FAILING TO OPEN IS SILENT; FAILING TO ENROL IS REPORTED. No authenticator, no PRF, a
//     cancelled prompt, a changed output - opening returns "no" for all of it, and the caller asks
//     for the passphrase exactly as it does today. The downside is bounded at zero: it either saves
//     typing or it does not, and it can never lose anything.
//
//     Enrolment is the other way round, and #538 is why. The member pressed a button and is owed an
//     answer, and "this device could not set that up" for four different causes is what turned one
//     defect into two days of guessing. It returns a `PrfDenial`.
//
//  4. NEITHER CEREMONY MAY WAIT FOREVER. `publicKey.timeout` is advisory, and Android's enrolment
//     hang is precisely a case where it is not honoured, so the bound is enforced here as well. A
//     promise that never settles is not caught by any `catch`, and what it produces is a busy
//     button with no error - which reads as a broken product, not a failed shortcut.
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

/**
 * Why an enrolment produced no wrap.
 *
 * Enrolment REPORTS; opening stays silent (rule 3). The asymmetry is deliberate: a member who just
 * pressed "create" asked for this and is owed an answer, while a shortcut that fails to OPEN must
 * cost nothing and fall through to the passphrase without a word.
 *
 * `no-prf` is the one that is permanent - this authenticator does not implement the extension and
 * never will - so the copy for it must not invite retrying forever.
 */
export type PrfDenial = 'cancelled' | 'no-prf' | 'unanswered' | 'already-enrolled'

/**
 * Why a wrap did not open.
 *
 * `openPrf` used to answer `null` for all of these, and that was defensible while the only consumer
 * was a screen that must not alarm anyone. It stopped being defensible the moment someone had to
 * DIAGNOSE it: the shortcut is per DEVICE by design, so the device that fails is a phone, and a
 * phone's browser has no console. Remote debugging over a cable is not a reasonable thing to ask of
 * a treasurer.
 *
 * The screen still says one quiet sentence. This is what sits behind a "details" tap, and
 * `different-key` is the one worth the whole exercise: it means the authenticator DID produce PRF
 * output and the output no longer matches what enrolment used. That is the synced-passkey hazard
 * the per-device rule exists for, and it is indistinguishable from a cancelled prompt until it is
 * named.
 */
export type PrfOpenDenial = 'cancelled' | 'no-prf' | 'unanswered' | 'different-key'

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

/** How long to wait for the platform before giving up. Generous: a real member is reading a system
 *  prompt, and cutting that short would invent a failure. */
const DEFAULT_TIMEOUT_MS = 60_000

/** Thrown by `answered` alone, so the catch can tell "never replied" from "replied no". */
class Unanswered extends Error {}

/**
 * Bound a ceremony that may never settle.
 *
 * `publicKey.timeout` is set as well, but it is ADVISORY and the case this exists for is precisely
 * the one where the platform does not honour it: on Android the second ceremony of an enrolment can
 * neither resolve nor reject, because the system sheet will not reopen while the first is still
 * tearing down. A bare `catch` is no defence - a pending promise is not a rejection - so the caller
 * sat on a busy button forever with nothing to show (#538).
 */
function answered<T>(p: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Unanswered()), ms)
    p.then(
      (v) => { clearTimeout(timer); resolve(v) },
      (e) => { clearTimeout(timer); reject(e) },
    )
  })
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
 * Returns a `PrfDenial` rather than a wrap on ANY failure, the member cancelling included. An
 * enrolment that half-worked must never be stored: a wrap we cannot open is worse than no wrap,
 * because it looks like a way in.
 *
 * It used to return a bare `null` for all of it. That collapsed four different situations into one
 * screen that said "this device could not set that up", so two days were spent guessing which one a
 * member had hit - and the one they had actually hit was a FIFTH that this function could not
 * report at all, because it never returned (#538).
 */
export async function enrolPrf(
  auth: Authenticator,
  vaultId: string,
  secret: Uint8Array,
  rpId: string,
  userLabel: string,
  timeoutMs: number = DEFAULT_TIMEOUT_MS,
): Promise<PrfWrap | PrfDenial> {
  try {
    const salt = crypto.getRandomValues(new Uint8Array(32))
    const created = await answered(auth.create({
      publicKey: {
        timeout: timeoutMs,
        challenge: crypto.getRandomValues(new Uint8Array(32)),
        rp: { id: rpId, name: 'Konclave' },
        // `.slice().buffer` for the same reason `bufOf` exists in storage.ts: TS 5.7's
        // Uint8Array<ArrayBufferLike> does not satisfy the DOM BufferSource type, a real
        // ArrayBuffer does.
        user: { id: hexToBytes(vaultId.slice(0, 64)).slice().buffer, name: userLabel, displayName: userLabel },
        pubKeyCredParams: [{ type: 'public-key', alg: -7 }, { type: 'public-key', alg: -257 }],
        authenticatorSelection: {
          // THIS device, not any authenticator the browser can reach. Without it the prompt also
          // offers a security key or "use another phone" over QR - and the wrap that comes back is
          // then bound to a thing the member may not have next time they reload this browser. The
          // whole design is per-device precisely because the spec guarantees nothing about PRF
          // output surviving a passkey sync, so accepting a roaming authenticator here would enrol
          // exactly the case the design refuses to rely on.
          authenticatorAttachment: 'platform',
          userVerification: 'required',
          residentKey: 'required',
        },
        // The salt is evaluated HERE, not only at the assertion below. Chrome and Safari have
        // returned PRF output at creation since early 2026, and when they do the second ceremony is
        // not needed at all - which matters because firing it immediately after the first is what
        // Android could not survive (#538). One ceremony also means one prompt, which is what a
        // member expects from a button that says "create a passkey".
        extensions: { prf: { eval: { first: salt } } } as AuthenticationExtensionsClientInputs,
      },
    }), timeoutMs)
    const cred = created as PublicKeyCredential | null
    if (!cred) return 'cancelled'

    // The fallback, for a browser that accepts the extension at creation but returns nothing there.
    // Asserting at enrolment rather than at first use means a device that cannot actually produce
    // output never stores a wrap it could not open.
    const atCreate = prfOutput(cred)
    const asserted = atCreate ? cred : await answered(auth.get({
      publicKey: {
        timeout: timeoutMs,
        challenge: crypto.getRandomValues(new Uint8Array(32)),
        rpId,
        allowCredentials: [{ type: 'public-key', id: cred.rawId }],
        userVerification: 'required',
        extensions: { prf: { eval: { first: salt } } } as AuthenticationExtensionsClientInputs,
      },
    }), timeoutMs)
    const out = prfOutput(asserted)
    // The ceremony completed and produced nothing: this authenticator does not implement PRF. That
    // is permanent, and the only denial here the member cannot fix by trying again.
    if (!out || out.length === 0) return 'no-prf'

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
  } catch (e) {
    if (e instanceof Unanswered) return 'unanswered'
    // The platform DOES say which of these happened, and the first version of this catch threw that
    // away by answering "cancelled" for all of them - the same one-sentence-for-many-causes mistake
    // this function had just been fixed for, reintroduced by its own fix.
    switch ((e as DOMException | null)?.name) {
      // A passkey for this vault already exists on this authenticator. The only denial whose remedy
      // is somewhere else entirely: the member has to remove it in their system's passkey manager.
      case 'InvalidStateError': return 'already-enrolled'
      // The options were refused outright - no platform authenticator, or no PRF. Permanent, and it
      // shares the permanent message rather than earning a fifth one nobody could act on differently.
      case 'NotSupportedError': return 'no-prf'
      // `NotAllowedError` (a cancelled or timed-out prompt) and anything else. Still a catch-all,
      // and deliberately the smallest one: its copy claims nothing beyond "nothing changed".
      default: return 'cancelled'
    }
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
  timeoutMs: number = DEFAULT_TIMEOUT_MS,
): Promise<Uint8Array | PrfOpenDenial> {
  let out: Uint8Array | null
  try {
    // Bounded for the same reason the enrolment is: this path has its own busy button
    // (`vaults.passkeyBusy`), so a ceremony that never answers freezes the unlock exactly as it
    // froze the enrolment.
    const asserted = await answered(auth.get({
      publicKey: {
        timeout: timeoutMs,
        challenge: crypto.getRandomValues(new Uint8Array(32)),
        rpId,
        allowCredentials: [{ type: 'public-key', id: unb64url(wrap.credentialId).slice().buffer }],
        userVerification: 'required',
        extensions: { prf: { eval: { first: hexToBytes(wrap.salt) } } } as AuthenticationExtensionsClientInputs,
      },
    }), timeoutMs)
    out = prfOutput(asserted)
  } catch (e) {
    // A cancelled prompt, a credential the browser no longer has, an origin that does not match.
    return e instanceof Unanswered ? 'unanswered' : 'cancelled'
  }
  // The ceremony completed and produced nothing: this authenticator does not implement PRF.
  if (!out) return 'no-prf'

  try {
    const plain = await crypto.subtle.decrypt(
      { name: 'AES-GCM', iv: hexToBytes(wrap.iv).slice().buffer },
      await keyFrom(out),
      hexToBytes(wrap.cipher).slice().buffer,
    )
    return new Uint8Array(plain)
  } catch {
    // THE CASE THIS SPLIT EXISTS FOR, and it was hidden inside the same catch as a cancellation.
    // The authenticator answered and produced output; that output no longer derives the key the
    // wrap was sealed with. A passkey that synced to another device, or one whose PRF the platform
    // does not keep stable - the hazard the per-device rule is built around. Reaching this means
    // the shortcut will not work here again, and only the member re-enrolling changes that.
    return 'different-key'
  }
}

/** Did `openPrf` hand back the secret, or a reason it did not? */
export function isPrfOpenDenial(r: Uint8Array | PrfOpenDenial): r is PrfOpenDenial {
  return typeof r === 'string'
}

function b64url(b: Uint8Array): string {
  return btoa(String.fromCharCode(...b)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}
function unb64url(s: string): Uint8Array {
  const b = atob(s.replace(/-/g, '+').replace(/_/g, '/'))
  return Uint8Array.from(b, (c) => c.charCodeAt(0))
}
