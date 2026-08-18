# CLAUDE.md - Konclave

> **Project memory.** GSD methodology: documentation-first. This file is the source of
> context for any work session on Konclave. Read it before coding.
>
> **Product sources of truth (read in full, in this order):**
> 1. [docs/CONCEITO_INICIAL.md](docs/CONCEITO_INICIAL.md) - the what, the why, closed decisions, principles.
> 2. [docs/UX_E_FLUXOS.md](docs/UX_E_FLUXOS.md) - journeys, screens, links, UX direction.
> 3. [docs/LOGICA_E_REGRAS.md](docs/LOGICA_E_REGRAS.md) - states, validations, lifecycles (the specification).
>
> If anything to be done contradicts any of the three, **stop and point out the contradiction**.
> Where the docs leave something "to logistics", it is an open decision - ask, don't invent.

---

## 1. What it is

**Konclave** - the vault that decides together. A **local-first desktop app** (Tauri:
Rust shell + Vite/React) that makes it usable, for an ordinary treasurer, to create and
operate a **collective, private, single-person-proof fund vault** on the Zcash network,
using **threshold signatures (FROST)**. Two equally weighted faces: **quorum-approved
payment** and **private payroll** (a single Orchard transaction with N outputs, approved
once). *Private on the outside, transparent on the inside.*

The gap it fills is **not the cryptography** (the official engine already exists and works) -
it is the **usability layer**. Today, using FROST on Zcash requires a CLI, multiple
terminals, and manual copying of hex. Konclave is the human layer on top of the Foundation's
tools.

**Context:** ZecHub Hackathon 3.0 (2026), FROST + Accounting tracks (equal weight).
Submission deadline: **2026-07-15 UTC**. Development is **solo**.

---

## 2. CLOSED decisions (do not reopen)

From [CONCEITO_INICIAL.md §13](docs/CONCEITO_INICIAL.md) + the logistics conversation:

| Topic | Decision |
|---|---|
| Name | **Konclave** |
| Platform | **Local-first desktop via Tauri** (Rust shell + Vite/React) |
| Engine integration | **Path 1** (invoke official CLI binaries) with **Path 2 rigor** |
| Where the key lives | **The key share NEVER leaves the device** (OS secure vault). Only **public material** travels between members |
| Coordination | **Official `frostd`** (blind server - sees only public data) + QR/copy-paste fallback (stretch) |
| Key generation (product) | **Real DKG** (trusted-dealer only as slice scaffolding) |
| Network | **Mainnet, real ZEC, minimal amount** (~0.01 ZEC). Receive **only in Orchard** |
| Privacy | **Shielded-first** (Orchard); no telemetry; secrets never in log/disk/URL |
| Scope | Untouchable core + 3 promoted extras (memo-payslip, accounting, proposal desk) |
| License | **Dual Apache-2.0 / MIT** |
| Team | **Solo** → scope locked to the core; extras only if there is room; stretch out of scope |

Technical decisions assumed in logistics:
- **Dev OS:** start native on **Windows**; **WSL2** only if the tooling breaks.
- **Binaries:** compile from source, **pinned by SHA**, vendored as submodules,
  with a checksum in `engine/versions.lock` (see [ADR-0001](docs/adr/0001-closed-decisions.md)).
- **Wallet layer:** **link `zcash_client_backend`** in Rust for sync/balance/plan
  (native structured data) - shell out **only** the FROST/sign binaries.
- **Frontend:** **Vite + React** as a static bundle ([ADR-0003](docs/adr/0003-vite-over-nextjs.md)
  revised the originally considered Next.js - inapplicable to a local-first app with no server).

---

## 3. Architecture - 3 layers

```
Layer 1 - ENGINE        official Zcash Foundation tools (do NOT reimplement crypto)
   frost-client · frostd · zcash-sign · zcash-devtool (PCZT) · zcash_client_backend
        │  (binary invocation + linked library)
        ▼
Layer 2 - ORCHESTRATOR  the backend we build (Rust, inside src-tauri/)
   ceremony · signing · wallet/sync · proposals (state machine) ·
   validation (ZIP 317) · store (SQLite + keychain) · IPC (Tauri commands)
        │  (structured DTOs via Tauri commands)
        ▼
Layer 3 - UI            the interface (Vite/React)
   Intro · Create/Join vault · Dashboard · Payment/Payroll · Proposal · Ledger · Members
```

Full detail and module map: [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md).

---

## 4. The Engine - official tools (map verified 2026-06-30)

| Tool | Repo | Role |
|---|---|---|
| `frostd` | `ZcashFoundation/frost-tools` | Coordination server (blind, public material only) |
| `frost-client` | `ZcashFoundation/frost-tools` | User init, DKG/trusted-dealer, contacts, ceremony |
| `zcash-sign` | `ZcashFoundation/frost-tools` (verified) | `generate --ak` → Orchard address + UFVK; `sign` injects the FROST signature into a Ywallet/PCZT plan |
| `zcash-devtool` | `zcash/zcash-devtool` | **PCZT** suite (create/prove/sign/combine) - the envelope for the tx and the payroll |
| `frost` (core lib) | `ZcashFoundation/frost` | Reference implementation of FROST |
| `zcash_client_backend` | `zcash/librustzcash` | **Linked** in Rust: UFVK sync, balance, plan construction |

**Zcash cryptographic key:** passing **`-C redpallas`** activates **Rerandomized FROST**
(compatible with Orchard). `zcash-sign` handles the Orchard randomizer. Follow the official
tutorial **without deviation** in the slice - this is where a mistake costs real funds.

---

## 5. Network context - NU6.2 / Orchard bug (Jun 2026)

Facts (verified 2026-06-30):
- A **soundness** bug in Orchard's ZK circuit (risk of **forgery**, NOT of privacy),
  present since May 2022, discovered on 2026-05-29 by Taylor Hornby **using Opus 4.8**.
- Fixed: soft-fork (Jun 2, block 3,363,426) + **hard-fork NU6.2** (Jun 3, block
  3,364,600), which **re-enabled Orchard with the corrected circuit**. No evidence of
  exploitation.
- **Current status:** Orchard is live and safe on mainnet. **Build against NU6.2** (tooling
  and lightwalletd aware of the upgrade).
- **(Honest) narrative angle for the README:** a trustworthy shared-custody tool right after
  the confidence shock - exactly what [CONCEITO §8](docs/CONCEITO_INICIAL.md) foresees as
  narrative weight. The bug was found with Opus 4.8; Konclave is built with the same model.
  State it without overstatement.

---

## 6. Non-negotiable principles (the quality contract)

**Privacy by default**
1. Shielded-first (Orchard). A transparent destination is an explicit, warned exception.
2. Data minimization. No telemetry. Nothing collected/logged/transmitted without need.
3. Secrets never persist outside the OS secure vault. Never in plaintext on disk, log, URL, query string.
4. The coordination server is **blind** (public material only). Documented and demonstrable.
5. Encrypted memos (payslip) = sensitive data; only the recipient/UFVK reads them.
6. Internal transparency, external privacy.

**Code quality (Path 1 with Path 2 rigor)**
7. **Structured output, never "reading the screen".** Force JSON/parseable output from the binaries.
8. **Validation at every boundary** (user input, binary output, network data). Explicit failures, never silent.
9. **TDD with destructive tests** (see §8).
10. **Explicit states.** The proposal state machine is modeled and auditable.
11. **Human-readable errors** - every failure becomes a clear, actionable message in the UI.
12. **Documentation-first (GSD).** This CLAUDE.md and the docs before the code.

**Positioning honesty**
13. **Credit the Foundation's tools** explicitly.
14. **Distinguish cryptographic guarantee from product lock** (e.g. quorum-by-value and
    balance reservation are product, not protocol) - including in the copy.
15. **Do not promise what you do not deliver.** A roadmap is a roadmap.

**Execution rules (from the bootstrap prompt)**
- **No co-authorship.** No "Co-authored-by" / "Generated with Claude Code" in commits,
  PRs, code, or README. Commits go out clean, in the owner's name.
- Dual Apache-2.0 / MIT license across the whole repo.

---

## 7. The UX principle that governs the UI

**Hide the cryptography, expose the trust.** The user never sees "FROST", "DKG",
"SIGHASH" or "nonce" - they see vault, members, approval, payment. Every action that moves
funds has a **preview + explicit confirmation**; a single click never fires money. Honest,
active copy ("Propose payment" → "Approve" → "Sent"). States always visible.

---

## 8. Destructive test suite (born in Phase 3)

The code is born to pass these failure scenarios. **Honest coverage: 7 of 8 have automated
tests (the 8th, `frostd`-offline, is validated live, not in unit tests); multi-device reconciliation
is implemented and tested end to end (engine + store + the `POST /api/vault/reconcile` trigger),
**both halves wired** - the balance-based `Superseded` invalidation and the `confirmed_txids`
`Sent`→`Confirmed` promotion (from `zcash-devtool wallet list-tx --json`).**
- Insufficient quorum. - ✅ tested (proposal state machine + `409` votes)
- Corrupted / missing share. - ✅ tested (sealed-share tamper/wrong-key + FROST share repair)
- `frostd` offline. - ⚠️ validated **live only** (the ceremony talks to a real frostd; no unit test)
- Malformed transaction. - ✅ tested **at the tool-output parser boundary** (not a real malformed tx object)
- **Sapling address instead of Orchard** (risk of locked funds). - ✅ tested (authoritative `zcash_address` decode)
- Insufficient balance. - ✅ tested (against a `WalletReader`; the test uses a mock balance, not a real sync)
- Expired proposal. - ✅ tested
- Multi-device reconciliation (local cache diverges from on-chain → on-chain wins). - ✅ **decision
  core + store wiring implemented and tested** (`orchestrator::reconcile`: a pure, deterministic
  "on-chain wins" engine - promotes a `Sent` proposal whose txid confirmed, invalidates live
  reservations the freshly-synced spendable can no longer fund, FIFO by `created_at` so every device
  agrees; 10 destructive tests. `Store::reconcile_proposals` maps the cached records in and persists
  the outcomes: `Confirm`→`Confirmed`, `Invalidate`→ the new terminal `Superseded` state; 4 store
  tests. The **fresh-sync trigger** also landed: `server::reconcile_vault` + `POST /api/vault/reconcile`
  read the on-chain Orchard spendable and run the engine; 3 server tests via a `FakeWallet`). The
  `confirmed_txids` source is now wired too: `WalletReader::confirmed_txids` reads the wallet's mined
  txids from `zcash-devtool wallet list-tx --json` (parser + reconcile-confirm tests), so a `Sent`
  proposal whose txid is mined is promoted to `Confirmed`. **Both halves are complete end to end.**

> Testing multi-member solo = running N `frost-client` identities against one `frostd`.

---

## 9. Phase roadmap

Full plan: [docs/ROADMAP.md](docs/ROADMAP.md).

| Phase | Objective | Gate |
|---|---|---|
| 0 - Foundation & Docs | Repo, license, CLAUDE.md, skeleton, reality-check | - |
| 1 - Vertical Slice (mainnet) | 1st real FROST transaction confirmed via CLI | 🔴 Gate 1 |
| 2 - Migration to real DKG | Vault via DKG (key never reconstituted) | - |
| 3 - Orchestrator (backend) | State machine, validation, payroll, destructive TDD | - |
| 4 - UI (design + screens) | Token system + screens against mock | - |
| 5 - Integration | Whole core through the UI on mainnet | 🔴 Gate 2 |
| 6 - Impact extras | Memo-payslip, accounting, proposal desk | - |
| 7 - Delivery | Unicorn README, video, diagram, submission | 🏁 |

---

## 10. Logistics parameters

| Parameter | Value | Status |
|---|---|---|
| Demo funding | ~0.01 ZEC (≈ $4 at ~$395/ZEC on 2026-06-30) | decided |
| Proposal expiry deadline | 72h | configurable placeholder |
| Line limit per payroll | function of the max tx size | to fix in Phase 3 |
| Payroll CSV columns | label, address, amount, memo | to fix in Phase 3 |
| `frostd` hosting in the demo | localhost (slice) → VPS if a multi-machine demo | to decide |

---
## 11. Current state

> **Full phase-by-phase history: [docs/HISTORY.md](docs/HISTORY.md).** Keep this summary in sync
> when a work-stream closes (move the narrative to HISTORY, update the lines below). Do not let this
> section grow back into a log.

**Where it runs.** The collective vault runs end to end for **payment and payroll**: propose →
validate (continuous) → approve/refuse (real quorum, expiry) → **sign** (FROST with the shares of
whoever approved, sealed at rest) → account (ledger + itemized CSV). Browser-native `/net` creates a
vault by **real DKG across devices over a blind relay** and signs over it; a **hosted blind helper**
builds/proves/broadcasts the tx without ever seeing a share (Architecture B, ADR-0006).

**Proven on mainnet.** **8 verifiable txids** (`docs/PROOF.md` / `scripts/verify-proof.mjs`),
including the Orchard→Ironwood migration + the first Ironwood-pool spend (V6/NU6.3), a send from a
real-DKG vault, and a **browser-signed** send. Ironwood: **proven on mainnet**.

**Signing convergence (EPIC #49) - Stages 1-2 done (2026-08-02).**
- **Stage 1 (#69):** the FROST ceremony lifted out of `NetVault` into a reusable, React-free
  **`SigningMachine`** (`ui/src/signing-machine.ts`), behavior-preserving, + a new orchestration test
  (two machines over an in-memory relay reach a verifying signature; H1 refusal fires). Validated by a
  live 2-tab DKG.
- **Stage 2 (#70):** `rearm()` + `isDone()` so one machine signs successive payments (fresh room per
  payment). `/net` unchanged.
- **Stage 3 (next):** an app-level background signer + a per-vault signing room (derived from the group
  key) + a singleton lock, so a send runs **from the Dashboard** with no "go to /net". **Stage 4**
  (Dashboard-triggered broadcast) stays **money-gated** behind a live dry-run.

**Ceremony security (ADR-0007).** H1 transaction-swap defense = on-device ZIP-244 sighash binding
(#67, primitive proven byte-exact vs the signer). PIN-gated admission + vault fingerprint close the
invite-as-bearer concern (#67 prevention / #68 detection, both live-validated 2-tab).

**Honest debts still open (§6.15):** Stage 3-4 of the Dashboard-send convergence; **H2** (seal the
SignRequest - needs a device-key handshake, #63); `/net` **multi-note over the live relay**
(unit-tested; single-spend is live-proven); a **live multi-device** (not two-tab) broadcast; **Tauri**
single-binary packaging (branch `feat/tauri-shell` on GitHub - groundwork, needs real per-platform
hardware; the GTK/WSLg window does not render here, ADR-0004); **Cargo workspace** (deferred: rusqlite
version conflict).
