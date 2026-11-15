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
3. The release goes to `staging` as a pull request, then `staging` into `main` with a merge commit,
   and that merge commit is tagged:
   ```
   git tag v<version> <merge commit> && git push origin v<version>
   ```

`main` moves only by a release merge or a tagged hotfix (`vX.Y.Z+1`); docs-only changes go to
`staging` (decided 2026-11-15). The host deploys `main`, so this is what makes the live web app
always a published release, and what lets `scripts/verify-web.mjs` call any other commit
`NOT A RELEASE`.

Pushing the tag triggers
[`desktop-release.yml`](../.github/workflows/desktop-release.yml): it builds the
Windows, macOS, and Linux installers on GitHub's own runners and opens a **draft**
release whose notes are the CHANGELOG section for that tag, followed by the list of commits since
the previous release grouped by type (via `scripts/release.mjs --notes`, git-cliff and `cliff.toml`). Review the draft, then publish it. Vercel deploys
the web from the same commit, so the version badge matches the release.

The same workflow rebuilds the web app at the tag, attaches `web-manifest.json` (the SHA-256 of
every file of that build, with a build attestation) and its line to the notes, and then checks that
production serves exactly those files. Until the draft is published the manifest is not
downloadable, so `scripts/verify-web.mjs` answers "inconclusive": publish the draft promptly. How
anyone checks the site: [VERIFY-WEB.md](VERIFY-WEB.md).

You can also build installers for an existing tag from the Actions tab
("Desktop release" -> Run workflow -> enter the tag).
