import 'fake-indexeddb/auto'
import { describe, expect, it } from 'vitest'
// @ts-expect-error - a plain .mjs script, deliberately not part of the app's TS build
import { openExport, examine, reportLines } from '../../scripts/open-export.mjs'
import { saveVault, loadVault, exportVault, importVault, parseVaultExport, type VaultData } from './storage'
import { decodeBundle } from './signing'

// `scripts/open-export.mjs` is what docs/RECOVERY.md hands a member whose laptop is dead: it opens a
// backup with nothing but Node and says whether the backup is complete. It had no test, and it was
// wrong about every backup in two ways.
//
// It read the quorum from `governance.threshold`, but governance is the string 'open' | 'quorum', so
// every backup printed "the quorum it belongs to: NO" and the check that the share agrees with the
// rest of the file never ran. And it treated seats as starting at 0, when seat N is roster[N - 1],
// so the last member's backup was reported INCONSISTENT.
//
// The exports here are written by the app's own `exportVault` and read back through
// `parseVaultExport`, so the script is judged against the file a member really has, not against a
// shape this test made up.

const PASS = 'correct horse battery staple'
const ROSTER = ['Alice', 'Bob', 'Carol']
const b64 = (u: Uint8Array) => btoa(String.fromCharCode(...u))

/** The sealed share, in the shape the create screen writes it (NetVault, "The secret bundle"). */
function shareBundle(seat: number, n: number, t: number): Uint8Array {
  return new TextEncoder().encode(JSON.stringify({
    kp: b64(new Uint8Array(40).fill(1)),
    pubkeys: b64(new Uint8Array(40).fill(2)),
    deviceSecret: b64(new Uint8Array(32).fill(3)),
    seat, n, t,
  }))
}

/** A backup exactly as a member downloads it: saved, exported, serialized, parsed. */
/** The vault id the app gives a vault: its group key in hex. Derived from a label so each test has
 *  its own vault. */
function vaultIdOf(label: string): { id: string; groupKey: Uint8Array } {
  const groupKey = Uint8Array.from({ length: 32 }, (_, i) => label.charCodeAt(i % label.length) ^ i)
  return { id: Array.from(groupKey, (b) => b.toString(16).padStart(2, '0')).join(''), groupKey }
}

async function backupOf(label: string, seat: number, n: number, t: number, roster = ROSTER) {
  const { id, groupKey } = vaultIdOf(label)
  const data: VaultData = {
    name: 'Family', governance: 'quorum', myName: roster[seat - 1], creatorName: roster[0],
    groupKey, address: 'u1familyaddress', roster,
    sealedShare: shareBundle(seat, n, t), accessSecret: new Uint8Array(32).fill(9),
  }
  await saveVault(id, data, PASS)
  const file = JSON.stringify(await exportVault(id, PASS, 'uview1example', 3_459_814))
  return parseVaultExport(file)
}

async function checked(id: string, seat: number, n: number, t: number, roster = ROSTER) {
  const bundle = await backupOf(id, seat, n, t, roster)
  const { env, v1, payload } = await openExport(bundle, PASS)
  return { ...examine(payload), report: reportLines(bundle, env, v1, payload).join('\n') }
}

describe('the offline checker reads a real backup the way the app wrote it', () => {
  it('the fixture is the share the app itself decodes', async () => {
    // Guards the test rather than the script: if the create screen's bundle changes shape, the
    // app's own decoder is what notices, and this stops agreeing with it.
    await backupOf('oe-anchor', 3, 3, 2)
    const restored = decodeBundle(await loadVault(vaultIdOf('oe-anchor').id, PASS))
    expect({ seat: restored.seat, n: restored.n, t: restored.t }).toEqual({ seat: 3, n: 3, t: 2 })
  })

  it('does not present a v1 backup\'s cleartext address as the vault\'s', async () => {
    // v1 kept the address outside the encryption, where anyone who can edit the file can change it,
    // and the app no longer imports it (A9). The report must not hand it to a member as the address.
    const bundle = await backupOf('oe-v1addr', 1, 3, 2)
    const { env, payload } = await openExport(bundle, PASS)
    const v1Report = reportLines(bundle, env, true, { ...payload, address: 'u1editedbysomeone' }).join('\n')
    expect(v1Report).not.toContain('u1editedbysomeone')
    expect(v1Report).toContain('not trusted in this format')
    const v2Report = reportLines(bundle, env, false, payload).join('\n')
    expect(v2Report).toContain('u1familyaddress') // a v2 address is sealed with the rest, and shown
  })

  it('says what the app refuses: a sealed part that is not a share, an id that is not the group key', () => {
    // The checker is a second reader of a backup, so it applies the app's rules (A9): otherwise a
    // member keeps a backup the app will not restore, reported as fine.
    const hexOf = (o: unknown) => Array.from(new TextEncoder().encode(JSON.stringify(o)), (x) => x.toString(16).padStart(2, '0')).join('')
    const notAShare = examine({ share: hexOf({ id: 'x', groupKey: 'y', share: 'z' }), roster: [] })
    expect(notAShare.share).toBeNull()
    expect(notAShare.problems.join(' ')).toMatch(/does not decode/)
    const edited = examine({ id: 'cd'.repeat(32), groupKey: 'ab'.repeat(32), roster: [] })
    expect(edited.problems.join(' ')).toMatch(/vault id and the group key in this file differ/)
  })

  it('agrees with the app about an edited v1: no read secret that is not one, no payee book', async () => {
    // The checker is a second reader of a backup: what the app refuses or ignores, it must not
    // report as there (A9). A v1 whose secret envelope points at the share's own ciphertext opens
    // as "S", and its payee book is cleartext anyone could have edited.
    const salt = crypto.getRandomValues(new Uint8Array(16))
    const iv = crypto.getRandomValues(new Uint8Array(12))
    const base = await crypto.subtle.importKey('raw', new TextEncoder().encode(PASS), 'PBKDF2', false, ['deriveKey'])
    const key = await crypto.subtle.deriveKey({ name: 'PBKDF2', salt, iterations: 210_000, hash: 'SHA-256' }, base, { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt'])
    const cipher = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, new Uint8Array(shareBundle(1, 3, 2))))
    const hx = (b: Uint8Array) => Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('')
    const { id } = vaultIdOf('oe-v1-edited')
    const file = { format: 'konclave-vault-export', version: 1, exportedAt: Date.now(), vault: {
      id, groupKey: id, name: 'Family', roster: ROSTER, createdAt: 1, salt: hx(salt), iv: hx(iv), cipher: hx(cipher),
      secretIv: hx(iv), secretCipher: hx(cipher), beneficiaries: [{ label: 'Alice', address: 'u1edited' }],
    } }
    const { payload } = await openExport(parseVaultExport(JSON.stringify(file)), PASS)
    expect(payload.accessSecret).toBeNull()
    expect(payload.beneficiaries).toBeUndefined()
    // And a v1 with no id or group key at all, which the app refuses, is reported.
    expect(examine({ ...payload, id: undefined, groupKey: undefined }, true).problems.join(' ')).toMatch(/no vault id or group key/)
  })

  // A v1 file as a member holds it, sealing a real share, with the clear fields edited as given.
  async function v1File(vault: Record<string, unknown> = {}) {
    const salt = crypto.getRandomValues(new Uint8Array(16))
    const iv = crypto.getRandomValues(new Uint8Array(12))
    const base = await crypto.subtle.importKey('raw', new TextEncoder().encode(PASS), 'PBKDF2', false, ['deriveKey'])
    const key = await crypto.subtle.deriveKey({ name: 'PBKDF2', salt, iterations: 210_000, hash: 'SHA-256' }, base, { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt'])
    const cipher = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, new Uint8Array(shareBundle(1, 3, 2))))
    const hx = (b: Uint8Array) => Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('')
    const { id } = vaultIdOf('oe-v1-shape')
    return JSON.stringify({ format: 'konclave-vault-export', version: 1, exportedAt: Date.now(), vault: {
      id, groupKey: id, name: 'Family', roster: ROSTER, createdAt: 1, salt: hx(salt), iv: hx(iv), cipher: hx(cipher), ...vault,
    } })
  }

  it.each([
    ['no roster', { roster: undefined }],
    ['a roster that is not a list', { roster: 'Alice,Bob,Carol' }],
    ['an id and group key that are not a 64-character key', { id: 'a'.repeat(63), groupKey: 'a'.repeat(63) }],
    ['an id and group key that are not hex', { id: 'zz'.repeat(32), groupKey: 'zz'.repeat(32) }],
  ])('says what the app refuses in an edited v1: %s', async (_name, vault) => {
    const text = await v1File(vault)
    // The app refuses it ...
    let refused = false
    try { await importVault(parseVaultExport(text), PASS) } catch { refused = true }
    expect(refused, 'the app refuses this file').toBe(true)
    // ... so the checker must not call it fine.
    const { payload } = await openExport(JSON.parse(text), PASS)
    expect(examine(payload, true).problems.length).toBeGreaterThan(0)
    // And the report itself still prints, with the problem in it.
    const { env } = await openExport(JSON.parse(text), PASS)
    expect(reportLines(JSON.parse(text), env, true, payload).join('\n')).toContain('INCONSISTENT')
  })

  it('says the same file is fine when it is a good v1', async () => {
    const { payload } = await openExport(JSON.parse(await v1File()), PASS)
    expect(examine(payload, true).problems).toEqual([])
  })

  it('does not carry a v1 backup\'s cleartext address into the dump', async () => {
    const { payload } = await openExport(JSON.parse(await v1File({ address: 'u1editedbysomeone' })), PASS)
    expect(payload.address).toBeUndefined()
  })

  it('says "refuses to import" only of a v1, which is the one the app checks that way', () => {
    const differ = { id: 'cd'.repeat(32), groupKey: 'ab'.repeat(32), roster: [] }
    expect(examine(differ, true).problems.join(' ')).toMatch(/refuses to import/)
    const v2 = examine(differ, false).problems.join(' ')
    expect(v2).toMatch(/differ/)
    expect(v2).not.toMatch(/refuses to import/)
  })

  it('finds the quorum, which an export records in the share', async () => {
    const r = await checked('oe-quorum', 1, 3, 2)
    expect(r.quorum, 'governance is "open" or "quorum", never the numbers').toEqual({ t: 2, n: 3 })
    expect(r.report).toMatch(/Quorum +2 of 3/)
    expect(r.report).toMatch(/the quorum it belongs to +yes/)
  })

  it.each([1, 2, 3])('a backup from seat %i of 3 is consistent', async (seat) => {
    // Seats start at 1: seat N is roster[N - 1]. The last member is seat 3 of 3, not outside it.
    const r = await checked(`oe-seat-${seat}`, seat, 3, 2)
    expect(r.problems).toEqual([])
    expect(r.report).not.toContain('INCONSISTENT')
  })

  it.each([0, 4])('a share holding seat %i of a 3-member roster is still flagged', async (seat) => {
    // Seat 0 is the create screen's "room full": the device was never seated.
    const r = await checked(`oe-outside-${seat}`, seat, 3, 2)
    expect(r.problems.join(' ')).toContain(`seat ${seat}`)
  })

  it('flags a share whose member count disagrees with the roster', async () => {
    // The check that could never run: with the quorum never found, nothing compared the share
    // with the rest of the file.
    const r = await checked('oe-disagree', 2, 4, 2)
    expect(r.problems.join(' ')).toMatch(/4 members.*roster lists 3/)
  })
})
