# ADR-0001 — Closed architecture decisions

- **Status:** accepted
- **Date:** 2026-06-30
- **Context:** Konclave (ZecHub Hackathon 3.0). Decisions consolidated from
  [CONCEITO_INICIAL.md §13](../CONCEITO_INICIAL.md) and the initial logistics conversation.

## Decision

### Product (source: CONCEITO §13)
1. **Name:** Konclave.
2. **Platform:** local-first desktop via Tauri (Rust shell + Next.js/React).
3. **Engine integration:** Path 1 (invoke official CLI binaries) with Path 2 rigor
   (structured output, validation at every boundary, destructive TDD).
4. **Custody:** the key share never leaves the device (OS keychain); between members only
   public material travels.
5. **Coordination:** official `frostd` (blind server) + QR/copy-paste fallback (stretch).
6. **Product key generation:** real DKG (trusted-dealer only as a slice scaffold).
7. **Network:** mainnet, real ZEC, minimal amount; receive only in Orchard.
8. **Privacy:** shielded-first; no telemetry; secrets never in log/disk/URL.
9. **Scope:** core + 3 promoted extras; stretch and roadmap kept separate.
10. **License:** dual Apache-2.0 / MIT.

### Technical (source: logistics)
11. **Team:** solo → scope locked to the core; extras only if there is room.
12. **Dev OS:** native Windows first; WSL2 only if the tooling breaks.
13. **Binary origin:** compile from source, pinned by SHA, vendored as submodules, with a
    checksum in `engine/versions.lock`. The pin is anchored to the commit of the official
    FROST+Zcash tutorial (a known-good path), guaranteeing version coherence of
    `frost-core`/`reddsa` across the tools.
14. **Wallet layer:** link `zcash_client_backend` in Rust for sync/balance/plan (native
    structured data); shell out only the FROST/sign binaries.
15. **Frontend:** Next.js as a static export.

## Consequences
- The binaries **must** be mutually compatible at the pinned SHA (same version of
  `frost-core`/`reddsa`), otherwise the signature may not verify.
- The "share never leaves the device" promise requires reconciling where `frost-client`
  stores the share (its own storage) with the keychain — to decide in Phase 1/3.
- Build against **NU6.2** (the 2026-06-03 hard-fork that re-enabled Orchard).

## Deferred decisions (logistics)
Proposal expiry deadline (72h placeholder), payroll line limit, CSV columns, a trusted
time source for expiry, `frostd` hosting for the demo.
