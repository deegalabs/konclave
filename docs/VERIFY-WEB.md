# Check that the web app is a published release

Konclave only lives at www.konclave.xyz. Check the address bar first; then you can check that what
that address serves is a release we published, file by file, without trusting the page itself.

The footer's version and commit are what the page says about itself, and a modified page can say
the same. The check below is made outside the page.

## The check

With Node 20 or later and a copy of this repository (no `npm install` needed):

```sh
node scripts/verify-web.mjs
```

It reads the version the site claims (`/version.json`), downloads that release's
`web-manifest.json` from the GitHub release, fetches every file the manifest lists from the site,
and compares each SHA-256. It also checks that `/` is the release's `index.html` and that the
security headers the release configures (the Content-Security-Policy among them) are the ones sent.
It prints `PASS` or `FAIL` per file.

| Exit | Meaning |
|---|---|
| 0 | Every file and header matched the release. |
| 1 | Something did not match: a file (named), a header, the version, or the commit (`NOT A RELEASE`). |
| 2 | Could not decide: the network failed, or the release has no manifest yet (a draft is not downloadable). |
| 3 | Wrong arguments, or a malformed manifest. |

Options: `--expect-version=0.22.0` refuses an older release; `--site=<https origin>` checks another
address; `--manifest=<file or https URL>` uses a manifest you already have.

`NOT A RELEASE` means the site serves a build of another commit than the release it names. The
project's rule is that `main`, which the host deploys, moves only by a release merge or a tagged
hotfix, so this is either a deploy outside that rule or a build that is not ours. Report it either way.

## What a PASS proves, and what it does not

- It proves that this fetch, from your network, at that moment, received exactly the release's files.
- It does not prove what another member received: a server can answer differently to different
  people, or change after you checked.
- It cannot see a file nothing references, which no manifest can list.
- It does not stop a compromised host from serving a modified app. It is a way to notice one.
- It does not check the desktop app, which bundles its own copy (#606).
- The installed app (PWA) does not yet refuse an update that is not a release (#605).

## Checking the manifest itself

The manifest is attached to the release by the release workflow, which also signs a build
attestation for it:

```sh
gh attestation verify web-manifest.json -R deegalabs/konclave
```

That shows GitHub's record of which workflow and commit produced it. To check without trusting
GitHub or us, rebuild: check out the commit the manifest names, build with the variables it records
under `build.env` and no other `VITE_` variable (Node 24, `pnpm install --frozen-lockfile`, then `pnpm -C ui run build`), and run
`node scripts/web-manifest-cli.mjs write ui/dist <commit> mine.json`. Your `mine.json` should be
byte-identical to the published one. The toolchain is part of the input: the commit pins the
lockfile, the Node major version is the release workflow's.
