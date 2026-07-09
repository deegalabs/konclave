# Konclave — Architecture

> Architecture document (GSD). Companion to [CLAUDE.md](../CLAUDE.md) and the 3 source docs.

## 1. Three-layer view

```
┌─────────────────────────────────────────────────────────────────────┐
│ Layer 3 — UI (Next.js/React, static export served by Tauri)           │
│   Intro · Create/Join vault · Dashboard · Payment/Payroll ·           │
│   Proposal (approve/refuse) · Sent · Ledger · Members                 │
└───────────────────────────────┬─────────────────────────────────────┘
                                 │  Tauri commands (structured DTOs)
┌───────────────────────────────▼─────────────────────────────────────┐
│ Layer 2 — ORCHESTRATOR (Rust, inside src-tauri/ — what we build)      │
│   ceremony · signing · wallet · proposals · validation · store · ipc  │
└───────────────────────────────┬─────────────────────────────────────┘
        binary invocation (structured output)     │  linked library
┌───────────────────────────────▼─────────────────────────────────────┐
│ Layer 1 — ENGINE (official Foundation tools — do not reimplement)     │
│   frostd · frost-client · zcash-sign · zcash-devtool(PCZT) ·          │
│   zcash_client_backend (linked)                                       │
└──────────────────────────────────────────────────────────────────────┘
                                 │
                    network: frostd (coordination) · lightwalletd · Zcash mainnet (NU6.2)
```

## 2. What travels vs. what stays (trust model)

| Stays **on the device only** (never leaves) | **Travels over the network** (public) |
|---|---|
| Key share, seed, secrets | DKG round packages, nonce commitments |
| Decrypted memos | Partial signatures |
| The act of signing | The final transaction (goes to mainnet) |

`frostd` is a **blind courier**: it carries public envelopes and opens none of them.
Compromising it reveals no secrets and grants no ability to spend — at worst it disrupts
coordination (hence the QR/copy-paste fallback).

## 3. Sources of truth

- **On-chain (mainnet):** final truth about funds. **On-chain always wins.**
- **Local state (per device):** share, vaults, labels, cache, in-progress proposals.
- **`frostd`:** ephemeral transport of **public** material; not a source of truth.

## 4. Orchestrator module map (`src-tauri/`)

| Module | Responsibility |
|---|---|
| `ceremony` | DKG (and trusted-dealer in the slice) via `frost-client` + `frostd` |
| `signing` | Proposal signing rounds; **Rerandomized FROST** (`-C redpallas`) via `zcash-sign` |
| `wallet` | Sync via UFVK, balance/history, plan construction (PCZT) — `zcash_client_backend` linked |
| `proposals` | **State machine** (LOGICA §6), balance reservation, expiry, reconciliation |
| `validation` | Address/amount/memo/fee (ZIP 317); explicit failures at every boundary |
| `store` | Local state in SQLite + share in the OS keychain |
| `ipc` | Tauri commands exposed to the UI; typed DTOs |

## 5. Proposal state machine (LOGICA §6)

```
draft ──propose──> awaiting ──quorum──> ready ──broadcast──> sent ──confirms──> confirmed
   │                    │
   │                    ├──refusal makes quorum unreachable──> refused
   │                    ├──expires──> expired
   │                    └──cancel (proposer only)──> cancelled
   discard
```
- Proposer counts as the 1st approval. Quorum = `t`. Approval is idempotent.
- Unreachability: if refusals > (n − t) → automatic `refused`.
- Balance reserved while the proposal is alive (a **product** lock, not a protocol one).
- Payroll = **one** transaction with N outputs → **one** proposal → **one** approval round.

## 6. Transaction flow (slice → product)

1. `frost-client` init for each member → contacts.
2. **DKG** via `frostd` (product) / trusted-dealer (slice) → group key, local shares.
3. `zcash-sign generate --ak` → **Orchard** address + UFVK.
4. Funding on mainnet (Orchard) → `wallet` syncs via UFVK.
5. Propose: `wallet` builds the plan → **PCZT** → `zcash-sign` extracts what to sign (+ randomizer).
6. Signing ceremony (`-C redpallas`) coordinated by `frostd` → FROST signature.
7. `zcash-sign` injects the signature into the PCZT → signed tx → broadcast → confirmation.

## 7. Packaging

- **Tauri sidecars:** the Engine binaries are packaged per target-triple.
- **Dev:** native Windows first; WSL2 as a fallback if the tooling requires Linux.
- **Deterministic build:** `engine/` compiles from source at a pinned SHA; checksum in
  `engine/versions.lock`.
