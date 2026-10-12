import { describe, it, expect } from 'vitest'
import { deriveRoom } from './net'

// Admission-PIN room derivation (ADR-0007 I4, as amended). The PIN is required; the room is a
// 128-bit id derived from the invite and the PIN, so a device holding only the invite lands in a
// different room and never meets the members.
describe('deriveRoom - PIN-gated admission', () => {
  it('without a PIN there is no room: the PIN is required', async () => {
    await expect(deriveRoom('GRQ2QWCT', '')).rejects.toThrow()
    await expect(deriveRoom('GRQ2QWCT', '   ')).rejects.toThrow() // whitespace-only = no PIN
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
    expect(wrong).not.toBe(right)
  })

  it('a PIN is trimmed (leading/trailing space does not change the room)', async () => {
    expect(await deriveRoom('GRQ2QWCT', ' 1234 ')).toBe(await deriveRoom('GRQ2QWCT', '1234'))
  })
})
