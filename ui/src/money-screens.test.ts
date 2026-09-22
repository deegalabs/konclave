import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

// Three defects from #282 that survived a month, each one a money control that misleads rather
// than fails. The issue prescribed a whole derived money model; most of what that was for has
// since been fixed piecemeal - the overspend guard fails closed, `no-funds` is distinguished from
// `over-balance`, and the dropped balance fields are back - so what remains is these, and they are
// held here rather than by a rewrite nobody needs.
const SRC = new URL('.', import.meta.url).pathname
const codeOf = (f: string) =>
  readFileSync(join(SRC, f), 'utf8').split('\n').filter((l) => !/^\s*(\/\/|\*|\/\*|\{\/\*)/.test(l)).join('\n')

describe('a blocked money screen watches the thing that blocked it', () => {
  it('the payment screen refreshes its balance', () => {
    // It read the balance once, at mount. Every block it can show - no funds, not enough, unknown
    // - was therefore permanent until the member thought to reload, and nothing suggested they
    // should. Someone waiting on a deposit sat in front of a button that would have worked.
    const code = codeOf('screens/NewPayment.tsx')
    expect(code, 'NewPayment stopped polling: a stale zero blocks the member until they reload')
      .toMatch(/usePoll\(/)
    expect(code, 'the poll no longer refreshes the balance itself').toMatch(/usePoll\([\s\S]{0,400}getBalance\(/)
  })

  it('the fraction buttons are dead when there is nothing to take a fraction of', () => {
    // At zero spendable these stayed enabled and did nothing: `setFraction` computed zero (or
    // minus the fee) and set no amount. A control that answers a click with silence is worse than
    // one that is visibly unavailable.
    const code = codeOf('screens/NewPayment.tsx')
    expect(code, 'the %/Max buttons are gated on the balance being KNOWN again, not on it being spendable')
      .not.toMatch(/payamt-max" disabled=\{availableZat == null\}/)
    expect(code).toMatch(/canTakeFraction/)
  })

  it('the confirming amount is not added to a total that already contains it', () => {
    // "0.0006" as the headline with "+0.0006 confirming" beneath it reads as 0.0012 - the same
    // money twice, on the balance card. The headline is the TOTAL.
    const code = codeOf('screens/Dashboard.tsx')
    const line = code.split('\n').find((l) => l.includes("t('dashboard.confirming'"))
    expect(line, 'Dashboard no longer renders the confirming line').toBeTruthy()
    expect(line, 'the leading + is back: the confirming amount is being added to a total that includes it')
      .not.toMatch(/\+\$\{/)
  })
})
