<div align="center">

# 🔐 Konclave

### One key holds the whole treasury: lose it and the money is gone, share it and one person can drain it. And on a public chain, every salary and every donor is there for a rival to read.

#### Konclave: private, collective FROST vaults on Zcash. *The vault that decides together.*

**Create and operate a shielded, threshold-signed fund vault on Zcash mainnet (quorum-approved payments and private payroll) without a command line, and without any single member ever able to move the funds or reconstruct the key.**

[![Zcash mainnet](https://img.shields.io/badge/Zcash-mainnet%20(NU6.3%20Ironwood)-e5a00d?logo=zcash&logoColor=white)](#proven-on-zcash-mainnet)
[![Built on FROST](https://img.shields.io/badge/built%20on-FROST-6f42c1)](#why-we-built-this)
[![License: Apache-2.0 OR MIT](https://img.shields.io/badge/license-Apache--2.0%20OR%20MIT-blue.svg)](#license)
[![Tests: Rust + UI, gated in CI](https://img.shields.io/badge/tests-Rust%20%2B%20UI%2C%20gated%20in%20CI-2ea44f.svg)](#status)
[![CI](https://github.com/deegalabs/konclave/actions/workflows/ci.yml/badge.svg)](https://github.com/deegalabs/konclave/actions/workflows/ci.yml)

Started for **ZecHub Hackathon 3.0** in mid-2026, and built as a product since.

The cryptography is the Zcash Foundation's; Konclave is the **human layer** on top. A FROST
signature looks, on-chain, like an ordinary single-signer transaction, so a group gets
**collective control, privacy, and an internal audit trail** in one: a combination no transparent
multisig (for example on an EVM chain) can offer.

</div>

---

## Try it live

- **Live app** (create a real vault, no setup): https://konclave-demo.vercel.app
- **FROST signing in the browser** (WebAssembly, ~60 ms): https://konclave-demo.vercel.app/#/signer
- **Multi-device vault, live over the internet:** create a vault at the live app and invite a
  second device with the code it shows; the two run a real **Distributed Key Generation** over a
  hosted blind relay and then sign as a quorum.
- **Pitch video:** [Watch on YouTube](https://youtu.be/_UyWlLRnJms)

> There is no demo mode and no sample data: the hosted app only ever shows a vault you actually
> created. The proof is the mainnet transaction below: an actual 2-of-3 quorum payment, signed by a
> FROST ceremony, broadcast to Zcash mainnet.

> Konclave has not been independently audited, and until #567 and #610 are fixed a payment the
> quorum signs is only as safe as our hosted coordinator. Do not keep significant funds in it yet.
> See [SECURITY.md](SECURITY.md#known-limitations).

## Why we built this

Using FROST on Zcash today means a **CLI, several terminals, and copying hex between participants
by hand**. The Zcash Foundation built and partially audited the cryptography (the audit excludes
rerandomized FROST, the variant Zcash uses; see [docs/CLAIMS.md](docs/CLAIMS.md)), and says plainly
that *wallet integration is the missing piece*: it is gated to "technically-inclined users". Other
teams have brought FROST to users: Zkool ships FROST multisig as a native app, Zafu runs FROST vaults
in a browser extension, and CYZE is a desktop app. Making "easy multi-sig tools for shielded
addresses (FROST in user-facing wallets)" is a named
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

Konclave splits a vault's shielded spend authority into **`t`-of-`n` FROST shares** across the
members by real **Distributed Key Generation**. The whole key is **never reconstituted**, at
creation or at signing, and each share **never leaves its owner's device**. On top of that it
builds the human layer: propose, approve to a quorum, sign, broadcast, and account, in plain
language, with a preview and an explicit confirmation before anything moves. Receives in a
**shielded** pool, built against **NU6.3 (Ironwood)** and proven across the Orchard → Ironwood
upgrade on mainnet.

**The design rule: hide the cryptography, expose the trust.** You never see "FROST", "DKG", or
"SIGHASH"; you see *vault, members, approval, payment*.

## Proven on Zcash mainnet

This is not a mock. **19 verifiable mainnet transactions**, each signed by a FROST quorum
(2-of-2, 2-of-3 and 3-of-4). **Six of them came from vaults split by a trusted dealer**, where the
whole key existed on one machine at creation: those are the early ones, the flagship below
included. The rest came from vaults created by Distributed Key Generation, where the key was never
whole on any machine. The first seven were signed with every share on one machine, and the eighth
in two browser tabs on one machine. Signing across separate machines came after that. The chain
shows that each transaction is real, mined and shielded. It cannot show how a transaction was
signed, and [docs/PROOF.md](docs/PROOF.md) says, row by row, what rests on the block and what rests
on the operators' word.

The flagship is an application-driven **quorum payment**, proposed and approved in the app, signed
by a FROST ceremony, broadcast to mainnet:

> **txid** [`43433a109d3f2a078c0a9269ccb156392ade7a1f7ac1532981611eda1e59a572`](https://mainnet.zcashexplorer.app/transactions/43433a109d3f2a078c0a9269ccb156392ade7a1f7ac1532981611eda1e59a572)

They also include: a **private payroll** (one shielded transaction, N encrypted
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
| **Private payroll** | Enter the beneficiaries (or import a CSV, in the local build) → one shielded transaction with N outputs, approved **once**. Each payslip rides in an **encrypted memo** that outsiders and the chain cannot read (the recipient, the members and the coordinator can). |
| **Accounting** | A full internal ledger (who proposed, who approved, states, dates) plus an **itemized CSV export** (a payroll of N is N line-items). Transparent inside, private outside. |

## Using it: step by step

The whole flow, in the app's own words (hide the cryptography, expose the trust):

1. **Create or join a vault** (Your vaults → Create a vault, or Join by invite). Pick the members
   and the quorum (2 of 3 by default). The key is generated by a real **DKG**: it is born split across the
   devices and never exists whole, anywhere.
2. **Fund it** (`/receive`). Share the vault's shielded **address** (u1…, with a QR and a ZIP-321
   payment link) and receive ZEC.
3. **Propose a payment** (`/pay`). Enter an amount and a recipient (pick a saved beneficiary or paste
   an address). Konclave validates the address and checks the balance *before* anything is created.
4. **Approve to quorum** (`/proposals` → a proposal). Each member reviews and approves or refuses.
   Nothing moves until the agreed number of approvals is in, and proposals expire.
5. **Sign & send.** At quorum a FROST ceremony signs with **only the shares of whoever approved** and
   broadcasts one shielded transaction. A preview and an explicit confirmation guard the
   broadcast: one click never moves money, and the key is never reassembled.
6. **Payroll, optional** (`/payroll`). Enter the beneficiaries (or import a CSV, in the local build)
   → one shielded transaction with N outputs, approved **once**, each payslip in an encrypted memo
   that outsiders and the chain cannot read (the recipient, the members and the coordinator can).
7. **Account** (`/ledger`). Every action lands in the internal ledger (who proposed, who approved,
   states, dates), with an itemized CSV export for the accountant.

Try the flow by creating a vault at [konclave-demo.vercel.app](https://konclave-demo.vercel.app),
or run it locally (see [**Try it**](#try-it)). The same walkthrough is available in-app under
`/docs`.

## How it works

```
  propose ─▶ approve (real M-of-N quorum, with expiry) ─▶ sign (FROST ceremony,
  only the shares of whoever approved) ─▶ broadcast (shielded) ─▶ ledger
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
browser, live over the internet**, with no server ever holding a share.

The crate [`konclave-wasm`](konclave-wasm/) compiles rerandomized-redpallas (Orchard) FROST to
WebAssembly. Two separate devices **create one vault by a real DKG** and then **produce a verifying
FROST group signature together**, each keeping only its own share, routed through a **hosted blind
relay** ([`relay-server/`](relay-server/), on Railway) that holds no key and carries public or
encrypted messages, with one exception: a payment's signing request crosses it unsealed until every
member's device has registered its public device key (see the trust model below). The one secret piece of the DKG (the round-2 packages) is **sealed
end-to-end** (X25519 → HKDF-SHA256 → XChaCha20-Poly1305), so the relay stays blind. Try it by
creating a vault at [konclave-demo.vercel.app](https://konclave-demo.vercel.app) and joining it from
a second device.

Other Zcash projects run FROST ceremonies too: Zkool as a native app, Zafu in a browser extension,
CYZE on the desktop. What Konclave adds next to them is the treasury layer a group needs: proposals,
approval to quorum, a payroll approved once, and a shared ledger, in a web app members also use from
a phone. This is the path to *your key lives on your phone, the platform never holds it*.

## Shared-custody safety: what is proven, what is not wired

A real shared vault must survive a lost device and an absent owner. Neither of these is in the
product yet:

- **Social recovery (demo, #58):** the repair scheme that lets a quorum rebuild a lost member's
  share without exposing the key is real and tested, and runs in the browser on a throwaway vault.
  It is not connected to real vaults. Today a lost seat comes back only from that member's own
  export, and a seat that is gone cannot be replaced (#154).
- **Inheritance (design, #58):** only the decision rule is built and tested; there is no
  proof-of-life signal, nothing is persisted and no vault can be armed.

## Trust model and honest limits

We distinguish **what the cryptography guarantees** from **what the product enforces**, and we do
not promise what we do not deliver.

- **Guaranteed by the cryptography:** the key is never reconstituted; a quorum signature is
  required to spend; your share never leaves your device.
- **Guaranteed by how the services are built (product, not protocol):** the relay carries sealed or
  public ceremony messages and, once every member's device has registered its public device key, never who a
  payment pays, though it sees member names and the quorum while a vault is created; the
  coordinator never receives a share but does hold the vault's viewing key (see *Who coordinates*
  below).
- **Enforced by the product (not the chain):** balance reservation and proposal expiry (72 hours)
  are application policy, not on-chain rules. We say so plainly. There is no quorum-by-value: the
  quorum is the one number fixed when the vault is created.
- **Who coordinates, and what that role is trusted with:** pure FROST does not define message
  transport, member identity, or who assembles the transaction, so *something* has to coordinate.
  Here that is the **hosted coordinator** (the helper): it builds and proves the transaction, hosts
  the signing round, and broadcasts the result. It is trusted for **availability**, for the
  **privacy of the books** and, until #567 and #610 are fixed, for **building only what was
  approved**. It holds each vault's viewing key, so it can read the balance, the payments, the
  amounts, the memos (payslips included) and the members' names. It never receives a share and
  cannot move funds on its own, because every payment needs a quorum's signatures. But today a malicious or
  compromised coordinator could change an approved payment,
  burn funds as fee or alter a memo: a payment the quorum signs is only as safe as the coordinator.
  The relay is a blind mailbox: since #63 the signing request is sealed to the members' device
  keys once every member's device has registered its public device key (each does when its member unlocks the
  vault), and from then on it carries ciphertext, not the recipient or the amount.
- **The AI assistant is off the money path, structurally:** [`mcp-server/`](mcp-server/) exposes a
  vault to an AI assistant that can **read** the books and **draft** a proposal, and deliberately has
  **no tool to approve, sign, or broadcast**. A drafted proposal is created *awaiting approval* and
  moves zero funds until humans act on it. The coordinator is the hosted helper, not the MCP server:
  the assistant proposes and informs, the human quorum decides, and the shares sign on the devices.
- **Security posture:** in the browser and in the desktop app (the same interface code, bundled
  into a native window and not yet validated on real hardware), the share is stored encrypted
  (AES-256-GCM under a PBKDF2-SHA256 key: 600,000 iterations for anything sealed since 2026-09-06;
  records stored before then keep 210,000 until the passphrase is changed, and a backup made before
  then keeps 210,000 for good, so make a new one) and decrypted only in memory. Moving the
  desktop's copy into the OS keychain is planned: the native commands exist, but no screen calls
  them and the released build does not enable a platform keychain yet
  ([`docs/NATIVE-STORAGE-BRIDGE.md`](docs/NATIVE-STORAGE-BRIDGE.md)). The local build, which creates
  vaults by DKG, seals it with XChaCha20-Poly1305 under a key derived from the vault passphrase
  with Argon2id, never stored, and unseals it only to ephemeral `0600` files during signing (in
  tmpfs where the system has one); the local bridge is guarded against CSRF/DNS-rebinding; secret
  material is zeroized in memory; destinations are validated with an authoritative `zcash_address`
  decode before any send. See [`SECURITY.md`](SECURITY.md).
- **Read access is gated, not just the spend (#388, live):** a Konclave vault's on-chain data is
  shielded, but the hosted coordinator holds its viewing key and used to answer reads to anyone who
  had the public vault id. Now every member holds a per-vault secret **S** (minted at the DKG, sent to
  the other members sealed, never in the clear); the coordinator's reads - balance, history, members,
  ledger - and the signing room are gated behind a token derived from S, so a leaked link opens
  neither the books nor the room. The vault list shows a **Private / Open** badge and an open
  (not-yet-migrated) vault carries a plain-language warning. Every governance write (vote, proposal,
  payroll, send, rename) is signed by the member's device and checked by the coordinator since
  2026-09-07 (#288, proven by `47e4e5dd…`); the check turns on per vault when a member of it
  unlocks. Stay honest about the limits: the read gate is per vault (legacy vaults stay open until
  re-created; an in-place upgrade is #406), and a leaked id still shows the vault's address and its
  quorum shape.
- **A leaked backup reveals nothing (#214, live):** the vault export is a single opaque blob -
  metadata, share, S and beneficiaries all encrypted under a passphrase, only a non-sensitive envelope
  in the clear - so a stolen backup file does not even disclose the vault id. Restoring it brings back
  the signing seat, and on a Private vault the export also carries the viewing key and the scan
  height a rebuild needs (#447, #480), if our coordinator answered when it was made. The export of a
  vault marked Open lacks the viewing key.
  What is still missing is a way to hand an existing vault to a different coordinator (see
  [`docs/RECOVERY.md`](docs/RECOVERY.md)).

**Proven vs pending, the honest ladder:**

- ✅ **On mainnet, 19 independently verifiable txids** (`node scripts/verify-proof.mjs`, or the
  [/proof](https://konclave-demo.vercel.app/#/proof) page): a **2-of-3 quorum payment** (proposed and
  approved in the app, FROST-signed, shares **sealed** at rest); a **private
  payroll**, one shielded Orchard transaction with **three outputs, each carrying its own encrypted
  memo**, 2-of-3 FROST-signed; a payment reproduced **end to end from a freshly created and funded
  vault**; a **send from a vault whose key was generated by real DKG** (three-participant DKG
  ceremony, key **never reconstituted**), then funded and spent by a FROST ceremony; on
  **NU6.3 / Ironwood** activation day, an **Orchard→Ironwood migration** plus the **first spend from
  the Ironwood pool** (both **V6/NU6.3**, 2-of-3 FROST); and a **browser-signed broadcast** - a
  browser-DKG vault whose two tabs each signed **in the browser** with only their own share over the
  blind relay, injected and broadcast by the coordinator (txid `3022420a…`, V6/NU6.3 Ironwood).
  Honest note: six of them used a **trusted-dealer** vault (the quorum payment, the Gate-1 slice,
  the fresh-vault payment, the payroll, and both sends of the Ironwood cycle); the others, which
  are the DKG-vault send and every browser-signed send, came from keys born by real **DKG**.
  [docs/PROOF.md](docs/PROOF.md) lists every one, and the list above is not all of them.
- 🔬 **By dry-run** (it *signs*, it does not yet *broadcast*): the fully-sealed local signing path
  (sealed configs unsealed only to ephemeral `0600` files, in tmpfs where the system has one).
- 🌐 **In the browser, live over the internet - broadcast PROVEN on mainnet:** multi-device DKG and
  FROST signing over a **hosted blind relay**, over a **real Orchard/Ironwood sighash** **under the
  transaction's own alpha** (the correct Orchard spend mechanism, verified under `ak+alpha`), with
  each device showing the payment before it signs (what it shows is not yet checked against what it
  signs, #610), then broadcast by the
  **hosted coordinator** (`helper-server`, Architecture B). Proven on mainnet: first with two tabs on one
  machine (`3022420a…`), then **across separate physical machines over the internet** (`aec83baf…`,
  block 3,460,285), two people in two places, each browser holding only its own share.
- 🔁 **Proven by test:** social recovery (RTS share repair) and the inheritance policy engine.
- 🗺️ **Roadmap, not shipped:** `/net` multi-note
  over the live relay; social-recovery / inheritance wired into a live vault UI (#58); replacing a
  lost seat, or changing the members or the quorum of an existing vault (#154). *(Now shipped, no
  longer roadmap: the browser broadcast; on-device share persistence with sign-after-restore; and
  the installable desktop binary - Tauri, first released as **v0.2.0** on 2026-08-03, latest
  **v0.8.0**, a pre-release that is not code-signed or notarized and not yet validated on real
  per-platform hardware, so the website does not offer the download yet; see
  [ADR-0004](docs/adr/0004-local-http-bridge.md).)*

On the June 2026 Orchard episode: the earlier soundness bug (fixed by the **NU6.2** hard-fork that
re-enabled Orchard with a corrected circuit) was a *forgery* risk, **not** a privacy loss, with
**no evidence of exploitation**. Konclave now targets current mainnet consensus - **NU6.3
(Ironwood)** - and is a trust-restoring tool built right after that confidence shock; we state this
without overstatement.

## How it compares

| | Bank | Transparent multisig (EVM) | CLI FROST (ZF tools) | **Konclave** |
|---|---|---|---|---|
| No single member can move the funds | no | yes | yes | **yes** |
| No single point of failure | no | yes | yes | **not yet: our hosted coordinator and relay ([#613](https://github.com/deegalabs/konclave/issues/613))** |
| Amounts and recipients private on chain | n/a | no | yes | **yes (our hosted coordinator reads them, [#516](https://github.com/deegalabs/konclave/issues/516))** |
| Group makeup hidden on-chain | n/a | no | yes | **yes** |
| Usable without a command line | yes | yes | **no** | **yes** |
| Private payroll (N outputs, one approval) | no | no | no | **yes** |
| Internal audit trail + itemized export | yes | no | no | **yes** |
| Multi-device / in the browser | n/a | wallet-dependent | no | **yes (DKG live)** |

## Tech stack

| Layer | Technology |
|---|---|
| UI | Vite + React + TypeScript (HashRouter static bundle), dependency-free i18n (PT-BR + EN) |
| Orchestrator | Rust: proposal state machine, ZIP-317/address validation, payroll, SQLite/**SQLCipher** store, XChaCha20-Poly1305 + Argon2id sealing (an OS-keychain store exists, with no platform backend enabled yet) |
| Browser signer | `konclave-wasm`: rerandomized-redpallas FROST + DKG + ECIES sealing + recovery, compiled to WebAssembly |
| Blind relay | `relay-server`: standalone `tiny_http` mailbox (CORS, forwards messages it never parses), hosted on Railway |
| Coordinator (helper) | `helper-server`: the Architecture-B helper ([ADR-0006](docs/adr/0006-browser-native-vault.md) Rung A) - given a vault's view-only UFVK + a signing request it builds/proves the PCZT, waits for the browsers' signatures, injects and broadcasts; it **never holds a share**, but its viewing key reads the vault's payments and memos; hosted on Railway as a **non-root** container (the native `orchestrator` is the local-mode equivalent) |
| Engine (not reimplemented) | ZF `frostd` · `frost-client` · `zcash-sign` · `zcash-devtool` · `librustzcash` (`zcash_client_backend` linked) |
| Deploy | Vercel (UI, git auto-deploy) · Railway (relay and coordinator) · Zcash mainnet (the real path) |

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
pnpm install && pnpm -C ui run build
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
├── relay-server/    the standalone, hosted blind relay (CORS, never parses what it forwards)
├── helper-server/   the hosted, share-blind Architecture-B helper (build/prove/broadcast; ADR-0006 Rung A)
├── src-tauri/       the Tauri desktop shell: the same ui/ in a native window (released since v0.2.0; embedding the orchestrator is #212)
├── ui/              Vite + React: Dashboard · Payment · Payroll · Proposal · Ledger · Members · /net · /signer
├── engine/          pinned engine versions (versions.lock)
└── docs/            ARCHITECTURE · ROADMAP · VERTICAL_SLICE · DIAGRAMS · ADRs
```

## Status

A working, mainnet-proven prototype. The core runs through the UI for **payment and payroll**:
propose → validate (continuous) → approve/refuse (real quorum, with expiry) → **sign (FROST with the
shares of whoever approved, sealed at rest)** → account (ledger + itemized CSV). A desktop app also
ships, on **Tauri**, since v0.2.0 (latest v0.8.0, a pre-release; Windows, Linux and Apple Silicon
macOS installers, none of them code-signed or notarized; open: embedding the orchestrator and the OS
keychain (#212), live per-platform hardware validation and signed installers (#606), so the website
does not offer the download yet). CI gates the whole repo on every push
(fmt + clippy `-D warnings` + tests across the Rust workspace crates, a wasm browser build, and the UI lint/test/build). What is shipped, dry-run, or
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
- [DEPLOY.md](DEPLOY.md): hosting and CI · [docs/archive/zechub-3.0-submission.md](docs/archive/zechub-3.0-submission.md): the ZecHub Hackathon 3.0 submission page, archived in its last state
- [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md): the three layers · [docs/ROADMAP.md](docs/ROADMAP.md): build plan
- [docs/DIAGRAMS.md](docs/DIAGRAMS.md): system flow in Mermaid · [docs/VERTICAL_SLICE.md](docs/VERTICAL_SLICE.md): the first mainnet transaction
- [SECURITY.md](SECURITY.md): posture and reporting · [CLAUDE.md](CLAUDE.md): project memory and context

## License

Dual **Apache-2.0** / **MIT**, at your choice (mirrors the Rust/Zcash ecosystem).
See [LICENSE-APACHE](LICENSE-APACHE) and [LICENSE-MIT](LICENSE-MIT).

<div align="center">
<sub>Built on Zcash and FROST · Private outside, transparent inside</sub>
</div>
