/// <reference types="node" />
// The REAL wasm, through the REAL relay, to the REAL helper-server gateway (KONCLAVE_OHTTP=1).
// Skipped unless both binaries are named, so the suite needs no other crate's build:
//
//   cargo build -p helper-server -p konclave-ohttp-relay
//   (cd konclave-wasm && wasm-pack build --target web --release --out-dir <dir> -- --features ohttp)
//   KONCLAVE_TEST_HELPER_BIN=<target>/debug/helper-server \
//   KONCLAVE_TEST_OHTTP_RELAY_BIN=<target>/debug/konclave-ohttp-relay \
//   KONCLAVE_TEST_WASM_PKG_DIR=<dir> \
//     pnpm --dir ui exec vitest run src/oblivious-transport.stack.test.ts
//
// The committed wasm has no Oblivious HTTP bindings (they are behind konclave-wasm's `ohttp`
// feature, off by default), so the module under test is pointed at a package built with it. Only
// `ensureWasm` is replaced (it loads the bundle's wasm by URL, which node cannot); the module is
// initialised here from the same bytes. The pin is the key configuration the helper serves, which
// is what an operator does once to produce the bundle's constant: the app never does.
import { spawn, type ChildProcess } from 'node:child_process'
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'

const PKG = process.env.KONCLAVE_TEST_WASM_PKG_DIR
vi.mock('./wasm-ready', () => ({ ensureWasm: async () => {} }))
// The transport (and this file) get the wasm built WITH the ohttp bindings, not the committed one.
// (Unset, the real module is left alone: the suite is skipped, and the file must still load.)
vi.mock('./wasm-pkg/konclave_wasm.js', async (original) =>
  process.env.KONCLAVE_TEST_WASM_PKG_DIR
    ? import(/* @vite-ignore */ pathToFileURL(`${process.env.KONCLAVE_TEST_WASM_PKG_DIR}/konclave_wasm.js`).href)
    : original())
import init from './wasm-pkg/konclave_wasm.js'
import { ObliviousError, obliviousRead } from './oblivious-transport'

const HELPER = process.env.KONCLAVE_TEST_HELPER_BIN
const RELAY = process.env.KONCLAVE_TEST_OHTTP_RELAY_BIN
const stack = HELPER && RELAY && PKG ? describe : describe.skip
const SECRET = 'a-relay-secret-for-the-stack-test'
// One line: key id the operator chooses, then 32 bytes of key material in hex.
const KEY_FILE = '23 a5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a5\n'

function freePort(): Promise<number> {
  return new Promise((resolve) => {
    const s = createServer()
    s.listen(0, '127.0.0.1', () => {
      const { port } = s.address() as { port: number }
      s.close(() => resolve(port))
    })
  })
}

async function waitFor(url: string): Promise<Response> {
  for (let i = 0; i < 150; i++) {
    try {
      const r = await fetch(url)
      if (r.status === 200) return r
    } catch { /* not up yet */ }
    await new Promise((r) => setTimeout(r, 100))
  }
  throw new Error(`${url} never came up`)
}

stack('the wasm client through the relay to the real helper', () => {
  const kids: ChildProcess[] = []
  let helper = ''
  let relay = ''
  let keyConfig = new Uint8Array()

  beforeAll(async () => {
    await init({ module_or_path: readFileSync(join(PKG!, 'konclave_wasm_bg.wasm')) })
    const dir = mkdtempSync(join(tmpdir(), 'konclave-oblivious-stack-'))
    // Mode 0600: the helper refuses a key file that group or others can read.
    writeFileSync(join(dir, 'ohttp-key'), KEY_FILE, { mode: 0o600 })
    const hport = await freePort()
    const rport = await freePort()
    kids.push(spawn(HELPER!, [], {
      cwd: dir, stdio: 'ignore',
      env: {
        ...process.env, KONCLAVE_OHTTP: '1', KONCLAVE_OHTTP_KEY_FILE: join(dir, 'ohttp-key'),
        KONCLAVE_OHTTP_RELAY_SECRET: SECRET, KONCLAVE_HELPER_ADDR: `127.0.0.1:${hport}`,
        KONCLAVE_VAULTS_DIR: join(dir, 'vaults'),
      },
    }))
    helper = `http://127.0.0.1:${hport}`
    // The operator's step, once: what the bundle will pin. The app never does this.
    keyConfig = new Uint8Array(await (await waitFor(`${helper}/api/ohttp-keys`)).arrayBuffer())
    kids.push(spawn(RELAY!, [], {
      cwd: dir, stdio: 'ignore',
      env: {
        ...process.env, PORT: String(rport), KONCLAVE_OHTTP_GATEWAY: `${helper}/api/ohttp`,
        // The helper is plain http on loopback: the relay refuses that unless told it is a test.
        KONCLAVE_OHTTP_GATEWAY_INSECURE: '1',
        KONCLAVE_OHTTP_RELAY_SECRET: SECRET, KONCLAVE_TRUSTED_PROXY_HOPS: '0',
      },
    }))
    relay = `http://127.0.0.1:${rport}/relay`
    // The relay has no health route; a GET on /relay is a typed refusal once it listens.
    for (let i = 0; i < 100; i++) {
      try { await fetch(relay); break } catch { await new Promise((r) => setTimeout(r, 100)) }
    }
  }, 30_000)

  afterAll(() => { for (const k of kids) k.kill() })

  const opts = () => ({ relayUrl: relay, pin: keyConfig })

  it('reads /api/health: the oblivious answer is the direct answer', async () => {
    const viaRelay = await obliviousRead(opts(), '/api/health')
    const direct = await fetch(`${helper}/api/health`)
    expect(viaRelay.status).toBe(200)
    expect(await viaRelay.text()).toBe(await direct.text())
  })

  it('reads a gated route: the helper answers it exactly as it answers direct (no read key, no such vault)', async () => {
    const path = '/api/vault/balance?vault=' + 'ab'.repeat(32)
    const viaRelay = await obliviousRead(opts(), path)
    const direct = await fetch(`${helper}${path}`)
    expect(viaRelay.status).toBe(direct.status)
    expect(viaRelay.status).not.toBe(200)
    expect(await viaRelay.text()).toBe(await direct.text())
  })

  it('a route off the list is the helper\'s own typed refusal, not a send', async () => {
    const r = await obliviousRead(opts(), '/api/vault/ufvk?vault=' + 'ab'.repeat(32))
    expect(r.status).toBeGreaterThanOrEqual(400)
  })

  it('nothing pinned: nothing is sent', async () => {
    await expect(obliviousRead({ ...opts(), pin: null }, '/api/health'))
      .rejects.toMatchObject({ kind: 'update_required' })
  })

  it('a pin of another key under the SAME id is the gateway\'s refusal, never a read', async () => {
    const other = Uint8Array.from(keyConfig)
    other[5] = (other[5] ?? 0) ^ 0xff // a byte of the public key: same id, different key
    const err = await obliviousRead({ ...opts(), pin: other }, '/api/health').catch((e) => e)
    expect(err).toBeInstanceOf(ObliviousError)
    expect(err.kind).toBe('gateway_refused')
  })

  it('a pin with a key id the gateway does not hold is update_required, from the gateway\'s typed 401', async () => {
    const other = Uint8Array.from(keyConfig)
    other[2] = (other[2] ?? 0) ^ 1
    const err = await obliviousRead({ ...opts(), pin: other }, '/api/health').catch((e) => e)
    expect(err).toBeInstanceOf(ObliviousError)
    expect(err.kind).toBe('update_required')
    expect(err.status).toBe(401)
  })

  it('a relay that is down fails closed with a typed error', async () => {
    const dead = `http://127.0.0.1:${await freePort()}/relay`
    const err = await obliviousRead({ ...opts(), relayUrl: dead }, '/api/health').catch((e) => e)
    expect(err).toBeInstanceOf(ObliviousError)
    expect(err.kind).toBe('relay_unreachable')
  })

  it('a request dated outside the window is a typed clock_skew carrying the gateway\'s time', async () => {
    const stale = Math.floor(Date.now() / 1000) - 3600
    const err = await obliviousRead({ ...opts(), now: () => stale }, '/api/health').catch((e) => e)
    expect(err).toBeInstanceOf(ObliviousError)
    expect(err.kind).toBe('clock_skew')
    expect(Math.abs(err.serverTime - Math.floor(Date.now() / 1000))).toBeLessThan(30)
  })

  it('the gateway answers nothing to a caller without the relay\'s secret, and sends no CORS header', async () => {
    const r = await fetch(`${helper}/api/ohttp`, { method: 'POST', headers: { 'content-type': 'message/ohttp-req' }, body: new Uint8Array(64) })
    expect(r.status).toBe(403)
    expect(r.headers.get('access-control-allow-origin')).toBeNull()
  })
})
