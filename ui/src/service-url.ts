// The one rule for an address a member gives for a coordinator or a relay (#1067). Both screens, both
// setters and both readers go through `parseServiceUrl`; nothing else decides whether such an address
// may be stored or used. The built-in bases (VITE_HELPER_BASE, VITE_RELAY_BASE, VITE_API_BASE) are
// build-time values, may be '' (same origin) and are not member input, so they do not come here.
//
// The base is an ORIGIN: https://host[:port], with http only for localhost and 127.0.0.1. Callers
// append `/api/...` to it, the coordinator serves its API at the root, and it accepts a relay only as
// an origin (`parse_relay_config`, orchestrator/src/relay_client.rs), so a path would be a mistake or a
// way to aim requests somewhere else. A password in the address would be kept in the browser's storage
// and sent in every request URL (CLAUDE.md section 6.3); a query or a fragment would be carried into
// every request too.
//
// The WHATWG parser is used for the host and the port, but it forgives what a member should be told
// about: it drops tabs and newlines inside the string and control characters at its ends, reads `\` as
// `/`, takes `https:host`, rewrites `127.1` to `127.0.0.1`, and reports an empty username, search or
// hash for a bare `@`, `?` or `#`. So the raw string is checked first, and the parser second.

/** The longest address taken, in characters, after the surrounding blanks are trimmed. */
export const SERVICE_URL_MAX = 256

/** Why an address was refused. One i18n key each (`serviceUrl.<reason>`), so the screens say why. */
export type ServiceUrlRefusal =
  | 'empty'
  | 'tooLong'
  | 'character'
  | 'credentials'
  | 'query'
  | 'fragment'
  | 'scheme'
  | 'insecure'
  | 'path'
  | 'malformed'

export type ServiceUrl = { ok: true; base: string } | { ok: false; reason: ServiceUrlRefusal }

// Controls (C0, DEL, C1), any whitespace, zero-width characters and every bidirectional control.
// eslint-disable-next-line no-control-regex -- matching control characters is what this line is for
const BAD_CHARACTER = /[\u0000-\u001F\u007F-\u009F\s\u061C\u200B-\u200F\u202A-\u202E\u2060-\u2069\uFEFF]/u
// http is for these two authorities exactly, as typed: not `localhost.`, `127.1` or `[::1]`.
const LOOPBACK = /^(localhost|127\.0\.0\.1)(:\d{1,5})?$/i

const refuse = (reason: ServiceUrlRefusal): ServiceUrl => ({ ok: false, reason })

/** The normalised base for an address a member typed (an origin, never a trailing slash), or why not. */
export function parseServiceUrl(input: string): ServiceUrl {
  const s = input.trim()
  if (s === '') return refuse('empty')
  if (s.length > SERVICE_URL_MAX) return refuse('tooLong')
  if (BAD_CHARACTER.test(s)) return refuse('character')
  if (s.includes('@')) return refuse('credentials')
  if (s.includes('?')) return refuse('query')
  if (s.includes('#')) return refuse('fragment')
  if (s.includes('\\')) return refuse('malformed')

  const scheme = /^([a-z][a-z0-9+.-]*):/i.exec(s)?.[1]?.toLowerCase()
  if (scheme === undefined) return refuse('malformed')
  if (scheme !== 'https' && scheme !== 'http') return refuse('scheme')
  const rest = s.slice(scheme.length + 1)
  if (!rest.startsWith('//')) return refuse('malformed')
  const slash = rest.indexOf('/', 2)
  const authority = slash === -1 ? rest.slice(2) : rest.slice(2, slash)
  if (slash !== -1 && !/^\/*$/.test(rest.slice(slash))) return refuse('path')
  if (authority === '') return refuse('malformed')
  if (scheme === 'http' && !LOOPBACK.test(authority)) return refuse('insecure')

  let url: URL
  try {
    url = new URL(`${scheme}://${authority}`)
  } catch {
    return refuse('malformed')
  }
  if (url.username || url.password || url.hostname === '') return refuse('malformed')
  return { ok: true, base: url.origin }
}

// Where a member's own address is kept, per device. The keys live here and nowhere else in the app
// (service-url-scan.test.ts), so nothing can store an address this rule did not take, or read one
// back without going through it again.
const STORAGE_KEY = { coordinator: 'konclave.coord.url', relay: 'konclave.relay.url' } as const
export type ServiceKind = keyof typeof STORAGE_KEY

/** The stored address for `kind`, read through the rule; null when nothing is stored. A value stored
 *  before #1067, or by hand, is checked like a typed one: what the rule refuses comes back refused. */
export function readServiceUrl(kind: ServiceKind): ServiceUrl | null {
  let raw: string | null = null
  try { raw = localStorage.getItem(STORAGE_KEY[kind]) } catch { /* storage unavailable */ }
  return raw === null ? null : parseServiceUrl(raw)
}

/** Store `input` for `kind` if the rule takes it, as the normalised base; otherwise store nothing.
 *  Returns the rule's answer either way, so the caller can say why. */
export function storeServiceUrl(kind: ServiceKind, input: string): ServiceUrl {
  const r = parseServiceUrl(input)
  if (r.ok) {
    try { localStorage.setItem(STORAGE_KEY[kind], r.base) } catch { /* applies this session only */ }
  }
  return r
}
