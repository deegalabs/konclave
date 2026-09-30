# Security Policy

Konclave is a self-custody tool for collective Zcash vaults using FROST threshold
signatures. Key shares never leave a member's device. The relay carries sealed or public
ceremony material: it never sees a share or who a payment pays, but it does see member
names and the quorum while a vault is being created; the hosted coordinator never receives
a share and cannot spend, but it holds each vault's viewing key and sees its payments.
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

- Key shares are sealed at rest (XChaCha20-Poly1305); for DKG vaults the sealing key is
  derived from a passphrase via Argon2id and never stored. In the browser, shares are
  stored in IndexedDB under AES-256-GCM with a key derived by PBKDF2-HMAC-SHA256 from the
  member's passphrase: 600,000 iterations for anything sealed since 2026-09-06 (#479); records
  and exports sealed before that keep 210,000 until the passphrase is changed.
- `frostd` (local build) and the relay see only public or sealed protocol material, plus, on the
  relay, the member names and the quorum exchanged while a vault is created; the hosted
  coordinator is view-only (see above).
- Shielded-first: receiving is shielded-only (the Ironwood pool since NU6.3); transparent
  destinations are an explicit, warned exception.
- The local bridge binds `127.0.0.1` only; no telemetry; secrets never in logs/URLs.
- We run a security audit before publishing, before broadcasts of real funds, and when
  auth / key custody / fund-movement code changes. Findings are tracked internally.

## Known limitations

This is early-stage software, not independently audited, under active hardening. Do not custody significant
funds with it yet. The Zcash Foundation's partial audit of FROST excludes rerandomized FROST,
the variant Zcash uses. Open items include the legacy `/net` ceremony driver without replay
mitigation (#363), a relay flood that can drop a live ceremony's messages (#400), vaults
created before per-vault read protection that stay readable by id (#406), and a restored
wallet that cannot be rescanned (#434).
