import { readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { codeAt } from './source-scan'

// The WASM is replaced here: these tests are about what the TRANSPORT does around it. The real
// wasm against the real relay and helper is `oblivious-transport.stack.test.ts`.
const wasm = vi.hoisted(() => ({
  sealThrows: null as string | null,
  open: null as null | (() => { status: number; contentType: string; body: Uint8Array }),
  calls: [] as string[],
  seals: [] as unknown[][],
}))
const order: string[] = []
vi.mock('./wasm-ready', () => ({ ensureWasm: async () => { order.push('ensureWasm') } }))
vi.mock('./wasm-pkg/konclave_wasm.js', () => ({
  ohttpSeal: (...args: unknown[]) => {
    order.push('ohttpSeal')
    wasm.seals.push(args)
    if (wasm.sealThrows) throw wasm.sealThrows
    return {
      wire: () => new Uint8Array([1, 2, 3]),
      open: () => {
        const a = wasm.open!()
        return { status: () => a.status, contentType: () => a.contentType, body: () => a.body }
      },
    }
  },
}))

import { ObliviousError, obliviousRead, type ObliviousFailure } from './oblivious-transport'

const RELAY = 'https://relay.example/relay'
// The configuration the bundle pins, standing in for PINNED_KEY_CONFIG_HEX (which is empty in this
// build). The mocked wasm does not parse it; the real one is exercised in the stack test.
const PIN = new Uint8Array([0, 41, 7, 0, 32])
const OPTS = { relayUrl: RELAY, pin: PIN, now: () => 1_800_000_000 }

function relayAnswers(status: number, contentType: string | null, body = new Uint8Array([9])) {
  return vi.fn(async () =>
    new Response(body as BodyInit, { status, headers: contentType ? { 'content-type': contentType } : {} }))
}

async function kindOf(p: Promise<unknown>): Promise<ObliviousFailure | 'resolved'> {
  try { await p; return 'resolved' } catch (e) {
    expect(e).toBeInstanceOf(ObliviousError)
    return (e as ObliviousError).kind
  }
}

beforeEach(() => {
  order.length = 0
  wasm.sealThrows = null; wasm.seals.length = 0
  wasm.open = () => ({ status: 200, contentType: 'application/json', body: new TextEncoder().encode('{"ok":true}') })
})
afterEach(() => { vi.unstubAllGlobals() })

describe('oblivious read, fail closed', () => {
  it('returns what the direct path would: the helper status, type and body', async () => {
    vi.stubGlobal('fetch', relayAnswers(200, 'message/ohttp-res'))
    wasm.open = () => ({ status: 401, contentType: 'application/json', body: new TextEncoder().encode('{"error":"read_key"}') })
    const r = await obliviousRead(OPTS, '/api/vault/balance?vault=ab', 'rk')
    expect(r.status).toBe(401)
    expect(await r.json()).toEqual({ error: 'read_key' })
    // The read key and the path go INTO the seal, as arguments, not onto the relay request.
    expect(wasm.seals[0]!.slice(1, 5)).toEqual(['GET', '/api/vault/balance?vault=ab', 'rk', ''])
    const [url, init] = (fetch as unknown as ReturnType<typeof vi.fn>).mock.calls[0]!
    expect(url).toBe(RELAY)
    expect(Object.keys(init.headers)).toEqual(['content-type'])
    expect(init.credentials).toBe('omit')
  })

  it('reaches the wasm only after ensureWasm()', async () => {
    vi.stubGlobal('fetch', relayAnswers(200, 'message/ohttp-res'))
    await obliviousRead(OPTS, '/api/health')
    expect(order[0]).toBe('ensureWasm')
    expect(order.indexOf('ensureWasm')).toBeLessThan(order.indexOf('ohttpSeal'))
  })

  it('a relay that cannot be reached throws and makes NO direct request', async () => {
    const f = vi.fn(async () => { throw new TypeError('network') })
    vi.stubGlobal('fetch', f)
    expect(await kindOf(obliviousRead(OPTS, '/api/vault/balance?vault=ab', 'rk'))).toBe('relay_unreachable')
    // Exactly one attempt, and only to the relay: no retry, no second URL.
    expect(f).toHaveBeenCalledTimes(1)
    expect(f.mock.calls.map((c) => (c as unknown[])[0])).toEqual([RELAY])
  })

  it.each([
    [400, 'gateway_refused'],
    [401, 'update_required'],
    [403, 'relay_refused'],
    [413, 'relay_refused'],
    [415, 'relay_refused'],
    [429, 'rate_limited'],
    [502, 'relay_error'],
    [504, 'relay_error'],
  ] as const)('relay answered %i -> %s, and nothing else is sent', async (status, kind) => {
    const f = relayAnswers(status, 'application/json')
    vi.stubGlobal('fetch', f)
    expect(await kindOf(obliviousRead(OPTS, '/api/health'))).toBe(kind)
    expect(f).toHaveBeenCalledTimes(1)
  })

  it('a 200 that is not message/ohttp-res is refused', async () => {
    vi.stubGlobal('fetch', relayAnswers(200, 'text/html'))
    expect(await kindOf(obliviousRead(OPTS, '/api/health'))).toBe('bad_response')
  })

  it('an answer that does not authenticate is not_authentic and yields nothing', async () => {
    vi.stubGlobal('fetch', relayAnswers(200, 'message/ohttp-res'))
    wasm.open = () => { throw 'ohttp:not_authentic' }
    expect(await kindOf(obliviousRead(OPTS, '/api/health'))).toBe('not_authentic')
  })

  it('a malformed authenticated answer is bad_response', async () => {
    vi.stubGlobal('fetch', relayAnswers(200, 'message/ohttp-res'))
    wasm.open = () => { throw 'ohttp:bad_response' }
    expect(await kindOf(obliviousRead(OPTS, '/api/health'))).toBe('bad_response')
  })

  it('a request the crate refuses is bad_request and never reaches the relay', async () => {
    const f = relayAnswers(200, 'message/ohttp-res')
    vi.stubGlobal('fetch', f)
    wasm.sealThrows = 'ohttp:bad_request'
    expect(await kindOf(obliviousRead(OPTS, 'no-slash'))).toBe('bad_request')
    expect(f).not.toHaveBeenCalled()
  })

  it('an unusable key configuration is bad_config', async () => {
    const f = relayAnswers(200, 'message/ohttp-res')
    vi.stubGlobal('fetch', f)
    wasm.sealThrows = 'ohttp:bad_config'
    expect(await kindOf(obliviousRead(OPTS, '/api/health'))).toBe('bad_config')
    expect(f).not.toHaveBeenCalled()
  })

  // A refusal the gateway made after opening the request is sealed and typed.
  it.each([
    [{ type: 'clock_skew', server_time: 1_800_000_999 }, 'clock_skew'],
    [{ type: 'replayed' }, 'replayed'],
    [{ type: 'busy' }, 'busy'],
    [{ type: 'something-new' }, 'gateway_refused'],
  ] as const)('a sealed problem %j is %s', async (problem, kind) => {
    vi.stubGlobal('fetch', relayAnswers(200, 'message/ohttp-res'))
    wasm.open = () => ({ status: 400, contentType: 'application/problem+json', body: new TextEncoder().encode(JSON.stringify(problem)) })
    const err = await obliviousRead(OPTS, '/api/health').catch((e) => e)
    expect(err).toBeInstanceOf(ObliviousError)
    expect(err.kind).toBe(kind)
    if (kind === 'clock_skew') expect(err.serverTime).toBe(1_800_000_999)
  })

  it('a sealed problem that is not JSON is gateway_refused', async () => {
    vi.stubGlobal('fetch', relayAnswers(200, 'message/ohttp-res'))
    wasm.open = () => ({ status: 400, contentType: 'application/problem+json', body: new TextEncoder().encode('<html>') })
    expect(await kindOf(obliviousRead(OPTS, '/api/health'))).toBe('gateway_refused')
  })

  it('a 401 from the gateway is "update the app" and nothing is fetched to recover', async () => {
    const f = relayAnswers(401, 'application/problem+json')
    vi.stubGlobal('fetch', f)
    expect(await kindOf(obliviousRead(OPTS, '/api/health'))).toBe('update_required')
    expect(f).toHaveBeenCalledTimes(1)
  })
})

describe('the key-config pin : the bundle\'s bytes, never the network\'s', () => {
  it('seals with exactly the pinned bytes, whatever else the caller holds', async () => {
    vi.stubGlobal('fetch', relayAnswers(200, 'message/ohttp-res'))
    const other = new Uint8Array([0, 41, 7, 9, 9])
    // A caller that holds a configuration it got from somewhere (same key id, other key) has no
    // option to hand it in: an unknown option is ignored, and the pin is what is sealed to.
    await obliviousRead({ ...OPTS, keyConfig: other } as never, '/api/health')
    expect(wasm.seals).toHaveLength(1)
    expect(Array.from(wasm.seals[0]![0] as Uint8Array)).toEqual(Array.from(PIN))
  })

  it('the build pins nothing yet, so by default nothing is sent', async () => {
    const f = relayAnswers(200, 'message/ohttp-res')
    vi.stubGlobal('fetch', f)
    const { pin: _drop, ...noPin } = OPTS
    expect(await kindOf(obliviousRead(noPin, '/api/health'))).toBe('update_required')
    expect(f).not.toHaveBeenCalled()
    expect(wasm.seals).toHaveLength(0)
  })

  it.each([[null], [new Uint8Array(0)]])('an empty pin (%j) is nothing', async (pin) => {
    const f = relayAnswers(200, 'message/ohttp-res')
    vi.stubGlobal('fetch', f)
    expect(await kindOf(obliviousRead({ ...OPTS, pin }, '/api/health'))).toBe('update_required')
    expect(f).not.toHaveBeenCalled()
  })
})

describe('it is wired into nothing a member can reach', () => {
  const SRC = fileURLToPath(new URL('.', import.meta.url))
  function all(dir: string, out: string[] = []): string[] {
    for (const n of readdirSync(dir)) {
      const p = join(dir, n)
      if (statSync(p).isDirectory()) { if (n !== 'wasm-pkg') all(p, out); continue }
      if (/\.(ts|tsx)$/.test(n)) out.push(p)
    }
    return out
  }

  it('no module but its own tests imports it', () => {
    const importers = all(SRC)
      .filter((p) => !/oblivious-transport(\.stack)?(\.test)?\.tsx?$/.test(p))
      .filter((p) => /from\s+['"]\.\/oblivious-transport['"]/.test(codeAt(p)))
    expect(importers).toEqual([])
    // Parsing every source file for comments is slow under a loaded full run.
  }, 60_000)

  it('only the transport reads the pin, and nothing in the app asks the coordinator for a key', () => {
    const files = all(SRC).filter((p) => !/\.test\.tsx?$/.test(p))
    const readers = files
      .filter((p) => /oblivious-key-config/.test(codeAt(p)))
      .map((p) => p.slice(SRC.length))
    expect(readers).toEqual(['oblivious-transport.ts'])
    // No source fetches a key configuration, and none passes the test seam: the pin is the bundle's.
    for (const p of files) {
      const code = codeAt(p)
      expect(code, p).not.toMatch(/ohttp-keys/)
      if (!/oblivious-transport\.ts$/.test(p)) expect(code, p).not.toMatch(/\bobliviousRead\b/)
    }
    const own = codeAt(join(SRC, 'oblivious-transport.ts'))
    expect(own).not.toMatch(/\bkeyConfig\b/)
    expect(own).not.toMatch(/ohttpKeyId/)
  }, 60_000)

  it('the module has one fetch, to the relay URL, and no way back to the direct path', () => {
    const code = codeAt(join(SRC, 'oblivious-transport.ts'))
    expect([...code.matchAll(/\bfetch\s*\(/g)]).toHaveLength(1)
    expect(code).toMatch(/fetch\(opts\.relayUrl,/)
    // The direct path lives in helper.ts / api.ts; neither may be reached from here.
    expect(code).not.toMatch(/from\s+['"]\.\/(helper|api)['"]/)
    expect(code).not.toMatch(/HELPER_BASE|helperBase\(/)
    // And it loads no wasm by itself: ensureWasm is the loader.
    expect(code).not.toMatch(/^import\s+init\s/m)
    expect(code).toMatch(/await ensureWasm\(\)/)
  })
})
