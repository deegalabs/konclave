import { describe, expect, it } from 'vitest'
import { readBackupFlags } from './webauthn-flags'
import { enrolPrf, type Authenticator } from './prf-wrap'

// Decided by the maintainer on 2026-11-06. Whether a passkey is a SYNCED one is read from the authenticator data the credential
// returned, byte by byte (WebAuthn §6.1: rpIdHash is bytes 0..31, the flags byte is byte 32, BE is
// bit 3 and BS is bit 4). Nothing here trusts a boolean a browser or a library volunteered.

/** Authenticator data with `flags` at byte 32: a 32-byte rpIdHash, the flags, a 4-byte counter. */
function authData(flags: number, len = 37): Uint8Array {
  const b = new Uint8Array(len)
  b.fill(0xaa, 0, 32)
  if (len > 32) b[32] = flags
  return b
}

const UP = 0x01
const UV = 0x04
const BE = 0x08
const BS = 0x10
const AT = 0x40

describe('reading BE and BS from authenticator data', () => {
  it('BE set and BS set: a synced passkey that is backed up', () => {
    expect(readBackupFlags(authData(UP | UV | BE | BS))).toEqual({ eligible: true, backedUp: true })
  })

  it('BE set and BS clear: eligible for sync, not backed up yet', () => {
    expect(readBackupFlags(authData(UP | UV | BE))).toEqual({ eligible: true, backedUp: false })
  })

  it('BE clear: a passkey bound to this device', () => {
    expect(readBackupFlags(authData(UP | UV))).toEqual({ eligible: false, backedUp: false })
    // Every other bit set must not leak into BE: only bit 3 decides it.
    expect(readBackupFlags(authData(0xff & ~BE & ~BS))).toEqual({ eligible: false, backedUp: false })
  })

  it('reads byte 32 and nothing else, with attested credential data after the counter', () => {
    const b = authData(UP | UV | AT | BE, 37 + 40)
    b.fill(0x08, 33) // trailing bytes that would read as BE if the offset were wrong
    expect(readBackupFlags(b)?.eligible).toBe(true)
    const clear = authData(UP | UV | AT, 37 + 40)
    clear.fill(0xff, 33)
    clear.fill(0xff, 0, 32)
    expect(readBackupFlags(clear)?.eligible).toBe(false)
  })

  it('accepts an ArrayBuffer as WebAuthn hands it over', () => {
    expect(readBackupFlags(authData(UP | BE).slice().buffer)?.eligible).toBe(true)
  })

  it('malformed: shorter than the 37 bytes the spec fixes, empty, or missing', () => {
    expect(readBackupFlags(authData(UP | BE, 36))).toBeNull()
    expect(readBackupFlags(authData(UP | BE, 33))).toBeNull()
    expect(readBackupFlags(new Uint8Array(0))).toBeNull()
    expect(readBackupFlags(null)).toBeNull()
    expect(readBackupFlags(undefined)).toBeNull()
  })

  it('malformed: BS without BE, which §6.1.3 forbids', () => {
    expect(readBackupFlags(authData(UP | BS))).toBeNull()
  })

  it('malformed: not bytes at all', () => {
    expect(readBackupFlags('0x1d' as unknown as Uint8Array)).toBeNull()
    expect(readBackupFlags({ length: 37, 32: BE } as unknown as Uint8Array)).toBeNull()
  })
})

describe('enrolPrf reports BE from the bytes, never from a convenience field', () => {
  const S = new Uint8Array(32).fill(9)
  const RP = 'konclave.xyz'
  const prf = { prf: { results: { first: new Uint8Array(32).fill(7).buffer } } }

  /** An authenticator that returns PRF output at create, with `response` as given. */
  const authWith = (response: unknown, getResponse?: unknown): Authenticator => ({
    create: async () => ({
      rawId: new Uint8Array([1, 2, 3, 4]).buffer,
      response,
      getClientExtensionResults: () => (getResponse === undefined ? prf : {}),
    }) as unknown as Credential,
    get: async () => ({
      rawId: new Uint8Array([1, 2, 3, 4]).buffer,
      response: getResponse,
      getClientExtensionResults: () => prf,
    }) as unknown as Credential,
  })

  const enrol = (a: Authenticator) => enrolPrf(a, 'ab'.repeat(32), S, RP, 'member')

  it('BE set in the creation authenticator data: backupEligible is true', async () => {
    const r = await enrol(authWith({ getAuthenticatorData: () => authData(UP | UV | BE | BS).slice().buffer }))
    if (typeof r === 'string') throw new Error(r)
    expect(r.backupEligible).toBe(true)
  })

  it('BE clear: backupEligible is false', async () => {
    const r = await enrol(authWith({ getAuthenticatorData: () => authData(UP | UV).slice().buffer }))
    if (typeof r === 'string') throw new Error(r)
    expect(r.backupEligible).toBe(false)
  })

  it('no authenticator data to read: backupEligible is null, and enrolment still succeeds', async () => {
    const r = await enrol(authWith(undefined))
    if (typeof r === 'string') throw new Error(r)
    expect(r.backupEligible).toBeNull()
    expect(r.cipher.length).toBeGreaterThan(0)
  })

  it('malformed authenticator data: null, not a guess, and enrolment still succeeds', async () => {
    const r = await enrol(authWith({ getAuthenticatorData: () => new Uint8Array(10).buffer }))
    if (typeof r === 'string') throw new Error(r)
    expect(r.backupEligible).toBeNull()
  })

  it('ignores a boolean a response volunteers: only the bytes count', async () => {
    const r = await enrol(authWith({ backupEligible: true, getAuthenticatorData: () => authData(UP | UV).slice().buffer }))
    if (typeof r === 'string') throw new Error(r)
    expect(r.backupEligible).toBe(false)
  })

  it('falls back to the assertion authenticator data when creation offers none', async () => {
    const r = await enrol(authWith({}, { authenticatorData: authData(UP | UV | BE).slice().buffer }))
    if (typeof r === 'string') throw new Error(r)
    expect(r.backupEligible).toBe(true)
  })
})
