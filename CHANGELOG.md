# Changelog

All notable changes to Konclave are recorded here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the project aims
for [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

A single version drives every surface: `ui/package.json` (shown in the in-app
version badge), `src-tauri/tauri.conf.json` (the desktop installer), and the git
tag. Bump them together with `node scripts/release.mjs <version>`, move the
entries below from **Unreleased** into a dated section, then tag `v<version>`.
Pushing the tag builds the desktop installers and uses that section as the
release notes (see `.github/workflows/desktop-release.yml`).

## [Unreleased]

### Added
- Backup card on the create-done step: download or copy the encrypted portable
  copy of the just-created vault before opening it, reusing the passphrase you
  just set (no second prompt).
- PWA version-update prompt: a "new version available" banner (checked every
  60s) lets a member finish mid-ceremony, then tap to update. Version badge
  (version and commit) in the Settings footer.
- Passphrase strength meter and one-tap strong-passphrase generator on every
  passphrase field.
- Vault export/import: an encrypted, portable copy of a vault that unlocks with
  its passphrase on any device.
- Onboarding redesign: three equal doors (Create, Join, Import), a stepped
  mobile-first create flow, and validate-then-unlock import.
- Recipient combobox that recognizes a known address and offers to save it.
- Vault fingerprint shown at the ceremony and on create-done.
- Live exchange rate and full-page loaders on Pay and Payroll; two-column
  Payroll redesign mirroring Pay.
- Blind relay: per-IP rate limiting. Hosted helper: capacity guard with a clear
  over-capacity message.

### Changed
- Default quorum is now 2-of-3, with a non-blocking warning badge when the
  signing quorum equals the device count (no recovery margin). See
  [ADR-0010](docs/adr/0010-quorum-redundancy-default.md).
- The in-vault embedded create modal (from the Vaults screen) is the create
  flow; the standalone `/net` route is legacy/diagnostics.
- The vault switcher opens to the right of the rail, over the page, and closes
  on outside click.
- Passphrase field icons are clean inline SVGs; the generate button no longer
  collides with the input edge.
- Removed em-dashes from user-facing copy.

### Fixed
- Create modal no longer auto-restores a selected vault when logged in (which
  had forced a cache clear).
- Vault roster stores member names, not throwaway relay tags.
- Self-rename heals member identity and migrates votes.

## [0.2.0] - 2026-08-02

### Added
- Desktop application (Tauri): Windows, macOS, and Linux installers, built and
  attached to a GitHub release from a version tag. The device key share lives in
  the OS secure store. Live per-platform hardware validation is still ongoing.

## [0.1.0] - 2026-08-02

### Added
- First tagged release: the browser-native collective vault (real DKG across
  devices over a blind relay, FROST signing) and the local-first bridge, proven
  on Zcash mainnet.

[Unreleased]: https://github.com/deegalabs/konclave/compare/v0.2.0...HEAD
[0.2.0]: https://github.com/deegalabs/konclave/compare/v0.1.0...v0.2.0
[0.1.0]: https://github.com/deegalabs/konclave/releases/tag/v0.1.0
