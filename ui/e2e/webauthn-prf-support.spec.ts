import { test, expect } from '@playwright/test'

// EXPERIMENT, like the SharedWorker one (#446). Option C stores the vault's read secret `S`
// encrypted under a key derived from the WebAuthn PRF extension, so a reload costs a touch instead
// of a passphrase. The whole design rests on two claims nobody had checked:
//
//   1. the PRF extension is actually available, and
//   2. its output is STABLE for the same (credential, salt) - because that output IS the key. If it
//      varies, every reload produces a different key and the stored secret is unopenable.
//
// Driven against Chrome's virtual authenticator over CDP, so this measures the browser we ship to
// rather than a library's promises.

const RP = 'localhost'
const SALT = new Array(32).fill(7)

test('is the WebAuthn PRF extension usable, and is its output stable?', async ({ page }) => {
  // WebAuthn refuses an IP as an RP ID, so this navigates to the localhost alias of the same
  // server. Both are secure contexts; only the name is valid as a relying-party id.
  await page.goto('http://localhost:4173/')

  const client = await page.context().newCDPSession(page)
  await client.send('WebAuthn.enable')
  const { authenticatorId } = await client.send('WebAuthn.addVirtualAuthenticator', {
    options: {
      protocol: 'ctap2',
      ctap2Version: 'ctap2_1',
      transport: 'internal',
      hasResidentKey: true,
      hasUserVerification: true,
      isUserVerified: true,
      automaticPresenceSimulation: true,
      // The capability under test. An older Chrome without it fails here, which is itself the answer.
      hasPrf: true,
    },
  })
  expect(authenticatorId, 'a virtual authenticator with PRF could be created').toBeTruthy()

  const result = await page.evaluate(async ([rpId, salt]) => {
    const enc = (s: string) => new TextEncoder().encode(s)
    const hex = (b: ArrayBuffer) =>
      Array.from(new Uint8Array(b), (x) => x.toString(16).padStart(2, '0')).join('')

    // 1. Create a credential asking for PRF.
    const cred = (await navigator.credentials.create({
      publicKey: {
        challenge: enc('c'),
        rp: { id: rpId as string, name: 'Konclave test' },
        user: { id: enc('u'), name: 'member', displayName: 'member' },
        pubKeyCredParams: [{ type: 'public-key', alg: -7 }],
        authenticatorSelection: { userVerification: 'required', residentKey: 'required' },
        extensions: { prf: {} },
      },
    })) as PublicKeyCredential | null
    if (!cred) return { error: 'no credential' }

    const created = cred.getClientExtensionResults() as { prf?: { enabled?: boolean } }
    const rawId = cred.rawId

    // 2. Two assertions with the SAME salt. The outputs must be identical, and non-empty.
    const evaluate = async () => {
      const a = (await navigator.credentials.get({
        publicKey: {
          challenge: enc('a'),
          rpId: rpId as string,
          allowCredentials: [{ type: 'public-key', id: rawId }],
          userVerification: 'required',
          extensions: { prf: { eval: { first: new Uint8Array(salt as number[]) } } },
        },
      })) as PublicKeyCredential | null
      const r = a?.getClientExtensionResults() as { prf?: { results?: { first?: ArrayBuffer } } }
      const first = r?.prf?.results?.first
      return first ? hex(first) : null
    }

    return { enabled: created?.prf?.enabled ?? null, one: await evaluate(), two: await evaluate() }
  }, [RP, SALT] as const)

  // Reported rather than asserted blind: the shape of the answer IS the finding.
  // eslint-disable-next-line no-console
  console.log('PRF result:', JSON.stringify(result))

  expect(result, 'the page could run the ceremony at all').not.toHaveProperty('error')
  const r = result as { enabled: boolean | null; one: string | null; two: string | null }
  expect(r.enabled, 'the authenticator reports PRF as enabled for the credential').toBe(true)
  expect(r.one, 'an assertion returns PRF output').toBeTruthy()
  expect(r.one!.length, 'and it is 32 bytes').toBe(64)
  expect(r.two, 'the second assertion returns output too').toBeTruthy()
  expect(
    r.two,
    'THE POINT: the same salt must give the same bytes, or it cannot be a key',
  ).toBe(r.one)
})
