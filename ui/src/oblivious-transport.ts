// One helper READ, sent obliviously: sealed on this device, carried by a forwarding relay to the
// helper's gateway, answered and opened on this device. EXPERIMENTAL PROOF OF CONCEPT, OFF BY DEFAULT.
//
// Nothing a member can reach calls this. Private mode is offered only once EVERY call class goes
// oblivious (reads, mailbox, writes, health), and today only reads exist here. Offering a mode that
// hides some requests and not others is the failure this file must not be the first step of.
//
// Rules it keeps, because a transport that can do otherwise is not private:
//  - FAIL CLOSED. Any failure in the relay, the gateway or the answer throws an `ObliviousError`.
//    There is NO fallback to a direct request and NO retry: the caller decides, and the only thing
//    that call ever sends is one POST to the relay URL it was given.
//  - The key configuration is PINNED by the bundle and is the ONLY one ever sealed to: its
//    exact bytes are `PINNED_KEY_CONFIG_HEX`, and nothing fetched from the network can take their
//    place, because there is no option to hand one in and no fetch of one. A rotated or hostile key
//    therefore cannot be used silently: with nothing pinned, or after a rotation the app has not
//    shipped yet, the answer is `update_required`.
//  - The cryptography is the WASM's (`konclave-ohttp`'s client half), reached only through
//    `ensureWasm()`. The relay's answer is opened there, and nothing of it is read before it
//    authenticates.

import { PINNED_KEY_CONFIG_HEX } from './oblivious-key-config'
import * as wasmPkg from './wasm-pkg/konclave_wasm.js'
import { ensureWasm } from './wasm-ready'

/**
 * What this module needs of the wasm. The bindings exist only in a wasm built with konclave-wasm's
 * `ohttp` feature, which the committed package is not (members download no code that nothing
 * reaches), so they are looked up by name and typed here rather than imported: the package this
 * file is checked against has no such export, and a build without them says `update_required`.
 */
interface OhttpWasm {
  ohttpSeal(
    config: Uint8Array, method: string, path: string, readKey: string | undefined,
    contentType: string, body: Uint8Array, dateUnix: number,
  ): {
    wire(): Uint8Array
    open(response: Uint8Array): { status(): number; contentType(): string; body(): Uint8Array }
  }
}

function ohttpWasm(): OhttpWasm {
  const api = wasmPkg as unknown as Partial<OhttpWasm>
  if (typeof api.ohttpSeal !== 'function') throw new ObliviousError('update_required')
  return api as OhttpWasm
}

/** The media types of RFC 9458, which the relay and the gateway insist on. */
const REQUEST_TYPE = 'message/ohttp-req'
const RESPONSE_TYPE = 'message/ohttp-res'
const PROBLEM_TYPE = 'application/problem+json'

/** The pinned configuration's bytes, or null when the build pins none (or the constant is not hex). */
function bundlePin(): Uint8Array | null {
  const hex = PINNED_KEY_CONFIG_HEX
  if (hex.length === 0 || hex.length % 2 !== 0 || /[^0-9a-f]/i.test(hex)) return null
  const out = new Uint8Array(hex.length / 2)
  for (let i = 0; i < out.length; i++) out[i] = parseInt(hex.slice(2 * i, 2 * i + 2), 16)
  return out
}

export type ObliviousFailure =
  /** This build pins no key, or the gateway no longer uses the one it pins: update the app. */
  | 'update_required'
  /** The key configuration is not usable. */
  | 'bad_config'
  /** The request could not be built or sealed (a path or header the crate refuses). */
  | 'bad_request'
  /** The relay could not be reached, or did not answer in time. */
  | 'relay_unreachable'
  /** Too many requests: the relay's limit or the gateway's budget for all private requests. */
  | 'rate_limited'
  /** The relay refused (4xx): too large, wrong type, or no CORS for this origin. */
  | 'relay_refused'
  /** The relay or the gateway behind it failed (5xx, a cut, a timeout). */
  | 'relay_error'
  /** The gateway refused the request and says nothing more (400): it was malformed. */
  | 'gateway_refused'
  /** The device clock is outside the window the gateway accepts (typed, sealed answer). */
  | 'clock_skew'
  /** The gateway has seen this exact request already. */
  | 'replayed'
  /** The gateway cannot take another request now; try again later. */
  | 'busy'
  /** The answer did not authenticate. Nothing of it is returned. */
  | 'not_authentic'
  /** The answer authenticated but is not a usable response, or is not the expected media type. */
  | 'bad_response'

export class ObliviousError extends Error {
  readonly kind: ObliviousFailure
  readonly status?: number
  /** For `clock_skew`: the gateway's own time, unix seconds, so the message can say how far off. */
  readonly serverTime?: number
  constructor(kind: ObliviousFailure, status?: number, serverTime?: number) {
    super(`oblivious request failed: ${kind}${status === undefined ? '' : ` (${status})`}`)
    this.name = 'ObliviousError'
    this.kind = kind
    this.status = status
    this.serverTime = serverTime
  }
}

export interface ObliviousOptions {
  /** The relay's `POST /relay` URL. The only address this module ever sends to. */
  relayUrl: string
  /**
   * TEST SEAM. The pinned key configuration, standing in for the bundle's constant. The app passes
   * nothing, and a scan fails the build if any source but a test does. It is not a place to put a
   * configuration fetched from the network: that is exactly what this module must never use.
   */
  pin?: Uint8Array | null
  /** Unix seconds; injectable for tests. */
  now?: () => number
  /** Give up on the relay after this many ms. */
  timeoutMs?: number
}

const WASM_CODE = /^ohttp:([a-z_]+)$/

/** A WASM error is a string `ohttp:<code>`; anything else is not ours and is treated as bad. */
function fromWasm(e: unknown): ObliviousError {
  const code = WASM_CODE.exec(typeof e === 'string' ? e : '')?.[1]
  switch (code) {
    case 'bad_config': return new ObliviousError('bad_config')
    case 'not_authentic': return new ObliviousError('not_authentic')
    case 'bad_request': return new ObliviousError('bad_request')
    default: return new ObliviousError('bad_response')
  }
}

/** The problem types the gateway seals (and the relay never sees). Unknown ones fall to `gateway_refused`. */
function problem(body: Uint8Array): ObliviousError {
  try {
    const v = JSON.parse(new TextDecoder().decode(body)) as { type?: unknown; server_time?: unknown }
    if (v.type === 'clock_skew') {
      return new ObliviousError('clock_skew', 400, typeof v.server_time === 'number' ? v.server_time : undefined)
    }
    if (v.type === 'replayed') return new ObliviousError('replayed', 409)
    if (v.type === 'busy') return new ObliviousError('busy', 503)
  } catch { /* not JSON: refused below */ }
  return new ObliviousError('gateway_refused')
}

/**
 * Read one path (with its query) from the helper obliviously. `readKey` is the vault read key the
 * direct path would send in `X-Konclave-Read`; it travels inside the seal, never as a header of the
 * outer request. Resolves to what the direct `fetch` would have: the helper's own status and body.
 * Rejects with an `ObliviousError` on every other outcome, and never sends anything but the one
 * sealed POST to `relayUrl`.
 */
export async function obliviousRead(
  opts: ObliviousOptions,
  path: string,
  readKey?: string,
): Promise<Response> {
  await ensureWasm()
  const pin = opts.pin === undefined ? bundlePin() : opts.pin
  if (pin === null || pin.length === 0) throw new ObliviousError('update_required')
  const date = (opts.now ?? (() => Math.floor(Date.now() / 1000)))()

  const wasm = ohttpWasm()
  let sealed: ReturnType<OhttpWasm['ohttpSeal']>
  try {
    sealed = wasm.ohttpSeal(pin, 'GET', path, readKey, '', new Uint8Array(0), date)
  } catch (e) {
    throw fromWasm(e)
  }

  let res: Response
  try {
    // ONE attempt. Credentials, referrer and cache are off: this request must carry nothing of
    // the page but its sealed body (the browser still sends the IP and the Origin - that is the
    // limit of what a browser lets a page hide, and the relay's header strip is the other half).
    res = await fetch(opts.relayUrl, {
      method: 'POST',
      headers: { 'content-type': REQUEST_TYPE },
      body: sealed.wire() as BodyInit,
      credentials: 'omit',
      referrerPolicy: 'no-referrer',
      cache: 'no-store',
      signal: AbortSignal.timeout(opts.timeoutMs ?? 15_000),
    })
  } catch {
    throw new ObliviousError('relay_unreachable')
  }

  // 401 is the gateway saying it does not hold the pinned key (outside the seal: it opened nothing).
  // The only right response is to update the app; fetching a key is exactly what must not happen.
  if (res.status === 401) throw new ObliviousError('update_required', 401)
  if (res.status === 400) throw new ObliviousError('gateway_refused', 400)
  if (res.status === 429) throw new ObliviousError('rate_limited', 429)
  if (res.status >= 500) throw new ObliviousError('relay_error', res.status)
  if (res.status !== 200) throw new ObliviousError('relay_refused', res.status)
  if (res.headers.get('content-type')?.split(';')[0]?.trim().toLowerCase() !== RESPONSE_TYPE) {
    throw new ObliviousError('bad_response', 200)
  }

  let bytes: Uint8Array
  try {
    bytes = new Uint8Array(await res.arrayBuffer())
  } catch {
    throw new ObliviousError('relay_error', 200)
  }

  try {
    const answer = sealed.open(bytes)
    const ct = answer.contentType()
    // A refusal the gateway made itself, sealed: typed, so the member is told what is wrong.
    if (ct.split(';')[0]?.trim().toLowerCase() === PROBLEM_TYPE) throw problem(answer.body())
    return new Response(answer.body() as BodyInit, {
      status: answer.status(),
      headers: ct ? { 'content-type': ct } : {},
    })
  } catch (e) {
    throw e instanceof ObliviousError ? e : fromWasm(e)
  }
}
