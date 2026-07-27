# Konclave: Build Roadmap

> Approved phase plan. Calibrated for **solo, ~15 days** (start 2026-06-30 →
> deadline 2026-07-15 UTC), **vertical slice first**, scope locked to the core.

## Schedule principles
- **The risk is in Phase 1** (crypto → broadcast). It comes first and is the existential gate.
- **Solo = scope discipline.** The core is a firm commitment; extras only if the core closes.
- **Documentation and security are cross-cutting** (day 1 to 15), not phases.

## Overview

| Phase | Days | Objective | Gate |
|---|---|---|---|
| 0: Foundation & Docs | 1 | Repo, license, CLAUDE.md, skeleton, reality-check | - |
| 1: Vertical Slice (mainnet) | 1-4 | 1st real FROST transaction confirmed via CLI | 🔴 Gate 1 |
| 2: Migration to real DKG | 4-5 | Vault via DKG (key never reconstituted) | - |
| 3: Orchestrator (backend) | 5-9 | State machine, validation, payroll, destructive TDD | - |
| 4: UI (design + screens) | 6-10 (parallel) | Token system + screens against mock | - |
| 5: Integration | 9-11 | Full core through the UI on mainnet | 🔴 Gate 2 |
| 6: Impact extras | 11-13 | Memo-payslip, accounting, proposal desk | - |
| 7: Delivery | 13-15 | Unicorn README, video, diagram, submission | 🏁 |

---

## Phase 0: Foundation & Documentation (GSD), Day 1
**Objective:** ground and project memory before any code.
**Deliverables:** skeleton (`engine/`, `src-tauri/`, `ui/`, `docs/`, `tests/`); dual
license; `CLAUDE.md`; source docs in `docs/`; `engine/versions.lock` (skeleton); ADR-0001;
`.gitignore`; this roadmap.
**Reality-check:** official repos located, reference tutorial confirmed, post-NU6.2 Orchard
status verified (Orchard live and safe on mainnet).
**Done when:** repo is navigable; CLAUDE.md is the source of context.

## Phase 1: Vertical Slice on Mainnet, Days 1-4 🔴
**Objective:** one real FROST transaction, confirmed on mainnet, even if ugly (via CLI).
- **1A - Toolchain:** compile the `frost-tools` + `zcash-sign` binaries from source
  (native Windows → WSL2 if it breaks), pin SHA + checksum, **verify interfaces
  (`--json`?)**, **test network access** (clone repo + reach lightwalletd NU6.2).
- **1B - Key:** material via trusted-dealer (scaffold) → `zcash-sign generate --ak` →
  **Orchard address + UFVK**.
- **1C - Funds:** fund ~0.01 ZEC to the **Orchard** address → sync via UFVK → read balance.
- **1D - Spend:** tx plan (PCZT) → signing ceremony (`-C redpallas`) via
  `frostd` → signed tx → broadcast → **confirmation on the explorer**.
> **🔴 GATE 1 (go/no-go):** transaction verifiable on-chain. If it doesn't close, replan
> before spending time on UX.

## Phase 2: Migration to real DKG, Days 4-5
**Objective:** swap trusted-dealer for **real DKG** via `frostd`.
**Done when:** the vault is born from DKG, the key is never reconstituted, and a
transaction goes out on top of it.

## Phase 3: Orchestrator, Days 5-9
**Objective:** wrap each CLI step as a Rust command with a **structured DTO**.
**Modules:** `ceremony`, `signing`, `wallet`, `proposals` (state machine §6),
`validation` (ZIP 317), `store` (SQLite + keychain), `ipc`.
**Includes:** balance reservation, expiry, reconciliation, payroll logic (N outputs).
**Done when:** the core is operable via commands + **the destructive suite passing** (6 of the
8 §8 scenarios have automated tests; `frostd`-offline is validated live and multi-device
reconciliation is an open item, see CLAUDE.md §8 for the honest per-scenario status).

## Phase 4: UI, Days 6-10 (parallel to Phase 3)
- **4A - Token system** (`frontend-design` skill): palette, typography, signature element
  derived from the Zcash/Orchard world, a dedicated treatment for "hiding value". Validated
  before it becomes a screen.
- **4B - Screens** against a mock: Intro → Create/Join → Dashboard → Payment/Payroll →
  Proposal → Sent → Ledger, Members, pending Proposals.
**Done when:** screens are navigable against the mock; baseline accessibility.

## Phase 5: Integration, Days 9-11 🔴
**Objective:** mock → real commands; the whole core works **through the UI** on mainnet.
**Includes:** real error states (frostd offline, insufficient balance, Sapling address).
> **🔴 GATE 2:** end-to-end core demo through the interface. If it slips, cut Phase 6.

## Phase 6: Impact extras (if there is room), Days 11-13
In order of impact: **memo-payslip** → **accounting via UFVK** (who proposed/approved +
CSV export) → **pending proposal desk** (with expiry).
**Done when:** what fits ships polished; what doesn't stays honest in the README roadmap.

## Phase 7: Delivery, Days 13-15 🏁
**Deliverables:** unicorn-standard README (hero, "why it exists", demo GIF + real tx link,
3-layer diagram, credit to the Foundation, quickstart, trust model, honest roadmap,
license); mainnet demo video; backup video; submission checklist.
**Done when:** submitted before 2026-07-15 UTC.

---

## Go/no-go gates
- **Gate 1 (end of Phase 1):** real FROST transaction on mainnet. Existential risk.
- **Gate 2 (end of Phase 5):** core functional through the UI. If it fails, cut extras and focus on polish.

## Slack
Slice closed by ~day 4-5; core by ~11; days 12-15 for delivery **and buffer**. If the
slice slips, Phase 6 is the escape valve, never the core.

---

# Forward roadmap (post-submission)

The core crypto is proven (real FROST over Orchard, five verifiable mainnet txids incl. a
DKG-vault send and a private multi-output payroll, and browser-side signing of a real
Orchard spend). The work from here is **consolidation, robustness, and reach**, not new
cryptography. Ordered by priority.

## A. Consolidation
- Keep `main` the single trunk; land verified work through PRs; keep the proof surfaces
  consistent (see [CLAIMS.md](CLAIMS.md)).
- Browser signing of a real Orchard spend is now on `main` (the ceremony signs under the
  PCZT's own randomizer/alpha and verifies under `ak+alpha`). The `/net` "demo → real broadcast"
  path is **designed and partly built on a branch** (not merged): **Architecture B**, a
  helper-assisted broadcast that is blind to spending. The browser devices keep the shares and
  sign over the blind relay; a helper (the native orchestrator, which never sees a share) builds
  and proves the real PCZT for the vault's own address, publishes a signing request, waits for
  the aggregate signature, injects, and broadcasts — consistent with "internal transparency,
  external privacy". The wire protocol and the relay handshake are implemented and unit-tested on
  both sides (`orchestrator::net_send` / `relay_client`; `ui/net-sign`); the live NetVault relay
  wiring and the end-to-end testnet proof remain (see `temp/NET-REAL-BROADCAST-SCOPING.md`).

## B. Network robustness — NU6.3 / Ironwood
- Ironwood introduces a **new shielded pool** ("Ironwood", V6 transactions with their own
  actions), distinct from Orchard. The FROST / RedPallas spend-authorization scheme is
  **unchanged** — an Ironwood spend is Orchard-shaped — so the FROST / DKG signing core
  carries over whole; what changes is the pool the engine and the PCZT bridge operate on.
- Because build, prove, and broadcast are delegated to `zcash-devtool`, Konclave inherits
  upstream Ironwood support once the engine is rebuilt against a librustzcash with NU6.3.
- **Code readiness — done:** the two mainnet-hardcoded network points are parameterized behind
  an explicit choice, mainnet as the default so production is unchanged —
  `konclave-signer build-payroll --network main|test` and
  `orchestrator::validate_recipient_on(addr, network)`. Tested for both networks.
- **End-to-end proven on testnet — done (out-of-repo experiment):** testnet is already past
  the Ironwood activation height, so it runs NU6.3 now. Rebuilding `zcash-devtool` against the
  Ironwood librustzcash pin lets the wallet **see and spend** Ironwood-pool funds that the
  pre-Ironwood engine is blind to. With the FROST↔PCZT bridge ported to the Ironwood pool
  (`sign_ironwood_with` / `apply_ironwood_signature`, V6 sighash), the full cycle — receive →
  build + prove for the vault's own address → FROST 2-of-3 ceremony → inject (the aggregate
  signature verifies) → broadcast → **mined into a block** — completed on testnet (tx
  `069f4260…`, block 4,202,966). This ran on a throwaway testnet vault, kept out-of-repo like the
  mainnet evidence infra; **the repo default (`main`) stays on the mainnet pre-Ironwood pin.**
- **Productization for mainnet (Option A — clean cut at activation) — prepared, held:** mainnet
  activates Ironwood at height 3,428,143 (~2026-07-28). The port is **ready on a branch, not
  merged**: the engine pin (`engine/versions.lock`) and `konclave-signer` moved to the Ironwood
  pin, extract/inject made pool-aware (Orchard pre-NU6.3, Ironwood post-NU6.3), and the C6 test
  vectors migrated from the pre-Ironwood PCZT format (v1) to a real Ironwood vector (v2). Held
  because the v2 wire format cannot parse v1, so merging before activation would break signing
  pre-Ironwood mainnet transactions; a clean cut at activation avoids a dual-maintenance window
  (see `temp/IRONWOOD-PRODUCTIZATION-PLAN.md`). Until activation the repo is
  deliberately left on the mainnet-valid pin.
- **Re-validated (2026-07-27):** the pin is confirmed identical to `zcash-devtool` `origin/main`
  (the reference Ironwood tool), so the PCZT wire format stays byte-for-byte compatible; the
  final librustzcash crates (zcash_primitives 0.30.0, orchard 0.15.4, pczt 0.9.1) are newer than
  what devtool main pins, so we hold and bump when devtool does. The **repo** `konclave-signer`
  (dual-pool) was re-run end to end on testnet — a 4-real-spend transaction, one FROST 2-of-3
  ceremony per spend, mined — so the branch is proven ready for the activation cut.

## C. On-device share persistence — done (web)
- **Done:** a device's share is persisted **encrypted at rest** (WebCrypto PBKDF2 → AES-GCM in
  IndexedDB, `ui/src/storage.ts`), unlocked per device by a passphrase; a member can close and
  reopen the app, restore the share, and **rejoin a signing session** without losing the vault.
- Custody invariant held: the share is stored **encrypted**, unlocked only on the device; viewing
  keys are always derived through ZIP-32 / official tooling, never as a hash of a shared value.
- **Next (with the shells):** desktop/mobile move the unlock to the OS keystore (Keychain /
  Credential Manager / Secret Service) and add passkey / biometric unlock.

## D. Multi-platform delivery (web-first; native shells optional)
**Decided: deliver web-first** — the browser + WASM + a blind relay is the universal client, so
the whole per-distro packaging matrix is optional, not required ([ADR-0005](adr/0005-web-first-delivery.md)).
One UI (`ui/`) and one crypto core (`konclave-wasm`) behind the relay:
- **Web** — browser + WASM + hosted relay (done; verified across separate machines). **Now
  installable as a PWA** (web app manifest + a network-first, update-safe service worker — the
  `/api` and `/relay` responses are never cached; the share lives only in encrypted IndexedDB).
- **Desktop (optional)** — a Tauri shell wrapping the `orchestrator` for native installers
  (Windows / macOS / Linux); deferred while the dev machine's GTK/WSLg window won't render
  ([ADR-0004](adr/0004-local-http-bridge.md)). Not Wails/Go: the backend is Rust and Wails hits
  the same WebKitGTK wall.
- **Mobile = the browser / PWA** — the same UI + WASM core; the device holds its share (encrypted
  IndexedDB) and signs, while build/prove/broadcast stay off-device via the helper (Architecture B),
  trustless and unable to move funds without the quorum. **Pending:** sign-after-restore in `/net`
  (restore works; reconnect-and-sign after a reload is the remaining piece).

## E. Closing the loop and depth
- **Real broadcast from the browser — in progress (Architecture B, PR #11).** The design is
  settled and the protocol built + unit-tested on both sides: devices keep the shares and sign
  over the blind relay; a helper (never sees a share) builds/proves the PCZT for the vault's own
  address, injects, broadcasts. Remaining: the live NetVault relay wiring + the end-to-end testnet
  proof (a funded browser-DKG vault). See §A and `temp/NET-REAL-BROADCAST-SCOPING.md`.
- Multi-device reconciliation (on-chain wins when the local cache diverges) — the decision core
  landed (`orchestrator::reconcile`, a pure deterministic "on-chain wins" engine, 10 destructive
  tests); the remaining work is wiring the report to the store + a fresh sync.
- Accounting depth (fiat valuation, cost basis, bookkeeping-software export).
