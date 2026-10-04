import { describe, expect, it } from 'vitest'
import { readingRows } from './device-reading'
import type { SignPreview } from './signing-machine'

// #610. The label on an output is optional and outside what the signature covers, so a missing one
// says nothing about where the money goes. The first version of this screen called every unlabelled
// output "back to the vault (change)", which under a refusal showed a payment to an outsider, stripped
// of its label, as the vault's own change: the one screen the member is told to compare with the
// proposal. Only the vault's own receivers, the same ones the money gate uses, may be called change.
const VAULT_CHG = 'de020202'
const OUTSIDER = 'cacacaca'
const isOurs = (r: string | null) => r === VAULT_CHG

const preview = (outputs: SignPreview['outputs']): SignPreview => ({ outputs, feeZat: 20_000 })

describe('readingRows', () => {
  it('names a labelled output by its address', () => {
    const rows = readingRows(preview([{ zat: 100_000_000, addr: 'u1alice', recipient: 'a1a1' }]), isOurs)
    expect(rows).toEqual([{ zat: 100_000_000, to: { kind: 'address', addr: 'u1alice' } }])
  })

  it('calls an unlabelled output change only when it pays one of the vault\'s own receivers', () => {
    const rows = readingRows(preview([{ zat: 99_960_000, addr: null, recipient: VAULT_CHG }]), isOurs)
    expect(rows).toEqual([{ zat: 99_960_000, to: { kind: 'vault' } }])
  })

  it('never calls an unlabelled payment to an outsider change', () => {
    const rows = readingRows(preview([{ zat: 100_000_000, addr: null, recipient: OUTSIDER }]), isOurs)
    expect(rows).toEqual([{ zat: 100_000_000, to: { kind: 'unnamed' } }])
  })

  it('does not guess when the device does not know the vault\'s receivers', () => {
    const rows = readingRows(preview([{ zat: 1, addr: null, recipient: VAULT_CHG }]), () => false)
    expect(rows[0]?.to).toEqual({ kind: 'unnamed' })
  })
})
