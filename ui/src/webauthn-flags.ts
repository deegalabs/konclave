// Reading the backup flags a passkey carries (D95).
//
// The shortcut is per DEVICE by design (prf-wrap.ts, rule 2): the spec guarantees nothing about PRF
// output surviving a passkey sync. A synced passkey is the case that design refuses to rely on, so
// when a member enrols one we tell them, and the only honest way to know is to read it from the
// authenticator data the credential returned.
//
// WebAuthn §6.1: the authenticator data is rpIdHash (32 bytes), flags (1 byte), signCount (4 bytes),
// then optional attested credential data and extensions. In the flags byte, bit 3 is BE (backup
// eligible: this credential may be synced) and bit 4 is BS (backup state: it is backed up now). BE
// is fixed for the life of the credential; BS can change.
//
// Read from the BYTES, never from a boolean a browser or a library volunteers: the one thing this
// notice must not do is say "this passkey stays here" because some field claimed so.

/** The two backup bits, as read. */
export interface BackupFlags {
  /** BE, bit 3: the credential may be synced to other devices. */
  eligible: boolean
  /** BS, bit 4: the credential is backed up right now. */
  backedUp: boolean
}

/** The fixed prefix every authenticator data has: 32-byte rpIdHash, flags, 4-byte signCount. */
const MIN_LEN = 37
const FLAGS_AT = 32
const BE = 1 << 3
const BS = 1 << 4

/**
 * BE and BS from raw authenticator data, or null when the bytes are not authenticator data.
 *
 * Null covers: no data, anything that is not an ArrayBuffer or a Uint8Array, fewer than the 37 bytes
 * §6.1 fixes, and BS set without BE, which §6.1.3 forbids. A caller treats null as "unknown", never
 * as "not synced".
 */
export function readBackupFlags(data: ArrayBuffer | Uint8Array | null | undefined): BackupFlags | null {
  let bytes: Uint8Array
  if (data instanceof Uint8Array) bytes = data
  else if (data instanceof ArrayBuffer) bytes = new Uint8Array(data)
  else return null
  if (bytes.length < MIN_LEN) return null
  const flags = bytes[FLAGS_AT]!
  const eligible = (flags & BE) !== 0
  const backedUp = (flags & BS) !== 0
  if (backedUp && !eligible) return null
  return { eligible, backedUp }
}

/**
 * The authenticator data a credential returned, as bytes, or null.
 *
 * A registration response exposes it through `getAuthenticatorData()` (Chrome 85, Safari 16,
 * Firefox 119); an assertion response through `authenticatorData`. Older browsers that only give the
 * CBOR `attestationObject` at registration get null here rather than a hand-rolled CBOR reader.
 */
export function authenticatorDataOf(c: Credential | null | undefined): ArrayBuffer | null {
  const r = (c as { response?: unknown } | null | undefined)?.response as
    | { getAuthenticatorData?: () => unknown; authenticatorData?: unknown }
    | undefined
  if (!r || typeof r !== 'object') return null
  try {
    if (typeof r.getAuthenticatorData === 'function') {
      const d = r.getAuthenticatorData()
      if (d instanceof ArrayBuffer) return d
    }
  } catch {
    /* a response that throws here has nothing we can read */
  }
  return r.authenticatorData instanceof ArrayBuffer ? r.authenticatorData : null
}
