// #354: what a signing session must NOT be handed when it joins.
//
// The signing room is permanent (derived from the group key alone) and a device listens on it
// continuously, so the room's history is never something to catch up on - it is the previous
// ceremony. Replaying it fed a finished payment's `sreq` and round-1 commitments into the next
// payment, and FROST refused the mix as "the participant's commitment is incorrect". The DKG room
// wants the opposite: a guest who opens the invite late must see what was said before they arrived.
import { describe, expect, it, vi, afterEach } from 'vitest'
import { RelaySession } from './net'

type Msg = { seq: number; from: string; data: string }

/** A fake relay holding `log`, answering the real contract: `messages` are the entries after
 *  `since`, and `next` is the last seq it holds (or `since` itself for an unknown room). */
function fakeRelay(log: Msg[]) {
  const seen: number[] = []
  const fetchMock = vi.fn(async (url: string | URL) => {
    const u = new URL(String(url), 'http://x')
    const since = Number(u.searchParams.get('since') ?? 0)
    seen.push(since)
    const messages = log.filter((m) => m.seq > since)
    const next = log.length ? log[log.length - 1]!.seq : since
    return {
      ok: true,
      json: async () => ({ messages, next, peers: 1 }),
    } as unknown as Response
  })
  vi.stubGlobal('fetch', fetchMock)
  return { seen }
}

const flush = async () => { for (let i = 0; i < 6; i++) await Promise.resolve() }

afterEach(() => { vi.unstubAllGlobals() })

const history: Msg[] = [
  { seq: 1, from: 'helper', data: '{"kind":"konclave_sign_request"}' },
  { seq: 2, from: 'a', data: '{"type":"s1","commit":"OLD-A"}' },
  { seq: 3, from: 'b', data: '{"type":"s1","commit":"OLD-B"}' },
  { seq: 4, from: 'a', data: '{"type":"signed"}' },
]

describe('RelaySession history', () => {
  it('replays everything by default - the DKG room needs a late joiner to catch up', async () => {
    fakeRelay(history)
    const got: string[] = []
    const s = new RelaySession('room', 'me', (m) => { got.push(m.data) })
    s.start()
    await flush()
    s.stop()
    expect(got).toHaveLength(4)
  })

  it('BUG #354: with tail start, a joiner is handed none of the previous ceremony', async () => {
    fakeRelay(history)
    const got: string[] = []
    const s = new RelaySession('room', 'me', (m) => { got.push(m.data) }, undefined, undefined, true)
    s.start()
    await flush()
    s.stop()
    // Not one stale commitment. Before the fix all four arrived, and the old `s1` commitments mixed
    // with fresh nonces are exactly what FROST rejects.
    expect(got).toEqual([])
  })

  it('tail start still delivers what arrives AFTER it joined', async () => {
    const log = [...history]
    fakeRelay(log)
    const got: string[] = []
    const s = new RelaySession('room', 'me', (m) => { got.push(m.data) }, undefined, 1, true)
    s.start()
    await flush()
    log.push({ seq: 5, from: 'b', data: '{"type":"s1","commit":"NEW-B"}' })
    await new Promise((r) => setTimeout(r, 20))
    s.stop()
    expect(got).toEqual(['{"type":"s1","commit":"NEW-B"}'])
  })

  it('tail start on a room that does not exist yet behaves like a normal reader', async () => {
    const { seen } = fakeRelay([])
    const got: string[] = []
    const s = new RelaySession('room', 'me', (m) => { got.push(m.data) }, undefined, undefined, true)
    s.start()
    await flush()
    s.stop()
    // The probe learns nothing (the relay echoes the probe value back), so the cursor stays at 0
    // and the session does not silently skip the first real message of a brand new ceremony.
    expect(seen[0]).toBe(Number.MAX_SAFE_INTEGER)
    expect(seen[1]).toBe(0)
    expect(got).toEqual([])
  })
})
