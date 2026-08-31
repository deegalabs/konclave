<div align="center">

# 🔐 Konclave

### One key holds the whole treasury: lose it and the money is gone, share it and one person can drain it. And on a public chain, every salary and every donor is there for a rival to read.

#### Konclave: private, collective FROST vaults on Zcash. *The vault that decides together.*

**Create and operate a shielded, threshold-signed fund vault on Zcash mainnet (quorum-approved payments and private payroll) without a command line, and without any single person ever able to move the funds or reconstruct the key.**

[![Zcash mainnet](https://img.shields.io/badge/Zcash-mainnet%20(NU6.3%20Ironwood)-e5a00d?logo=zcash&logoColor=white)](#proven-on-zcash-mainnet)
[![FROST + Accounting](https://img.shields.io/badge/ZecHub%203.0-FROST%20%2B%20Accounting-6f42c1)](#why-we-built-this)
[![License: Apache-2.0 OR MIT](https://img.shields.io/badge/license-Apache--2.0%20OR%20MIT-blue.svg)](#license)
[![Tests: 315 Rust + 245 UI](https://img.shields.io/badge/tests-315%20Rust%20%2B%20245%20UI-2ea44f.svg)](#status)
[![CI](https://github.com/deegalabs/konclave/actions/workflows/ci.yml/badge.svg)](https://github.com/deegalabs/konclave/actions/workflows/ci.yml)

Submission for **ZecHub Hackathon 3.0** · FROST + Accounting

The cryptography is the Zcash Foundation's; Konclave is the **human layer** on top. A FROST
signature looks, on-chain, like an ordinary single-signer transaction, so a group gets
**collective control, privacy, and an internal audit trail** in one: a combination no transparent
multisig (for example on an EVM chain) can offer.

</div>

---

## Try it live

- **Live app** (create a real vault, no setup): https://konclave-demo.vercel.app
- **FROST signing in the browser** (WebAssembly, ~60 ms): https://konclave-demo.vercel.app/#/signer
- **Multi-device vault, live over the internet:** https://konclave-demo.vercel.app/#/net. Open it
  in **two tabs**: one creates a vault and shows an invite code, the other joins, and together they
  run a real **Distributed Key Generation** over a hosted blind relay, then sign as a quorum.
- **Pitch video:** [Watch on YouTube](https://youtu.be/_UyWlLRnJms)

> There is no demo mode and no sample data: the hosted app only ever shows a vault you actually
> created. The proof is the mainnet transaction below: an actual 2-of-3 quorum payment, signed by a
> FROST ceremony, broadcast to Zcash mainnet.

## Why we built this

Using FROST on Zcash today means a **CLI, several terminals, and copying hex between participants
by hand**. The Zcash Foundation finished the cryptography, audited twice, and says plainly that
*wallet integration is the missing piece*: it is gated to "technically-inclined users," and
**no usable GUI for FROST on Zcash exists.** Making "easy multi-sig tools for shielded addresses
(FROST in user-facing wallets)" is a named
[Zcash Community Grants funding priority](https://zcashcommunitygrants.org/).

Konclave fills that gap for the people who need it most: a **treasurer** who must not be a single
point of failure or theft; **cooperatives, community funds, and small orgs** that decide together;
and **NGOs, journalists, and activists** for whom a *transparent* multisig is not a feature but a
liability, because it doxes the donor set, the staff salaries, and the org's structure to anyone
watching the chain.

## The problem

A group holds money together and faces two problems it cannot escape. **One:** if a single key is
lost or stolen, the treasury is gone. **Two:** on a normal blockchain, everyone can see the
salaries, the donors, and the whole structure. Zcash and FROST solve both, cryptographically, but
only a cryptographer can currently use them.

## The solution

Konclave splits a vault's Orchard spend authority into **`t`-of-`n` FROST shares** across the
members by real **Distributed Key Generation**. The whole key is **never reconstituted**, at
creation or at signing, and each share **never leaves its owner's device**. On top of that it
builds the human layer: propose, approve to a quorum, sign, broadcast, and account, in plain
language, with a preview and an explicit confirmation before anything moves. Receives in a
**shielded** pool, built against **NU6.3 (Ironwood)** and proven across the Orchard → Ironwood
upgrade on mainnet.

**The design rule: hide the cryptography, expose the trust.** You never see "FROST", "DKG", or
"SIGHASH"; you see *vault, members, approval, payment*.

## Proven on Zcash mainnet

This is not a mock. **15 verifiable mainnet transactions**, every one a real FROST ceremony with
the key never reconstituted - quorums of 2-of-2, 2-of-3 and 3-of-4. The flagship is an application-driven **quorum payment** - proposed
and approved in the app, signed by a FROST ceremony, broadcast to mainnet:

> **txid** [`43433a109d3f2a078c0a9269ccb156392ade7a1f7ac1532981611eda1e59a572`](https://mainnet.zcashexplorer.app/transactions/43433a109d3f2a078c0a9269ccb156392ade7a1f7ac1532981611eda1e59a572)

They also prove, on-chain: a **private payroll** (one shielded transaction, N encrypted
memos), a send from a **real DKG vault** (the key born distributed, never assembled), a
**browser-signed** broadcast (each browser holding only its own share over the blind relay,
*including one signed across separate physical machines, over the internet, by two people in two
places*), and the full
**Orchard → Ironwood** cycle under **NU6.3** (the migration that seeds the Ironwood pool, then the
first Ironwood-pool FROST spend on mainnet).

You don't have to trust us: run `node scripts/verify-proof.mjs` - it checks every txid against public
block explorers - or open any of them from [docs/PROOF.md](docs/PROOF.md).

## What you can do

| | |
|---|---|
| **Quorum payment** | Propose a payment → members approve → at quorum the vault signs (FROST) and sends a shielded transaction (the Ironwood pool, since NU6.3). One click never moves money; every fund-moving action has a preview and an explicit confirmation. |
| **Private payroll** | Enter the beneficiaries (or import a CSV, on the local build) → one shielded transaction with N outputs, approved **once**. Each payslip rides in an **encrypted memo** only its recipient can read. |
| **Accounting** | A full internal ledger (who proposed, who approved, states, dates) plus an **itemized CSV export** (a payroll of N is N line-items). Transparent inside, private outside. |

## Using it: step by step

The whole flow, in the app's own words (hide the cryptography, expose the trust):

1. **Create or join a vault** (`/create`, or `/net` to do it across two devices). Pick the members
   and the quorum (e.g. 2 of 3). The key is generated by a real **DKG**: it is born split across the
   devices and never exists whole, anywhere.
2. **Fund it** (`/receive`). Share the vault's shielded **Orchard address** (with a QR and a ZIP-321
   payment link) and receive ZEC.
3. **Propose a payment** (`/pay`). Enter an amount and a recipient (pick a saved beneficiary or paste
   an address). Konclave validates the address and checks the balance *before* anything is created.
4. **Approve to quorum** (`/proposals` → a proposal). Each member reviews and approves or refuses.
   Nothing moves until the agreed number of approvals is in, and proposals expire.
5. **Sign & send.** At quorum a FROST ceremony signs with **only the shares of whoever approved** and
   broadcasts one shielded transaction. A preview and an explicit confirmation guard the
   broadcast: one click never moves money, and the key is never reassembled.
6. **Payroll, optional** (`/payroll`). Import a CSV of beneficiaries → one shielded transaction with
   N outputs, approved **once**, each payslip in an encrypted memo only its recipient can read.
7. **Account** (`/ledger`). Every action lands in the internal ledger (who proposed, who approved,
   states, dates), with an itemized CSV export for the accountant.

Try the flow by creating a vault at [konclave-demo.vercel.app](https://konclave-demo.vercel.app),
or run it locally (see [**Try it**](#try-it)). The same walkthrough is available in-app under
`/docs`.

## How it works

```
  propose ─▶ approve (real M-of-N quorum, with expiry) ─▶ sign (FROST ceremony,
  only the shares of whoever approved) ─▶ broadcast (Orchard, shielded) ─▶ ledger
                              the key is never reassembled
```

Three layers, each with a clear job:

```
  Layer 3 · UI            Vite + React (vault · members · payment · payroll · proposal · ledger)
     │  structured JSON over a loopback-only bridge (127.0.0.1)
  Layer 2 · ORCHESTRATOR  Rust: proposal state machine · validation (ZIP-317, addresses) ·
     │                    payroll · sealed key custody · SQLite store · the FROST↔PCZT bridge
     │  structured I/O (never "screen-scraping" a CLI)
  Layer 1 · ENGINE        the official Zcash Foundation tools (crypto is NOT reimplemented):
                          frostd · frost-client · zcash-sign · zcash-devtool · librustzcash
```

## The step beyond: multi-device FROST in the browser

Aimed straight at the FROST track's "threshold signing wallets" idea, and at the question everyone
asks (*"can I just use it on my phone?"*), Konclave runs the whole threshold stack **in the
browser, live over the internet**, with no server ever seeing a secret.

The crate [`konclave-wasm`](konclave-wasm/) compiles rerandomized-redpallas (Orchard) FROST to
WebAssembly. Two separate devices **create one vault by a real DKG** and then **produce a verifying
FROST group signature together**, each keeping only its own share, routed through a **hosted blind
relay** ([`relay-server/`](relay-server/), on Railway) that carries only public or already-encrypted
bytes and holds no key. The one secret piece of the DKG (the round-2 packages) is **sealed
end-to-end** (X25519 → HKDF-SHA256 → XChaCha20-Poly1305), so the relay stays blind. Try it at
[`konclave-demo.vercel.app/#/net`](https://konclave-demo.vercel.app/#/net) in two tabs.

We are not aware of another Zcash FROST DKG-and-signing ceremony driven entirely from the
**browser** - an ecosystem scan (Aug 2026) found no comparable. (Zkool ships FROST shielded multisig
on Zcash, but as a native app; the in-browser ceremony is the distinction, not the multisig
primitive.) This is the path to *your key lives on your phone, the platform never has access*.

## Shared-custody safety: recovery + inheritance

A real shared vault must survive a lost device and an absent owner. Both are built on the same
FROST and blind-relay foundation and proven by tests:

- **Social recovery:** when a member loses their device, a **quorum rebuilds that member's share**
  (the Repairable Threshold Scheme). The group key is never touched, no share is revealed, and the
  repaired share is byte-identical to the lost one, and then signs a verifying 2-of-3.
- **Inheritance / dead-man's-switch:** the owner sends signed proof-of-life heartbeats; if they
  lapse past a window (plus a cancellable grace period), the quorum is authorized to **release** the
  vault to a named heir. The release is an ordinary quorum-signed payment.

## Trust model and honest limits

We distinguish **what the cryptography guarantees** from **what the product enforces**, and we do
not promise what we do not deliver.

- **Guaranteed by the protocol:** the key is never reconstituted; a quorum signature is required to
  spend; the coordination server (`frostd`, and the blind relay) is **blind**, so only public
  material crosses it; your share never leaves your device.
- **Enforced by the product (not the chain):** quorum-by-value, balance reservation, and proposal
  expiry are application policy, not on-chain-enforced rules. We say so plainly.
- **Who coordinates, and what that role is trusted with:** pure FROST does not define message
  transport, member identity, or who assembles the transaction, so *something* has to coordinate.
  Here that is the **blind helper**: it builds and proves the transaction, hosts the signing round,
  and broadcasts the result. It is trusted for **availability**, never for secrets or authority - it
  never receives a share, and it cannot spend without a quorum. The relay is a blind mailbox: since
  #63 the signing request is sealed to the members' device keys, so it carries ciphertext, not the
  recipient or the amount.
- **The AI assistant is off the money path, structurally:** [`mcp-server/`](mcp-server/) exposes a
  vault to an AI assistant that can **read** the books and **draft** a proposal, and deliberately has
  **no tool to approve, sign, or broadcast**. A drafted proposal is created *awaiting approval* and
  moves zero funds until humans act on it. The coordinator is the blind helper, not the MCP server:
  the assistant proposes and informs, the human quorum decides, and the shares sign on the devices.
- **Security posture:** shares are sealed at rest (XChaCha20-Poly1305, Argon2id-derived key, key in
  the OS keychain) and unsealed only to ephemeral `0600` files in tmpfs during signing; the local
  bridge is guarded against CSRF/DNS-rebinding; secret material is zeroized in memory; destinations
  are validated with an authoritative `zcash_address` decode before any send. See
  [`SECURITY.md`](SECURITY.md).
- **Read access is gated, not just the spend (#388, live):** a Konclave vault's on-chain data is
  shielded, but the hosted helper keeps a *view-only* copy of it and used to answer reads to anyone
  who had the public vault id. Now every member holds a per-vault secret **S** (minted at the DKG,
  sealed to members, never on the wire); the helper's reads - balance, history, members, ledger - and
  the signing room are gated behind a token derived from S, so a leaked link opens neither the books
  nor the room. The vault list shows a **Private / Open** badge and an open (not-yet-migrated) vault
  carries a plain-language warning. Stay honest about the limit: the gate is opt-in per vault (legacy
  vaults stay open until migrated, #406) and **write** endpoints are not yet authenticated (#288).
- **A leaked backup reveals nothing (#214, live):** the vault export is a single opaque blob -
  metadata, share, S and beneficiaries all encrypted under a passphrase, only a non-sensitive envelope
  in the clear - so a stolen backup file does not even disclose the vault id. Restoring it brings back
  the signing seat; recovering the vault's on-chain identity also needs the helper record (see
  [`docs/RECOVERY.md`](docs/RECOVERY.md)).

**Proven vs pending, the honest ladder:**

- ✅ **On mainnet, eight independently verifiable txids** (`node scripts/verify-proof.mjs`, or the
  [/proof](https://konclave-demo.vercel.app/#/proof) page): a **2-of-3 quorum payment** (proposed and
  approved in the app, FROST-signed, shares **sealed** at rest); a **private
  payroll**, one shielded Orchard transaction with **three outputs, each carrying its own encrypted
  memo**, 2-of-3 FROST-signed; a payment reproduced **end to end from a freshly created and funded
  vault**; a **send from a vault whose key was generated by real DKG** (three-participant DKG
  ceremony, key **never reconstituted**), then funded and spent by a FROST ceremony; on
  **NU6.3 / Ironwood** activation day, an **Orchard→Ironwood migration** plus the **first spend from
  the Ironwood pool** (both **V6/NU6.3**, 2-of-3 FROST); and a **browser-signed broadcast** - a
  browser-DKG vault whose two tabs each signed **in the browser** with only their own share over the
  blind relay, injected and broadcast by the blind helper (txid `3022420a…`, V6/NU6.3 Ironwood).
  Honest note: the quorum payment, payroll, and fresh-vault txids used a **trusted-dealer** vault;
  the DKG-vault send and the browser-signed broadcast came from keys born by real **DKG**.
- 🔬 **By dry-run** (it *signs*, it does not yet *broadcast*): the fully-sealed local signing path
  (sealed configs unsealed only to ephemeral tmpfs files).
- 🌐 **In the browser, live over the internet - broadcast PROVEN on mainnet:** multi-device DKG and
  FROST signing over a **hosted blind relay**, over a **real Orchard/Ironwood sighash** **under the
  transaction's own alpha** (the correct Orchard spend mechanism, verified under `ak+alpha`), with
  each device confirming what the tx pays (`describeOutputs`) before it signs, then broadcast by the
  **hosted blind `helper-server`** (Architecture B). Proven on mainnet: first with two tabs on one
  machine (`3022420a…`), then **across separate physical machines over the internet** (`aec83baf…`,
  block 3,460,285), two people in two places, each browser holding only its own share.
- 🔁 **Proven by test:** social recovery (RTS share repair) and the inheritance policy engine.
- 🗺️ **Roadmap, not shipped:** `/net` multi-note
  over the live relay, and social-recovery / inheritance wired into a live vault UI. *(Now shipped,
  no longer roadmap: the browser broadcast; on-device share persistence with sign-after-restore; and
  the installable desktop binary - Tauri **v0.2.0**, 2026-08-03, see
  [ADR-0004](docs/adr/0004-local-http-bridge.md).)*

On the June 2026 Orchard episode: the earlier soundness bug (fixed by the **NU6.2** hard-fork that
re-enabled Orchard with a corrected circuit) was a *forgery* risk, **not** a privacy loss, with
**no evidence of exploitation**. Konclave now targets current mainnet consensus - **NU6.3
(Ironwood)** - and is a trust-restoring tool built right after that confidence shock; we state this
without overstatement.

## How it compares

| | Bank | Transparent multisig (EVM) | CLI FROST (ZF tools) | **Konclave** |
|---|---|---|---|---|
| No single point of failure/theft | no | yes | yes | **yes** |
| Amounts and recipients private | n/a | no | yes | **yes** |
| Group makeup hidden on-chain | n/a | no | yes | **yes** |
| Usable without a command line | yes | yes | **no** | **yes** |
| Private payroll (N outputs, one approval) | no | no | no | **yes** |
| Internal audit trail + itemized export | yes | no | no | **yes** |
| Multi-device / in the browser | n/a | wallet-dependent | no | **yes (DKG live)** |

## Tech stack

| Layer | Technology |
|---|---|
| UI | Vite + React + TypeScript (HashRouter static bundle), dependency-free i18n (PT-BR + EN) |
| Orchestrator | Rust: proposal state machine, ZIP-317/address validation, payroll, SQLite/**SQLCipher** store, XChaCha20-Poly1305 + Argon2id sealing, OS keychain |
| Browser signer | `konclave-wasm`: rerandomized-redpallas FROST + DKG + ECIES sealing + recovery, compiled to WebAssembly |
| Blind relay | `relay-server`: standalone `tiny_http` mailbox (CORS, opaque messages), hosted on Railway |
| Blind helper | `helper-server`: the Architecture-B helper ([ADR-0006](docs/adr/0006-browser-native-vault.md) Rung A) - given a vault's view-only UFVK + a signing request it builds/proves the PCZT, waits for the browsers' signatures, injects and broadcasts; **blind to shares**, hosted on Railway as a **non-root** container (the native `orchestrator` is the local-mode equivalent) |
| Engine (not reimplemented) | ZF `frostd` · `frost-client` · `zcash-sign` · `zcash-devtool` · `librustzcash` (`zcash_client_backend` linked) |
| Deploy | Vercel (UI, git auto-deploy) · Railway (relay) · Zcash mainnet (the real path) |

## Try it

No engine, no funds, no setup: a console walkthrough of every use case against the **real** backend
(in-process, no server):

```sh
cargo run --manifest-path orchestrator/Cargo.toml --example simulate
```

It prints the whole flow: the vault, authoritative address safety, propose → approve to quorum, a
refusal, a private payroll (N beneficiaries), and the itemized ledger/CSV.

Run the full app locally (browser via a local bridge; live balance/signing needs the Zcash
Foundation engine binaries built per [`engine/versions.lock`](engine/versions.lock)):

```sh
npm --prefix ui ci && npm --prefix ui run build
cargo run --manifest-path orchestrator/Cargo.toml --bin konclave -- serve --web ui/dist
# then open the printed http://127.0.0.1:4762
```

The multi-device network (two tabs make one vault, then sign) works against the local server at
`http://127.0.0.1:4762/#/net`, or live on the hosted app above.

## Project structure

```
konclave/
├── orchestrator/    Rust backend: domain (money · proposal · payroll · validation · address) ·
│                    orchestration (ceremony · dkg · send · signer · pczt · wallet) · store ·
│                    secrets · the loopback HTTP bridge · the blind relay
├── konclave-wasm/   FROST redpallas + DKG + ECIES sealing + RTS recovery → WebAssembly (the browser)
├── konclave-signer/ the FROST↔PCZT bridge (resolves the pczt 0.5↔0.7 gap; born in the slice)
├── relay-server/    the standalone, hosted blind relay (CORS, opaque messages)
├── helper-server/   the hosted, share-blind Architecture-B helper (build/prove/broadcast; ADR-0006 Rung A)
├── src-tauri/       the Tauri desktop shell wrapping the orchestrator (released as v0.2.0)
├── ui/              Vite + React: Dashboard · Payment · Payroll · Proposal · Ledger · Members · /net · /signer
├── engine/          pinned engine versions (versions.lock)
└── docs/            ARCHITECTURE · ROADMAP · VERTICAL_SLICE · DIAGRAMS · ADRs
```

## Status

A working, mainnet-proven prototype. The core runs through the UI for **payment and payroll**:
propose → validate (continuous) → approve/refuse (real quorum, with expiry) → **sign (FROST with the
shares of whoever approved, sealed at rest)** → account (ledger + itemized CSV). A desktop app also
ships as **Tauri v0.2.0** (Windows/macOS/Linux installers; live per-platform hardware validation is
the open item). CI gates the whole repo on every push (fmt + clippy `-D warnings` + tests across the
Rust workspace crates, a wasm browser build, and the UI lint/test/build). What is shipped, dry-run, or
roadmap is in the honest ladder above and tracked in [`docs/ROADMAP.md`](docs/ROADMAP.md).

## Built on the Zcash Foundation's tools

Konclave does **not** reimplement cryptography. It stands on
[frost-tools](https://github.com/ZcashFoundation/frost-tools) (`frostd`, `frost-client`,
`zcash-sign`), the reference [`frost`](https://github.com/ZcashFoundation/frost) crate,
[zcash-devtool](https://github.com/zcash/zcash-devtool), and
[librustzcash](https://github.com/zcash/librustzcash), adding the usability, orchestration, and
accounting layer on top. Thank you to the Zcash Foundation and the wider Zcash community.

## Documentation

- **[docs/GUIDE.md](docs/GUIDE.md): the complete guide** - use cases, domain model, state machine, sequence diagrams, step-by-step, process explanations, and tips
- [SUBMISSION.md](SUBMISSION.md): the hackathon submission write-up · [DEPLOY.md](DEPLOY.md): hosting and CI
- [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md): the three layers · [docs/ROADMAP.md](docs/ROADMAP.md): build plan
- [docs/DIAGRAMS.md](docs/DIAGRAMS.md): system flow in Mermaid · [docs/VERTICAL_SLICE.md](docs/VERTICAL_SLICE.md): the first mainnet transaction
- [SECURITY.md](SECURITY.md): posture and reporting · [CLAUDE.md](CLAUDE.md): project memory and context

## License

Dual **Apache-2.0** / **MIT**, at your choice (mirrors the Rust/Zcash ecosystem).
See [LICENSE-APACHE](LICENSE-APACHE) and [LICENSE-MIT](LICENSE-MIT).

<div align="center">
<sub>Built on Zcash and FROST · ZecHub Hackathon 3.0 · Private outside, transparent inside</sub>
</div>
