import { afterEach, describe, expect, it, vi } from 'vitest'
import { copyText } from './clipboard'
import { codeOf } from './source-scan'

// #313: Add funds (the vault's address and the payment link) and the proof page (txids) said
// "Copied" whatever the clipboard did. They now say it only when the write resolved, and say so
// when it did not.
describe('copyText says what the clipboard did', () => {
  const original = Object.getOwnPropertyDescriptor(globalThis, 'navigator')
  afterEach(() => { if (original) Object.defineProperty(globalThis, 'navigator', original); else delete (globalThis as { navigator?: unknown }).navigator })
  const withClipboard = (writeText: unknown) =>
    Object.defineProperty(globalThis, 'navigator', { value: { clipboard: writeText ? { writeText } : undefined }, configurable: true })

  it('is true when the browser confirmed the write', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined)
    withClipboard(writeText)
    expect(await copyText('u1x')).toBe(true)
    expect(writeText).toHaveBeenCalledWith('u1x')
  })
  it('is false when the write was refused, and the rejection does not escape', async () => {
    withClipboard(vi.fn().mockRejectedValue(new DOMException('denied', 'NotAllowedError')))
    expect(await copyText('u1x')).toBe(false)
  })
  it('is false when there is no clipboard at all (an insecure context)', async () => {
    withClipboard(undefined)
    expect(await copyText('u1x')).toBe(false)
  })
})

describe('the two screens go through it and claim nothing on their own', () => {
  for (const f of ['screens/Receive.tsx', 'screens/Proof.tsx']) {
    it(`${f} awaits the write and says when it failed`, () => {
      const src = codeOf(f)
      expect(src).not.toMatch(/void navigator\.clipboard/)
      expect(src).not.toMatch(/navigator\.clipboard/)
      expect(src).toMatch(/await copyText\(/)
      expect(src).toMatch(/copyErr|copyFailed/)
    })
  }
})

// #313, the rest: the /net page copied the vault's address and the signing-session code without
// waiting for the clipboard, and said nothing either way. Every write there is now awaited (through
// copyText or the shared CopyButton), and the address says whether it was copied.
describe('the /net page claims nothing about a copy it did not wait for', () => {
  it('every clipboard write in NetVault.tsx is awaited', () => {
    const src = codeOf('screens/NetVault.tsx')
    const writes = [...src.matchAll(/navigator\.clipboard\??\.writeText\(/g)]
    for (const w of writes) expect(src.slice(Math.max(0, w.index! - 6), w.index)).toBe('await ')
    expect(src).toMatch(/await copyText\(hostedAddress\)/)
    expect(src).toMatch(/toast\.copyFailed/)
  })
})
