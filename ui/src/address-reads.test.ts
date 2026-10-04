/// <reference types="node" />
import { describe, expect, it } from 'vitest'
import { addressText } from './approved-payment'
import { codeOf } from './source-scan'

// Two screens read a stored vault's address inside an effect, which a server render does not run and
// this suite has no DOM to run, so the reading is pinned in the code that carries it. Both go through
// `addressText`, the reading the money gate and the deposit screen use: a record whose address is not
// text must come out as no address, never as a value `shortAddr` would throw on (A9).
describe('a stored address that is not text is read as none on every screen', () => {
  it('the reading itself', () => {
    expect(addressText(123)).toBe('')
    expect(addressText({ x: 1 })).toBe('')
    expect(addressText(' u1x ')).toBe('u1x')
  })

  it('the vault list reads each record through it', () => {
    expect(codeOf('./screens/Vaults.tsx')).toContain('orchard_address: addressText(s.address)')
  })

  it('the creation screen reads the registered address through it', () => {
    expect(codeOf('./screens/NetVault.tsx')).toContain('setHostedAddress(addressText(v.address))')
  })
})
