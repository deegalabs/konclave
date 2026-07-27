// Architecture B — the browser (device) side of a real /net broadcast.
//
// A helper that never sees a share publishes a SIGNING REQUEST into the vault's relay room:
// the shielded sighash, the per-spend Orchard/Ironwood randomizers (alpha), and the proven
// PCZT (so each device can confirm what it is signing via describeOutputs). The devices run
// their FROST ceremony among themselves and publish back a SIGNING RESPONSE: one aggregate
// signature per requested spend. The helper injects and broadcasts.
//
// This module is the wire protocol, mirroring the orchestrator's `net_send` exactly so both
// sides agree byte-for-byte. Parsing is strict: a malformed or wrong-kind message is rejected,
// never half-interpreted.

export const REQUEST_KIND = 'net-sign-request'
export const RESPONSE_KIND = 'net-sign-response'

/** One spend to authorize: action index + its 64-hex redpallas randomizer. */
export type SpendReq = { index: number; alpha: string }

/** What the helper publishes. `pcztHex` is the proven PCZT for on-device describeOutputs. */
export type SignRequest = {
  kind: string
  sighash: string // 64-hex
  spends: SpendReq[]
  pcztHex: string
}

/** One aggregate signature the devices produced for a requested spend (128-hex). */
export type SigResp = { index: number; sig: string }

/** What the devices publish back: exactly one signature per requested spend. */
export type SignResponse = { kind: string; sigs: SigResp[] }

export function hexToBytes(s: string): Uint8Array {
  if (s.length % 2 !== 0) throw new Error('odd-length hex')
  const out = new Uint8Array(s.length / 2)
  for (let i = 0; i < out.length; i++) out[i] = parseInt(s.slice(i * 2, i * 2 + 2), 16)
  return out
}

export function bytesToHex(b: Uint8Array): string {
  let s = ''
  for (const x of b) s += x.toString(16).padStart(2, '0')
  return s
}

/**
 * The orchestrator serializes the request with a `pczt_hex` field (Rust snake_case). Parse it
 * strictly: wrong kind, missing fields, or bad types -> null, so a device never acts on a
 * half-understood request.
 */
export function parseSignRequest(data: string): SignRequest | null {
  let o: unknown
  try {
    o = JSON.parse(data)
  } catch {
    return null
  }
  if (typeof o !== 'object' || o === null) return null
  const r = o as Record<string, unknown>
  if (r.kind !== REQUEST_KIND) return null
  if (typeof r.sighash !== 'string' || typeof r.pczt_hex !== 'string') return null
  if (!Array.isArray(r.spends)) return null
  const spends: SpendReq[] = []
  for (const s of r.spends) {
    if (typeof s?.index !== 'number' || typeof s?.alpha !== 'string') return null
    spends.push({ index: s.index, alpha: s.alpha })
  }
  return { kind: REQUEST_KIND, sighash: r.sighash, spends, pcztHex: r.pczt_hex }
}

/**
 * Build the response the helper's `SignResponse::into_sigs` consumes: one 128-hex signature per
 * spend, keyed by action index. Serialized with the snake_case `kind` the orchestrator expects.
 */
export function buildSignResponse(sigs: SigResp[]): string {
  return JSON.stringify({ kind: RESPONSE_KIND, sigs })
}
