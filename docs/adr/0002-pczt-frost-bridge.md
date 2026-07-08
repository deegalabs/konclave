# ADR-0002 — The PCZT/FROST integration gap and the konclave-signer bridge

- **Status:** accepted
- **Date:** 2026-07-01
- **Context:** Phase 1 (vertical slice). While running the real Orchard spend flow
  with FROST on mainnet, we discovered that the official tools **do not interoperate**
  today at this step.

## Discovery

[CONCEITO_INICIAL.md](../CONCEITO_INICIAL.md) §6 assumed that "the complete
FROST → Zcash transaction flow already exists and works today". This is true **only for
the exact Ywallet tutorial combination** (Ywallet + `zcash-sign`, co-maintained). When
using a **headless** wallet (`zcash-devtool`, the choice consistent with the local-first
product), an integration gap appears:

- **`zcash-sign`** (frost-tools): injects the FROST signature, but reads PCZT only on the
  old stack (`pczt 0.5` / `orchard 0.11-fork`, `unstable-frost` feature); the Ywallet path
  is disabled (`#[cfg(false)]`). Against the devtool PCZT,
  `into_effects()` fails ("Not enough information to build the transaction's effects").
- **`zcash-devtool`** (zcash): creates/proves/broadcasts PCZT on the new stack
  (`pczt 0.7` / `orchard 0.14`), but `pczt update-with-signature` returns
  `"TODO: Maybe support this"` for the **Orchard** pool (only transparent implemented).

In other words: one creates the transaction but does not inject the Orchard signature; the
other injects but does not read the new PCZT. No official binary closes the loop on its own.

## Decision

Build **`konclave-signer`** — a minimal bridge that:
1. reads the proved PCZT from `zcash-devtool`, computes the `sighash` (v5) and extracts the
   `randomizer` (alpha) of each real spend (dummies filtered out);
2. after the FROST ceremony, injects the redpallas signature via
   `orchard::pczt::Action::apply_signature`, which **validates** the signature against the
   randomized key `rk` before applying it.

Pinned to the **same versions as `zcash-devtool`** (`orchard 0.14` with
`unstable-frost`, `pczt 0.7`, librustzcash `rev 08334ebe`) so that the PCZT wire format
matches byte for byte. Enabling discovery: **mainline `orchard 0.14` already ships the
FROST hooks** (`unstable-frost`, `apply_signature`, access to `alpha`) — the old fork was
upstreamed.

## Consequences

- It is **glue, not cryptography**: only calls to the official libraries; the FROST math
  stays in `frost-core`. It does not violate "Path 1 / do not reimplement crypto".
- It is not scope creep: it is the **core of the Orchestrator** (Layer 2, always our code),
  built earlier. It will be folded into `src-tauri/` in Phase 3.
- **Honesty correction** to CONCEITO §6: the "already works today" holds only for the
  Ywallet+zcash-sign combination; with a headless wallet, you must pin a compatible set
  **or** own the bridge. `engine/versions.lock` pins the set.
- FROST communication in the demo: `frostd` requires HTTPS; for local testing we generate a
  local CA + leaf cert for `127.0.0.1` in the system store (reqwest uses
  `rustls-tls-native-roots`). Participants confirm with `y` (interactive prompt).

## Proof

Konclave's first FROST transaction on mainnet:
`f63ee64d7bc086a8286631d03936ec2ca2ca57f4e4c63712fc95c1f02c522360` (block 3,396,616).
Full flow in [VERTICAL_SLICE.md](../VERTICAL_SLICE.md).
