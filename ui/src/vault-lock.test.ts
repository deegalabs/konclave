import { describe, expect, it } from 'vitest'
import { needsUnlock } from './vault-lock'

// The rule the route guards ask. #439: the guard asked the BRIDGE's question on a browser-native
// vault, which never sets `locked`, so it never fired and a member walked into a protected vault
// holding no S. Every private read then 401'd into a blank screen.

const base = { unlockedThisSession: false, hasAccessSecret: false }

describe('needsUnlock - can this device read the vault, or must it unlock first (#439)', () => {
  it('THE BUG: a protected vault with no S in memory must be stopped', () => {
    // A page reload is enough to produce this: the session is in memory. Before the fix nothing
    // stopped it, because `bridgeLocked` is undefined on a browser-native vault.
    expect(needsUnlock({ ...base, securedLocally: true })).toBe(true)
  })

  it('and it is stopped even though the bridge flag says nothing', () => {
    // The precise shape of the defect, pinned: undefined `bridgeLocked` used to make the whole
    // condition false regardless of anything else.
    expect(needsUnlock({ bridgeLocked: undefined, securedLocally: true, ...base })).toBe(true)
  })

  it('a protected vault WITH S in memory goes straight through', () => {
    expect(needsUnlock({ ...base, securedLocally: true, hasAccessSecret: true })).toBe(false)
  })

  it('an OPEN vault is not stopped: its reads work without a token', () => {
    // The helper keeps the gate open until a readKey is registered, so demanding an unlock here
    // would break the 5 live vaults that have not migrated to #388.
    expect(needsUnlock({ ...base, securedLocally: false })).toBe(false)
  })

  it('the bridge case is unchanged: locked and not unlocked this session is stopped', () => {
    expect(needsUnlock({ ...base, bridgeLocked: true })).toBe(true)
  })

  it('the bridge case is unchanged: locked but unlocked this session goes through', () => {
    expect(needsUnlock({ ...base, bridgeLocked: true, unlockedThisSession: true })).toBe(false)
  })

  it('a device with NO local record is not sent to the unlock door it cannot open', () => {
    // `securedLocally` undefined means there is nothing on this device to decrypt. Routing here
    // would offer a door with no key behind it, and could bounce between screens. Its reads may
    // still 401; saying so honestly is the wider fix, not this one.
    expect(needsUnlock({ ...base })).toBe(false)
    expect(needsUnlock({ ...base, securedLocally: undefined })).toBe(false)
  })

  it('a bridge vault that is not locked goes through', () => {
    expect(needsUnlock({ ...base, bridgeLocked: false })).toBe(false)
  })
})
