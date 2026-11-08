import { describe, expect, it } from 'vitest'
import { receiversFingerprint } from './format'

describe('the viewing code', () => {
  it('is this exact value: the domain, the group key and both receivers are in it', async () => {
    expect(await receiversFingerprint('ab'.repeat(32), 'cc'.repeat(43), 'dd'.repeat(43))).toBe('SXWXK-NF66F-H5T8W-BJX9N-5BEX3')
  })
  it('an id that is not hex is an error, never a code of zeros', async () => {
    await expect(receiversFingerprint('zz', 'cc', 'dd')).rejects.toThrow()
    await expect(receiversFingerprint('abc', 'cc', 'dd')).rejects.toThrow()
  })
})
