# Changelog

What changed, written for the person who has to live with it — a treasurer holding real ZEC, not a
reader of commit messages. If an entry does not answer *"what is different for me now"*, it does not
belong here.

**Three rules this file keeps**, which are the same three the product keeps ([CLAUDE.md §6](CLAUDE.md)):

- **A fix that closes a hole says what the hole was.** "Improved security" tells a member nothing
  about whether they were exposed, for how long, or whether they need to act.
- **What is NOT done stays visible.** A roadmap is a roadmap. If something works in one place and
  not another, the entry says which.
- **Nothing here is a promise.** Where a claim is proven on mainnet, the txid is the proof and it is
  linked.

Grouped by what a member notices, not by pull request. The PR numbers are there so anyone can go and
check, which is the point of citing them.

**How it is kept.** Every PR that touches source a member meets updates the `Unreleased` section, and
CI refuses the PR otherwise - a `no-changelog` label is the deliberate way out, for changes a member
genuinely cannot see. At release time `node scripts/release.mjs <version>` renames the section and
`--notes` prints it as the desktop release body, so the tag, the installer and the in-app version
badge all say the same thing.

Dates are UTC. Format follows [Keep a Changelog](https://keepachangelog.com/); versions follow
[SemVer](https://semver.org/).

---

## [Unreleased]

### Your backup is now the whole vault

An export used to restore your **seat** and not the vault. It carried your share, but not the
viewing key — which is minted once at random and lived only on the helper — so a rebuilt wallet held
real spend authority over money it could not see. It now carries the viewing key (#447) and the
block height to scan from (#480); without that height a rebuilt wallet starts looking from today and
never finds the notes the vault already holds, and there is no rescan.

`scripts/open-export.mjs` opens a backup with **no Konclave at all** — Node's own crypto, no
packages, no network — and reports whether the file is complete rather than dumping it (#484). The
same story is in the app under **Documentation → Recovery**, written to be saved *with* the file,
because the day you need it is the day the app is gone (#485).

### You can change your passphrase

The one credential in the product with no way to rotate, and the one whose compromise costs most
(#470, #471). Local and per device: your other machines keep the passphrase they have. There is
still no recovering a forgotten one — the encrypted export remains the only spare key.

### Reading a vault stops costing what spending does

A reload used to send you back to the vault list to pick the vault you were already inside. The
passphrase is now asked **on the screen you were on** (#467). A passkey — Face ID, Windows Hello,
Touch ID — can stand in for it when opening the books, per device, and **sending money still asks
for the passphrase** (#468). That shortcut had shipped unreachable: nothing in the product ever
enrolled one.

### The viewing key no longer travels in the clear

TLS always covered the wire, but the browser's own extensions and any TLS-terminating proxy could
read the key that decrypts every payslip the vault ever sent. Once a vault has a registered device,
the helper seals that response to those devices and **the plaintext path closes** (#476, #481).
Vaults whose members are all on older builds keep working until one of them migrates.

### Governance writes are authenticated

A vote or a rename from someone who does not hold the seat's share is refused, from the first device
on that vault that unlocks (#448, #450, #452, #453, #454, #455). The gate is per vault and turns on
at that moment, so existing vaults keep working.

### Settings was rebuilt

Named sections, the two forms that used to expand inline are dialogs, and the long explanations moved
behind a `?` (#473, #487). Theme and language moved into the app shell, where per-device preferences
belong (#475). The delete confirmation stopped printing the vault name in its own placeholder — the
gate that exists to force an act of recall was showing the answer.

### Also

- The documentation's section menu on a phone took about 500px — five wrapped rows — before the page
  itself began. It is one row that scrolls, and it opens showing the section you are reading (#488).
- One language toggle instead of two (#489). The version in the docs header was the older one, with
  22px targets and the accent colour used as a selected state.

### Fixed

- **The helper served no private reads for part of 2026-09-06** (#466). The CORS preflight never
  named `X-Konclave-Read`, so browsers refused to send it and every balance, proposal and member
  list failed. The fix had reached the deployed binary in #403 and never the source, so rebuilding
  from `main` reintroduced it.
- **PBKDF2 raised to 600,000 iterations** (#479) — the number OWASP gives for SHA-256, where 210,000
  is the SHA-512 one. Existing vaults and backups keep opening at whatever they were sealed with;
  changing your passphrase re-seals at the new count.
- **The helper asked liveness twice** (#477), and the shell's poll never paused with the tab. Six
  requests in 26 seconds became three.
- The wallet birthday and the change receiver are recorded at **boot** (#445, #478), because the
  registration path that recorded them runs rarely; and those migrations now run **before** the
  registry is read (#482), so the process serves the corrected values instead of healing on the
  next restart.
- The WASM module is loaded in one place (#483). Five screens had their own initialiser, and the
  export was the sixth path that needed one and had none.

### Known limits

- `/api/vault` is outside the read gate: a leaked vault id still reveals the vault's address and
  quorum. The books stay closed (#388).
- Sealing covers the viewing key. The member list and the remaining private reads are still served
  in the clear to the browser — [#476](https://github.com/deegalabs/konclave/issues/476).
- Every contrast failure the accessibility audit found is in the **light** theme, which is the
  default. Four token values clear them; not yet applied.
- Passkey enrolment fails on Windows Hello before 25H2, which does not support the PRF extension.
  The message does not yet say so.

---

## [0.2.0] — 2026-08-02

The desktop line: a Tauri shell over the orchestrator, with Windows, macOS and Linux installers. The
web app stays the primary delivery ([ADR-0005](docs/adr/)); desktop is the optional native shell.

**Not done:** live per-platform hardware validation.

## [0.1.0] — 2026-08-02

Browser-native FROST treasury on Zcash mainnet. Real DKG across devices over a blind relay, signing
in WASM on the device, and a hosted helper that builds and broadcasts without ever seeing a share.

Proven on mainnet, with verifiable txids in [docs/PROOF.md](docs/PROOF.md).
