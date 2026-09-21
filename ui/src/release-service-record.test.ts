import { describe, expect, it } from 'vitest'
// @ts-expect-error - a plain .mjs script, deliberately not part of the app's TS build
import { buildsNote } from '../../scripts/release.mjs'

// "Which coordinator and which relay were live when this shipped?" had no answer. The web app is
// whatever `main` was, the desktop whatever the tag was, and the two services are whatever someone
// last pushed by hand - and they carry NO version to reconstruct from, deliberately, because a
// number nobody bumps lies. Each reports a build identity instead, so the release records what they
// were answering at the moment it was cut.
describe('the release records which services were live', () => {
  it('names both services and what each answered', () => {
    const note = buildsNote([['coordinator', 'abc1234'], ['relay', 'deadbeefcafe0001']], '2026-09-21')
    expect(note).toContain('coordinator')
    expect(note).toContain('abc1234')
    expect(note).toContain('relay')
    expect(note).toContain('deadbeefcafe0001')
    expect(note, 'the date the reading was taken is part of the record').toContain('2026-09-21')
  })

  it('records a service it could not reach, rather than dropping it', () => {
    // The half nobody could check is exactly the half an audit needs to know about. Omitting it
    // would read as "there were no services", and guessing would be worse than either.
    const note = buildsNote([['coordinator', 'unreachable'], ['relay', 'abc']], '2026-09-21')
    expect(note).toContain('coordinator')
    expect(note).toContain('unreachable')
  })

  it('says the services may be OLDER than the release, because they usually are', () => {
    // The trap this record exists to remove: reading `## [0.5.0]` and assuming everything in it
    // was live everywhere on that date. The web app was; the hand-deployed services may not be.
    const note = buildsNote([['coordinator', 'abc1234'], ['relay', 'def']], '2026-09-21')
    expect(note.toLowerCase()).toContain('older')
  })

  it('is a blockquote, so it cannot be mistaken for a changelog entry', () => {
    expect(buildsNote([['coordinator', 'a'], ['relay', 'b']], '2026-09-21').startsWith('> ')).toBe(true)
  })
})
