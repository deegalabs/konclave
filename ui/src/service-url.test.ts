import { describe, expect, it } from 'vitest'
import { parseServiceUrl, serviceUrlForDisplay, SERVICE_URL_MAX, type ServiceUrlRefusal } from './service-url'

// #1067: one rule for an address a member types for a coordinator or a relay. The table carries the
// issue's acceptance criteria and the places where the WHATWG parser forgives what a member should be
// told about (it drops tabs and newlines inside, strips control characters at the ends, reads `\` as
// `/`, takes `https:host`, and reports an empty username / search / hash for `@`, `?` and `#`). Each
// of those is checked on the raw string, so each has a row here.

const refused: [string, string, ServiceUrlRefusal][] = [
  ['plain http to a public host', 'http://example.org', 'insecure'],
  ['a user and password', 'https://user:pass@example.org', 'credentials'],
  ['a user alone', 'https://user@example.org', 'credentials'],
  ['an empty user (`@` the parser forgets)', 'https://@example.org', 'credentials'],
  ['a query', 'https://example.org/?a=1', 'query'],
  ['a bare `?` (empty search to the parser)', 'https://example.org?', 'query'],
  ['a fragment', 'https://example.org#f', 'fragment'],
  ['a bare `#` (empty hash to the parser)', 'https://example.org#', 'fragment'],
  ['a scheme that is not http(s)', 'ftp://example.org', 'scheme'],
  ['javascript:', 'javascript:alert(1)', 'scheme'],
  ['a bare host', 'example.org', 'malformed'],
  ['`https:host` (no slashes)', 'https:example.org', 'malformed'],
  ['`https:/host` (one slash)', 'https:/example.org', 'malformed'],
  ['a backslash form', 'https:\\\\example.org', 'malformed'],
  ['a backslash after the host', 'https://example.org\\api', 'malformed'],
  ['inner whitespace', 'https://exa mple.org', 'character'],
  ['a tab inside (the parser drops it)', 'https://exa\tmple.org', 'character'],
  ['a newline inside (the parser drops it)', 'https://example.org\n/x', 'character'],
  ['a leading control character', '\u0001https://example.org', 'character'],
  ['a trailing DEL', 'https://example.org\u007f', 'character'],
  ['a bidirectional override', 'https://exa\u202Emple.org', 'character'],
  ['a bidirectional isolate', 'https://\u2066example.org', 'character'],
  ['a zero-width character', 'https://exa\u200Bmple.org', 'character'],
  ['an over-long address', `https://${'a'.repeat(SERVICE_URL_MAX)}.org`, 'tooLong'],
  ['a path prefix', 'https://example.org/coordinator', 'path'],
  ['a path after a port', 'https://example.org:8443/api', 'path'],
  ['an IPv6 loopback over http', 'http://[::1]:4762', 'insecure'],
  ['`localhost.` over http', 'http://localhost.:4762', 'insecure'],
  ['`127.1` over http (the parser rewrites it to 127.0.0.1)', 'http://127.1:4762', 'insecure'],
  ['a loopback lookalike over http', 'http://localhost.example.org', 'insecure'],
  ['an invalid port', 'https://example.org:99999', 'malformed'],
  ['nothing', '', 'empty'],
  ['blanks', '   ', 'empty'],
]

const accepted: [string, string, string][] = [
  ['https', 'https://example.org', 'https://example.org'],
  ['one trailing slash', 'https://example.org/', 'https://example.org'],
  ['several trailing slashes', 'https://my-helper.example.com//', 'https://my-helper.example.com'],
  ['a port', 'https://example.org:8443', 'https://example.org:8443'],
  ['the default port, dropped', 'https://example.org:443', 'https://example.org'],
  ['upper case, lowered as the parser does', 'HTTPS://Example.ORG', 'https://example.org'],
  ['surrounding blanks and a pasted newline', '  https://example.org\n', 'https://example.org'],
  ['http to localhost', 'http://localhost:4762', 'http://localhost:4762'],
  ['http to 127.0.0.1', 'http://127.0.0.1:4762', 'http://127.0.0.1:4762'],
  ['https to localhost (no dot required)', 'https://localhost', 'https://localhost'],
  ['the test hosts the suite stores', 'https://coordinator.invalid', 'https://coordinator.invalid'],
  ['an .example host', 'https://coordinator.example', 'https://coordinator.example'],
  ['the longest address taken', `https://${'a'.repeat(SERVICE_URL_MAX - 'https://'.length - 4)}.org`, `https://${'a'.repeat(SERVICE_URL_MAX - 'https://'.length - 4)}.org`],
]

describe('parseServiceUrl (#1067)', () => {
  it.each(refused)('refuses %s', (_, input, reason) => {
    expect(parseServiceUrl(input)).toEqual({ ok: false, reason })
  })

  it.each(accepted)('accepts %s', (_, input, base) => {
    expect(parseServiceUrl(input)).toEqual({ ok: true, base })
  })

  it('returns a base callers can append `/api/...` to: never a trailing slash', () => {
    for (const [, input] of accepted) {
      const r = parseServiceUrl(input)
      expect(r.ok && !r.base.endsWith('/')).toBe(true)
    }
  })
})

// An address recorded before the rule (a vault record's coordinator) is shown, never used: only what
// identifies the server, never a name, password, path, query or fragment.
describe('serviceUrlForDisplay (#1067 review)', () => {
  it.each([
    ['an address the rule takes, as its base', 'https://Old.example/', 'https://old.example'],
    ['credentials, dropped', 'https://user:secret@old.example', 'https://old.example'],
    ['credentials and a port', 'http://user:secret@old.example:4762/p?token=1#f', 'http://old.example:4762'],
    ['a path, query and fragment, dropped', 'https://old.example/coord?token=secret#secret', 'https://old.example'],
  ])('shows %s', (_, raw, shown) => {
    expect(serviceUrlForDisplay(raw)).toBe(shown)
  })

  it.each([['nothing', ''], ['not an address', 'secret words'], ['another scheme', 'ftp://user:secret@old.example']])(
    'shows nothing for %s', (_, raw) => {
      expect(serviceUrlForDisplay(raw)).toBeNull()
    })
})
