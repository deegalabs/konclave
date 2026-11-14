import { describe, expect, it } from 'vitest'
import { releaseLink } from './docs/release-link'

// The release notes' links: a file of the repository opens on GitHub, Konclave's GitHub pages stay
// links, and anything else is shown as words with no link.
describe('releaseLink', () => {
  it("opens a path of the repository on GitHub, at that release's tag", () => {
    expect(releaseLink('helper-server/CHANGELOG.md', '0.19.0')).toBe('https://github.com/deegalabs/konclave/blob/v0.19.0/helper-server/CHANGELOG.md')
    expect(releaseLink('./docs/PROOF.md#gate-1', '0.6.0')).toBe('https://github.com/deegalabs/konclave/blob/v0.6.0/docs/PROOF.md#gate-1')
  })
  it("keeps Konclave's own GitHub pages, and only those", () => {
    const advisory = 'https://github.com/deegalabs/konclave/security/advisories/GHSA-42h7-6fcj-554w'
    expect(releaseLink(advisory, '0.19.0')).toBe(advisory)
    expect(releaseLink('https://github.com/deegalabs/konclave-other/x', '0.19.0')).toBeNull()
    expect(releaseLink('https://semver.org', '0.19.0')).toBeNull()
    expect(releaseLink('http://github.com/deegalabs/konclave', '0.19.0')).toBeNull()
  })
  it('turns nothing else into a link', () => {
    for (const h of ['javascript:alert(1)', 'mailto:a@b.c', '//evil.example/x', '/vaults', '#/proof', '../secrets.md', 'docs/../../x', '']) {
      expect(releaseLink(h, '0.19.0'), h).toBeNull()
    }
  })
})
