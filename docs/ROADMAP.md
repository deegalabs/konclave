# Konclave: Build Roadmap

> Approved phase plan. Calibrated for **solo, ~15 days** (start 2026-06-30 →
> deadline 2026-07-15 UTC), **vertical slice first**, scope locked to the core.

---

## Status - 2026-08-19 (post-hackathon)

The core runs end to end (payment + payroll: propose -> validate -> approve/refuse -> sign with
FROST -> account) and is **proven on mainnet** (11 verifiable txids, see `docs/PROOF.md`). This
cycle's work:

**Shipped**
- **Web landing** rebuilt around one objective: a photorealistic vault video, with a platform
  **install modal** (real v0.2.0 desktop binaries, one-click direct downloads) and the pitch left
  of it. The rest of the old landing moved into `/docs`.
- **Desktop coordination-mode picker** - our helper / your own helper / local, chosen at runtime
  (Settings + an ask-before-create chooser), with a **unified vault list** (local + browser-DKG
  vaults together). Tested (helper unit tests) and documented (Docs "Coordination modes").
- **Repo hygiene:** all typographic dashes (`-` `-` `-`) removed repo-wide; Portuguese code
  comments translated to English (the UI stays bilingual via i18n).
- **Five GSP critique loops -> fixes** across every surface (landing, coordination UI, the six
  money screens, and Members/Ceremonies/Proof/Lab): WCAG AA contrast on the primary CTA,
  hide-the-crypto copy, honesty reconciliations (the desktop-download claim vs docs; the Members
  multi-device note), PT/EN leaks, input validation on money/URL fields, and locale-aware dates.
  The **preview + explicit-confirm money contract was audited and is honored** - a single click
  never moves funds.
- **Cargo workspace:** the Rust crates are unified under one workspace - orchestrator aligned on
  `rusqlite 0.37` to resolve the long-deferred `links="sqlite3"` conflict (vs konclave-signer's
  `zcash_client_sqlite`); every crate compiles and orchestrator's **227 tests pass** (the
  SQLCipher store included). The 0.31 -> 0.37 bump needed no code changes.

**Gated - needs the owner's machine / explicit authorization (cannot run from CI)**
- A real **Dashboard-triggered broadcast** on mainnet (money-gated; needs a funded vault + a live
  dry-run; the final click is the owner's).
- **Live desktop (Tauri) validation** of all three coordination modes end to end.
- A **live multi-device** (not two-tab) broadcast.

**Open honest debts (§6.15, unchanged)**
- **H2:** seal the SignRequest (device-key handshake, #63).
- `/net` **multi-note** over the live relay (unit-tested; single-spend is live-proven).
- **Tauri** live **per-platform hardware** validation (the desktop app is **released as v0.2.0**,
  Windows/macOS/Linux installers; what remains open is validating each platform's installer on
  real hardware, not building the shell).

## Shipped since (2026-08-22)

- **Desktop app RELEASED as v0.2.0** (2026-08-03, git tag `v0.2.0`): a real Tauri shell
  (`src-tauri/`) wrapping the orchestrator, with Windows/macOS/Linux installers. Only the
  live per-platform hardware validation stays open (above); the shell itself is no longer roadmap.
- **Hosted blind helper is a real crate** (`helper-server/`, CI-gated): the Architecture-B
  helper (ADR-0006 Rung A) deployed on Railway, blind to shares. The native `orchestrator`
  (`konclave serve`) is the equivalent **local-mode** helper.
- **Quorum default = `2-of-3`** with a non-blocking warning badge when `n === t` (no recovery
  margin), [ADR-0010](adr/0010-quorum-redundancy-default.md).
- **Create is now an in-vault flow.** The real create path is the embedded `<NetVault embedded />`
  modal launched from `/vaults` ([ADR-0009](adr/0009-vault-ia-restructure.md)); the standalone
  `/net` route is **legacy / diagnostics** (linked from Settings), no longer a redirect target.
- **Onboarding + UX polish:** the 3-door onboarding redesign, a passphrase strength meter +
  generator, vault export/import, the recipient combobox, and the PWA update prompt + version badge.

> **Network:** mainnet is now **NU6.3 "Ironwood"** (activated 2026-07-28, block 3,428,143), live
> and safe. Historical phase text below that reads "NU6.2" describes the state at that phase; the
> current consensus target is NU6.3.

---

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

> **Current focus (2026-08-02) - the live tracker is GitHub Issues** (this file is the strategic
> shape, the issues are the work items). Active thread: **the signing convergence** (EPIC #49) so a
> payment sends **from the Dashboard**, not from `/net`.
> - **Stage 1 (#69, done):** the FROST ceremony extracted from `NetVault` into a reusable
>   `SigningMachine` (+ an orchestration test).
> - **Stage 2 (#70, done):** `rearm()` so one machine signs successive payments.
> - **Stage 3 core (#72, done):** an app-level `BackgroundSigner` + a per-vault signing room +
>   a singleton guard + an injected **governance gate** (sign-async/sync is configurable per vault
>   and changeable by a governance proposal; mechanism vs policy).
> - **Next:** Stage 3 live wiring (a background relay session on the signing room + the Dashboard
>   "Send" trigger + the governance UI), then **Stage 4** (the Dashboard-triggered broadcast), which
>   stays **money-gated** behind a live dry-run.
>
> Ceremony security landed alongside: H1 transaction-swap defense + PIN-gated admission + vault
> fingerprint (#67/#68, ADR-0007). Open security follow-up: H2 (seal the SignRequest, #63).

The core crypto is proven (real FROST over Orchard, **eight** verifiable mainnet txids incl. a
DKG-vault send, a private multi-output payroll, and - on NU6.3 activation day - an
Orchard→Ironwood migration plus the first **Ironwood-pool spend** (both V6/NU6.3, FROST 2-of-3),
and browser-side signing of a real **Ironwood** spend (the eighth txid, `3022420a…`, a V6/NU6.3
Ironwood tx). The work from here is **consolidation, robustness, and reach**, not new
cryptography. Ordered by priority.

## A. Consolidation
- Keep `main` the single trunk; land verified work through PRs; keep the proof surfaces
  consistent (see [CLAIMS.md](CLAIMS.md)).
- Browser signing of a real spend is now on `main` (the ceremony signs under the PCZT's own
  randomizer/alpha and verifies under `ak+alpha`). The `/net` "demo → real broadcast" path is
  **proven on mainnet**: **Architecture B**, a helper-assisted broadcast that is blind to
  spending. The browser devices keep the shares and sign over the blind relay; a helper (the
  hosted `helper-server`, or the native orchestrator, which never sees a share) builds and proves
  the real PCZT for the vault's own address, publishes a signing request, waits for the aggregate
  signature, injects, and broadcasts - consistent with "internal transparency, external privacy".
  A browser-DKG 2-of-2 vault signed and broadcast a real Ironwood tx this way (txid `3022420a…`,
  block 3,429,922). Still open: a broadcast across **separate physical devices** (proven so far
  with two browser tabs on one machine) and **multi-note** over the live relay (unit-tested).

## B. Network robustness - NU6.3 / Ironwood
- Ironwood introduces a **new shielded pool** ("Ironwood", V6 transactions with their own
  actions), distinct from Orchard. The FROST / RedPallas spend-authorization scheme is
  **unchanged** - an Ironwood spend is Orchard-shaped - so the FROST / DKG signing core
  carries over whole; what changes is the pool the engine and the PCZT bridge operate on.
- Because build, prove, and broadcast are delegated to `zcash-devtool`, Konclave inherits
  upstream Ironwood support once the engine is rebuilt against a librustzcash with NU6.3.
- **Code readiness - done:** the two mainnet-hardcoded network points are parameterized behind
  an explicit choice, mainnet as the default so production is unchanged -
  `konclave-signer build-payroll --network main|test` and
  `orchestrator::validate_recipient_on(addr, network)`. Tested for both networks.
- **End-to-end proven on testnet - done (out-of-repo experiment):** testnet is already past
  the Ironwood activation height, so it runs NU6.3 now. Rebuilding `zcash-devtool` against the
  Ironwood librustzcash pin lets the wallet **see and spend** Ironwood-pool funds that the
  pre-Ironwood engine is blind to. With the FROST↔PCZT bridge ported to the Ironwood pool
  (`sign_ironwood_with` / `apply_ironwood_signature`, V6 sighash), the full cycle - receive →
  build + prove for the vault's own address → FROST 2-of-3 ceremony → inject (the aggregate
  signature verifies) → broadcast → **mined into a block** - completed on testnet (tx
  `069f4260…`, block 4,202,966). This ran on a throwaway testnet vault, kept out-of-repo like the
  mainnet evidence infra; **the repo default (`main`) stays on the mainnet pre-Ironwood pin.**
- **Productization for mainnet (Option A - clean cut at activation) - DONE + PROVEN.** Ironwood
  activated on mainnet at height 3,428,143 (2026-07-28). The port (#10) was merged at activation:
  the engine pin (`engine/versions.lock`) and `konclave-signer` on the Ironwood pin, extract/inject
  pool-aware (Orchard pre-NU6.3, Ironwood post-NU6.3), C6 vectors on the Ironwood v2 format. Then
  the full cycle was **proven on mainnet** with two V6/NU6.3 FROST 2-of-3 txids: an Orchard→Ironwood
  migration (`54266f47…`, block 3,428,205) and the first Ironwood-pool spend (`36c60f1e…`, block
  3,428,246). Gotcha unblocked at activation: a single-note Orchard spend leaves an unsigned bundle
  dummy; `create-max` (spend all notes) makes every action a real spend, so there is no dummy. This
  is librustzcash **#2777** (derivation not stamped on wallet-controlled zero-value spends), already
  fixed upstream by commit `51385a15`; `create-max` is our interim workaround until the engine pin is
  bumped to include the fix.
- **Re-validated (2026-07-27):** the pin is confirmed identical to `zcash-devtool` `origin/main`
  (the reference Ironwood tool), so the PCZT wire format stays byte-for-byte compatible; the
  final librustzcash crates (zcash_primitives 0.30.0, orchard 0.15.4, pczt 0.9.1) are newer than
  what devtool main pins, so we hold and bump when devtool does. The **repo** `konclave-signer`
  (dual-pool) was re-run end to end on testnet - a 4-real-spend transaction, one FROST 2-of-3
  ceremony per spend, mined - so the branch is proven ready for the activation cut.

## C. On-device share persistence - done (web)
- **Done:** a device's share is persisted **encrypted at rest** (WebCrypto PBKDF2 → AES-GCM in
  IndexedDB, `ui/src/storage.ts`), unlocked per device by a passphrase; a member can close and
  reopen the app, restore the share, and **rejoin a signing session** without losing the vault.
- Custody invariant held: the share is stored **encrypted**, unlocked only on the device; viewing
  keys are always derived through ZIP-32 / official tooling, never as a hash of a shared value.
- **Next (with the shells):** desktop/mobile move the unlock to the OS keystore (Keychain /
  Credential Manager / Secret Service) and add passkey / biometric unlock.

## D. Multi-platform delivery (web-first; native shells optional)
**Decided: deliver web-first** - the browser + WASM + a blind relay is the universal client, so
the whole per-distro packaging matrix is optional, not required ([ADR-0005](adr/0005-web-first-delivery.md)).
One UI (`ui/`) and one crypto core (`konclave-wasm`) behind the relay:
- **Web** - browser + WASM + hosted relay (done; verified across separate machines). **Now
  installable as a PWA** (web app manifest + a network-first, update-safe service worker - the
  `/api` and `/relay` responses are never cached; the share lives only in encrypted IndexedDB).
- **Desktop (RELEASED, v0.2.0)** - a Tauri shell (`src-tauri/`) wrapping the `orchestrator`,
  shipped as native installers (Windows / macOS / Linux) at git tag `v0.2.0` (2026-08-03). What
  remains is live **per-platform hardware** validation (the dev machine's GTK/WSLg window won't
  render, [ADR-0004](adr/0004-local-http-bridge.md)). Not Wails/Go: the backend is Rust and Wails
  hits the same WebKitGTK wall.
- **Mobile = the browser / PWA** - the same UI + WASM core; the device holds its share (encrypted
  IndexedDB) and signs, while build/prove/broadcast stay off-device via the helper (Architecture B),
  trustless and unable to move funds without the quorum. Sign-after-restore in `/net` is **wired end
  to end** (the saved bundle carries the KeyPackage + group key + seat; a reloaded device rejoins a
  signing room, re-announces its original seat, and signs with the restored share - no DKG redo;
  covered by a bundle+seat test). **Remaining:** a live two-browser proof.

## E. Closing the loop and depth
- **Real broadcast from the browser - PROVEN on mainnet (Architecture B).** Devices keep the
  shares and sign over the blind relay; a helper (never sees a share) builds/proves the PCZT for
  the vault's own address, injects, broadcasts. A browser-DKG vault carried this to a confirmed
  mainnet Ironwood txid (`3022420a…`). Remaining depth: a broadcast across **separate physical
  devices** (proven so far as two tabs on one machine) and **multi-note** over the live relay
  (unit-tested). See §A.
- Multi-device reconciliation (on-chain wins when the local cache diverges) - decision core + store
  wiring + fresh-sync trigger all landed (`orchestrator::reconcile` + `Store::reconcile_proposals` +
  `server::reconcile_vault` / `POST /api/vault/reconcile`; `Superseded` terminal state; 21 tests).
  **Complete end to end:** the balance-based invalidation AND the `Sent`→`Confirmed` promotion (the
  `confirmed_txids` source is wired via `zcash-devtool wallet list-tx --json`).
- Accounting depth (fiat valuation, cost basis, bookkeeping-software export).

## F. Fully in-browser (the trustless endgame)

The direction: everything a spend needs runs **in the browser** (sync, build, prove, FROST-sign,
broadcast), so there is **no operator and no manual step** and the model is maximally trustless and
private. The custody core is already browser-native (real DKG, FROST-redpallas signing, encrypted
on-device share). What is missing is the transaction machinery, deliberately kept off the WASM build
today to stay wasm-clean (`konclave-wasm` excludes the Halo2 proving path, `zcash_primitives`, and
secp256k1/C deps on purpose).

> **Decision recorded:** [ADR-0006](adr/0006-browser-native-vault.md) formalizes this as the
> **browser-native vault** (the `/vault` operating inside `/net`), on a staircase whose rungs map
> onto the three helper stages below: **A** = the blind **hosted** helper turning `/net` into a
> self-service web vault (stage 2), **B** = the light logic and PCZT build moving into the browser,
> **C** = fully in-WASM (stage 3). The immediate milestone **M1** is Rung A plus a **cross-device**
> broadcast (two separate devices, each holding only its share) carried to a **confirmed mainnet
> txid**, with a verifiable ceremony record. That is the milestone an independent review of the
> ZecHub FROST projects (2026-07-29) named as the meaningful one, and which none of the six had
> reached.

**Three stages for the helper (each strictly more decentralized, all trustless - the helper never
sees a share and cannot move funds without the quorum's signatures):**
1. **Manual CLI (today):** `konclave net-send` builds + proves + broadcasts; the browser devices sign
   over the blind relay. Simplest form; proves the loop.
2. **Blind service / daemon:** the same helper runs as a service that watches the relay for a
   browser-initiated spend and auto-builds/proves/broadcasts. Removes the manual step, still blind.
3. **WASM-only:** the browser does sync + build + prove + sign + broadcast itself. No helper at all.

**The four capabilities to bring into WASM, by difficulty:**
- **Broadcast** (browser → lightwalletd) - smallest: grpc-web + CORS, or a blind raw-tx **forwarder**
  (trustless like the relay: it only relays a fully-signed tx, cannot alter or author one).
- **Build** the PCZT (`zcash_client_backend` construction) - medium: compile to wasm, store notes in
  IndexedDB rather than SQLite.
- **Prove** the Orchard action (Halo2) - **the make-or-break. Compile risk retired (2026-07-28
  spike):** `orchard`'s proving path (`orchard` feature `circuit` = `halo2_proofs` + `halo2_gadgets`
  + `ProvingKey`) **compiles to `wasm32-unknown-unknown`** once Halo2's `multicore`/rayon feature is
  turned off (`orchard = { default-features = false, features = ["circuit"] }` - `halo2_proofs`
  hard-errors on wasm32 without atomics when `multicore` is on). A ~2.3 MB probe `.wasm` built with
  the `ProvingKey::build` symbols present. **First perf data point (2026-07-28):** `ProvingKey::build`
  (keygen, the heaviest Halo2 setup op) takes **~21 s single-threaded** in wasm (Node/V8, ~= a
  browser). That is too slow per app-load, but keygen is **deterministic and avoidable** - ship the
  precomputed proving key (standard practice) so the browser never runs keygen; it is not a per-tx
  cost. **Still open:** the real per-transaction `create_proof` time (needs a real Orchard circuit
  witness to measure) - single-thread Halo2 is heavy, so wasm threads (atomics + COOP/COEP isolation)
  is the likely speedup path.
- **Sync** (light client in WASM) - largest: compact-block sync, trial-decryption, witness updates.

**Security invariant, unchanged at every stage:** the share stays encrypted on the device, the
vault's viewing key lives in the browser (the member already owns it), and no operator or service
ever sees a secret. Security is in **who signs** (the devices), never in who assembles the tx.

**Fallback:** if in-WASM proving is not viable yet, stage 2 (blind service) already delivers a
no-manual-step, trustless flow while the WASM proving path matures.

---

## Desktop coordination-mode picker + unified vault list - SHIPPED 2026-08-18

> Captured and shipped 2026-08-18 (after the landing-video work): #100 (runtime mode + Settings
> control), #101 (unified vault list), #102 (ask-before-create chooser). **Still open:** a live
> **desktop** validation of all three modes end to end (the Tauri window doesn't render in CI/WSL).
> The design below is what landed.

On desktop (Tauri) the coordination backend is decided at **build time** today
(`helperConfigured()` reads `VITE_HELPER_BASE`). Make it the **user's runtime choice** - all three
trustless (the helper never sees a share, never moves funds without the quorum):

1. **Our hosted helper** (default) - the blind Architecture-B helper.
2. **Your own helper** - a self-hosted helper URL (Settings field + localStorage override, so
   `helperConfigured()` becomes runtime, not build-time).
3. **Local, no helper** - the local orchestrator/bridge (`/create` → `POST {BASE}/api/vault/dkg`),
   no third party at all.

- **Ask before creating** - the create flow surfaces the mode choice up front.
- **Unified vault list** - `/vaults` branches on `netMode` (one source) today; show **local +
  helper vaults together** so a person sees every vault regardless of how it was created.
- **Works in all three** - helper (Architecture B) and local/bridge already exist; "your helper" is
  the URL field; the rest is wiring + the merged list.

Touches `api` / `helper` / `Settings` / `Vaults`. Its own branch/PR, not bundled with the landing.
Aligns with the decentralization ladder above (blind helper → your helper → local).
