import { describe, expect, it } from 'vitest'
import { bannerRefusal, noteSeatRefused, seatRefusal } from './seat-registration'
import { deviceRefusal } from './session'
import { clearVaultTraces } from './remove-vault'

// A refused seat lives in one store: what the dashboard shows, what the shell says and what keeps the
// signer from arming read the same entry, and removing the vault from the device forgets it.
describe('a refused seat, one store', () => {
  const V = 'cd'.repeat(32)
  it('a coded refusal is the banner and the signer gate at once', () => {
    noteSeatRefused(V, 'registration.seatRefused', 'a_code')
    expect(seatRefusal(V)).toBe('registration.seatRefused')
    expect(deviceRefusal(V)).toBe('a_code')
  })
  it('an uncoded refusal on a clean vault shows the banner and leaves no code', () => {
    clearVaultTraces(V)
    noteSeatRefused(V, 'registration.seatTaken')
    expect(seatRefusal(V)).toBe('registration.seatTaken')
    expect(deviceRefusal(V)).toBeUndefined()
  })
  it('removing the vault from the device forgets it', () => {
    noteSeatRefused(V, 'registration.seatRefused', 'a_code')
    clearVaultTraces(V)
    expect(seatRefusal(V)).toBeNull()
    expect(deviceRefusal(V)).toBeUndefined()
  })
  it('a later refusal without a code keeps the code, so the signer stays disarmed', () => {
    noteSeatRefused(V, 'registration.seatRefused', 'a_code')
    noteSeatRefused(V, 'registration.seatRefused')
    expect(deviceRefusal(V)).toBe('a_code')
    clearVaultTraces(V)
  })
  it('the banner shows only a refusal without a code; a coded one is the shell\'s', () => {
    clearVaultTraces(V)
    noteSeatRefused(V, 'registration.seatRefused', 'a_code')
    expect(bannerRefusal(V)).toBeNull()
    clearVaultTraces(V)
    noteSeatRefused(V, 'registration.seatTaken')
    expect(bannerRefusal(V)).toBe('registration.seatTaken')
    clearVaultTraces(V)
  })
})
