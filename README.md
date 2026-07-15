<div align="center">

# 🔐 Konclave

### One key holds the whole treasury: lose it and the money is gone, share it and one person can drain it. And on a public chain, every salary and every donor is there for a rival to read.

#### Konclave: private, collective FROST vaults on Zcash. *The vault that decides together.*

**Create and operate a shielded, threshold-signed fund vault on Zcash mainnet (quorum-approved payments and private payroll) without a command line, and without any single person ever able to move the funds or reconstruct the key.**

[![Zcash mainnet](https://img.shields.io/badge/Zcash-mainnet%20(NU6.2)-e5a00d?logo=zcash&logoColor=white)](#proven-on-zcash-mainnet)
[![FROST + Accounting](https://img.shields.io/badge/ZecHub%203.0-FROST%20%2B%20Accounting-6f42c1)](#why-we-built-this)
[![License: Apache-2.0 OR MIT](https://img.shields.io/badge/license-Apache--2.0%20OR%20MIT-blue.svg)](#license)
[![Tests: 183 Rust + 23 UI](https://img.shields.io/badge/tests-183%20Rust%20%2B%2023%20UI-2ea44f.svg)](#status)
[![CI](https://github.com/deegalabs/konclave/actions/workflows/ci.yml/badge.svg)](https://github.com/deegalabs/konclave/actions/workflows/ci.yml)

Submission for **ZecHub Hackathon 3.0** · FROST + Accounting

The cryptography is the Zcash Foundation's; Konclave is the **human layer** on top. A FROST
signature looks, on-chain, like an ordinary single-signer transaction, so a group gets
**collective control, privacy, and an internal audit trail** in one: a combination no transparent
multisig (for example on an EVM chain) can offer.

</div>

---

## Demo

- **Live app** (demo data, no setup): https://konclave-demo.vercel.app
- **FROST signing in the browser** (WebAssembly, ~60 ms): https://konclave-demo.vercel.app/#/signer
- **Multi-device vault, live over the internet:** https://konclave-demo.vercel.app/#/net. Open it
  in **two tabs**: one creates a vault and shows an invite code, the other joins, and together they
  run a real **Distributed Key Generation** over a hosted blind relay, then sign as a quorum.
- **Pitch video:** [Watch on YouTube](https://youtu.be/_UyWlLRnJms)

> The hosted app runs on demo data. The real proof is the mainnet transaction below: an actual
> 2-of-3 quorum payment, signed by a FROST ceremony, broadcast to Zcash mainnet.

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
language, with a preview and an explicit confirmation before anything moves. Receives only in
**Orchard** (shielded), built against **NU6.2**.

**The design rule: hide the cryptography, expose the trust.** You never see "FROST", "DKG", or
"SIGHASH"; you see *vault, members, approval, payment*.

## Proven on Zcash mainnet

This is not a mock. A **2-of-3 quorum payment**, proposed and approved in the app, signed by a real
**FROST ceremony**, and broadcast to **Zcash mainnet**, with the key never reconstituted:

> **txid** [`43433a109d3f2a078c0a9269ccb156392ade7a1f7ac1532981611eda1e59a572`](https://mainnet.zcashexplorer.app/transactions/43433a109d3f2a078c0a9269ccb156392ade7a1f7ac1532981611eda1e59a572)

(The first Konclave FROST transaction, a CLI-driven Gate-1 slice, is
[`f63ee64d…c522360`](https://mainnet.zcashexplorer.app/transactions/f63ee64d7bc086a8286631d03936ec2ca2ca57f4e4c63712fc95c1f02c522360), block 3,396,616.)

You don't have to trust us: open the txid in the explorer.

## What you can do

| | |
|---|---|
| **Quorum payment** | Propose a payment → members approve → at quorum the vault signs (FROST) and sends a shielded Orchard transaction. One click never moves money; every fund-moving action has a preview and an explicit confirmation. |
| **Private payroll** | Import a CSV of beneficiaries → one shielded Orchard transaction with N outputs, approved **once**. Each payslip rides in an **encrypted memo** only its recipient can read. |
| **Accounting** | A full internal ledger (who proposed, who approved, states, dates) plus an **itemized CSV export** (a payroll of N is N line-items). Transparent inside, private outside. |

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

To our knowledge, a first for Zcash: a full DKG-and-signing FROST ceremony driven entirely from the
browser. This is the path to *your key lives on your phone, the platform never has access*.

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
- **Security posture:** shares are sealed at rest (XChaCha20-Poly1305, Argon2id-derived key, key in
  the OS keychain) and unsealed only to ephemeral `0600` files in tmpfs during signing; the local
  bridge is guarded against CSRF/DNS-rebinding; secret material is zeroized in memory; destinations
  are validated with an authoritative `zcash_address` decode before any send. See
  [`SECURITY.md`](SECURITY.md).

**Proven vs pending, the honest ladder:**

- ✅ **On mainnet, four independently verifiable txids** (`node scripts/verify-proof.mjs`, or the
  [/proof](https://konclave-demo.vercel.app/#/proof) page): a **2-of-3 quorum payment** (proposed and
  approved in the app, FROST-signed, from a **real-DKG** vault, shares **sealed**); a **private
  payroll**, one shielded Orchard transaction with **three outputs, each carrying its own encrypted
  memo**, 2-of-3 FROST-signed; and a payment reproduced **end to end from a freshly created and funded
  vault**. Honest note: the payroll and fresh-vault txids used a **trusted-dealer** vault; the
  app-driven payment used DKG.
- 🔬 **By dry-run** (it *signs*, it does not yet *broadcast*): the fully-sealed signing path (sealed
  configs unsealed only to ephemeral tmpfs files).
- 🌐 **In the browser, live over the internet:** multi-device DKG and FROST signing over a **hosted
  blind relay**. The signature is real; the message is a **test digest**, not yet a broadcast tx.
- 🔁 **Proven by test:** social recovery (RTS share repair) and the inheritance policy engine.
- 🗺️ **Roadmap, not shipped:** sending from a fresh **DKG** vault (the payroll evidence used a
  trusted-dealer vault), real-transaction signing in the browser (still a test digest), full on-device
  share persistence (restore works; signing-after-restore pending), and the single installable desktop
  binary (Tauri, see [ADR-0004](docs/adr/0004-local-http-bridge.md)).

On the June 2026 Orchard episode: Konclave targets **NU6.2**, which re-enabled Orchard with a
corrected circuit. The earlier soundness bug was a *forgery* risk, **not** a privacy loss, and there
is **no evidence of exploitation**. Konclave is a trust-restoring tool built right after that
confidence shock, and we state this without overstatement.

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
cargo run --manifest-path orchestrator/Cargo.toml --bin konclave -- serve --web ui/dist --demo
# then open the printed http://127.0.0.1:4762
```

The multi-device network (two tabs make one vault, then sign) works against the local server at
`http://127.0.0.1:4762/#/net`, or live at the hosted demo above.

## Project structure

```
konclave/
├── orchestrator/    Rust backend: domain (money · proposal · payroll · validation · address) ·
│                    orchestration (ceremony · dkg · send · signer · pczt · wallet) · store ·
│                    secrets · the loopback HTTP bridge · the blind relay
├── konclave-wasm/   FROST redpallas + DKG + ECIES sealing + RTS recovery → WebAssembly (the browser)
├── konclave-signer/ the FROST↔PCZT bridge (resolves the pczt 0.5↔0.7 gap; born in the slice)
├── relay-server/    the standalone, hosted blind relay (CORS, opaque messages)
├── ui/              Vite + React: Dashboard · Payment · Payroll · Proposal · Ledger · Members · /net · /signer
├── engine/          pinned engine versions (versions.lock)
└── docs/            ARCHITECTURE · ROADMAP · VERTICAL_SLICE · DIAGRAMS · ADRs
```

## Status

A working, mainnet-proven prototype. The core runs through the UI for **payment and payroll**:
propose → validate (continuous) → approve/refuse (real quorum, with expiry) → **sign (FROST with the
shares of whoever approved, sealed at rest)** → account (ledger + itemized CSV). CI gates the whole
repo on every push (fmt + clippy `-D warnings` + tests across four Rust crates, a wasm browser build,
and the UI lint/test/build). What is shipped, dry-run, or roadmap is in the honest ladder above and
tracked in [`docs/ROADMAP.md`](docs/ROADMAP.md).

## Built on the Zcash Foundation's tools

Konclave does **not** reimplement cryptography. It stands on
[frost-tools](https://github.com/ZcashFoundation/frost-tools) (`frostd`, `frost-client`,
`zcash-sign`), the reference [`frost`](https://github.com/ZcashFoundation/frost) crate,
[zcash-devtool](https://github.com/zcash/zcash-devtool), and
[librustzcash](https://github.com/zcash/librustzcash), adding the usability, orchestration, and
accounting layer on top. Thank you to the Zcash Foundation and the wider Zcash community.

## Documentation

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
