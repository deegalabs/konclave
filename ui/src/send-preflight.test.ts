/// <reference types="node" />
import { afterEach, describe, expect, it, vi } from 'vitest'
import { readFileSync } from 'node:fs'
import { humanError } from './api'
import { alreadySent, netReplyText, notSendableText, panelStep, resolvedStep, stepResult, unresolvedNoteKey, watchSent } from './send-preflight'
import { en } from './i18n/en'
import { ptBR } from './i18n/pt-BR'
import { codeOf } from './source-scan'

// The coordinator's record of a payment is the last word on whether it went out (#626 review): the
// room may name a second sender after a window, and the panel used to report the coordinator's "not
// ready" refusal as a failed send, withdrawing every signature over a payment that had gone out.
describe('send preflight', () => {
  it('finds the payment sent, with its txid, by the rule that reads a send\'s outcome', () => {
    const list = [
      { id: 'p1', state: 'sent', txid: 'ab12' },
      { id: 'p2', state: 'ready', txid: null },
      { id: 'p3', state: 'sent', txid: null },
      { id: 'p4', state: 'confirmed', txid: 'cd34' },
    ]
    expect(alreadySent(list, 'p1')).toBe('ab12')
    expect(alreadySent(list, 'p2')).toBeNull()
    expect(alreadySent(list, 'p3')).toBeNull() // "sent" with no txid is not a send to show
    expect(alreadySent(list, 'p4')).toBe('cd34') // a send the chain confirmed is still a send
    expect(alreadySent(list, 'p9')).toBeNull()
    expect(alreadySent(null, 'p1')).toBeNull() // an unreadable list says nothing either way
  })

  it('the coordinator says why it will not send: its "not ready" carries the payment\'s state', () => {
    const rust = readFileSync(new URL('../../helper-server/src/main.rs', import.meta.url), 'utf8')
    expect(rust).toMatch(/json!\(\{ "error": "proposal is not ready to send", "state": (p\.)?state \}\)/)
  })

  it('the panel checks before sending, and reads a refusal by the state the coordinator gives', () => {
    const panel = codeOf('./screens/SigningPanel.tsx')
    const at = panel.indexOf('async function doSend(')
    expect(at).toBeGreaterThan(-1)
    const send = panel.slice(at)
    expect(send).toMatch(/const sentAs = alreadySent\(await listProposals\(vault\.group_pubkey\), args\.proposalId\)\s*if \(sentAs\) \{[\s\S]*?showFor\(pid, \{ txid: sentAs \}\)\s*return\s*\}/)
    expect(send.indexOf('alreadySent(')).toBeLessThan(send.indexOf('executeProposal(args)'))
    // What the reply means is one rule (readReply, send-outcome.test.ts); a refusal for a payment that
    // is not sendable is worded by notSendableText (below).
    // Each ending is routed by panelStep (tested below), and each step to the one call that does it.
    expect(send).toMatch(/const step = panelStep\(readReply\(r\), t\)\s*if \(step\.do === 'resolve'\) await resolveUnknown\(vault\.group_pubkey, pid\)\s*else apply\(pid, step\)/)
    expect(panel).toMatch(/apply\(proposalId, resolvedStep\(r\)\)/)
    expect(panel).not.toMatch(/function unknown\(/)
    // apply: a failure goes to fail(); everything else is shown through stepResult.
    expect(panel).toMatch(/if \(step\.do === 'fail'\) return fail\(pid, step\.text, step\.raw\)/)
    expect(panel).toMatch(/showFor\(pid, stepResult\(step\)\)/)
    // The countdown is guarded by payment, and reset when another payment opens.
    expect(panel).toMatch(/onAttempt: count,/)
    expect(panel).toMatch(/const count = \(n: number\) => \{ if \(boundTo\.current === proposalId\) setChecking\(n\) \}/)
    // A peer's failure goes through the payment's record too.
    // Never over a payment that may be on the network, one shown as sent, or this device's own send
    // still running; and announced only when shown.
    expect(panel).toMatch(/if \(!active \|\| sending \|\| !peerFailureMayShow\(outcomes\.current\.restore\(active\.id\)\)\) \{ bg\.clearPeerFailure\(\); return \}\s*showFor\(active\.id, \{ error: msg \}\)\s*toast\.err\(msg\)/)
    // A throw after the request went out may follow a broadcast: unknown, never a failure.
    expect(send).toMatch(/catch \(e\) \{[\s\S]*?if \(asked\) apply\(pid, \{ do: 'unknown', why: 'lost' \}\)\s*else fail\(pid,/)
    expect(panel).toMatch(/setResult\(outcomes\.current\.restore\(id\)\)\s*setChecking\(0\)/)
    // Every result about a payment goes through the book.
    expect(panel).toMatch(/\(txid\) => showFor\(active\.id, \{ txid \}\)/)
    expect(panel).toMatch(/outcomes\.current\.clear\(pid\)\s*setResult\(null\)/)
    // Every outcome of a send goes to its own payment, never to whatever is open.
    expect(send).toMatch(/fail\(pid, e instanceof Error \? e\.message : String\(e\)\)/)
    expect(panel).not.toMatch(/boundTo\.current!/)
    // The note under an unknown outcome is the one unresolvedNoteKey names.
    expect(panel).toMatch(/\{t\(unresolvedNoteKey\(unresolved\.unresolved\)\)\}/)
    // A send's outcome reaches the screen only for its own payment.
    const path = panel.slice(panel.indexOf('function showFor('), panel.indexOf('async function doSign('))
    expect(path.match(/setResult\(/g)?.length, 'only showFor, Try again, and the two resets at the start of a send').toBe(4)
    expect(panel).toMatch(/function showFor\(pid: string, r: PanelResult\) \{\s*if \(outcomes\.current\.record\(pid, r, boundTo\.current\)\) setResult\(r\)\s*\}/)
    // A payment that opens again shows what its own send came to (OutcomeBook).
    expect(panel).toMatch(/setResult\(outcomes\.current\.restore\(id\)\)/)
  })

  // The sentence is built from the state the coordinator names, through the dictionaries' names.
  it('words a refusal for every state the coordinator can name, and one it should not, in both languages', () => {
    const tFor = (d: Record<string, string>) => (k: string, v?: Record<string, string | number>) =>
      (d[k] ?? k).replace(/\{(\w+)\}/g, (_, n: string) => String(v?.[n] ?? `{${n}}`))
    for (const d of [en, ptBR]) {
      const t = tFor(d)
      const texts = ['pending', 'refused', 'expired', 'bogus'].map((st) => notSendableText(t, st))
      for (const x of texts) {
        expect(x).not.toMatch(/state\.|\{|signing\./)
        expect(x).not.toMatch(/bogus/)
      }
      // A pending payment lost an approval and may become sendable again: never "no longer sends it".
      const noLonger = d['signing.errNoLongerSendable']!.split('{state}')[1]!
      expect(noLonger.length).toBeGreaterThan(10)
      expect(texts[0]).not.toContain(noLonger)
      expect(texts[0]).toBe(d['signing.errNotSendablePending'])
      expect(texts[1]).toContain(noLonger) // refused
      expect(texts[2]).toContain(noLonger) // expired
    }
  })

  it('every open panel watches the payment\'s record, whatever its phase, with the light watch', () => {
    // The whole effect, guard to dependencies: a phase or a "started" condition added to either is a
    // panel that stops watching (#626 review), and a bare interval is one that floods the coordinator.
    const panel = codeOf('./screens/SigningPanel.tsx')
    // It watches until the payment shows as sent, through a failure or an unknown outcome too: a
    // screen that says nothing went out must learn that it did.
    expect(panel).toMatch(/const sentTxid = sentTxidOf\(result\)/)
    expect(panel).toMatch(/const sent = sentTxidOf\(result\)/)
    expect(panel).not.toMatch(/'txid' in result/)
    expect(panel).toMatch(/useEffect\(\(\) => \{\s*if \(!active \|\| !vault \|\| sending \|\| sentTxid\) return\s*return watchSent\(\(\) => listProposals\(vault\.group_pubkey\), active\.id, \(txid\) => showFor\(active\.id, \{ txid \}\)\)\s*\}, \[active, vault, sending, sentTxid\]\)/)
    expect(panel.match(/watchSent\(/g)?.length).toBe(1)
  })
})

// Every open panel watches, so the watch must be light (#626 review, round 3): the coordinator holds
// the vault's lock for the whole of a send and every read naming the vault waits on it, holding one
// of its workers. A read every 4 s from every open panel, each one waiting, emptied the pool.
describe('watchSent', () => {
  afterEach(() => { vi.useRealTimers() })

  function fakeDoc(hidden = false) {
    const handlers = new Map<string, () => void>()
    return {
      doc: { hidden, addEventListener: (k: string, h: () => void) => void handlers.set(k, h), removeEventListener: (k: string) => void handlers.delete(k) },
      win: { addEventListener: (k: string, h: () => void) => void handlers.set('win:' + k, h), removeEventListener: (k: string) => void handlers.delete('win:' + k) },
    }
  }

  it('keeps one read in flight: a coordinator that holds the read gets no second one', async () => {
    vi.useFakeTimers()
    const { doc, win } = fakeDoc()
    let calls = 0
    const stop = watchSent(() => { calls++; return new Promise(() => {}) }, 'p1', () => {}, 4000, doc, win)
    await vi.advanceTimersByTimeAsync(40_000)
    expect(calls).toBe(1)
    stop()
  })

  it('reads nothing while the tab is hidden', async () => {
    vi.useFakeTimers()
    const { doc, win } = fakeDoc(true)
    let calls = 0
    const stop = watchSent(async () => { calls++; return [] }, 'p1', () => {}, 4000, doc, win)
    await vi.advanceTimersByTimeAsync(40_000)
    expect(calls).toBe(0)
    stop()
  })

  it('says the payment went out once the record has it, and stops asking when stopped', async () => {
    vi.useFakeTimers()
    const { doc, win } = fakeDoc()
    const lists = [[{ id: 'p1', state: 'ready', txid: null }], [{ id: 'p1', state: 'sent', txid: 'ab12' }]]
    let calls = 0
    const seen: string[] = []
    const stop = watchSent(async () => lists[Math.min(calls++, 1)]!, 'p1', (txid) => seen.push(txid), 4000, doc, win)
    await vi.advanceTimersByTimeAsync(4000)
    expect(seen).toEqual([])
    await vi.advanceTimersByTimeAsync(4000)
    expect(seen).toEqual(['ab12'])
    stop()
    const after = calls
    await vi.advanceTimersByTimeAsync(20_000)
    expect(calls).toBe(after)
  })

  it('a read still in flight when the watch stops says nothing when it lands', async () => {
    // The panel stops the watch when another payment opens; a read of the previous one that lands
    // afterwards must not show that payment's txid on the new one.
    vi.useFakeTimers()
    const { doc, win } = fakeDoc()
    let land: (l: Array<{ id: string; state: string; txid: string | null }>) => void = () => {}
    const seen: string[] = []
    const stop = watchSent(() => new Promise((res) => { land = res }), 'p1', (txid) => seen.push(txid), 4000, doc, win)
    await vi.advanceTimersByTimeAsync(4000)
    stop()
    land([{ id: 'p1', state: 'sent', txid: 'ab12' }])
    await vi.advanceTimersByTimeAsync(0)
    expect(seen).toEqual([])
  })

  it('a read that fails leaves the watch running', async () => {
    vi.useFakeTimers()
    const { doc, win } = fakeDoc()
    let calls = 0
    const stop = watchSent(async () => { calls++; throw new Error('offline') }, 'p1', () => {}, 4000, doc, win)
    await vi.advanceTimersByTimeAsync(12_000)
    expect(calls).toBe(3)
    stop()
  })
})

// The coordinator's refusal reaches the panel with its state, not only its English words.
describe('executeProposal passes the state of a refused send', () => {
  it('returns the coordinator\'s state with its error', async () => {
    const mem = new Map<string, string>()
    vi.stubGlobal('localStorage', {
      getItem: (k: string) => mem.get(k) ?? null,
      setItem: (k: string, v: string) => void mem.set(k, String(v)),
      removeItem: (k: string) => void mem.delete(k),
      clear: () => mem.clear(),
    })
    localStorage.setItem('konclave.coord.mode', 'custom')
    localStorage.setItem('konclave.coord.url', 'https://coordinator.invalid')
    vi.stubGlobal('fetch', async () => new Response(JSON.stringify({ error: 'proposal is not ready to send', state: 'sent' }), { status: 409 }))
    try {
      const { executeProposal } = await import('./helper')
      const r = await executeProposal({ vault: 'gk', proposalId: 'p1', relayBase: '', room: 'r' })
      expect(r).toEqual({ error: 'proposal is not ready to send', state: 'sent' })
      vi.stubGlobal('fetch', async () => new Response(JSON.stringify({ error: 'build failed' }), { status: 500 }))
      expect(await executeProposal({ vault: 'gk', proposalId: 'p1', relayBase: '', room: 'r' })).toEqual({ error: 'build failed' })
    } finally {
      vi.unstubAllGlobals()
    }
  })
})

// What the panel does with each ending of a send. Only a send
// that went nowhere fails, withdraws and offers Try again; one that may be on the network is unknown,
// with the note that says which; the record decides the rest.
describe('panelStep', () => {
  const t = (k: string, v?: Record<string, string | number>) => (v ? `${k}${JSON.stringify(v)}` : k)
  it('a send that may be on the network, or a broadcast that errored, is unknown, never a failure, each with its note', () => {
    expect(panelStep({ kind: 'held' }, t)).toEqual({ do: 'unknown', why: 'held' })
    expect(panelStep({ kind: 'held', txid: 'f00d' }, t)).toEqual({ do: 'unknown', why: 'broadcast', txid: 'f00d' })
    expect(unresolvedNoteKey('held')).toBe('signing.heldNote')
    expect(unresolvedNoteKey('broadcast')).toBe('signing.broadcastNote')
    expect(unresolvedNoteKey('lost')).toBe('signing.unresolvedNote')
  })
  it('a lost reply or a payment another device sent is asked of the record', () => {
    expect(panelStep({ kind: 'resolve' }, t)).toEqual({ do: 'resolve' })
    expect(panelStep({ kind: 'resolve', sentElsewhere: true }, t)).toEqual({ do: 'resolve' })
  })
  // The record's answer after a lost reply: sent, or unknown. Never a failure: a
  // failure withdraws and offers Try again over a payment that may be on the network (#280).
  it('a lost reply the record resolves is sent or unknown, never a failure', () => {
    expect(resolvedStep({ kind: 'sent', txid: 'ab' })).toEqual({ do: 'sent', txid: 'ab' })
    expect(resolvedStep({ kind: 'unresolved' })).toEqual({ do: 'unknown', why: 'lost' })
  })
  it('a send is shown sent', () => {
    expect(panelStep({ kind: 'sent', txid: 'ab' }, t)).toEqual({ do: 'sent', txid: 'ab' })
  })
  it('only a send that went nowhere fails, with its reason', () => {
    expect(panelStep({ kind: 'not-sent', why: 'unreachable' }, t)).toEqual({ do: 'fail', text: 'signing.errUnreachable' })
    expect(panelStep({ kind: 'not-sent', why: 'no-txid' }, t)).toEqual({ do: 'fail', text: 'signing.errNoTxid' })
    expect(panelStep({ kind: 'not-sent', why: 'not-sendable', state: 'expired', raw: 'r' }, t)).toEqual({ do: 'fail', text: notSendableText(t, 'expired'), raw: 'r' })
    const e = panelStep({ kind: 'not-sent', why: 'error', raw: 'insufficient funds' }, t)
    expect(e).toEqual({ do: 'fail', text: humanError(t, 'insufficient funds'), raw: 'insufficient funds' })
    expect(humanError(t, 'insufficient funds')).not.toBe('insufficient funds')
  })
})

// What each step shows on the panel.
describe('stepResult', () => {
  it('a send shows its txid; an unknown its reason and the txid to look for; a failure its text', () => {
    expect(stepResult({ do: 'sent', txid: 'ab' })).toEqual({ txid: 'ab' })
    expect(stepResult({ do: 'unknown', why: 'held' })).toEqual({ unresolved: 'held' })
    expect(stepResult({ do: 'unknown', why: 'broadcast', txid: 'f0' })).toEqual({ unresolved: 'broadcast', txid: 'f0' })
    expect(stepResult({ do: 'unknown', why: 'lost' })).toEqual({ unresolved: 'lost' })
    expect(stepResult({ do: 'fail', text: 'x' })).toEqual({ error: 'x' })
  })
})

// What /net says for each ending: only a send that went nowhere is "failed".
describe('netReplyText', () => {
  it('fails only a send that went nowhere, and names a payment another device sent', () => {
    const failed = (x: { en: string }) => x.en.startsWith('Execute failed')
    expect(failed(netReplyText({ kind: 'sent', txid: 'ab' }))).toBe(false)
    expect(failed(netReplyText({ kind: 'held' }))).toBe(false)
    expect(failed(netReplyText({ kind: 'held', txid: 'f0' }))).toBe(false)
    expect(netReplyText({ kind: 'held', txid: 'f0' }).en).toContain('f0')
    expect(failed(netReplyText({ kind: 'resolve' }))).toBe(false)
    const elsewhere = netReplyText({ kind: 'resolve', sentElsewhere: true })
    expect(failed(elsewhere)).toBe(false)
    expect(elsewhere.en).toMatch(/another device already sent/i)
    expect(elsewhere.en).not.toBe(netReplyText({ kind: 'resolve' }).en)
    for (const e of [{ kind: 'not-sent', why: 'unreachable' }, { kind: 'not-sent', why: 'no-txid' }, { kind: 'not-sent', why: 'error', raw: 'r' }] as const) {
      expect(failed(netReplyText(e)), JSON.stringify(e)).toBe(true)
      expect(netReplyText(e).stop).toBe(true)
    }
    expect(netReplyText({ kind: 'held' }).stop).toBe(false)
  })
})
