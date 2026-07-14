# CLAUDE.md — Konclave

> **Project memory.** GSD methodology: documentation-first. This file is the source of
> context for any work session on Konclave. Read it before coding.
>
> **Product sources of truth (read in full, in this order):**
> 1. [docs/CONCEITO_INICIAL.md](docs/CONCEITO_INICIAL.md) — the what, the why, closed decisions, principles.
> 2. [docs/UX_E_FLUXOS.md](docs/UX_E_FLUXOS.md) — journeys, screens, links, UX direction.
> 3. [docs/LOGICA_E_REGRAS.md](docs/LOGICA_E_REGRAS.md) — states, validations, lifecycles (the specification).
>
> If anything to be done contradicts any of the three, **stop and point out the contradiction**.
> Where the docs leave something "to logistics", it is an open decision — ask, don't invent.

---

## 1. What it is

**Konclave** — the vault that decides together. A **local-first desktop app** (Tauri:
Rust shell + Vite/React) that makes it usable, for an ordinary treasurer, to create and
operate a **collective, private, single-person-proof fund vault** on the Zcash network,
using **threshold signatures (FROST)**. Two equally weighted faces: **quorum-approved
payment** and **private payroll** (a single Orchard transaction with N outputs, approved
once). *Private on the outside, transparent on the inside.*

The gap it fills is **not the cryptography** (the official engine already exists and works) —
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
| Coordination | **Official `frostd`** (blind server — sees only public data) + QR/copy-paste fallback (stretch) |
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
  (native structured data) — shell out **only** the FROST/sign binaries.
- **Frontend:** **Vite + React** as a static bundle ([ADR-0003](docs/adr/0003-vite-over-nextjs.md)
  revised the originally considered Next.js — inapplicable to a local-first app with no server).

---

## 3. Architecture — 3 layers

```
Layer 1 — ENGINE        official Zcash Foundation tools (do NOT reimplement crypto)
   frost-client · frostd · zcash-sign · zcash-devtool (PCZT) · zcash_client_backend
        │  (binary invocation + linked library)
        ▼
Layer 2 — ORCHESTRATOR  the backend we build (Rust, inside src-tauri/)
   ceremony · signing · wallet/sync · proposals (state machine) ·
   validation (ZIP 317) · store (SQLite + keychain) · IPC (Tauri commands)
        │  (structured DTOs via Tauri commands)
        ▼
Layer 3 — UI            the interface (Vite/React)
   Intro · Create/Join vault · Dashboard · Payment/Payroll · Proposal · Ledger · Members
```

Full detail and module map: [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md).

---

## 4. The Engine — official tools (map verified 2026-06-30)

| Tool | Repo | Role |
|---|---|---|
| `frostd` | `ZcashFoundation/frost-tools` | Coordination server (blind, public material only) |
| `frost-client` | `ZcashFoundation/frost-tools` | User init, DKG/trusted-dealer, contacts, ceremony |
| `zcash-sign` | `ZcashFoundation/frost-tools` (verified) | `generate --ak` → Orchard address + UFVK; `sign` injects the FROST signature into a Ywallet/PCZT plan |
| `zcash-devtool` | `zcash/zcash-devtool` | **PCZT** suite (create/prove/sign/combine) — the envelope for the tx and the payroll |
| `frost` (core lib) | `ZcashFoundation/frost` | Reference implementation of FROST |
| `zcash_client_backend` | `zcash/librustzcash` | **Linked** in Rust: UFVK sync, balance, plan construction |

**Zcash cryptographic key:** passing **`-C redpallas`** activates **Rerandomized FROST**
(compatible with Orchard). `zcash-sign` handles the Orchard randomizer. Follow the official
tutorial **without deviation** in the slice — this is where a mistake costs real funds.

---

## 5. Network context — NU6.2 / Orchard bug (Jun 2026)

Facts (verified 2026-06-30):
- A **soundness** bug in Orchard's ZK circuit (risk of **forgery**, NOT of privacy),
  present since May 2022, discovered on 2026-05-29 by Taylor Hornby **using Opus 4.8**.
- Fixed: soft-fork (Jun 2, block 3,363,426) + **hard-fork NU6.2** (Jun 3, block
  3,364,600), which **re-enabled Orchard with the corrected circuit**. No evidence of
  exploitation.
- **Current status:** Orchard is live and safe on mainnet. **Build against NU6.2** (tooling
  and lightwalletd aware of the upgrade).
- **(Honest) narrative angle for the README:** a trustworthy shared-custody tool right after
  the confidence shock — exactly what [CONCEITO §8](docs/CONCEITO_INICIAL.md) foresees as
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
11. **Human-readable errors** — every failure becomes a clear, actionable message in the UI.
12. **Documentation-first (GSD).** This CLAUDE.md and the docs before the code.

**Positioning honesty**
13. **Credit the Foundation's tools** explicitly.
14. **Distinguish cryptographic guarantee from product lock** (e.g. quorum-by-value and
    balance reservation are product, not protocol) — including in the copy.
15. **Do not promise what you do not deliver.** A roadmap is a roadmap.

**Execution rules (from the bootstrap prompt)**
- **No co-authorship.** No "Co-authored-by" / "Generated with Claude Code" in commits,
  PRs, code, or README. Commits go out clean, in the owner's name.
- Dual Apache-2.0 / MIT license across the whole repo.

---

## 7. The UX principle that governs the UI

**Hide the cryptography, expose the trust.** The user never sees "FROST", "DKG",
"SIGHASH" or "nonce" — they see vault, members, approval, payment. Every action that moves
funds has a **preview + explicit confirmation**; a single click never fires money. Honest,
active copy ("Propose payment" → "Approve" → "Sent"). States always visible.

---

## 8. Destructive test suite (born in Phase 3)

The code is born to pass these failure scenarios:
- Insufficient quorum.
- Corrupted / missing share.
- `frostd` offline.
- Malformed transaction.
- **Sapling address instead of Orchard** (risk of locked funds).
- Insufficient balance.
- Expired proposal.
- Multi-device reconciliation (local cache diverges from on-chain → on-chain wins).

> Testing multi-member solo = running N `frost-client` identities against one `frostd`.

---

## 9. Phase roadmap

Full plan: [docs/ROADMAP.md](docs/ROADMAP.md).

| Phase | Objective | Gate |
|---|---|---|
| 0 — Foundation & Docs | Repo, license, CLAUDE.md, skeleton, reality-check | — |
| 1 — Vertical Slice (mainnet) | 1st real FROST transaction confirmed via CLI | 🔴 Gate 1 |
| 2 — Migration to real DKG | Vault via DKG (key never reconstituted) | — |
| 3 — Orchestrator (backend) | State machine, validation, payroll, destructive TDD | — |
| 4 — UI (design + screens) | Token system + screens against mock | — |
| 5 — Integration | Whole core through the UI on mainnet | 🔴 Gate 2 |
| 6 — Impact extras | Memo-payslip, accounting, proposal desk | — |
| 7 — Delivery | Unicorn README, video, diagram, submission | 🏁 |

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

**Phase 1 (Vertical Slice) — ✅ GATE 1 ACHIEVED (2026-07-01).**
Konclave's first 2-of-3 FROST transaction on **mainnet**:
txid `f63ee64d7bc086a8286631d03936ec2ca2ca57f4e4c63712fc95c1f02c522360` (block 3,396,616).
Full flow and lessons in [docs/VERTICAL_SLICE.md](docs/VERTICAL_SLICE.md).

- **Environment:** WSL2/Ubuntu (Windows without a C/C++ toolchain). rustc 1.96.1, clang 21, cmake, protoc.
- **Engine:** `frost-tools` @ `3d2985c` (frostd/frost-client/zcash-sign) + `zcash-devtool`
  @ `91ba536` (wallet/sync/PCZT/broadcast), compiled. Pins in
  [engine/versions.lock](engine/versions.lock).
- **The bridge (`konclave-signer`):** built and proven — it resolves the **integration gap**
  between frost-tools (pczt 0.5) and zcash-devtool (pczt 0.7). It is the **birth of the
  Orchestrator**. See [ADR-0002](docs/adr/0002-pczt-frost-bridge.md).
- **Proven flow:** trusted-dealer 2-of-3 (redpallas) → Orchard address + UFVK →
  funded with real ZEC → sync → PCZT create/prove → `konclave-signer extract` →
  FROST ceremony via `frostd` (TLS) → `konclave-signer inject` → `pczt send` → mainnet.
- **⚠️ Security debt:** `frost-client` stores shares in **plaintext** in
  `~/.local/frost/credentials.toml` → encrypt/keychain in Phase 3.

**Phase 2 (real DKG) — ✅ COMPLETE (2026-07-01).** Vault generated by **Distributed Key
Generation** (3 participants via `frostd`), the key **never reconstituted**. DKG group:
`0ab93649e62dd68858ed57af1e7f7743cc2a4912110d7fb547d35c8c8494ee34` → Orchard address
`u1t2qphc0v…836yl2`. Shares validated by a 2-of-3 signing ceremony. DKG flow
in [docs/VERTICAL_SLICE.md](docs/VERTICAL_SLICE.md).

**Phase 3 (Orchestrator) — 3.1–3.3 ✅ COMPLETE.** Crate `orchestrator/` (Rust, TDD),
**51 green destructive tests**:
- **3.1 Domain:** `money` (checked Zatoshis), `proposal` (state machine §6),
  `validation` (ZIP 317, memo, payroll).
- **3.2 Orchestration:** `tools`/`wallet`/`signer`/`pczt`/`ceremony` — they wrap the
  binaries with structured output (parsers tested against the slice's real output).
- **3.3 Security + store:** `secrets` (XChaCha20-Poly1305 seals the shares at rest; keychain
  via trait; ephemeral 0600 file). **Settled in 5-E**: the live ceremony path came to use
  **sealed** `frost-client` configs, unsealed only to ephemeral 0600 files in tmpfs during
  signing — no plaintext share on disk. `store` (embedded SQLite: vaults, proposals, votes).

- **3.4 Payroll:** `payroll` (N-output plan, `import_csv`, aggregate validation) +
  `money::from_zec_str`. The **Tauri commands (IPC)** are left for the **integration
  (Phase 5)**, when the Tauri shell exists — building them without the frontend would be an
  untestable stub.

**Backend state:** `orchestrator/` complete across domain + orchestration + security +
store + payroll, **59 green destructive tests**. Only the Tauri shell + IPC remain (in
integration). Build: WSL2, `CARGO_TARGET_DIR` outside the repo (code versioned; `ktarget`
only in WSL).

**Phase 4 (UI/design) — ✅ COMPLETE.** Design system **"Lacre"** (archival paper,
oxblood, Archivo + mono, secrecy banner, wax seal) in `ui/src/lacre.css`; a navigable
app in Vite + React + TS (HashRouter): Dashboard, Intro, Ceremony, New Payment,
New Payroll, Proposal, Sent, Ledger. See [ADR-0003](docs/adr/0003-vite-over-nextjs.md).

**Phase 5c (UI ↔ core integration) — ✅ pivot complete (2026-07-01).**
- **WSLg go/no-go failed:** the GTK/Tauri window does not render on this machine (icon in
  the taskbar, no content; not even software rendering fixes it). Recorded in
  [ADR-0004](docs/adr/0004-local-http-bridge.md).
- **Pivot:** instead of Tauri IPC, the Orchestrator exposes a **local loopback HTTP bridge**
  (`konclave serve`, a new bin in the crate; `src/server.rs`, dep `tiny_http`) that serves
  the UI bundle **+ the `/api/*` API** wired to the tested core. Binds **only on 127.0.0.1**.
- **Proven end to end:** the **Windows** browser → the server on **WSL** via
  `localhost:4762` (health, 2-of-3 vault, proposals, statics). **69 green tests**
  (10 new for `server::handle`, including destructive ones: 405/404-json/403-traversal/502).
- **UI wired to live data:** `ui/src/api.ts` (client with a fallback to the mock) + Vite
  proxy `/api`; the Dashboard shows the real vault/proposals with a "● live" seal.
- **Launcher:** `scripts/konclave.ps1` (Windows) + `scripts/_serve.sh` (WSL) — it builds,
  brings up the bridge, and opens the browser.
- **Tauri packaging (single desktop binary):** moved to the **roadmap** (ADR-0004) —
  the local-first guarantee does not change, only the delivery form.

**Phase 5d (end-to-end write flow through the UI) — ✅ COMPLETE (2026-07-01).**
The whole "propose → approve → sign → send" track through the application:
- **Live balance:** `/api/balance` wired to the slice wallet (re-synced; 90000
  spendable zat). The Dashboard shows the real balance.
- **Create/approve/refuse:** `POST /api/proposals` (boundary validation + spend guard
  against the real balance) and `POST /api/proposals/{id}/approve|refuse` (authoritative
  state machine; 409 on a conflicting/out-of-state vote). The `NewPayment` and `Proposal`
  screens wired to live data. **88 green tests.**
- **Ceremony + send:** `orchestrator/src/send.rs` chains the tested wrappers
  (pczt create/prove/send · konclave-signer extract/inject · frostd coordinator +
  concurrent participants) into a Ready→Sent flow, with a **dry-run** that signs without
  broadcasting. Exposed at `POST /api/proposals/{id}/send` (enabled by `--ceremony`).
- **🏁 First application-driven mainnet tx (no longer manual CLI):**
  txid `43433a109d3f2a078c0a9269ccb156392ade7a1f7ac1532981611eda1e59a572` — a 2-of-3
  quorum-approved payment, signed by a FROST ceremony server-side and broadcast, all
  through the HTTP bridge. The key was **never reconstituted**.

**Accounting trail — ✅ functional (2026-07-01).** `store::list_all_proposals` (full
ledger, terminal states included); `GET /api/ledger` (JSON) + `GET /api/ledger.csv`
(**itemized export**: a single payment = 1 entry; a payroll of N = **N entries**, one
per beneficiary, with RFC-4180 escaping). The `Ledger` screen wired to live data with CSV
export + print/PDF. Accounting redesign (document / accrual / draft / beneficiary-entity)
planned in [temp/REDESENHO_FOLHA.md](temp/REDESENHO_FOLHA.md).

**Phase 5 — coherence, payroll, and robustness (2026-07-01):**
- **5-A** real vault (the app stopped showing a fake seed; the address/group are now = those
  of the wallet and the ceremony).
- **5-B** payroll through the UI: **propose + approve** (editable document, accrual period,
  local draft); **multi-output engine** (`konclave-signer build-payroll`, which links
  `zcash_client_backend` — §2) + **multi-signature ceremony** (one FROST signature per real
  spend) — the payroll **actually signs**.
- **5-C** error states: address warnings, **technical errors → human messages** (§6.11),
  proposal **expiry** (§6.3).
- **101 green tests.**

**Phase 5 — identity and security (2026-07-01):**
- **5-D** members and beneficiaries as **entities**: real members (name + FROST pubkey) +
  a Members screen; beneficiary registry with pickers; and **approval ↔ the share that
  signs** — the ceremony resolves the configs of **whoever approved** (proven: approving as
  Carol makes `carol.toml` sign).
- **5-E** shares **stop being in plaintext**: sealed configs (XChaCha20-Poly1305,
  `konclave seal`) and unsealed only to **ephemeral 0600 files in tmpfs** during signing;
  the slice's plaintexts were removed (proven by a dry-run with only the `.sealed` files).
  Key custody: a 0600 file (the product uses the OS keychain).
- **5-F** **create a vault via DKG through the UI** (`orchestrator/src/dkg.rs`,
  `POST /api/vault/dkg`, the `Ceremony` screen): init → contact exchange → concurrent DKG
  (frostd, RedPallas) → group → `zcash-sign` (Orchard address + UFVK) → view-only wallet →
  **sealed shares** (5-E). The key is **never reconstituted**. Proven live (CLI and HTTP):
  a new 2-of-3 vault with a real address/UFVK and sealed configs.
- **110 green tests. Phase 5 (Gate 2) — full track.**

**Real product state (no overclaim):** the core runs through the UI for **payment and
payroll** — propose → validate (continuous) → approve/refuse (real quorum, expiry) → **sign
(FROST with the shares of whoever approved, sealed at rest)** → account (ledger + itemized
CSV). **Proven on mainnet:** 1 **single payment** (txid `43433a10…`). **Proven only by
dry-run (signs, does NOT broadcast):** the multi-output payroll and the sealed path — the
**real broadcasts of the payroll/sealed path have not yet been done**.

**Honest debts STILL OPEN (do not promise what you do not deliver, §6.15):**
- **Sending from a freshly created DKG vault** requires pointing the ceremony at its configs
  (the server uses a single ceremony); the **funded demo** stays on the slice's
  trusted-dealer vault. DKG **creation** (5-F) is complete; **sending** from a new DKG vault
  is the follow-up.
- **Real broadcast** of the payroll and the sealed path are pending; **Tauri** packaging is
  roadmap (ADR-0004).
- ✅ **Settled:** cosmetic member identity (5-D.3), plaintext shares (5-E), and
  DKG-not-wired-into-the-UI (5-F truly creates a vault via DKG).

**Next:** Phase 6 (extras) · Phase 7 (README/video/diagram/mock showcase) · follow-ups
(DKG vault send · real broadcasts).

---

**Phase 8 — Polish & standardization — 🔧 IN PROGRESS on branch `polish/foundation`
(2026-07-08, not yet merged; 21 commits, CI-green, 129 tests).** A hardening + standardization
pass that does NOT touch the crypto core. Highlights:
- **OSS foundation:** CI (fmt + clippy `-D warnings` + test on both crates + UI lint/build),
  `SECURITY.md` + internal `SECURITY_AUDIT.md`, CONTRIBUTING/CoC, editorconfig/nvmrc/rustfmt.
- **Security (audit Round 1):** **C1** CSRF/DNS-rebinding on the loopback bridge FIXED
  (`handle_secured`: Host gate + per-session token); **M1** stop serving the UFVK; **M3**
  delete-vault name confirmation enforced server-side; **H1** passphrase entropy raised
  (Argon2id, 6 words); **C3** DKG cleartext only in tmpfs + RAII guard; **C2** sealing key in
  the OS keychain (`KeychainStore` behind `KeyStore`; `seal --keychain` / `sealing_keychain_id`;
  keyring pinned with no backend feature, mock-tested); **M2** authoritative address guard
  (`address::validate_recipient` via `zcash_address` — decode + receiver-pool + network check,
  wired into both proposal paths so a Sapling-only/wrong-network/malformed destination is a 400
  before the builder; 7 unit + 2 server tests); **L2** local DB encrypted at rest (SQLCipher via
  `bundled-sqlcipher-vendored-openssl`; `Store::open_keyed` + `serve --db-keychain <id>` with the
  key from the C2 keychain; non-breaking — plaintext DBs still open; protects vault metadata +
  UFVK; 3 store tests, verified live). Open: C6 signer tests (funds-blocked — needs a real
  Orchard PCZT vector).
- **Bugs fixed:** real `created_at` timestamp (kills the expiry/date display bugs), tofu icons,
  self-hosted fonts (local-first), shared `format.ts`.
- **Standardization:** repo is **English** (folders `rosto→ui`, `orquestrador→orchestrator`,
  `motor→engine`; screens + routes + components English; comments + backend strings + versioned
  docs translated). **UI is bilingual** via a dependency-free i18n (PT-BR default + EN, 377
  keys/locale, a language toggle).
- **Design system (GSP):** ran the GSP brand pipeline (`.design/branding/konclave/`) in
  consolidate mode (kept the current dark + blue `#57a6ff`) → one truthful token layer +
  `STYLE.md`, applied to the code (merged the 3 CSS systems, flattened, on-brand favicon).
- **Accessibility:** WCAG 2.2 AA pass — the tarja and all nav/rows are keyboard-operable,
  modals are real dialogs, live regions, focus-visible, reduced-motion.

Remaining polish backlog (see `temp/ROADMAP-EXECUCAO.md`): Tier 2 security — only **C6 signer
tests** left (funds-blocked — needs a real Orchard PCZT vector); M2/C2/C3/L2/M1 all closed.
Cargo workspace still deferred (rusqlite 0.31 vs 0.35 / libsqlite3 conflict). Tier 3 (remaining
a11y moderates). Engine binaries ARE built on this machine now
(`~/ktarget-engine`: zcash-devtool, frostd; frost-tools compiled). The `frostd` readiness
handshake replaced the fixed sleep in the DKG/send ceremony.
