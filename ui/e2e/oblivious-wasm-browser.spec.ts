// wasm_client_round_trip_in_browser (OHTTP experimental proof of concept). The built wasm, in real
// Chromium, seals a request, a real forwarding relay carries it (CORS preflight included) to a real helper-server
// gateway, and the answer is opened back in the page. Skipped unless the binaries are named:
//
//   cargo build -p helper-server -p konclave-ohttp-relay
//   (cd konclave-wasm && wasm-pack build --target web --release --out-dir <dir> -- --features ohttp)
//   KONCLAVE_TEST_HELPER_BIN=... KONCLAVE_TEST_OHTTP_RELAY_BIN=... KONCLAVE_TEST_WASM_PKG_DIR=<dir> \
//     pnpm --dir ui e2e oblivious-wasm-browser
//
// The wasm served to the page is the one built WITH konclave-wasm's `ohttp` feature: the committed
// package (what members download) has no such bindings.
//
// What this runs is the WASM export (`ohttpSeal`, `.open`), not the TS wrapper in
// oblivious-transport.ts: that module is not in the bundle (nothing imports it) and is covered
// against the same stack, under node, by oblivious-transport.stack.test.ts.
import { spawn, type ChildProcess } from 'node:child_process'
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { createServer as httpServer } from 'node:http'
import { createServer as netServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { test, expect } from '@playwright/test'

const HELPER = process.env.KONCLAVE_TEST_HELPER_BIN
const RELAY = process.env.KONCLAVE_TEST_OHTTP_RELAY_BIN
const PKG_DIR = process.env.KONCLAVE_TEST_WASM_PKG_DIR
test.skip(!HELPER || !RELAY || !PKG_DIR, 'KONCLAVE_TEST_HELPER_BIN, KONCLAVE_TEST_OHTTP_RELAY_BIN and KONCLAVE_TEST_WASM_PKG_DIR are not all set')

const PKG = pathToFileURL(`${PKG_DIR}/`)
const SECRET = 'a-relay-secret-for-the-browser-test'
const KEY_FILE = '31 5c5c5c5c5c5c5c5c5c5c5c5c5c5c5c5c5c5c5c5c5c5c5c5c5c5c5c5c5c5c5c5c\n'

function freePort(): Promise<number> {
  return new Promise((resolve) => {
    const s = netServer()
    s.listen(0, '127.0.0.1', () => {
      const { port } = s.address() as { port: number }
      s.close(() => resolve(port))
    })
  })
}

async function up(url: string): Promise<void> {
  for (let i = 0; i < 150; i++) {
    try { await fetch(url); return } catch { await new Promise((r) => setTimeout(r, 100)) }
  }
  throw new Error(`${url} never came up`)
}

test('wasm_client_round_trip_in_browser', async ({ page }) => {
  const kids: ChildProcess[] = []
  const dir = mkdtempSync(join(tmpdir(), 'konclave-oblivious-browser-'))
  // Mode 0600: the helper refuses a key file that group or others can read.
  writeFileSync(join(dir, 'ohttp-key'), KEY_FILE, { mode: 0o600 })
  // The page's own origin: a static server for the wasm package, so the relay can be told to allow it.
  const pagePort = await freePort()
  const origin = `http://127.0.0.1:${pagePort}`
  const files: Record<string, [string, Buffer]> = {
    '/konclave_wasm.js': ['text/javascript', readFileSync(new URL('konclave_wasm.js', PKG))],
    '/konclave_wasm_bg.wasm': ['application/wasm', readFileSync(new URL('konclave_wasm_bg.wasm', PKG))],
    '/': ['text/html', Buffer.from('<!doctype html><title>oblivious</title>')],
  }
  const site = httpServer((req, res) => {
    const f = files[req.url ?? '/']
    if (!f) { res.writeHead(404).end(); return }
    res.writeHead(200, { 'content-type': f[0] }).end(f[1])
  })
  await new Promise<void>((r) => site.listen(pagePort, '127.0.0.1', r))
  try {
    const hport = await freePort()
    const rport = await freePort()
    const helper = `http://127.0.0.1:${hport}`
    const relay = `http://127.0.0.1:${rport}/relay`
    kids.push(spawn(HELPER!, [], {
      cwd: dir, stdio: 'ignore',
      env: {
        ...process.env, KONCLAVE_OHTTP: '1', KONCLAVE_OHTTP_KEY_FILE: join(dir, 'ohttp-key'),
        KONCLAVE_OHTTP_RELAY_SECRET: SECRET, KONCLAVE_HELPER_ADDR: `127.0.0.1:${hport}`,
        KONCLAVE_VAULTS_DIR: join(dir, 'vaults'),
      },
    }))
    await up(`${helper}/api/health`)
    kids.push(spawn(RELAY!, [], {
      cwd: dir, stdio: 'ignore',
      env: {
        ...process.env, PORT: String(rport), KONCLAVE_OHTTP_GATEWAY: `${helper}/api/ohttp`,
        // The helper is plain http on loopback: the relay refuses that unless told it is a test.
        KONCLAVE_OHTTP_GATEWAY_INSECURE: '1',
        KONCLAVE_OHTTP_ORIGINS: origin, KONCLAVE_OHTTP_RELAY_SECRET: SECRET,
        KONCLAVE_TRUSTED_PROXY_HOPS: '0',
      },
    }))
    await up(relay)

    const seen: string[] = []
    page.on('request', (r) => seen.push(`${r.method()} ${r.url()}`))
    await page.goto(`${origin}/`)
    const pinned = Array.from(new Uint8Array(await (await fetch(`${helper}/api/ohttp-keys`)).arrayBuffer()))
    const out = await page.evaluate(async ({ origin, relay, pinned }) => {
      const m = await import(/* @vite-ignore */ `${origin}/konclave_wasm.js`)
      await m.default({ module_or_path: `${origin}/konclave_wasm_bg.wasm` })
      // The page is handed the pinned configuration by the test, as the bundle would hold it: it
      // never asks the helper for one (the helper offers none to a page: no CORS on that route).
      const cfg = new Uint8Array(pinned)
      const sealed = m.ohttpSeal(cfg, 'GET', '/api/health', undefined, '', new Uint8Array(0), Math.floor(Date.now() / 1000))
      const r = await fetch(relay, { method: 'POST', headers: { 'content-type': 'message/ohttp-req' }, body: sealed.wire() })
      const answer = sealed.open(new Uint8Array(await r.arrayBuffer()))
      let again = ''
      try { sealed.open(new Uint8Array(0)) } catch (e) { again = String(e) }
      return {
        relayStatus: r.status,
        status: answer.status(), type: answer.contentType(), body: new TextDecoder().decode(answer.body()), again,
      }
    }, { origin, relay, pinned })

    const direct = await (await fetch(`${helper}/api/health`)).text()
    expect(out.relayStatus).toBe(200)
    expect(out.status).toBe(200)
    expect(out.body).toBe(direct)
    expect(out.again).toBe('ohttp:context_used')
    // A page cannot read the helper's key configuration (no CORS on that route), nor reach the
    // gateway's own endpoint: the browser refuses to hand the answer over.
    const direct2 = await page.evaluate(async (helper) => {
      try { await fetch(`${helper}/api/ohttp-keys`); return 'readable' } catch { return 'blocked' }
    }, helper)
    expect(direct2).toBe('blocked')
    // The page never asked the helper for the health read itself: only the relay saw it.
    expect(seen.filter((s) => s.includes(`${helper}/api/health`))).toEqual([])
    expect(seen.some((s) => s === `POST ${relay}`)).toBe(true)
  } finally {
    for (const k of kids) k.kill()
    site.close()
  }
})
