import { randomBytes } from 'node:crypto'
import { execFile } from 'node:child_process'
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { generateExports } from '../drill/ceremony'
import { checkScanFloor, inspectSeat, openSeat, safeFailure } from '../drill/inspect'
import { matchRegistration } from '../drill/registration'
// @ts-expect-error Standalone Node reader.
import { freshReopen } from '../drill/fresh.mjs'
// @ts-expect-error Standalone Node filesystem adapter.
import { outputLocation, writeExports } from '../drill/live.mjs'
import { encodeBundle } from './signing'
import { bytesToHex, unb64 } from './bytes'
import { codeAt } from './source-scan'
import { CREATION_PROTOCOL } from './creation-protocol'
import { pkpDigestHex } from './wasm-pkg/konclave_wasm.js'

// Real storage stretching, three WASM contexts and a separate Node reader per seat.
vi.setConfig({ testTimeout: 90_000, hookTimeout: 90_000 })
const passwords = Array.from({ length: 3 }, () => randomBytes(32).toString('base64url'))
let entries: Awaited<ReturnType<typeof generateExports>>
let opened: Awaited<ReturnType<typeof openSeat>>[]

async function refused(run: () => unknown, reason: string) {
  try { await run(); return false } catch (e) { return safeFailure(e) === reason }
}

beforeAll(async () => {
  vi.stubGlobal('fetch', () => { throw new Error('Unexpected network request') })
  try {
    entries = await generateExports(passwords)
    opened = await Promise.all(entries.map(({ seat, file }) => openSeat(file, passwords[seat - 1]!, true)))
  } catch (e) { throw new Error(safeFailure(e)) }
})

afterAll(() => {
  vi.unstubAllGlobals()
})

describe('recovery export drill', () => {
  it('uses the screen encoder with the original byte representation and caller defaults', () => {
    const { share } = opened[0]!
    const material = { keyPackage: () => unb64(share.kp), pubkeys: () => unb64(share.pubkeys) }
    const bytes = encodeBundle(material, 0, 0, 0)
    const original = JSON.stringify({ kp: share.kp, pubkeys: share.pubkeys, seat: 0, n: 0, t: 0 })
    expect(new TextDecoder().decode(bytes) === original).toBe(true)
    const screen = codeAt(fileURLToPath(new URL('./screens/NetVault.tsx', import.meta.url)))
    expect(screen.includes('encodeBundle(dkg, mySeatRef.current, cfg?.n ?? 0, cfg?.t ?? 0)')).toBe(true)
  })

  it('reopens three different real packages from independent stores under the same group and S', () => {
    expect(entries.map(e => e.seat)).toEqual([1, 2, 3])
    expect(new Set(opened.map(o => o.share.kp)).size).toBe(3)
    for (const [i, { share, payload }] of opened.entries()) {
      expect([share.seat, share.t, share.n]).toEqual([i + 1, 2, 3])
      expect(share.pubkeys === opened[0]!.share.pubkeys && payload.groupKey === opened[0]!.payload.groupKey
        && payload.accessSecret === opened[0]!.payload.accessSecret && payload.cp === CREATION_PROTOCOL).toBe(true)
    }
  })

  it('reopens each encrypted file in a restricted child and preserves existing output', async () => {
    const parent = await mkdtemp(join(tmpdir(), 'konclave-export-test-'))
    try {
      const { output } = await outputLocation(join(parent, 'exports'))
      await writeExports(output, entries)
      expect(await writeExports(output, entries).then(() => false, (e: NodeJS.ErrnoException) => e.code === 'EEXIST')).toBe(true)
      for (const { seat } of entries) {
        const path = join(output, 'seat-' + seat + '.konclave.json')
        const file = JSON.parse(await readFile(path, 'utf8'))
        if (process.platform !== 'win32') expect((await stat(path)).mode & 0o077).toBe(0)
        expect(await freshReopen(file, passwords[seat - 1], true)).toBe(seat)
      }
    } finally { await rm(parent, { recursive: true, force: true }) }
  })

  it('refuses the wrong passphrase and a changed ciphertext byte without quoting either input', async () => {
    const { file } = entries[0]!
    const tampered = { ...file, cipher: (file.cipher.startsWith('00') ? '01' : '00') + file.cipher.slice(2) }
    const reason = 'Wrong passphrase or unreadable export.'
    expect(await refused(() => freshReopen(file, passwords[1], true), reason)).toBe(true)
    expect(await refused(() => freshReopen(tampered, passwords[0], true), reason)).toBe(true)
  })

  it('refuses v1, Open vaults and Private vaults missing the read secret', async () => {
    expect(await refused(() => openSeat({ version: 1 }, passwords[0]!), 'A v2 export is required.')).toBe(true)
    const { payload } = opened[0]!
    for (const edit of [{ governance: 'open' }, { accessSecret: null }]) {
      expect(await refused(() => inspectSeat({ ...payload, ...edit }, true), 'A Private vault and its read secret are required.')).toBe(true)
    }
  })

  it('never calls the seat-only export complete, and refuses an absent or invalid floor', async () => {
    expect(await refused(() => freshReopen(entries[0]!.file, passwords[0]), 'The viewing key is missing.')).toBe(true)
    for (const floor of [undefined, null, -1, 1.5, '1']) {
      expect(await refused(() => checkScanFloor(floor), 'A nonnegative wallet scan floor is required.')).toBe(true)
    }
  })

  it('refuses an invalid seat, a mismatched roster owner and a changed quorum', async () => {
    const { payload, share } = opened[0]!
    const material = { keyPackage: () => unb64(share.kp), pubkeys: () => unb64(share.pubkeys) }
    for (const [seat, n, t] of [[0, 3, 2], [4, 3, 2], [2, 3, 2], [1, 2, 2], [1, 3, 1]] as const) {
      const edited = { ...payload, share: bytesToHex(encodeBundle(material, seat, n, t)) }
      expect(await refused(() => inspectSeat(edited, true), 'Expected one seated member of a 2-of-3 vault.')).toBe(true)
    }
  })

  it('refuses a helper answer about another group, pin, protocol, address, or quorum', async () => {
    const { share, payload } = opened[0]!
    const id: string = payload.id
    const digest = pkpDigestHex(unb64(share.pubkeys), 2, 3)
    // Deliberately incomplete. No synthetic registration can supply wallet data to the writer.
    const view = { vault_id: id, state: 'pinned', pkp_digest: digest, threshold: 2, total: 3,
      address: crypto.randomUUID(), change_receiver: crypto.randomUUID() }
    const reg = { ...view, cp: CREATION_PROTOCOL, ufvk: '', birthday: 0 }
    const reason = 'The registration does not match this ceremony and wallet.'
    expect(await refused(() => matchRegistration(reg, view, id, digest), 'The viewing key is missing.')).toBe(true)
    for (const edit of [{ vault_id: '' }, { state: 'closed' }, { pkp_digest: '' }, { total: 4 }, { address: 'disagrees' }]) {
      expect(await refused(() => matchRegistration(reg, { ...view, ...edit }, id, digest), reason)).toBe(true)
    }
    for (const edit of [{ vault_id: '' }, { cp: CREATION_PROTOCOL - 1 }, { threshold: 1 }]) {
      expect(await refused(() => matchRegistration({ ...reg, ...edit }, view, id, digest), reason)).toBe(true)
    }
  })

  it('prints only a fixed verdict in a successful CLI run and redacts dependency failures', async () => {
    const cli = fileURLToPath(new URL('../drill/export.mjs', import.meta.url))
    const result = await promisify(execFile)(process.execPath, [cli, 'self-test']).catch(() => null)
    expect(result?.stdout.trim() === 'PASS real 2-of-3 DKG, three seat-only exports and three fresh-process reopens.').toBe(true)
    expect(result?.stderr.trim() === '').toBe(true)
    const failed = await promisify(execFile)(process.execPath, [cli, 'unknown']).then(() => null,
      (e: { stdout: string; stderr: string }) => e)
    expect(failed?.stdout === '' && failed.stderr.trim() === 'FAIL Use self-test, generate NEW_DIRECTORY, or verify EXPORT_FILE.').toBe(true)
    const { payload, share } = opened[0]!
    for (const secret of [passwords[0], share.kp, payload.accessSecret, JSON.stringify(entries[0]!.file)]) {
      expect(safeFailure(new Error(secret)) === 'The drill did not finish.').toBe(true)
    }
  })

  it('posts only the current creation pin to loopback and stops at a registration refusal', async () => {
    const requests: string[] = []
    let publicPin = false
    vi.stubGlobal('fetch', async (url: string, init: RequestInit) => {
      const { pathname, hostname } = new URL(url)
      requests.push(pathname)
      expect(hostname === '127.0.0.1' && init.redirect === 'error').toBe(true)
      if (pathname === '/api/health') return Response.json({ client: { creation: CREATION_PROTOCOL } })
      const body = JSON.parse(String(init.body))
      publicPin = Object.keys(body).sort().join(',') === 'cp,group_key,name,pkp,proofs,threshold,total'
        && body.cp === CREATION_PROTOCOL && body.threshold === 2 && body.total === 3
        && typeof body.pkp === 'string' && body.proofs.length === 3
      return Response.json({}, { status: 422 })
    })
    const helper = { origin: 'http://127.0.0.1:14780', vaults: '', checker: '' }
    expect(await refused(() => generateExports(passwords, helper), 'The isolated testnet helper or its registration is unavailable.')).toBe(true)
    expect(publicPin && requests.join(' ') === '/api/health /api/vault').toBe(true)
  })
})
