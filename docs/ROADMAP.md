# Konclave — Build Roadmap

> Approved phase plan. Calibrated for **solo, ~15 days** (start 2026-06-30 →
> deadline 2026-07-15 UTC), **vertical slice first**, scope locked to the core.

## Schedule principles
- **The risk is in Phase 1** (crypto → broadcast). It comes first and is the existential gate.
- **Solo = scope discipline.** The core is a firm commitment; extras only if the core closes.
- **Documentation and security are cross-cutting** (day 1 to 15), not phases.

## Overview

| Phase | Days | Objective | Gate |
|---|---|---|---|
| 0 — Foundation & Docs | 1 | Repo, license, CLAUDE.md, skeleton, reality-check | — |
| 1 — Vertical Slice (mainnet) | 1–4 | 1st real FROST transaction confirmed via CLI | 🔴 Gate 1 |
| 2 — Migration to real DKG | 4–5 | Vault via DKG (key never reconstituted) | — |
| 3 — Orchestrator (backend) | 5–9 | State machine, validation, payroll, destructive TDD | — |
| 4 — UI (design + screens) | 6–10 (parallel) | Token system + screens against mock | — |
| 5 — Integration | 9–11 | Full core through the UI on mainnet | 🔴 Gate 2 |
| 6 — Impact extras | 11–13 | Memo-payslip, accounting, proposal desk | — |
| 7 — Delivery | 13–15 | Unicorn README, video, diagram, submission | 🏁 |

---

## Phase 0 — Foundation & Documentation (GSD) — Day 1
**Objective:** ground and project memory before any code.
**Deliverables:** skeleton (`engine/`, `src-tauri/`, `ui/`, `docs/`, `tests/`); dual
license; `CLAUDE.md`; source docs in `docs/`; `engine/versions.lock` (skeleton); ADR-0001;
`.gitignore`; this roadmap.
**Reality-check:** official repos located, reference tutorial confirmed, post-NU6.2 Orchard
status verified (Orchard live and safe on mainnet).
**Done when:** repo is navigable; CLAUDE.md is the source of context.

## Phase 1 — Vertical Slice on Mainnet — Days 1–4 🔴
**Objective:** one real FROST transaction, confirmed on mainnet, even if ugly (via CLI).
- **1A — Toolchain:** compile the `frost-tools` + `zcash-sign` binaries from source
  (native Windows → WSL2 if it breaks), pin SHA + checksum, **verify interfaces
  (`--json`?)**, **test network access** (clone repo + reach lightwalletd NU6.2).
- **1B — Key:** material via trusted-dealer (scaffold) → `zcash-sign generate --ak` →
  **Orchard address + UFVK**.
- **1C — Funds:** fund ~0.01 ZEC to the **Orchard** address → sync via UFVK → read balance.
- **1D — Spend:** tx plan (PCZT) → signing ceremony (`-C redpallas`) via
  `frostd` → signed tx → broadcast → **confirmation on the explorer**.
> **🔴 GATE 1 (go/no-go):** transaction verifiable on-chain. If it doesn't close, replan
> before spending time on UX.

## Phase 2 — Migration to real DKG — Days 4–5
**Objective:** swap trusted-dealer for **real DKG** via `frostd`.
**Done when:** the vault is born from DKG, the key is never reconstituted, and a
transaction goes out on top of it.

## Phase 3 — Orchestrator — Days 5–9
**Objective:** wrap each CLI step as a Rust command with a **structured DTO**.
**Modules:** `ceremony`, `signing`, `wallet`, `proposals` (state machine §6),
`validation` (ZIP 317), `store` (SQLite + keychain), `ipc`.
**Includes:** balance reservation, expiry, reconciliation, payroll logic (N outputs).
**Done when:** the core is operable via commands + **the whole destructive suite passing**.

## Phase 4 — UI — Days 6–10 (parallel to Phase 3)
- **4A — Token system** (`frontend-design` skill): palette, typography, signature element
  derived from the Zcash/Orchard world, a dedicated treatment for "hiding value". Validated
  before it becomes a screen.
- **4B — Screens** against a mock: Intro → Create/Join → Dashboard → Payment/Payroll →
  Proposal → Sent → Ledger, Members, pending Proposals.
**Done when:** screens are navigable against the mock; baseline accessibility.

## Phase 5 — Integration — Days 9–11 🔴
**Objective:** mock → real commands; the whole core works **through the UI** on mainnet.
**Includes:** real error states (frostd offline, insufficient balance, Sapling address).
> **🔴 GATE 2:** end-to-end core demo through the interface. If it slips, cut Phase 6.

## Phase 6 — Impact extras (if there is room) — Days 11–13
In order of impact: **memo-payslip** → **accounting via UFVK** (who proposed/approved +
CSV export) → **pending proposal desk** (with expiry).
**Done when:** what fits ships polished; what doesn't stays honest in the README roadmap.

## Phase 7 — Delivery — Days 13–15 🏁
**Deliverables:** unicorn-standard README (hero, "why it exists", demo GIF + real tx link,
3-layer diagram, credit to the Foundation, quickstart, trust model, honest roadmap,
license); mainnet demo video; backup video; submission checklist.
**Done when:** submitted before 2026-07-15 UTC.

---

## Go/no-go gates
- **Gate 1 (end of Phase 1):** real FROST transaction on mainnet. Existential risk.
- **Gate 2 (end of Phase 5):** core functional through the UI. If it fails, cut extras and focus on polish.

## Slack
Slice closed by ~day 4–5; core by ~11; days 12–15 for delivery **and buffer**. If the
slice slips, Phase 6 is the escape valve — never the core.
