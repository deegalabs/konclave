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
| Network | **Mainnet, real ZEC, minimal amount** (~0.01 ZEC). Shielded receive **only** (see note) |
| Privacy | **Shielded-first** (Orchard); no telemetry; secrets never in log/disk/URL |
| Scope | Untouchable core + 3 promoted extras (memo-payslip, accounting, proposal desk) |
| License | **Dual Apache-2.0 / MIT** |
| Team | **Solo** → scope locked to the core; extras only if there is room; stretch out of scope |

> **Note on "Receive only in Orchard" (post-NU6.3).** Since NU6.3 "Ironwood" activated on
> mainnet (§5), new shielded receives land in the **Ironwood** pool at the protocol level (Orchard
> is withdraw-only going forward). The decision stands as **shielded-first, shielded-receive-only**;
> the concrete retarget of the receive path to Ironwood rides on the engine slice
> (`feat/engine-ironwood-bump`, #259), which is prepared and green but **gated on a live round-trip
> and not yet merged to `main`**. Treat the Orchard wording above as the historical framing and this
> note as the current, gated target.

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
- **Update (2026-08):** mainnet has since activated **NU6.3 "Ironwood"** (2026-07-28, block
  3,428,143), which adds the **Ironwood shielded pool** (V6 transactions). Ironwood is **live and
  safe**, and the current consensus target is **NU6.3** (build against it; the RedPallas/FROST
  spend-authorization scheme is unchanged, so the signing core carries over). The NU6.2 text above
  is the historical context for the June 2026 Orchard episode.
- **Update (2026-08-26), verified against primary sources.** Each item below was checked at
  zips.z.cash / the Zcash forum / the issuing body; anything that could only be found on social
  media or secondary press is marked as such and is NOT a basis for decisions.
  - **`zcashd` is dead. CONFIRMED.** It halts at block 3,417,100 (2026-07-18) and does not support
    NU6.3; the network was left Zebra-only deliberately
    ([end-of-life](https://zcash.github.io/zcash/user/end-of-life.html)). Build against Zebra/Zaino,
    never against a zcashd assumption ([#256](https://github.com/deegalabs/konclave/issues/256)).
  - **ZIP 326 is the rule that binds us today. CONFIRMED** ([ZIP 326](https://zips.z.cash/zip-0326),
    status Draft, NU6.3): *"A wallet MUST NOT send funds to any external receiver (including its
    own) in the Orchard pool after NU6.3 activation."* Our destination validation still asks for an
    Orchard receiver, which is the receiver this forbids
    ([#341](https://github.com/deegalabs/konclave/issues/341)).
  - **NU7 is being polled, not scheduled. CONFIRMED with a large caveat.** The coinholder vote runs
    2026-08-25 to 2026-09-14, snapshot block 3,459,350, legitimacy quorum 1,000,000 ZEC - and the
    thread says plainly *"it is a sentiment poll, not a vote"*. `draft-arya-deploy-nu7` is **Draft
    with activation heights TBD**. **NU6.3 remains the consensus target**; NU7 is a thing to watch,
    not to build against.
  - Two NU7 candidates would touch this product if it lands: **ZIP 218** caps Orchard actions per
    block (a hard ceiling on payroll outputs, see
    [#295](https://github.com/deegalabs/konclave/issues/295)), and **ZIP 2002 (Explicit Fees)**
    changes fee validation for v6+ transactions (touches our ZIP 317 work,
    [#206](https://github.com/deegalabs/konclave/issues/206)).
  - **"FROST v3 ships in NU7" is misleading.** ZIP 312 is **Draft**, category **Wallet**, with no
    target upgrade, and is not among the NU7 candidates; `frost-core v3.0.0` shipped in April 2025.
    What does matter: the Foundation's 2026 goals include finalising ZIP 312, **integrating FROST
    into `zcash-devtool`**, and publishing an **official DKG** - which would change our integration
    path, and is worth tracking rather than reacting to.
  - **Not confirmed, do not repeat:** that a CFTC hearing named Zcash (the 2026-08-20 Innovation
    Advisory Committee meeting is real and Winklevoss is a member, but no CFTC document mentions
    Zcash); that PGPZ *is* a 501(c)(4) (there is a grant application describing it as *planned*);
    a Zaino-replaces-lightwalletd date; and the Zebra CVEs circulating without a primary advisory.
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

## 8b. Incidents

When the product breaks for someone who was not testing it on purpose, it gets a postmortem in
[docs/incidents/](docs/incidents/) — **written first, registered only with the maintainer's
approval** (the rule and the template are in that folder's README).

Two things make these worth reading rather than filing: they say what is **still open**, so a
postmortem never retires an alarm while the hazard stands; and they name the **author's** mistakes,
not only the system's. Two of the three defects in the 2026-08-26 signing incident were the same
mistake in different places, and the third was introduced by the fix for the first — none of which
is visible from the code.

- [2026-08-26 · no vault could sign a second payment](docs/incidents/2026-08-26-signing-replay.md) — one defect in three readers, plus a regression from its own fix
- [2026-08-27 · the helper stopped answering](docs/incidents/2026-08-27-helper-unresponsive.md) — serial request loop; root cause still open (#375)

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
| Demo funding | ~0.01 ZEC (≈ $7.79 at $778.56/ZEC on 2026-08-26; was ≈ $4 at ~$395 on 2026-06-30) | decided |
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

**Proven on mainnet.** **15 verifiable txids** (`docs/PROOF.md` / `scripts/verify-proof.mjs`),
including the Orchard→Ironwood migration + the first Ironwood-pool spend (V6/NU6.3), a send from a
real-DKG vault, a **browser-signed** send, a **3-of-4** vault operated by someone other than the
maintainer, and - since 2026-08-26 - a **private payroll on the web path** (2 beneficiaries in one V6
transaction, `7c4c1dd5`, block 3,461,704), and a ceremony **across separate physical machines over
the internet** (`aec83baf`, block 3,460,285: proposed and approved by one operator, co-signed by
another on a different computer in a different place), and - since 2026-08-28 - a send **signed from a phone via the installed PWA** (`2d861b8f`, block 3,463,297: 2-of-2, closing signature made on an Android phone in a mobile browser, its share sealed on that phone), and - since 2026-08-29 - a send with **the relay blind to the payment** (#63: the SignRequest sealed to the devices and the ceremony carrying no cleartext PCZT, `047fe6ca`, block 3,464,505; the block shows a normal send, the relay's blindness is attested by the captured room trace, `docs/proof/2026-08-29-relay-blind.md`). Quorums proven: 2-of-2, 2-of-3, 3-of-4.
Ironwood: **proven on mainnet**. The cross-device broadcast is **no longer an open debt**.

**On "local-first", which changed shape rather than becoming false.** The closed decision in §2 is a
local-first *desktop* app, and the desktop shell exists (v0.2.0). What ships and is used is the
browser path, and that is not a retreat from the principle: the key share still never leaves the
device (sealed in the browser's own storage, signed in WASM on the device), the relay is a blind
mailbox and the helper is **view-only** and never receives, derives or stores a share. What moved is
the *delivery* - a browser instead of a binary - not where the secret lives. Read §2's "local-first
desktop" as the original intent and ADR-0005 as the delivery that carries it today.

**Signing convergence (EPIC #49) - Stages 1-2 done (2026-08-02).**
- **Stage 1 (#69):** the FROST ceremony lifted out of `NetVault` into a reusable, React-free
  **`SigningMachine`** (`ui/src/signing-machine.ts`), behavior-preserving, + a new orchestration test
  (two machines over an in-memory relay reach a verifying signature; H1 refusal fires). Validated by a
  live 2-tab DKG.
- **Stage 2 (#70):** `rearm()` + `isDone()` so one machine signs successive payments (fresh room per
  payment). `/net` unchanged.
- **Stage 3 + 4 (done, 2026-08-27, EPIC closed):** an app-level background signer on a per-vault
  signing room, the panel mounted at the shell, and the broadcast triggered from the Dashboard desk.
  Proven on mainnet with `78fe7dfa…` - ceremony start to signature response in **7 seconds**. The
  money gate stayed: the send is still a preview plus an explicit confirm, never a single click.
  What is NOT done and keeps its own issues: the cross-tab lock is still an in-process `Set`
  (#285), and the ceremony has no abort and no reload persistence (#284).

**Ceremony security (ADR-0007).** H1 transaction-swap defense = on-device ZIP-244 sighash binding
(#67, primitive proven byte-exact vs the signer). PIN-gated admission + vault fingerprint close the
invite-as-bearer concern (#67 prevention / #68 detection, both live-validated 2-tab).

**Desktop (Tauri) - RELEASED as v0.2.0 (2026-08-03).** The desktop line shipped: real `src-tauri/`
code (Tauri shell over the `orchestrator`) tagged **`v0.2.0`**, with Windows/macOS/Linux installers.
The web app stays the primary delivery (ADR-0005); desktop is the optional native shell. **Still open:**
live **per-platform hardware** validation (the GTK/WSLg window does not render here, ADR-0004).

**H1 is DONE and live, in BOTH rounds since 2026-08-27.** Every device recomputes the ZIP-244 sighash
from **its own** PCZT and signs that, refusing the ceremony if it disagrees with the requested one,
and it decodes and shows what the transaction pays before contributing a share. `SigningMachine` is
what the background signer drives, so this is the live path, not a lab one. #62 is closed.

> **This paragraph overstated the guarantee until 2026-08-27, and the correction is worth keeping.**
> The check bound round 1 only. In round 2, `onSp` overwrote the locally derived sighash with the
> coordinator's wire value **without comparing them**, and the share is computed over the
> coordinator's SigningPackage (`frost_rerandomized::sign` signs the message inside it). So a device
> displayed the transaction it had verified and signed the one it was handed. Fixed in #355: `onSp`
> now refuses a mismatch and never overwrites the local sighash. Only with that does "a hostile
> helper cannot swap the transaction under a signer" hold as written.

**Honest debts still open (§6.15).** Ordered by what they cost:

- **The helper serves one request at a time** (#375), so a five-minute send makes the whole service
  indistinguishable from dead, `/api/health` included. It took the vault down on 2026-08-27 -
  see [the postmortem](docs/incidents/2026-08-27-helper-unresponsive.md). Root cause untouched.
- **Write endpoints are unauthenticated** (#288, critical): anyone with a vault id can vote. The
  permanent damage is gone (a refusal can now be withdrawn), the authentication is not.
- **`/net` never got the replay mitigation** (#363): `NetVault.tsx` is a second, diverged ceremony
  driver whose wire type erases the ceremony tag and whose `onMessage` ignores history.
- **H2 CONFIDENTIALITY is DONE (#63), merged and proven live (2026-08-29).** The device-key handshake
  landed: each device derives a persistent comms key from its share, registers it, and the helper
  hybrid-seals the SignRequest to the seated devices; the ceremony no longer re-broadcasts the PCZT.
  The relay is blind to who a vault pays and how much (proof: `047fe6ca`, room trace). Live validation
  caught two defects unit tests missed (the `sreq` still leaked the PCZT; sealing per-device overflowed
  the relay's 128 KiB cap - fixed by hybrid sealing). What is NOT done is **ORIGIN AUTHENTICATION**:
  an outsider with the vault id can still register a key or post room messages - that is **#392**
  (authenticate the room messages / the registrant), which reuses this same device-key foundation.
- **Read access is not gated** (#267 second half): dropping `/api/vaults` closed discovery, not
  authorization. Blocked on a migration decision - 26 live vaults, invites already distributed.
- **No staging** (#370). Every fix this week was validated by spending real ZEC on mainnet, and a
  preview shares the production helper, so "try it" still means "try it on the live vaults".
- **`/net` multi-note over the live relay** (unit-tested; single-spend is live-proven), and **Tauri**
  live per-platform hardware validation (above).

**Ops + hardening (2026-08).**
- **Ironwood finals engine bump prepared (#259, branch `feat/engine-ironwood-bump`).** pczt 0.9.1 /
  `zcash_client_backend` 0.24.0-rc.6 (librustzcash) + `zcash-sign` frost-tools #593 + `zcash-devtool`
  from `main`. CI is green, but it is **gated on a live round-trip and NOT merged to `main`** -
  `engine/versions.lock` on `main` intentionally keeps the older pins until then.
- **Hosted blind helper deployed on mainnet, non-root.** The Architecture-B helper (ADR-0006 Rung A)
  runs on Railway against mainnet (~26 live vaults). The container now runs as a **non-root**
  `konclave` user: the entrypoint enters as root only to `chown` the durable Railway volume, then
  drops via `gosu` before running the share-blind helper (#265). It still never receives, derives, or
  stores a share.
- **Security-hardening cycle landed:** GitHub Actions pinned to commit SHAs and `curl | sh`
  installers removed from workflows; a script-injection vector in the desktop-release notes step
  fixed; pnpm supply-chain policies (minimum release age, dependency-trust policy, block on exotic
  sub-dependencies); and the non-root helper above.
