# Releasing

One version drives every surface, so the in-app badge, the desktop installer,
and the git tag never disagree:

- `ui/package.json` version, shown in the in-app version badge (with the commit).
- `src-tauri/tauri.conf.json` version, stamped on the desktop installers.
- the git tag `v<version>`.

## Cut a release

1. Move the **Unreleased** entries in [`CHANGELOG.md`](../CHANGELOG.md) into a
   new dated section, `## [<version>] - YYYY-MM-DD`, and add the compare link at
   the bottom.
2. Bump both version files and confirm the CHANGELOG section exists:
   ```
   node scripts/release.mjs <version>
   ```
3. Commit and tag:
   ```
   git commit -am "release: v<version>"
   git tag v<version> && git push origin main --tags
   ```

Pushing the tag triggers
[`desktop-release.yml`](../.github/workflows/desktop-release.yml): it builds the
Windows, macOS, and Linux installers on GitHub's own runners and opens a **draft**
release whose notes are the CHANGELOG section for that tag (via
`scripts/release.mjs --notes`). Review the draft, then publish it. Vercel deploys
the web from the same commit, so the version badge matches the release.

You can also build installers for an existing tag from the Actions tab
("Desktop release" -> Run workflow -> enter the tag).
