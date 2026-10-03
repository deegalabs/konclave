# Security Policy

Konclave is a self-custody tool for collective Zcash vaults using FROST threshold
signatures. Key shares never leave a member's device. The relay carries sealed or public
ceremony material: it never sees a share, and once every member's device has registered its
public device key it does not see who a payment pays, but it does see member names and the quorum while a
vault is being created; the hosted coordinator never receives a share and cannot move funds
on its own, but it holds each vault's viewing key and sees its payments, and it builds the
transactions the quorum signs (see Known limitations).
Because it can move real funds, we take security seriously and audit before publishing and
whenever authentication, key custody, or fund-movement paths change.

## Reporting a vulnerability

**Do not open a public issue for security problems.** Report privately via
[GitHub Security Advisories](https://github.com/deegalabs/konclave/security/advisories/new).

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
  stored before that keep 210,000 until the passphrase is changed, and an export made before
  that keeps 210,000 for good.
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
and while it is down no payment can be made. What is fixed and what is open, by kind of attack:

- **Changing the app itself.** Open: every member using the web app loads it from our web host, so a
  compromised host could serve all of them a modified app at once, and the threshold would not
  stop that. Nothing yet lets a member check that the app they run is a published release
  (#605), and the desktop installers are not code-signed (#606).
- **Changing what a payment pays.** Fixed: a device signs only the message it derives from its
  own copy of the transaction, in both signing rounds, so another member cannot swap the
  transaction under it (#62; round 2: #355, #579). That guards against a member, not against
  the coordinator, which builds the transaction to begin with. Open: an approval is not yet tied
  to the exact content of the proposal (#567), and a signing device does not yet check what it
  shows against what it signs, nor the fee or the memos (#610). Until both are fixed, a
  malicious or compromised coordinator could change an approved payment, burn funds as fee or
  alter a memo: a payment the quorum signs is only as safe as the hosted coordinator, which also
  supplies what the signing screen shows.
- **Acting as another member.** Fixed: every vote, proposal, payroll, rename and send is signed by
  the member's device and checked by the coordinator, and votes, proposals and payrolls are
  recorded under the seat that signed them (#288, #569); seats in the signing room, and the
  messages that carry the arming tally, are authenticated (#401, #424, #425). Open: a member can claim a colleague's seat before the
  colleague does, and then vote as them (#577); an approval recorded while a vault still took
  unsigned writes keeps counting after it requires signatures (#575); two requests for one vault
  can run unserialised (#576); and the write check turns on per vault, the first time a member
  unlocks it, so until then that vault still accepts unsigned writes.
- **Denial of service.** Fixed: one slow request no longer takes the coordinator or the relay down
  (#384, #393). Open: the hosted coordinator is a single point of failure, and so is the relay for
  the signing round. While either is down nothing can be spent, though the funds stay on chain.
  If the coordinator's copy of a vault were lost for good, the vault's viewing key would survive
  only in members' backups made on a Private vault since 2026-09-06 while our coordinator was
  reachable; without one, even a full
  quorum of shares cannot spend the vault's notes (`docs/RECOVERY.md`). Even with backups, there is
  no tool yet to rebuild the vault, neither on our coordinator (#214) nor without our servers (#613). A flood can drop a live ceremony's
  messages at the relay (#400), the legacy `/net` ceremony driver lacks the replay mitigation
  (#363), and a restored vault can report zero and cannot be rescanned (#434).
- **Privacy.** Fixed: once every member's device has registered its public device key, which it does when its
  member unlocks the vault, the signing request is sealed to those devices, so the relay does not
  learn who a payment pays or how much (#63); the coordinator's private reads (balance, history,
  proposals, ledger, members) and the signing room are gated by a per-vault secret, so a leaked
  vault id opens neither, though it still shows the vault's address and its quorum (#402, #403);
  and the viewing key reaches the devices sealed (#481). Open: the coordinator holds each vault's
  viewing key and reads its books (#516); a vault where some member has not yet unlocked it on a
  current version still sends its signing requests unsealed; vaults created before the per-vault secret stay
  readable by id until they are re-created, or upgraded in place if #406 lands; a restored vault
  keeps its viewing key unencrypted in browser storage (#599); the coordinator stores proposals
  and member names in the clear (#601); the signing room carries governance metadata the relay
  can read (#340); the relay sees the members' names and the quorum while a vault is created; and
  the relay, the coordinator and the web host see members' IP addresses and timing.
- **Where the share lives.** In the browser and in the desktop app, the share is kept in the
  app's own storage, which a browser can clear; the app asks for persistent storage and warns
  when it is refused (#307). Each member can export an encrypted backup, which opens without
  Konclave (`scripts/open-export.mjs`); importing it into other FROST tools does not exist yet
  (#214), and keeping the share in the operating system's keychain on the desktop is planned,
  not done.
