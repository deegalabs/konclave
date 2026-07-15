# Konclave

> **The vault that decides together.** No payment leaves without a quorum.
> Private on the outside, transparent on the inside.

[![License: Apache-2.0 OR MIT](https://img.shields.io/badge/license-Apache--2.0%20OR%20MIT-blue.svg)](#license)
[![Network: Zcash mainnet](https://img.shields.io/badge/network-Zcash%20mainnet%20(NU6.2)-e5a00d.svg)](#proven-on-mainnet)
[![FROST + Accounting](https://img.shields.io/badge/ZecHub%203.0-FROST%20%2B%20Accounting-6f42c1.svg)](#why-it-exists)
![Tests: 173 Rust + 23 UI](https://img.shields.io/badge/tests-173%20Rust%20%2B%2023%20UI-2ea44f.svg)

Konclave is a **local-first desktop app** that makes it usable, for ordinary people, to
create and operate a **collective, private fund vault** on the **Zcash** network using
threshold signatures (**FROST**). Pay by quorum, or run an entire **private payroll** in one
collectively-approved shielded transaction — without touching a command line, and without
leaking amounts, recipients, or the group's makeup to the public chain.

The cryptography already exists and comes from the official **Zcash Foundation** tools.
What was missing was the **human layer** — that is what Konclave delivers.

---

## Why it exists

Today, using FROST on Zcash requires a **CLI, several terminals, and manually copying hex
between participants**. The Zcash Foundation finished the cryptography (audited twice) and
says plainly that *wallet integration is the missing piece* — it is gated to
"technically-inclined users." **No usable GUI for FROST on Zcash exists.** Making
"easy multi-sig tools for shielded addresses (FROST in user-facing wallets)" is even a
[named Zcash Community Grants funding priority](https://zcashcommunitygrants.org/).

Konclave fills that gap for the people who need it most:

- A **treasurer of a collective** who must not be a single point of failure — or a single
  point of theft.
- **Cooperatives, community funds, and small orgs** that decide together and want shared
  books without a bank.
- **NGOs, journalists, and activists** for whom a *transparent* multisig is not a feature
  but a liability — it doxes the donor set, staff salaries, and org structure to anyone
  watching the chain.

A FROST signature looks, on-chain, like an ordinary single-signer transaction. Konclave
gives these groups **collective control + privacy + an internal audit trail** — a
combination no transparent multisig (e.g. on EVM) can offer.

## Proven on mainnet

This is not a mock. A **2-of-3 quorum payment**, proposed and approved in the app, signed by
a real **FROST ceremony**, and broadcast to **Zcash mainnet** — the key never reconstituted:

> **txid** [`43433a109d3f2a078c0a9269ccb156392ade7a1f7ac1532981611eda1e59a572`](https://mainnet.zcashexplorer.app/transactions/43433a109d3f2a078c0a9269ccb156392ade7a1f7ac1532981611eda1e59a572)

(The first Konclave FROST transaction — a CLI-driven Gate-1 slice — is
[`f63ee64d…c522360`](https://mainnet.zcashexplorer.app/transactions/f63ee64d7bc086a8286631d03936ec2ca2ca57f4e4c63712fc95c1f02c522360), block 3,396,616.)

## What you can do

| | |
|---|---|
| **Quorum payment** | Propose a payment → members approve → at quorum the vault signs and sends. One click never moves money; every fund-moving action has a preview + explicit confirmation. |
| **Private payroll** | Import a CSV of beneficiaries → one shielded Orchard transaction with N outputs, approved **once**. Each payslip rides in an **encrypted memo** only its recipient can read. |
| **Accounting** | A full internal ledger (who proposed, who approved, states, dates) + an **itemized CSV export** — a payroll of N is N line-items. Transparent inside, private outside. |

## How it works

**Hide the cryptography, expose the trust.** You never see "FROST", "DKG" or "SIGHASH" — you
see *vault, members, approval, payment*. The vault key is split among members by real
**Distributed Key Generation**; **no single share moves funds** and the whole key is **never
reconstituted**, not at creation and not at signing. Your share **never leaves your device**.

```
  propose ─▶ approve (real M-of-N quorum, with expiry) ─▶ sign (FROST ceremony,
  only the shares of whoever approved) ─▶ broadcast (Orchard, shielded) ─▶ ledger
                              the key is never reassembled
```

Three layers, each with a clear job:

```
  Layer 3 — UI            Vite + React (vault · members · payment · payroll · proposal · ledger)
     │  structured JSON over a loopback-only bridge (127.0.0.1)
  Layer 2 — ORCHESTRATOR  Rust: proposal state machine · validation (ZIP-317, addresses) ·
     │                    payroll · sealed key custody · SQLite store · the FROST↔PCZT bridge
     │  structured I/O (never "screen-scraping" a CLI)
  Layer 1 — ENGINE        the official Zcash Foundation tools (crypto is NOT reimplemented):
                          frostd · frost-client · zcash-sign · zcash-devtool · librustzcash
```

## Try it in 10 seconds

No engine, no funds, no setup — a console walkthrough of every use case against the **real**
backend (in-process, no server):

```sh
cargo run --manifest-path orchestrator/Cargo.toml --example simulate
```

It prints the whole flow: the vault, authoritative address safety, propose → approve to
quorum, a refusal, a private payroll (N beneficiaries), and the itemized ledger/CSV.

To run the full app locally (browser via a local bridge; live balance/signing needs the
Zcash Foundation engine binaries built per [`engine/versions.lock`](engine/versions.lock)):

```sh
# build the UI bundle once, then serve it + the API from the tested core
npm --prefix ui ci && npm --prefix ui run build
cargo run --manifest-path orchestrator/Cargo.toml --bin konclave -- serve --web ui/dist --demo
# then open the printed http://127.0.0.1:4762
```

## Trust model & honest limits

We distinguish **what the cryptography guarantees** from **what the product enforces**, and
we do not promise what we do not deliver:

- **Guaranteed by the protocol:** the key is never reconstituted; a quorum signature is
  required to spend; the coordination server (`frostd`) is **blind** (only public material
  crosses it); your share never leaves your device.
- **Enforced by the product (not the chain):** quorum-by-value, balance reservation, and
  proposal expiry are application policy — not on-chain-enforced rules. We say so plainly.
- **Security posture:** shares are sealed at rest (XChaCha20-Poly1305, Argon2id-derived key)
  and only unsealed to ephemeral `0600` files in tmpfs during signing; the loopback bridge is
  guarded against CSRF/DNS-rebinding; secret material is zeroized in memory; destinations are
  validated with an authoritative `zcash_address` decode before any send. See
  [`SECURITY.md`](SECURITY.md).
- **Proven vs pending (honesty).** We are precise about the maturity of each claim:
  - ✅ **On mainnet:** a **2-of-3 quorum payment** — proposed/approved in the app, FROST-signed,
    broadcast (txid above); the vault created by **real DKG**; shares **sealed** at rest.
  - 🔬 **By dry-run** (it *signs*, it does not yet *broadcast*): the **private payroll**
    (multi-output Orchard) and the fully-sealed signing path.
  - 🌐 **In the browser** (proven across tabs): separate browser contexts create **one vault by a
    real Distributed Key Generation** and then **sign together with a verifying FROST group
    signature**, over a **blind relay**, each keeping only its own share (see below).
  - 🗺️ **Roadmap, not shipped:** real payroll/sealed broadcasts, sending from a fresh DKG vault,
    hosting the relay publicly (phone-to-phone), persisting the share on-device, the single
    installable desktop binary (Tauri).
- **On the June 2026 Orchard episode:** Konclave targets **NU6.2**, which re-enabled Orchard
  with a corrected circuit. The earlier soundness bug was a *forgery* risk, **not** a privacy
  loss; there is **no evidence of exploitation**. Konclave is a trust-restoring tool built
  right after that confidence shock — stated without overstatement.

## Roadmap (honest)

- **Real broadcasts** of the payroll and the sealed path; sending from a freshly-created DKG
  vault.
- **Delivery form:** a single installable desktop app (Tauri) — the local-first guarantee
  does not change, only the packaging.
- **Decentralized, online coordination:** a *blind, swappable* relay (self-hostable / P2P)
  plus a QR/air-gapped fallback that needs no server — so members approve and sign
  asynchronously from anywhere, with the secret always local.
- **Browser client (`konclave.app`) — multi-device FROST in the browser:** the crate
  [`konclave-wasm`](konclave-wasm/) runs the full **rerandomized redpallas (Orchard) FROST**
  stack in WebAssembly. Proven **across two browser contexts over a blind relay**
  ([`orchestrator/src/relay.rs`](orchestrator/src/relay.rs), [`ui/src/screens/NetVault.tsx`](ui/src/screens/NetVault.tsx)):
  they **create one vault by a real Distributed Key Generation** (the secret round-2 packages
  sealed end-to-end with X25519 → HKDF → XChaCha20-Poly1305, so the relay stays blind), then
  **produce a verifying FROST group signature together**, each device keeping only its own
  share. The single-tab `/signer` route also signs a valid 64-byte signature in ~60 ms and
  re-derives **what it signs** with a **byte-exact ZIP-244 `sig_digest`** (pure blake2b,
  anchored to the `orchard` crate's own digest, no `secp256k1`), so a blind relay/delegate can
  never make it sign blind. The share and nonces never leave the device. To our knowledge a
  first for Zcash. Still a proof-of-concept, not a shipped, audited client: the browser
  signature is over a test digest (not yet a broadcast transaction), and the relay is not yet
  hosted (runs locally; two tabs on one machine today).
- Auditor / viewing-key read-only role (selective disclosure); share recovery & rotation.

## Built on the Zcash Foundation's tools

Konclave does **not** reimplement cryptography. It stands on
[frost-tools](https://github.com/ZcashFoundation/frost-tools) (`frostd`, `frost-client`,
`zcash-sign`), the reference [`frost`](https://github.com/ZcashFoundation/frost) crate,
[zcash-devtool](https://github.com/zcash/zcash-devtool), and
[librustzcash](https://github.com/zcash/librustzcash) — and adds the usability, orchestration,
and accounting layer on top. Thank you to the Zcash Foundation and the wider Zcash community.

## Documentation

- [CLAUDE.md](CLAUDE.md) — project memory and context.
- [docs/CONCEITO_INICIAL.md](docs/CONCEITO_INICIAL.md) — the what and the why.
- [docs/UX_E_FLUXOS.md](docs/UX_E_FLUXOS.md) — journeys and screens.
- [docs/LOGICA_E_REGRAS.md](docs/LOGICA_E_REGRAS.md) — states and rules.
- [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) — the three layers.
- [docs/ROADMAP.md](docs/ROADMAP.md) — build plan · [SECURITY.md](SECURITY.md) — reporting & posture.

## License

Dual **Apache-2.0** / **MIT**, at your choice (mirrors the Rust/Zcash ecosystem).
See [LICENSE-APACHE](LICENSE-APACHE) and [LICENSE-MIT](LICENSE-MIT).
