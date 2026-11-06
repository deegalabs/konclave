import { describe, expect, it } from 'vitest'
// @ts-expect-error - a plain .mjs script, deliberately not part of the app's TS build
import { upgradeFirst } from '../../scripts/release.mjs'

// What a member must do BEFORE running an installer belongs on the first line of the release body,
// not under "The app" and four categories down. An entry that opens "**Upgrading from" is printed
// there as well as in its own category.
describe('an upgrade warning opens the release notes', () => {
  const body = [
    '## The app',
    '',
    '### Fixed',
    '',
    '- **Something else.** Unrelated.',
    '',
    '## The desktop shell and shared parts',
    '',
    '### Changed',
    '',
    "- **Upgrading from 0.16.0: do NOT tick 'Delete the application data'.** First line",
    '  continues here.',
    '- **Next entry.** Not lifted.',
  ].join('\n')

  it('puts the whole entry first, unbulleted, and keeps it in its category', () => {
    const out = upgradeFirst(body)
    const [first, second] = out.split('\n')
    expect(first).toBe("**Upgrading from 0.16.0: do NOT tick 'Delete the application data'.** First line")
    expect(second).toBe('continues here.')
    // Only that entry is lifted, and the body follows it whole.
    expect(out).toBe(`${first}\n${second}\n\n${body}`)
  })

  it('leaves a body without one unchanged', () => {
    const plain = body.replace('**Upgrading from', '**Upgraded from')
    expect(upgradeFirst(plain)).toBe(plain)
  })

  it('lifts only an entry that opens with it, not a mention inside another', () => {
    const mention = '- **Fixed.** Upgrading from 0.15.0 was slow.\n  - **Upgrading from nested** no.'
    expect(upgradeFirst(mention)).toBe(mention)
  })
})
