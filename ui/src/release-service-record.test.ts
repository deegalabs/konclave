import { describe, expect, it } from 'vitest'
// @ts-expect-error - a plain .mjs script, deliberately not part of the app's TS build
import { buildsNote, versionsToReport } from '../../scripts/release.mjs'

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

describe('a release body describes the installer, not its own section', () => {
  // v0.5.0 was cut into the changelog and then superseded before it was ever published - the
  // draft did not carry two security fixes, so it was discarded and 0.6.0 took its place.
  //
  // A body built from the 0.6.0 section alone would have described ELEVEN entries while the
  // installer carried FORTY-TWO, and nine `Security` entries from the orphaned section would have
  // reached desktop users unannounced. The notes have to cover everything since the last version
  // anyone actually received.
  it('includes a section that was cut but never tagged', () => {
    // Real numbers from the day it happened: 0.5.0 exists in the changelog, has no tag.
    const reported = versionsToReport('0.6.0')
    expect(reported[0]).toBe('0.6.0')
    expect(reported, 'the superseded section is silently dropped from the release body')
      .toContain('0.5.0')
  })

  it('stops at the last version that shipped, rather than reporting everything ever', () => {
    // Self-correcting: in the normal case the previous release IS tagged, so the walk stops at
    // once and this returns a single version. Without that it would re-announce the whole history
    // on every release.
    const reported = versionsToReport('0.6.0')
    expect(reported, 'the walk ran past a version that was actually released').not.toContain('0.4.0')
  })
})
