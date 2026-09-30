import 'fake-indexeddb/auto'
import { describe, expect, it } from 'vitest'
// @ts-expect-error - a plain .mjs script, deliberately not part of the app's TS build
import { openExport, examine, reportLines } from '../../scripts/open-export.mjs'
import { saveVault, loadVault, exportVault, parseVaultExport, type VaultData } from './storage'
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
async function backupOf(id: string, seat: number, n: number, t: number, roster = ROSTER) {
  const data: VaultData = {
    name: 'Family', governance: 'quorum', myName: roster[seat - 1], creatorName: roster[0],
    groupKey: new Uint8Array(32).fill(7), address: 'u1familyaddress', roster,
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
    const restored = decodeBundle(await loadVault('oe-anchor', PASS))
    expect({ seat: restored.seat, n: restored.n, t: restored.t }).toEqual({ seat: 3, n: 3, t: 2 })
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
