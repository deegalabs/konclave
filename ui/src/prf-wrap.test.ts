import { describe, expect, it, vi } from 'vitest'
import { enrolPrf, openPrf, type Authenticator, type PrfDenial, type PrfWrap } from './prf-wrap'

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

/** The wrap, or a failed test. Narrows `PrfWrap | PrfDenial` at the one place that cares, so a
 *  denial can never be silently spread into an object and assert nothing. */
function wrapOf(r: PrfWrap | PrfDenial): PrfWrap {
  if (typeof r === 'string') throw new Error(`expected a wrap, got the denial "${r}"`)
  return r
}

describe('the PRF wrap (#446 C)', () => {
  it('round-trips the secret on the device that enrolled', async () => {
    const auth = fakeAuth('A')
    const wrap = wrapOf(await enrolPrf(auth, 'ab'.repeat(32), S, RP, 'member'))
    expect(Array.from((await openPrf(auth, wrap, RP))!)).toEqual(Array.from(S))
  })

  it('does NOT open on a device whose PRF output differs, and says so by returning null', async () => {
    // The property the whole per-device rule exists for. The spec guarantees nothing about PRF
    // output surviving a passkey SYNC, and Apple's forums carry open reports of exactly this
    // asymmetry. A wrap that silently opened with the wrong key would be worse; a wrap that throws
    // would make the member read a stack trace. It returns null, and the caller asks for the
    // passphrase.
    const wrap = wrapOf(await enrolPrf(fakeAuth('A'), 'ab'.repeat(32), S, RP, 'member'))
    expect(await openPrf(fakeAuth('B'), wrap, RP)).toBeNull()
  })

  it('never stores a wrap it could not open: no PRF output means no enrolment', async () => {
    // A browser that reports the extension and returns nothing (Firefox answers `{}` where Chrome
    // answers `enabled: false`) must not leave a record that looks like a way in.
    const noPrf: Authenticator = {
      create: async () => ({ rawId: new Uint8Array([1]).buffer, getClientExtensionResults: () => ({}) }) as unknown as Credential,
      get: async () => ({ rawId: new Uint8Array([1]).buffer, getClientExtensionResults: () => ({}) }) as unknown as Credential,
    }
    // And it names the cause. This is the one denial the member cannot fix by trying again, so
    // the screen has to be able to say so instead of inviting a third attempt.
    expect(await enrolPrf(noPrf, 'ab'.repeat(32), S, RP, 'member')).toBe('no-prf')
  })

  it('a cancelled prompt is silent, on both paths', async () => {
    // The member pressing Escape is not an error. It is them choosing the passphrase.
    const cancels: Authenticator = {
      create: async () => { throw new DOMException('NotAllowedError') },
      get: async () => { throw new DOMException('NotAllowedError') },
    }
    expect(await enrolPrf(cancels, 'ab'.repeat(32), S, RP, 'member')).toBe('cancelled')
    const wrap: PrfWrap = { credentialId: 'AQID', salt: 'aa'.repeat(32), iv: 'bb'.repeat(12), cipher: 'cc'.repeat(48) }
    expect(await openPrf(cancels, wrap, RP)).toBeNull()
  })

  it('a tampered wrap does not open', async () => {
    const auth = fakeAuth('A')
    const wrap = wrapOf(await enrolPrf(auth, 'ab'.repeat(32), S, RP, 'member'))
    const tampered = { ...wrap, cipher: wrap.cipher.replace(/^../, 'ff') }
    expect(await openPrf(auth, tampered, RP)).toBeNull()
  })

  it('two vaults on one device derive different keys', async () => {
    // The salt is per vault, so one vault's wrap can never open another's, even on the same
    // credential and the same authenticator.
    const auth = fakeAuth('A')
    const a = wrapOf(await enrolPrf(auth, 'ab'.repeat(32), S, RP, 'member'))
    const b = wrapOf(await enrolPrf(auth, 'cd'.repeat(32), S, RP, 'member'))
    expect(a.salt).not.toBe(b.salt)
    const crossed = { ...b, salt: a.salt }
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

describe('an enrolment that is never answered (#538)', () => {
  // The failure Bob hit on 2026-09-20, and the one this file could not express until now.
  //
  // `enrolPrf` runs TWO ceremonies: `create()`, then `get()` immediately after, because the PRF
  // output is generally not available at create. On Android the second call can neither resolve nor
  // reject - the system sheet does not reopen while the first is still tearing down, and the request
  // simply sits there. A bare `catch` does not help: a pending promise is not a rejection.
  //
  // What the member saw was the button stuck on "Waiting for this device...", forever, with no
  // error - because the caller's `finally` never ran. Every one of the eight tests above drives an
  // authenticator that ALWAYS answers, so the suite covered every way the ceremony can FAIL and no
  // way for it to go quiet. That gap is the bug, not just the symptom.
  const stuck = (): Authenticator => ({
    create: fakeAuth('A').create,
    get: () => new Promise<Credential>(() => {}),
  })

  it('gives up instead of hanging, and says it was never answered', async () => {
    const raced = await Promise.race([
      enrolPrf(stuck(), 'ab'.repeat(32), S, RP, 'member', 50),
      new Promise((r) => setTimeout(() => r('hung'), 1000)),
    ])
    expect(raced, 'enrolPrf must settle on its own rather than wait forever').not.toBe('hung')
    // And it must not be reported as a cancellation: the member did nothing, the platform went
    // quiet, and telling them to try again is only honest if that is what actually happened.
    expect(raced).toBe('unanswered')
  })
})

describe('one ceremony where the browser allows it (follow-on to #538)', () => {
  // #538 stopped the enrolment hanging. It did not remove the thing that hangs: two WebAuthn
  // ceremonies fired back to back, which is what Android could not survive. Chrome and Safari have
  // returned PRF output at CREATION since early 2026, so on those the second ceremony is not needed
  // at all - and one prompt is also what a member expects from one button.
  const atCreate = (): Authenticator => ({
    create: async (o) => {
      const ext = o.publicKey?.extensions as { prf?: { eval?: { first?: BufferSource } } } | undefined
      const first = ext?.prf?.eval?.first as Uint8Array | undefined
      const out = new Uint8Array(32)
      if (first) for (let i = 0; i < 32; i++) out[i] = first[i % first.length]!
      return {
        rawId: new Uint8Array([1, 2, 3, 4]).buffer,
        getClientExtensionResults: () => ({ prf: { results: { first: out.buffer } } }),
      } as unknown as Credential
    },
    get: async () => { throw new Error('the second ceremony must not run when creation answered') },
  })

  it('does not assert again when creation already produced the output', async () => {
    const auth = atCreate()
    const get = vi.spyOn(auth, 'get')
    const wrap = wrapOf(await enrolPrf(auth, 'ab'.repeat(32), S, RP, 'member'))
    expect(get, 'the enrolment fired a second prompt it did not need').not.toHaveBeenCalled()
    expect(wrap.cipher.length, 'it still wrapped the secret').toBeGreaterThan(0)
  })

  it('asks for the salt at creation, not only at the assertion', async () => {
    let asked: CredentialCreationOptions | undefined
    const inner = atCreate()
    await enrolPrf({ create: (o) => { asked = o; return inner.create(o) }, get: inner.get },
      'ab'.repeat(32), S, RP, 'member')
    const ext = asked?.publicKey?.extensions as { prf?: { eval?: { first?: unknown } } }
    expect(ext.prf?.eval?.first, 'without eval at create there is nothing to return there').toBeDefined()
  })
})

describe('the platform says WHICH refusal it was (follow-on to #538)', () => {
  // #538's own catch answered "cancelled" for every rejection - the same one-sentence-for-many-causes
  // mistake it had just been written to fix, reintroduced by the fix. The platform does name them.
  const throwing = (name: string): Authenticator => ({
    create: async () => { throw new DOMException('', name) },
    get: async () => { throw new DOMException('', name) },
  })

  it('reports an existing passkey as such, since its remedy is outside this app', async () => {
    expect(await enrolPrf(throwing('InvalidStateError'), 'ab'.repeat(32), S, RP, 'm')).toBe('already-enrolled')
  })

  it('reports refused options as the permanent case', async () => {
    expect(await enrolPrf(throwing('NotSupportedError'), 'ab'.repeat(32), S, RP, 'm')).toBe('no-prf')
  })

  it('keeps a cancelled prompt as a cancellation', async () => {
    expect(await enrolPrf(throwing('NotAllowedError'), 'ab'.repeat(32), S, RP, 'm')).toBe('cancelled')
  })
})
