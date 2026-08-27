// #354 + #356: the signing room carries two kinds of message with opposite needs, and the transport
// must not decide between them.
//
// - The arming tally is REBUILT from history (a device that reloads mid-payment learns who already
//   signed by reading the room back), which is why arming is scoped by proposal and expires on the
//   wire. Cut history off and two members sit at "1 of 2" with both present and no error.
// - The FROST ceremony is the opposite: a finished payment's messages replayed into a fresh one are
//   what FROST rejects as "the participant's commitment is incorrect".
//
// So RelaySession only reports WHERE a message came from. These tests pin that contract.
import { describe, expect, it, vi, afterEach } from 'vitest'
import { RelaySession } from './net'

type Msg = { seq: number; from: string; data: string }

function fakeRelay(log: Msg[]) {
  const fetchMock = vi.fn(async (url: string | URL) => {
    const u = new URL(String(url), 'http://x')
    const since = Number(u.searchParams.get('since') ?? 0)
    const messages = log.filter((m) => m.seq > since)
    const next = log.length ? log[log.length - 1]!.seq : since
    return { ok: true, json: async () => ({ messages, next, peers: 1 }) } as unknown as Response
  })
  vi.stubGlobal('fetch', fetchMock)
}

const flush = async () => { for (let i = 0; i < 6; i++) await Promise.resolve() }

afterEach(() => { vi.unstubAllGlobals() })

const history: Msg[] = [
  { seq: 1, from: 'b', data: '{"type":"armed","seat":2,"proposal":"p1","at":1}' },
  { seq: 2, from: 'helper', data: '{"kind":"konclave_sign_request"}' },
  { seq: 3, from: 'a', data: '{"type":"s1","commit":"OLD-A"}' },
]

describe('RelaySession history labelling', () => {
  it('still replays the room from the start - the arming tally is rebuilt from it', async () => {
    fakeRelay(history)
    const got: string[] = []
    const s = new RelaySession('room', 'me', (m) => { got.push(m.data) })
    s.start()
    await flush()
    s.stop()
    expect(got).toHaveLength(3)
  })

  it('labels everything in the FIRST poll as historical', async () => {
    fakeRelay(history)
    const got: boolean[] = []
    const s = new RelaySession('room', 'me', (_m, hist) => { got.push(hist) })
    s.start()
    await flush()
    s.stop()
    expect(got).toEqual([true, true, true])
  })

  it('labels what arrives after that as live', async () => {
    const log = [...history]
    fakeRelay(log)
    const got: { data: string; hist: boolean }[] = []
    const s = new RelaySession('room', 'me', (m, hist) => { got.push({ data: m.data, hist }) }, undefined, 1)
    s.start()
    await flush()
    log.push({ seq: 4, from: 'b', data: '{"type":"s1","commit":"NEW-B"}' })
    await new Promise((r) => setTimeout(r, 20))
    s.stop()
    const fresh = got.filter((g) => !g.hist)
    expect(fresh.map((g) => g.data)).toEqual(['{"type":"s1","commit":"NEW-B"}'])
  })

  it('an empty room does not burn the historical flag on the first real message', async () => {
    const log: Msg[] = []
    fakeRelay(log)
    const got: { data: string; hist: boolean }[] = []
    const s = new RelaySession('room', 'me', (m, hist) => { got.push({ data: m.data, hist }) }, undefined, 1)
    s.start()
    await flush()
    log.push({ seq: 1, from: 'a', data: '{"type":"s1","commit":"FIRST"}' })
    await new Promise((r) => setTimeout(r, 20))
    s.stop()
    // The first poll was empty, so the ceremony's opening message is live, not history.
    expect(got).toEqual([{ data: '{"type":"s1","commit":"FIRST"}', hist: false }])
  })
})
