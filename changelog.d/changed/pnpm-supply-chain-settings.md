- **The dependency supply-chain settings are now in force; until now they did nothing.**
  `pnpm-workspace.yaml` has carried `minimumReleaseAge` (refuse a package published less than 24
  hours ago), `trustPolicy: no-downgrade` (refuse a version with weaker trust evidence than an
  earlier one) and `blockExoticSubdeps` (refuse git and tarball sources below a direct dependency).
  pnpm reads them from 10.16, 10.21 and 10.26, and the workspace pinned pnpm 9.15.0, which ignores
  them without a warning. That was the hole: every dependency added or updated while they sat there
  got none of those checks. The workspace now pins pnpm 10.34.9, CI installs that version, and
  `engines` asks for pnpm 10.26 or later, so an older pnpm stops instead of skipping the checks.
  Measured on a copy of the repository: pnpm 9.15.0 accepted a TypeScript build published six hours
  earlier, and 10.34.9 refuses it. Two locked packages fail the trust check and are excluded by exact
  version, each with its reason in the file: `semver@6.3.1` (a backport, a false positive of the
  publish-date ordering) and `@trickfilm400/rollup-plugin-off-main-thread@3.0.0-pre1` (a fork that
  `workbox-build` requires, published without the provenance its previous release had).
  For contributors: Corepack switches to the pinned pnpm by itself; a pnpm older than 10.26 installed
  globally now stops with an engine error, and `pnpm add` or `pnpm update` can now be refused.
