# Changelog

Written for the person who has to live with it: a treasurer holding real ZEC, not a reader of commit
messages. If an entry does not answer "what is different for me now", it does not belong here.

Format: [Keep a Changelog](https://keepachangelog.com/). Versions: [SemVer](https://semver.org/).
Dates are UTC.

## The categories decide what gets announced

This is the reason the file is categorised rather than written as prose. Without the categories,
nobody can tell a closed security hole from a polished button, and both end up in the same post or
neither does.

| Category | What goes in it | Announced |
|---|---|---|
| `Security` | A hole that was open, closed. Always says what was exposed and for how long. | Always. Forum post, and a MINOR release at minimum. |
| `Added` | Something a member can now do that they could not before. | Yes, in the release post. |
| `Changed` | Same capability, different behaviour a member will notice. | Only if it changes a habit. |
| `Fixed` | It was broken, now it is not. | Only if a member hit it, or could have. |
| `Known limits` | What is still not done. Survives the release, never a draft note. | Always. |

Anything a member cannot notice (refactor, test, CI, dependency bump) does not go in at all. CI
enforces the reverse: a PR touching source a member meets must update this file or carry the
`no-changelog` label.

At release time `node scripts/release.mjs <version>` renames `Unreleased` to the version, and
`--notes` prints that section as the desktop release body, so the tag, the installer and the in-app
version badge agree.

### Versioning while pre-1.0

`0.MINOR.PATCH`. Anything under `Security` or `Added` takes a MINOR. A release with only `Fixed`
takes a PATCH. There is no 1.0 while items remain under `Known limits` that have not been closed or
explicitly accepted.

---

## [Unreleased]

### Fixed

- **A vault that already existed kept its blank address, even after 0.4.0 fixed the cause.** That
  release made the create screen record the vault's address; it did nothing for the vaults already
  on a device, because `saveVault` runs only at creation and nothing ever revisits a record. So
  every vault made before it went on reporting the address missing however many times its member
  re-exported. It is backfilled now from the helper, which is the only other place it exists, the
  first time any screen loads the vault. (#501)

- **The relay room a pinned ceremony lands in had no test.** Change that derivation's input by one
  byte and every device computes a different room, so the members simply never meet. It is covered
  by golden vectors now, taken from the code before the escaping change that prompted them, so they
  pin the behaviour across it.

- **The backup checker did not mention the one thing that lets a restore READ the vault.** It
  reported the share, the address, the viewing key and the scan floor, and said nothing about the
  per-vault read secret - so a backup that restores a device able to sign but not to see anything
  passed as complete. It is reported now, along with the quorum and the seat, and two consistency
  checks that catch a file whose share disagrees with its own metadata rather than one that is
  merely missing a field. (#484)

## [0.4.0] 2026-09-07

### Security

- **The hosted helper read request bodies with no ceiling.** One POST could make it buffer without
  limit, on the service every vault's balance, proposal and send goes through, and which already had
  an outage from a related cause on 2026-08-27. Open since the helper existed; filed as #269 on
  2026-08-23. The relay has capped since #390.
  **The 0.3.0 notes said both servers had a bounded body read. That was true of the relay only.**
  The ceiling now lives in one crate, `konclave-http`, that both servers read, and a test refuses a
  body read that has none. The worker pool deliberately stays per-server: the two sizings look like
  one duplicated rule and are not, and sharing them would have shrunk the helper's pool. (#269)

- **The backup handed to you when a vault is created did not carry the viewing key.** It is the copy
  most members keep, and it restored the seat and not the vault: real spend authority over money the
  rebuilt device could not detect. `exportVault` has taken the viewing key and the scan floor since
  #447 and #480, and the create screen was the one caller passing neither, so
  **the 0.3.0 notes saying the export carried both were true of the Settings export alone.**
  It now fetches them the same way Settings does, and when it cannot - registration and the read key
  land asynchronously, so this copy can be written before there is a key to fetch - the screen
  **says the backup is incomplete** and sends you to Settings, instead of handing over a file that
  looks whole. A test refuses any `exportVault` call that omits them. (#447, #480)

- **A vault created on the web recorded a blank address, permanently.** `saveVault` was called with
  `address: ''`, literally, for both create and join, and nothing ever filled it in, so every backup
  reported the address missing. The device cannot re-derive it - `zcash-sign` mints it from a random
  `sk` it discards - so the record had no second source but the helper, which had already handed the
  address back at registration and was being ignored.

### Fixed

- **The recovery script printed a Node stack trace instead of an answer.** A missing file, a
  directory, an unreadable file or a truncated download all reached the reader as
  `Error: ENOENT ... at readFileSync`. That tool runs when the laptop is dead or the browser will
  not start, so a stack trace at that moment says the last resort is broken too. Every failure is a
  sentence now, and the exit code separates "could not start" (2) from "did not open" (1).

- **The recovery script could not open a v1 backup at all.** v1 keeps `salt`/`iv`/`cipher` under
  `vault` and encrypts only the share, so the script threw on hex it never found, before reaching
  the notice that would have explained the format. It reads both now, and tells a v1 holder the part
  that matters: their metadata was never encrypted, and anyone with the file can read the vault
  name, the members and the address without the passphrase. Legacy vaults still exist, so this was
  refusing exactly the backups most likely to be old. (#484)

## [0.3.0] 2026-09-07

### Security

- **The viewing key was served in plaintext to the browser.** It decrypts every payslip a vault has
  ever sent. TLS covered the wire, but any browser extension with host permissions, and any
  TLS-terminating proxy, could read it at the endpoint. The helper now seals that response to the
  vault's registered devices and refuses to serve it unsealed. The plaintext path stays open only
  for vaults with no registered device, so nobody is locked out of a key they already hold.
  (#476, #481)
- **Governance writes were unauthenticated.** A vote or a rename from anyone who could reach the
  helper was accepted. A write is now signed by an Ed25519 key derived from the seat's FROST share,
  and refused otherwise. Per vault, turning on at the first device that unlocks, so existing vaults
  keep working. (#288, #448, #450, #452, #453, #454, #455)
- **PBKDF2 ran at 210,000 iterations with SHA-256**, the count OWASP gives for SHA-512. Raised to
  600,000. Vaults and backups already sealed keep opening at their own count, which travels with the
  ciphertext; changing your passphrase re-seals at the new one. (#479)
- **A share export restored the seat but not the vault.** It omitted the viewing key, so a member
  rebuilding from their own backup held spend authority over money they could not detect. It now
  carries the viewing key and the wallet birthday, without which a rebuilt wallet scans from the
  current height and finds nothing. (#447, #480)
- **The passphrase could not be rotated.** The one credential with no way to change it, and the one
  whose compromise costs most. Local and per device. (#470, #471)

### Added

- **Open an export without Konclave.** `scripts/open-export.mjs` uses Node's own crypto, no packages
  and no network, and reports whether a backup is complete instead of printing its contents. The
  same procedure is in the app under Documentation > Recovery. (#484, #485)
- **A passkey can open the books.** Face ID, Windows Hello or Touch ID in place of the passphrase
  for reading a vault, enrolled per device from Settings. Sending money still requires the
  passphrase. The feature had shipped unreachable: nothing enrolled a passkey, so the unlock button
  could never render. (#468)
- **Unlock happens where you are.** A reload used to send you back to the vault list to pick the
  vault you were already inside. (#467)

### Changed

- Settings rebuilt: named sections, dialogs instead of forms that expand inline, long explanations
  behind a `?`. Theme and language moved to the app shell. (#473, #475, #487)
- The documentation menu on a phone is one scrolling row instead of five wrapped ones, about 60px
  instead of 500. (#488)

### Fixed

- **The helper served no private reads for part of 2026-09-06.** The CORS preflight did not name
  `X-Konclave-Read`, so browsers refused to send it and every balance, proposal and member list
  failed. The fix had reached the deployed binary in #403 and never the source, so rebuilding from
  `main` reintroduced it. (#466)
- Text and control edges did not meet WCAG AA in either theme. Muted text ran 4.07:1 to 4.43:1,
  passphrase placeholders 3.36:1, and no control had a perceptible edge at 1.31:1. The ratios are
  computed by a test from the tokens now. (#494)
- The wallet birthday and the change receiver are recorded at boot, and those migrations run before
  the registry is read, so the process serves the corrected values instead of healing on the next
  restart. (#445, #478, #482)
- The WASM module is loaded in one place. Five screens had their own initialiser, and the export was
  the sixth path that needed one and had none. (#483)
- Liveness is polled once by the shell instead of twice, and pauses with the tab. Six requests in 26
  seconds became three. (#477)

### Known limits

- The member list and the remaining private reads still reach the browser in plaintext. Sealing
  covers the viewing key only. ([#476](https://github.com/deegalabs/konclave/issues/476))
- `/api/vault` sits outside the read gate: a leaked vault id reveals the vault's address and quorum.
  The books stay closed ([#388](https://github.com/deegalabs/konclave/issues/388)).
- **A vault created before #388 cannot fetch its own viewing key**, so the export fix above does
  not reach it: the helper refuses that read outright for a vault with no read key, and the export
  falls back to whatever the device already had, which is nothing. Those exports still restore the
  seat and not the vault. It lands per vault, when the vault is protected
  ([#406](https://github.com/deegalabs/konclave/issues/406)).
- **Passkey enrolment says nothing when the authenticator has no PRF.** Every failure in that path
  is silent on purpose, because a shortcut that fails must cost nothing, and the price of that is a
  member whose authenticator lacks the extension watching the option quietly not work. Measured
  working on Windows 11 25H2 (build 26200.8457) and on Android through the installed PWA. Windows
  Hello did not support the extension as of Microsoft's own answer in April 2024; the build where
  that changed is NOT established (a vendor blog names the February 2026 cumulative update, whose
  own release notes mention neither WebAuthn nor Windows Hello), so no version boundary is claimed.
- The desktop build has never been validated on real per-platform hardware.
- The `/net` ceremony driver never received the replay mitigation
  ([#363](https://github.com/deegalabs/konclave/issues/363)).

---

## [0.2.0] 2026-08-02

### Added

- The desktop line: a Tauri shell over the orchestrator, with Windows, macOS and Linux installers.
  The web app stays the primary delivery (ADR-0005); desktop is the optional native shell.

### Known limits

- No live per-platform hardware validation.

## [0.1.0] 2026-08-02

### Added

- Browser-native FROST treasury on Zcash mainnet. Real DKG across devices over a blind relay,
  signing in WASM on the device, and a hosted helper that builds and broadcasts without ever seeing
  a share. Verifiable txids in [docs/PROOF.md](docs/PROOF.md).
