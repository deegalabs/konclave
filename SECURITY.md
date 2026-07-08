# Security Policy

Konclave is a self-custody tool for collective Zcash vaults using FROST threshold
signatures. Key shares never leave a member's device; the coordination server sees
only public protocol material. Because it can move real funds, we take security
seriously and audit before publishing and whenever authentication, key custody, or
fund-movement paths change.

## Reporting a vulnerability

**Do not open a public issue for security problems.** Report privately via
[GitHub Security Advisories](https://github.com/deegalabs/konclave/security/advisories/new).

Please include: affected component (FROST signer, PCZT bridge, the local HTTP bridge,
key sealing, etc.), reproduction steps, and impact. We aim to acknowledge within a few
days. Never include real key shares, seeds, passphrases, or a funded vault's secrets in
a report.

## Scope

In scope: the orchestrator (`orquestrador/`), the FROST↔PCZT bridge (`konclave-signer/`),
the loopback HTTP bridge, key sealing/derivation, and the frontend (`rosto/`).

Out of scope: the upstream Zcash Foundation tools (`frostd`, `frost-client`, `zcash-sign`,
`zcash-devtool`) and `librustzcash` — report those to their maintainers.

## Our practices

- Key shares are sealed at rest (XChaCha20-Poly1305); for DKG vaults the sealing key is
  derived from a passphrase via Argon2id and never stored.
- The coordination server (`frostd`) sees only public protocol material.
- Shielded-first: receiving is Orchard-only; transparent destinations are an explicit,
  warned exception.
- The local bridge binds `127.0.0.1` only; no telemetry; secrets never in logs/URLs.
- We run a security audit before publishing, before broadcasts of real funds, and when
  auth / key custody / fund-movement code changes. Findings are tracked internally.

## Known limitations

This is hackathon-stage software under active hardening. Do not custody significant
funds with it yet. The current threat model and open items are tracked in our internal
audit log; headline residual risks (e.g. the local bridge's request authentication) are
being addressed before any "production-ready" claim.
