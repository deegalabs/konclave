import { describe, it, expect } from 'vitest'
import { deriveRoom, encodeInvite, parseInvite } from './net'

// Admission-PIN room derivation (#65 / ADR-0007 I4). Without a PIN the room IS the invite code
// (backward-compatible bearer model); with a PIN the room is a 128-bit id derived from both, so a
// device holding only the code lands in a different room and never meets the members.
describe('deriveRoom - PIN-gated admission', () => {
  it('with no PIN, the room is exactly the invite code', async () => {
    expect(await deriveRoom('GRQ2QWCT', '')).toBe('GRQ2QWCT')
    expect(await deriveRoom('GRQ2QWCT', '   ')).toBe('GRQ2QWCT') // whitespace-only = no PIN
  })

  it('with a PIN, the room is a deterministic 128-bit hex id (not the code)', async () => {
    const r = await deriveRoom('GRQ2QWCT', '1234')
    expect(r).toMatch(/^[0-9a-f]{32}$/)
    expect(r).not.toBe('GRQ2QWCT')
    expect(await deriveRoom('GRQ2QWCT', '1234')).toBe(r) // deterministic: same code+PIN -> same room
  })

  it('a wrong PIN yields a DIFFERENT room (a code-only attacker never meets the members)', async () => {
    const right = await deriveRoom('GRQ2QWCT', 'secret-pin')
    const wrong = await deriveRoom('GRQ2QWCT', 'guessed')
    const noPin = await deriveRoom('GRQ2QWCT', '')
    expect(wrong).not.toBe(right)
    expect(noPin).not.toBe(right) // the code alone (no PIN) also lands elsewhere
  })

  it('a PIN is trimmed (leading/trailing space does not change the room)', async () => {
    expect(await deriveRoom('GRQ2QWCT', ' 1234 ')).toBe(await deriveRoom('GRQ2QWCT', '1234'))
  })
})

// Relay carried in the invite (#213 follow-up): a joiner auto-meets the creator on the creator's
// relay. Backward-compatible - a plain code (default relay) is unchanged. RELAY_BASE is '' in tests.
describe('encodeInvite / parseInvite - relay in the invite', () => {
  it('a default-relay invite is just the room code (backward-compatible)', () => {
    expect(encodeInvite('GRQ2QWCT')).toBe('GRQ2QWCT')
    expect(encodeInvite('GRQ2QWCT', '')).toBe('GRQ2QWCT')
    expect(parseInvite('GRQ2QWCT')).toEqual({ room: 'GRQ2QWCT', relay: null })
  })

  it('a non-default relay round-trips, opaque (not the raw URL) in the invite', () => {
    const inv = encodeInvite('GRQ2QWCT', 'https://relay.b.example/')
    expect(inv.startsWith('GRQ2QWCT~')).toBe(true)
    expect(inv).not.toContain('https://') // encoded, not pasted in the clear
    expect(parseInvite(inv)).toEqual({ room: 'GRQ2QWCT', relay: 'https://relay.b.example' })
  })

  it('tolerates a malformed or empty relay part (falls back to the default)', () => {
    expect(parseInvite('GRQ2QWCT~')).toEqual({ room: 'GRQ2QWCT', relay: null })
    expect(parseInvite('GRQ2QWCT~not-valid-base64!!')).toEqual({ room: 'GRQ2QWCT', relay: null })
  })

  it('rejects a non-http relay payload (no javascript:/data: rendezvous)', () => {
    const bad = encodeInvite('GRQ2QWCT', 'javascript:alert(1)')
    expect(parseInvite(bad).relay).toBeNull()
  })
})
