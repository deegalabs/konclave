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
  // The tags are PASSED IN. These tests used to read them from the machine running them, which is
  // how they came to pass on a developer's laptop and fail in CI, where the checkout has no tags
  // at all (#573). What was released is a fact about the repository's history, so the tests state
  // it, exactly as it stood on the day: every version tagged except 0.5.0.
  const RELEASED = new Set(['0.6.0', '0.4.0', '0.3.0', '0.2.0', '0.1.0'])

  it('includes a section that was cut but never tagged', () => {
    // Real numbers from the day it happened: 0.5.0 exists in the changelog, has no tag.
    const reported = versionsToReport('0.6.0', RELEASED)
    expect(reported[0]).toBe('0.6.0')
    expect(reported, 'the superseded section is silently dropped from the release body')
      .toContain('0.5.0')
  })

  it('stops at the last version that shipped, rather than reporting everything ever', () => {
    // Self-correcting: in the normal case the previous release IS tagged, so the walk stops at
    // once and this returns a single version. Without that it would re-announce the whole history
    // on every release.
    const reported = versionsToReport('0.6.0', RELEASED)
    expect(reported, 'the walk ran past a version that was actually released').not.toContain('0.4.0')
    expect(reported).toEqual(['0.6.0', '0.5.0'])
  })

  // "Cannot tell" is wider than "git is missing". A shallow checkout has git and no tags, and the
  // release workflow's has at most the tag being released. Neither says anything about what
  // shipped before, and with nothing to stop at the walk reported every section in the file.
  it('reports the version alone when the checkout has no tags at all', () => {
    expect(versionsToReport('0.6.0', new Set())).toEqual(['0.6.0'])
  })

  it('reports the version alone when the only tag is the one being released', () => {
    expect(versionsToReport('0.6.0', new Set(['0.6.0']))).toEqual(['0.6.0'])
  })

  it('reports the version alone when there is no git to ask', () => {
    expect(versionsToReport('0.6.0', null)).toEqual(['0.6.0'])
  })

  // "Another tag exists" is not "an earlier release is known". Each of these is another tag, and
  // with the first version of this fix each one sent the walk through the whole file.
  it('does not take a release candidate, or a tag that is no version, for an earlier release', () => {
    expect(versionsToReport('0.6.0', new Set(['0.6.0', '0.7.0-rc.1']))).toEqual(['0.6.0'])
    expect(versionsToReport('0.6.0', new Set(['vault-demo']))).toEqual(['0.6.0'])
  })

  it('reports an old version alone when only newer ones are tagged', () => {
    // Rebuilding an old tag by hand, in a checkout that knows a later release and nothing earlier.
    expect(versionsToReport('0.4.0', new Set(['0.6.0']))).toEqual(['0.4.0'])
  })
})
