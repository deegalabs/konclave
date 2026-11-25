# Security Policy

Konclave is a self-custody tool for collective Zcash vaults using FROST threshold
signatures. Key shares stay sealed on a member's device and leave it only inside the
encrypted backup the member exports. The relay carries sealed or public
ceremony material: it never sees a share, and once every member's device has registered its
public device key it does not see who a payment pays, but it does see member names and the quorum while a
vault is being created; the hosted coordinator never receives a share and cannot move funds
on its own, but it holds each vault's viewing key and sees its payments, and it builds the
transactions the quorum signs (see Known limitations).
Because it can move real funds, we take security seriously and audit before publishing and
whenever authentication, key custody, or fund-movement paths change.

## Reporting a vulnerability

**Do not open a public issue for security problems.** Report privately via
[GitHub Security Advisories](https://github.com/deegalabs/konclave/security/advisories/new),
or by email to [security@deegalabs.com](mailto:security@deegalabs.com). To encrypt an email,
use our PGP key at
[www.deegalabs.com/.well-known/pgp-key.txt](https://www.deegalabs.com/.well-known/pgp-key.txt),
fingerprint `E266 E6A9 3F09 1314 EDFC AD07 B51B FE1A C8C2 B361` (DeegaLabs Security
<security@deegalabs.com>, expires 2028-11-13); check the fingerprint before you use it. The same
two channels, and the key, are listed in
[www.deegalabs.com/.well-known/security.txt](https://www.deegalabs.com/.well-known/security.txt).

Please include: affected component (FROST signer, PCZT bridge, the local HTTP bridge,
key sealing, etc.), reproduction steps, and impact. We aim to acknowledge within a few
days. Never include real key shares, seeds, passphrases, or a funded vault's secrets in
a report.

## Scope

In scope: the orchestrator (`orchestrator/`), the FROST↔PCZT bridge (`konclave-signer/`),
the loopback HTTP bridge, key sealing/derivation, the frontend (`ui/`), the hosted
coordinator (`helper-server/`), the relay (`relay-server/`), the browser signer
(`konclave-wasm/`), the shared crates `konclave-seal/` and `konclave-http/`, the SDK
(`sdk/`), and the MCP server (`mcp-server/`).

Out of scope: the upstream Zcash Foundation tools (`frostd`, `frost-client`, `zcash-sign`,
`zcash-devtool`) and `librustzcash`. Report those to their maintainers.

## Our practices

- In the local build, key shares are sealed at rest (XChaCha20-Poly1305); for DKG vaults the
  sealing key is derived from a passphrase via Argon2id and never stored. In the browser and
  in the desktop app (the same interface code, bundled into a native window), shares are
  stored in IndexedDB under AES-256-GCM with a key derived by PBKDF2-HMAC-SHA256 from the
  member's passphrase: 600,000 iterations for anything sealed since 2026-09-06 (#479); records
  stored before that keep 210,000 until the passphrase is next typed on that device (a passkey unlock does not re-seal, and a record with a sealed field that no longer opens stays at its count), and an export made before
  that keeps 210,000 for good.
- On a protected vault, the saved people and the addresses recently paid from it are sealed in the
  browser under a key derived from the vault's secret, and open only once the vault is unlocked on
  the device; an unfinished payroll is not written to the browser's storage and is kept in memory
  only while the vault stays unlocked (since 0.23.0).
- A send's proven and signed transaction files are kept in private temporary storage (readable only
  by the account that runs the send on Linux and macOS) and removed when the step ends, on the
  hosted coordinator, the local bridge and the command line, and the coordinator's
  recovery backup leaves out each vault's send working directory (since 0.23.0).
- `frostd` (local build) and the relay see only public or sealed protocol material, plus, on the
  relay, the member names and the quorum exchanged while a vault is created and, until every
  member's device has registered its public device key, the signing request in the clear (see Privacy below). The hosted
  coordinator never holds a share; it holds each vault's viewing key and builds its
  transactions (see Known limitations).
- Shielded-first: receiving is shielded-only (the Ironwood pool since NU6.3); transparent
  destinations are an explicit, warned exception.
- The local bridge binds `127.0.0.1` only; no telemetry; secrets never in logs/URLs.
- We run a security audit before publishing, before broadcasts of real funds, and when
  auth / key custody / fund-movement code changes. Findings are tracked internally.

## Known limitations

This is early-stage software, not independently audited, under active hardening. Do not custody significant
funds with it yet. The Zcash Foundation's partial audit of FROST excludes rerandomized FROST,
the variant Zcash uses.

The weakest points today are the services we host for every vault: the web host that serves the
app, and the hosted coordinator, which builds every transaction, holds each vault's viewing key,
and while it is down no payment can be made. A fix on the device side reaches a device only when it runs the fixed version: when the app says "New version available", press Update. Desktop pre-releases do not update themselves (#606).

What is fixed and what is open, by kind of attack:

- **Changing the app itself.** Open: every member using the web app loads it from our web host, so a
  compromised host could serve all of them a modified app at once, and the threshold would not
  stop that. From the first release that publishes a `web-manifest.json` (the release after
  0.21.0), anyone can check from outside the app that the web app the site serves is that
  release, file by file (`node scripts/verify-web.mjs`, [docs/VERIFY-WEB.md](docs/VERIFY-WEB.md)).
  That is detection, for whoever runs it, at that moment: it does not stop a compromised host, does
  not prove what another member received, and an installed app (PWA) does not yet refuse an update
  that is not a release (#605). The desktop
  installers are not code-signed (#606).
- **Changing what a payment pays.** Fixed: a device signs only the message it derives from its
  own copy of the transaction, in both signing rounds, so another member cannot swap the
  transaction under it (#62; round 2: #355, #579). That guards against a member, not against
  the coordinator, which builds the transaction to begin with. A signing device reads the payment from the
  transaction, checks it against the approved payment, memos included, and refuses a fee that is not exactly ZIP 317's fee for its actions at a rate the device accepts
  (5,000 per action, and from block 3,590,000 also ZIP 2009's 1,000, so after that height a coordinator can still charge the older, higher rate) (#610, live on the web since 2026-10-04 and in the desktop installers since v0.10.0); the legacy `/net` page no longer signs payments at all (its signer refuses every request), and the fee limit
  grows with the spends and outputs the coordinator chooses. Open: an approval is not yet tied
  to the exact content of the proposal, and the approved payment a device compares with is
  fetched from the coordinator when it signs (#567). Until that is fixed, a malicious or
  compromised coordinator could change a proposal after it was approved: a payment the quorum
  signs is only as safe as the hosted coordinator. Also open: a device's record of what it signed
  stays on that device, so a member who signs for the same seat on another device (a backup restored
  there included), in another browser or a private window, or after clearing the browser's storage
  is not warned there that the seat already signed that payment, and signing again could pay it
  twice. A device that reads the chain itself would narrow this (#516, not scheduled).
- **Acting as another member.** Fixed: every vote, proposal, payroll, rename and send is signed by
  the member's device and checked by the coordinator, and votes, proposals and payrolls are
  recorded under the seat that signed them (#288, #569); seats in the signing room, and the
  messages that carry the arming tally, are authenticated (#401, #424, #425); two writes to one
  vault no longer run unserialised (#576, since 2026-10-04; a read does not queue behind a write, and the ones that record a mined send take the lock only when it is free); and since release 0.23.0 approvals are counted by seat, and one
  recorded before the vault required signatures no longer counts (#575). Open: on a vault created before 8 November 2026, a
  member can claim a colleague's seat before the colleague does, and then vote as them (#577; a vault
  created since then takes a seat only with that seat's own certificate, ADR-0012, which leaves the
  older vaults as they are: covering them needs an in-place upgrade, tracked in #406 and not built); and the write check turns on per vault, the first time a member unlocks it, so
  until then that vault still accepts unsigned writes.
- **Denial of service.** Fixed: one slow request no longer takes the coordinator or the relay down
  (#384, #393). Open: the hosted coordinator is a single point of failure, and so is the relay for
  the signing round. While either is down nothing can be spent, though the funds stay on chain.
  If the coordinator's copy of a vault were lost for good, the vault's viewing key would survive
  only in members' backups made on a Private vault since 2026-09-06 while our coordinator was
  reachable; without one, even a full
  quorum of shares cannot spend the vault's notes (`docs/RECOVERY.md`). Even with backups, there is
  no tool yet to rebuild the vault, neither on our coordinator (#214) nor without our servers (#613). A flood can drop a live ceremony's
  messages at the relay (#400), the legacy `/net` ceremony driver lacks the replay mitigation
  (#363; that page no longer signs payments at all), and a restored vault can report zero and cannot be rescanned (#434).
- **Privacy.** Fixed: once every member's device has registered its public device key, which it does when its
  member unlocks the vault, the signing request is sealed to those devices, so the relay does not
  learn who a payment pays or how much (#63); the coordinator's private reads (balance, history,
  proposals, ledger, members) and the signing room are gated by a per-vault secret, so a leaked
  vault id opens neither, though it still shows the vault's addresses (receive and change) and its quorum (#402, #403);
  once a vault has a registered device, the viewing key reaches the devices sealed (#481); the app's
  console messages no longer name a vault's signing room and name a vault only by the first 8
  characters of its id; and the copy of a transaction the coordinator shares for signing no longer
  carries what finishes it, so whoever could read an unsealed signing request can no longer put the
  signed transaction together and broadcast it (both since 0.23.0). Open: what a protected vault saved
  on a device before 0.23.0 stays in plain text until the vault is next unlocked there, the sealed
  lists open with the vault's secret, which every member holds, and the vault's record on the device
  keeps its id, name, members' names, quorum and receive address in the clear (the app's changelog
  lists the rest under Known limits); the coordinator holds each vault's
  viewing key and reads its books (#516); a vault where some member has not yet unlocked it on a
  current version still sends its signing requests unsealed; vaults created before the per-vault secret stay
  readable by id until they are re-created, or upgraded in place if #406 lands; a device that restored a vault before the fix keeps its viewing key unencrypted in local storage until that vault's passphrase is next typed, and a copy already taken stays valid for the life of the vault (#599); the coordinator stores proposals
  and member names in the clear (#601); the signing room carries governance metadata the relay
  can read (#340); the relay sees the members' names and the quorum while a vault is created; and
  the relay, the coordinator and the web host see members' IP addresses and timing.
- **Where the share lives.** In the browser and in the desktop app, the share is kept in the
  app's own storage, which a browser can clear; the app asks for persistent storage and warns
  when it is refused (#307). Each member can export an encrypted backup, which opens without
  Konclave (`scripts/open-export.mjs`); importing it into other FROST tools does not exist yet
  (#214), and keeping the share in the operating system's keychain on the desktop is planned,
  not done.
- **ZIP 2005.** Vaults created with the current derivation are not recoverable under ZIP 2005 (quantum recoverability); whether and how to move to a recoverable derivation is open (#428).
