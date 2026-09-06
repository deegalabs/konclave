import { describe, expect, it, vi } from 'vitest'
import { enrolPrf, openPrf, type Authenticator, type PrfWrap } from './prf-wrap'

// #446 option C. The authenticator is injected, so these drive the REAL crypto path (HKDF over the
// PRF output, AES-GCM over `S`) without a browser. What is faked is only the authenticator, which
// is the one thing a test cannot have.
//
// The properties under test are the three rules the design rests on: the wrap opens on the device
// that made it, it does NOT open when the PRF output differs (a synced passkey on a second device,
// which the spec does not prevent and Apple's forums show happening), and every failure is silent
// so the caller falls through to the passphrase.

const S = new Uint8Array(32).fill(9)
const RP = 'konclave.xyz'

/** An authenticator whose PRF is a pure function of the salt, plus a per-device twist. */
function fakeAuth(device = 'A'): Authenticator {
  const prfFor = (salt: Uint8Array) => {
    const out = new Uint8Array(32)
    for (let i = 0; i < 32; i++) out[i] = (salt[i % salt.length]! + device.charCodeAt(0)) & 0xff
    return out.buffer
  }
  const results = (o: CredentialRequestOptions) => {
    const ext = o.publicKey?.extensions as { prf?: { eval?: { first?: BufferSource } } } | undefined
    const first = ext?.prf?.eval?.first as Uint8Array | undefined
    return { prf: { results: { first: first ? prfFor(first) : undefined } } }
  }
  return {
    create: async () => ({
      rawId: new Uint8Array([1, 2, 3, 4]).buffer,
      getClientExtensionResults: () => ({ prf: { enabled: true } }),
    }) as unknown as Credential,
    get: async (o) => ({
      rawId: new Uint8Array([1, 2, 3, 4]).buffer,
      getClientExtensionResults: () => results(o),
    }) as unknown as Credential,
  }
}

describe('the PRF wrap (#446 C)', () => {
  it('round-trips the secret on the device that enrolled', async () => {
    const auth = fakeAuth('A')
    const wrap = await enrolPrf(auth, 'ab'.repeat(32), S, RP, 'member')
    expect(wrap, 'enrolment produced a wrap').not.toBeNull()
    expect(Array.from((await openPrf(auth, wrap!, RP))!)).toEqual(Array.from(S))
  })

  it('does NOT open on a device whose PRF output differs, and says so by returning null', async () => {
    // The property the whole per-device rule exists for. The spec guarantees nothing about PRF
    // output surviving a passkey SYNC, and Apple's forums carry open reports of exactly this
    // asymmetry. A wrap that silently opened with the wrong key would be worse; a wrap that throws
    // would make the member read a stack trace. It returns null, and the caller asks for the
    // passphrase.
    const wrap = await enrolPrf(fakeAuth('A'), 'ab'.repeat(32), S, RP, 'member')
    expect(await openPrf(fakeAuth('B'), wrap!, RP)).toBeNull()
  })

  it('never stores a wrap it could not open: no PRF output means no enrolment', async () => {
    // A browser that reports the extension and returns nothing (Firefox answers `{}` where Chrome
    // answers `enabled: false`) must not leave a record that looks like a way in.
    const noPrf: Authenticator = {
      create: async () => ({ rawId: new Uint8Array([1]).buffer, getClientExtensionResults: () => ({}) }) as unknown as Credential,
      get: async () => ({ rawId: new Uint8Array([1]).buffer, getClientExtensionResults: () => ({}) }) as unknown as Credential,
    }
    expect(await enrolPrf(noPrf, 'ab'.repeat(32), S, RP, 'member')).toBeNull()
  })

  it('a cancelled prompt is silent, on both paths', async () => {
    // The member pressing Escape is not an error. It is them choosing the passphrase.
    const cancels: Authenticator = {
      create: async () => { throw new DOMException('NotAllowedError') },
      get: async () => { throw new DOMException('NotAllowedError') },
    }
    expect(await enrolPrf(cancels, 'ab'.repeat(32), S, RP, 'member')).toBeNull()
    const wrap: PrfWrap = { credentialId: 'AQID', salt: 'aa'.repeat(32), iv: 'bb'.repeat(12), cipher: 'cc'.repeat(48) }
    expect(await openPrf(cancels, wrap, RP)).toBeNull()
  })

  it('a tampered wrap does not open', async () => {
    const auth = fakeAuth('A')
    const wrap = await enrolPrf(auth, 'ab'.repeat(32), S, RP, 'member')!
    const tampered = { ...wrap!, cipher: wrap!.cipher.replace(/^../, 'ff') }
    expect(await openPrf(auth, tampered, RP)).toBeNull()
  })

  it('two vaults on one device derive different keys', async () => {
    // The salt is per vault, so one vault's wrap can never open another's, even on the same
    // credential and the same authenticator.
    const auth = fakeAuth('A')
    const a = await enrolPrf(auth, 'ab'.repeat(32), S, RP, 'member')
    const b = await enrolPrf(auth, 'cd'.repeat(32), S, RP, 'member')
    expect(a!.salt).not.toBe(b!.salt)
    const crossed = { ...b!, salt: a!.salt }
    expect(await openPrf(auth, crossed, RP)).toBeNull()
  })

  it('the enrolment asks for PRF at create AND evaluates it before storing', async () => {
    // The output is generally not available at create(), so a device that cannot actually produce
    // it must be discovered at enrolment, not at first use.
    const auth = fakeAuth('A')
    const create = vi.spyOn(auth, 'create')
    const get = vi.spyOn(auth, 'get')
    await enrolPrf(auth, 'ab'.repeat(32), S, RP, 'member')
    expect(create).toHaveBeenCalledOnce()
    expect(get, 'it asserts once to obtain the output').toHaveBeenCalledOnce()
    const ext = create.mock.calls[0]![0].publicKey?.extensions as { prf?: unknown }
    expect(ext.prf, 'PRF is requested at creation').toBeDefined()
  })

  // The shortcut is per-device by design: the spec guarantees nothing about PRF output surviving a
  // passkey sync, and Apple's own forums carry reports of it differing by sync direction. Enrolling
  // a roaming authenticator - a security key, or another phone over QR - would bind the wrap to
  // something this browser may not reach next reload, which is the case the design refuses to rely
  // on. Asserted on what is REQUESTED, since only the browser can honour it.
  it('asks for this device, not any authenticator the browser can reach', async () => {
    let asked: CredentialCreationOptions | undefined
    const auth = fakeAuth('A')
    const spy: Authenticator = {
      create: (o) => { asked = o; return auth.create(o) },
      get: (o) => auth.get(o),
    }
    await enrolPrf(spy, 'ab'.repeat(32), S, RP, 'member')
    const sel = asked?.publicKey?.authenticatorSelection
    expect(sel?.authenticatorAttachment, 'a roaming authenticator must not be enrolled').toBe('platform')
    expect(sel?.userVerification, 'the member must be verified, not merely present').toBe('required')
  })
})
