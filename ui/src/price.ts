// ZEC -> USD estimate — OPT-IN and disclosed (privacy by default, §6.1/§6.2).
//
// A price lookup is the ONE outbound request in an otherwise egress-free app, and it reveals to a
// third party that someone is running a Zcash tool. So it is OFF until the user turns it on, the
// source is named in the UI, and the last rate is cached so an enabled vault keeps working offline
// (and makes at most one network call per TTL). No amount, address, or vault id is ever sent — the
// request carries only "what is ZEC worth in USD".

const KEY_ENABLED = 'konclave.usd.enabled'
const KEY_CACHE = 'konclave.usd.cache'
const TTL_MS = 10 * 60 * 1000 // a cached rate older than this is stale (still shown, flagged)
// Public price source. Named in the UI so the user knows who they are talking to.
const SOURCE = 'CoinGecko'
const ENDPOINT = 'https://api.coingecko.com/api/v3/simple/price?ids=zcash&vs_currencies=usd'

export interface Rate {
  usd: number // USD per 1 ZEC
  at: number // epoch ms when fetched
  source: string
}

export function usdEnabled(): boolean {
  try {
    return localStorage.getItem(KEY_ENABLED) === '1'
  } catch {
    return false
  }
}

export function setUsdEnabled(on: boolean): void {
  try {
    if (on) localStorage.setItem(KEY_ENABLED, '1')
    else localStorage.removeItem(KEY_ENABLED)
  } catch {
    /* storage blocked — the toggle just will not persist */
  }
}

export function cachedRate(): Rate | null {
  try {
    const raw = localStorage.getItem(KEY_CACHE)
    if (!raw) return null
    const r = JSON.parse(raw) as Partial<Rate>
    if (typeof r.usd === 'number' && r.usd > 0 && typeof r.at === 'number') {
      return { usd: r.usd, at: r.at, source: r.source || SOURCE }
    }
  } catch {
    /* corrupt cache — treat as none */
  }
  return null
}

export function rateIsStale(r: Rate | null): boolean {
  return !r || Date.now() - r.at > TTL_MS
}

/**
 * Fetch the current ZEC/USD rate from the public source and cache it. Never throws: on any failure
 * it falls back to the cached rate (possibly stale), or null if there is none. The caller decides
 * how to present a stale/absent rate. Only runs when the user has opted in.
 */
export async function fetchRate(): Promise<Rate | null> {
  try {
    const res = await fetch(ENDPOINT, { headers: { accept: 'application/json' } })
    if (!res.ok) return cachedRate()
    const data = (await res.json()) as { zcash?: { usd?: number } }
    const usd = data?.zcash?.usd
    if (typeof usd !== 'number' || !(usd > 0)) return cachedRate()
    const rate: Rate = { usd, at: Date.now(), source: SOURCE }
    try {
      localStorage.setItem(KEY_CACHE, JSON.stringify(rate))
    } catch {
      /* cache write blocked — return the fresh rate anyway */
    }
    return rate
  } catch {
    return cachedRate()
  }
}

/** Convert a ZEC amount (string, e.g. "2.4180") to a formatted USD string, or null if not priceable. */
export function zecToUsd(zec: string | number | undefined, rate: Rate | null): string | null {
  if (!rate) return null
  const n = typeof zec === 'number' ? zec : parseFloat(zec || '')
  if (!isFinite(n)) return null
  const usd = n * rate.usd
  return usd.toLocaleString(undefined, { style: 'currency', currency: 'USD', maximumFractionDigits: 2 })
}
