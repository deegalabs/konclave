- **Anyone can check that the web app is a published release.** From this release on, each release
  publishes `web-manifest.json`: the SHA-256 of every file of the web app it builds, with a build
  attestation, and its fingerprint in the release notes. `node scripts/verify-web.mjs` fetches every
  one of those files from www.konclave.xyz and compares it, file by file, with the manifest of the
  version the site claims; it also checks the security headers, and calls a site serving another
  commit "NOT A RELEASE". How to run it and what it does not prove: `docs/VERIFY-WEB.md`. It
  detects a modified app for whoever runs it, at that moment; it does not stop a compromised host,
  does not prove what another member received, and the installed app does not yet refuse an update
  that is not a release (#605).
