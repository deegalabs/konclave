import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { codeOf } from './source-scan'

// #615: the proof page offered "verify on-chain now", a fetch to an explorer API that the site's
// Content-Security-Policy never admitted, so the browser refused it and the check read as a broken
// claim. The page now offers only what works everywhere (explorer links, the script), and this test
// holds its network origins to the policy, so the drift cannot come back unnoticed.
describe('the proof page contacts nothing the policy refuses (#615)', () => {
  const policy = JSON.parse(readFileSync(new URL('../vercel.json', import.meta.url), 'utf8')) as {
    headers: { headers: { key: string; value: string }[] }[]
  }
  const csp = policy.headers.flatMap((h) => h.headers).find((h) => h.key.toLowerCase() === 'content-security-policy')!.value
  const connectSrc = csp.split(';').map((d) => d.trim()).find((d) => d.startsWith('connect-src'))!
  const allowed = connectSrc.split(/\s+/).slice(1)

  const src = codeOf('./screens/Proof.tsx')

  it('reads the policy', () => {
    expect(allowed).toContain("'self'")
  })

  it('makes no request of its own', () => {
    expect(src).not.toMatch(/\bfetch\s*\(/)
    expect(src).not.toMatch(/XMLHttpRequest|EventSource|WebSocket/)
  })

  it('every https origin it names is either a link a person opens or an origin the policy admits', () => {
    const origins = new Set((src.match(/https:\/\/[a-z0-9.-]+/gi) ?? []).map((u) => u.toLowerCase()))
    // Links the member opens in a new tab are navigation, not connect-src; they are the point of the page.
    const links = new Set(['https://mainnet.zcashexplorer.app', 'https://blockchair.com'])
    for (const o of origins) {
      if (links.has(o)) continue
      expect(allowed, `${o} is neither an explorer link nor in connect-src`).toContain(o)
    }
  })

  it('offers the explorer links and the script instead of a button that cannot run', () => {
    expect(src).not.toMatch(/proof-verify|verifyAll|checkBlockchair/)
    expect(src).toContain('scripts/verify-proof.mjs')
    expect(src).toContain('explorerZec(t.txid)')
    expect(src).toContain('explorerBlockchair(t.txid)')
  })
})
