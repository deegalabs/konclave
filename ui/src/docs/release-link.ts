const REPO = 'https://github.com/deegalabs/konclave'

/**
 * Where a link in the release notes goes, or null for words with no link.
 *
 * The changelogs cite files by their path in the repository (`helper-server/CHANGELOG.md`), which
 * GitHub resolves and this site would open as a route that does not exist. So a path opens the file
 * on GitHub as it was at that release's tag (`v<version>`), which is what the notes describe; `main`
 * may have moved or renamed it since. Konclave's own GitHub pages stay links. Any other host, or a path that climbs
 * out of the repository, is shown as its words only: the notes are read on our site, and a link
 * nobody here checked is not one it should hand on.
 */
export function releaseLink(href: string, version: string): string | null {
  if (href === REPO || href.startsWith(`${REPO}/`)) return href
  if (/^[a-z][a-z0-9+.-]*:/i.test(href) || /^[/#?\\]/.test(href)) return null
  const path = href.replace(/^(\.\/)+/, '')
  if (!path || path.split(/[/#?]/).includes('..')) return null
  return `${REPO}/blob/v${version}/${path}`
}
