# Check that the web app is a published release

On the web, Konclave only lives at www.konclave.xyz. Check the address bar first; then you can check
that what that address serves is a release we published, file by file, without trusting the page
itself.

The footer's version and commit are what the page says about itself, and a modified page can say
the same. The check below is made outside the page.

## The check

With Node 22 or later and a copy of this repository (no `npm install` needed):

```sh
node scripts/verify-web.mjs
```

It reads the version the site claims (`/version.json`), downloads that release's
`web-manifest.json` from the GitHub release, fetches every file the manifest lists from the site,
and compares each SHA-256. It also checks that `/` is the release's `index.html` and that the
security headers the release configures (the Content-Security-Policy among them) are the ones sent
on `/`. It prints `PASS`, `FAIL` or `INCONCLUSIVE` per file and per header.

The first release that publishes a `web-manifest.json` is the one after 0.21.0. Until a release is
published (a draft is not downloadable), the check answers "inconclusive".

| Exit | Meaning |
|---|---|
| 0 | Every file and header matched the release. |
| 1 | Something did not match: a file (named), a header, the version, or the commit (`NOT A RELEASE`). |
| 2 | Could not decide: the network failed, a server error, or the release has no published manifest yet. |
| 3 | Wrong arguments, or a malformed manifest. |

Options: `--expect-version=0.22.0` refuses any other version, so a host cannot pass by serving an
older release; `--site=<https origin>` checks another address; `--manifest=<file or https URL>` uses
a manifest you already have.

`NOT A RELEASE` means the site serves a build of another commit than the release it names. `main`,
which the host deploys, moves only by a release merge or a tagged hotfix
([RELEASING.md](RELEASING.md)), so this is either a deploy outside that rule or a build that is not
ours.

**On a FAIL:** do not unlock a vault with the app at that address, tell the other members of your
vault, and report it ([SECURITY.md](../SECURITY.md)).

## What a PASS proves, and what it does not

- It proves that this fetch, from your network, at that moment, received exactly the files of the
  release the manifest describes.
- It trusts that manifest. By default it is the one attached to the GitHub release; the next
  section shows how to check it.
- Without `--expect-version`, an older published release passes too.
- It does not prove what another member received: a server can answer differently to different
  people, or change after you checked.
- It checks the site, not the copy your browser or installed app is already running.
- It cannot see a file nothing references, which no manifest can list.
- It does not stop a compromised host from serving a modified app. It is a way to notice one.
- It does not check the desktop app, which bundles its own copy (#606).
- The installed app (PWA) does not yet refuse an update that is not a release (#605).

## Checking the manifest itself

The release workflow attaches the manifest and signs a build attestation for it:

```sh
gh release download v<version> -p web-manifest.json -R deegalabs/konclave
gh attestation verify web-manifest.json -R deegalabs/konclave
```

That shows GitHub's record of which workflow and commit produced it. To check without trusting
GitHub or us, rebuild it. The variables must be set for BOTH commands, because the writer records
the `VITE_*` variables of its own environment; use exactly the ones the manifest lists under
`build.env`, no others, and leave `KONCLAVE_DESKTOP_BUILD` unset (it builds the desktop variant):

```sh
git checkout <commit the manifest names>
export VITE_HELPER_BASE=https://helper.konclave.xyz VITE_RELAY_BASE=https://relay.konclave.xyz
pnpm install --frozen-lockfile
pnpm -C ui run build
node scripts/web-manifest-cli.mjs write ui/dist <commit> mine.json
cmp mine.json web-manifest.json
```

The two files should be identical. The toolchain is part of the input: the commit pins the lockfile
and the pnpm version (`packageManager` in `package.json`); the release workflow builds with Node 24.
