import { describe, expect, it } from 'vitest'
import { endSend, newSendAttempt, takeSend } from './send-attempt'
import { codeOf } from './source-scan'

// The signing panel's memory of the send it fired (#626). It lasts for the page, because the panel
// stays mounted while closed: a device whose send went nowhere sends again when the room names it
// for the same payment, and one whose send went out, or may have, does not.
describe('the send memory', () => {
  it('fires once for a payment while its send runs or went out', () => {
    const a = newSendAttempt()
    expect(takeSend(a, 'p1')).toBe(true)
    expect(takeSend(a, 'p1')).toBe(false)
    endSend(a, 'p1', 'sent')
    expect(takeSend(a, 'p1')).toBe(false)
    expect(takeSend(a, 'p2')).toBe(true) // another payment is another send
  })

  it('a send that ended with nothing sent lets the next naming fire', () => {
    // Scenario A: the panel is closed when the send fails. Scenario B: it is open. Either way the
    // failure path runs (the panel stays mounted), and the next time the room names this device
    // for the same payment, it sends.
    const a = newSendAttempt()
    expect(takeSend(a, 'p1')).toBe(true)
    endSend(a, 'p1', 'not-sent')
    expect(takeSend(a, 'p1')).toBe(true)
  })

  it('the end of one payment\'s send never releases another\'s', () => {
    const a = newSendAttempt()
    takeSend(a, 'p1')
    endSend(a, 'p2', 'not-sent')
    expect(takeSend(a, 'p1')).toBe(false)
  })

  it('a send that may have gone out keeps the memory: no second send from this page (#280)', () => {
    const a = newSendAttempt()
    takeSend(a, 'p1')
    endSend(a, 'p1', 'unknown')
    expect(takeSend(a, 'p1')).toBe(false)
  })
})

describe('the panel goes through the send memory', () => {
  const panel = codeOf('./screens/SigningPanel.tsx')

  it('fires from the effect only through fireSend, and keeps no memory of its own', () => {
    // fireSend (send-attempt.ts) is takeSend behind the decision and this device's signature.
    expect(panel).toMatch(/if \(!active \|\| !fireSend\(attempt\.current, active\.id, \{ named: bg\.iSend, armed \}\)\) return\s*void doSend\(\)/)
    expect(panel).not.toMatch(/sentOnce/)
  })

  it('the failure path releases the memory, the unknown path keeps it', () => {
    // Which ending releases it is stepEffects (busy-endings.test.ts); the panel applies that verdict.
    const apply = panel.slice(panel.indexOf('function apply('), panel.indexOf('function fail('))
    expect(apply).toContain('if (fx.endAs) endSend(attempt.current, pid, fx.endAs)')
  })

  it('"Try again" only clears what is shown: it never sends by itself', () => {
    const at = panel.indexOf("{t('signing.tryAgain')}")
    const button = panel.slice(panel.lastIndexOf('<button', at), at)
    expect(button).toMatch(/onClick=\{clearShown\}/)
    expect(panel).toMatch(/function clearShown\(\) \{\s*if \(active\) outcomes\.current\.clear\(active\.id\)\s*setResult\(null\)\s*\}/)
    expect(button).not.toMatch(/doSend/)
  })
})

describe('/net reads a send reply by the same rule', () => {
  it('NetVault goes through readReply, never the reply\'s fields by hand', () => {
    const net = codeOf('./screens/NetVault.tsx')
    const at = net.indexOf('const r = await executeProposal(')
    const block = net.slice(at, net.indexOf('} finally {', at))
    expect(block).toMatch(/const said = netReplyText\(readReply\(r\)\)\s*setPropMsg\(pe\(said\.pt, said\.en\)\)\s*if \(said\.stop\) return/)
    expect(block).not.toMatch(/'error' in r|'unknown' in r|r\.txid|end\./)
  })
})
