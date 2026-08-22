# Konclave: ZecHub Hackathon 3.0 submission

> **The vault that decides together.** A local-first app that makes **FROST threshold
> vaults usable for ordinary treasurers** on Zcash. Private on the outside, transparent on
> the inside.

- **Tracks:** **FROST** (primary) + **Accounting**.
- **Repository:** https://github.com/deegalabs/konclave
- **Live demo (browser, no setup):** https://konclave-demo.vercel.app
- **License:** dual **Apache-2.0 / MIT**.

---

## What it is

Using FROST on Zcash today means a command line, several terminals, and copying hex between
participants by hand. The Zcash Foundation finished the cryptography; the missing piece is the
**human layer**. Konclave is that layer: a group creates a shared vault, and **no payment
leaves without a quorum**, without anyone ever holding the whole key.

Two equally-weighted faces:

- **Quorum payment:** propose → members approve → at quorum the vault signs (FROST) and
  broadcasts a shielded Orchard transaction. One click never moves money.
- **Private payroll:** one shielded transaction with N outputs, approved once; each payslip
  rides in an **encrypted memo** only its recipient can read.

Plus a full internal **ledger** with an itemized CSV export (the Accounting track).

**Design principle:** hide the cryptography, expose the trust. The user sees *vault, members,
approval, payment*, never "FROST", "DKG" or "SIGHASH".

## How it uses the Zcash network (mainnet)

This is not a mock. A **2-of-3 quorum payment**, proposed and approved in the app, signed by
a real **FROST ceremony**, broadcast to **Zcash mainnet**, the key never reconstituted:

- App-driven tx: [`43433a109d3f2a078c0a9269ccb156392ade7a1f7ac1532981611eda1e59a572`](https://mainnet.zcashexplorer.app/transactions/43433a109d3f2a078c0a9269ccb156392ade7a1f7ac1532981611eda1e59a572)
- First slice (CLI, Gate 1): [`f63ee64d7bc086a8286631d03936ec2ca2ca57f4e4c63712fc95c1f02c522360`](https://mainnet.zcashexplorer.app/transactions/f63ee64d7bc086a8286631d03936ec2ca2ca57f4e4c63712fc95c1f02c522360)

Receives in a **shielded** pool, built against **NU6.3 (Ironwood)** and proven across the
Orchard → Ironwood upgrade on mainnet. The vault is created by real **Distributed Key Generation**
(the key is never assembled, at creation or at signing).

## Built on the Zcash Foundation's tools (no crypto reimplemented)

`frostd` · `frost-client` · `zcash-sign` ([frost-tools](https://github.com/ZcashFoundation/frost-tools)),
the reference [`frost`](https://github.com/ZcashFoundation/frost) crate,
[zcash-devtool](https://github.com/zcash/zcash-devtool), and
[librustzcash](https://github.com/zcash/librustzcash). Konclave adds the usability,
orchestration, and accounting layer on top.

## The step beyond: konclave.app (FROST across devices, in the browser)

The headline new capability, aimed straight at the FROST track's "threshold signing wallets"
idea: **separate devices create and operate one vault entirely in the browser, over a blind
relay, with no server ever seeing a secret.**

- A **blind relay** (`orchestrator/src/relay.rs`) moves only public or already-encrypted
  bytes between devices. It cannot read a share or forge a signature.
- A real **Distributed Key Generation runs across two browser tabs** in WebAssembly
  (`konclave-wasm`): each device ends with its own share, the group key is agreed by all, and
  the one secret step (the DKG round-2 packages) is **sealed end-to-end** (X25519 →
  HKDF-SHA256 → XChaCha20-Poly1305) so the relay stays blind.
- Those DKG-born shares then **produce a verifying FROST group signature together**, each
  device signing with only its own piece, proven live across tabs.

We found no comparable: a full rerandomized-redpallas (Orchard) FROST ceremony, including DKG,
driven entirely from the browser (ecosystem scan, Aug 2026). Zkool ships FROST shielded multisig on
Zcash, but as a native app - the **in-browser** ceremony is our distinction, not the multisig
primitive. This is the path to "your key lives on your phone, the platform never has access", a
shared-custody wallet you open on any device.

## Try it

**In the browser, no setup:** the hosted demo (mock data) and the in-browser signer:

- App walkthrough: https://konclave-demo.vercel.app
- FROST signing in the browser (WebAssembly, ~60 ms): https://konclave-demo.vercel.app/#/signer

**The real backend in 10 seconds** (no engine, no funds):

```sh
cargo run --manifest-path orchestrator/Cargo.toml --example simulate
```

**The full app locally** (browser via a loopback bridge):

```sh
npm --prefix ui ci && npm --prefix ui run build
cargo run --manifest-path orchestrator/Cargo.toml --bin konclave -- serve --web ui/dist
# open the printed http://127.0.0.1:4762
```

**The multi-device network (two tabs make one vault, then sign):**

```sh
# with the server above running, open TWO tabs at:
#   http://127.0.0.1:4762/#/net
# tab 1: "Gerar convite" → copy the code; tab 2: paste it → "Entrar com o código"
# both tabs run a real blind DKG and show the same vault key; then "Assinar" signs together.
```

> Note: the standalone `/net` route above is the **legacy / diagnostics** surface. In the product,
> the real create + multi-device flow is the embedded `<NetVault embedded />` modal launched from
> `/vaults`, which runs the same ceremony without leaving the vault shell (ADR-0009).

## Shared-custody safety: recovery + inheritance

Beyond spending, a real shared vault has to survive a lost device and an absent owner. Both are
built on the same FROST + blind-relay foundation and proven by tests:

- **Social recovery:** when a member loses their device, a **quorum rebuilds that member's
  share** (the Repairable Threshold Scheme). The group key is never touched, no share is revealed,
  and the repaired share is byte-identical to the lost one. It then signs a verifying 2-of-3.
- **Inheritance / dead-man's-switch:** the owner sends signed proof-of-life heartbeats; if they
  lapse past a window (plus a grace period the owner can still cancel in), the quorum is
  authorized to **release** the vault to a named heir. The release is an ordinary quorum-signed
  payment (reuses the FROST send path).

## Honest limits (we do not promise what we do not deliver)

- ✅ **On mainnet, eight verifiable txids** (incl. the first browser-signed broadcast) (`node scripts/verify-proof.mjs`, or the /proof page):
  a 2-of-3 quorum payment (proposed/approved in-app, FROST-signed, shares sealed at rest);
  a **private payroll** (one shielded Orchard tx, 3 outputs, one encrypted memo each, 2-of-3 FROST);
  a payment reproduced end to end from a freshly created + funded vault; a **send from a real DKG
  vault** (three-participant DKG ceremony, key never reconstituted), funded and spent by FROST; and,
  on **NU6.3 / Ironwood** activation day, an **Orchard→Ironwood migration** plus the **first spend
  from the Ironwood pool** (both **V6/NU6.3**, 2-of-3 FROST). The
  quorum payment, payroll, and fresh-vault txids used a trusted-dealer vault; only the DKG-vault send
  came from a key born by real DKG.
- 🔬 **By dry-run** (signs, does not yet broadcast): the fully-sealed signing path.
- 🌐 **In the browser, live over the internet - broadcast PROVEN on mainnet:** multi-device DKG +
  FROST signing over a **hosted blind relay** (Railway), then a real broadcast via the **hosted
  blind `helper-server`** (Architecture B, ADR-0006 Rung A). A browser-DKG vault signed a real
  Ironwood transaction **in the browser** - each tab contributing only its own share - and the
  blind helper injected and broadcast it: mainnet txid `3022420a…` (V6/NU6.3). Try the ceremony at
  https://konclave-demo.vercel.app/#/net in two tabs. Honest limit: proven so far with **two tabs
  on one machine**; a broadcast across **separate physical devices** is the open milestone.
- 🧩 **Blind helper (`helper-server`):** a real, CI-tested crate deployed on Railway that, given a
  vault's view-only UFVK and a signing request, builds/proves the PCZT, waits for the browsers'
  signatures, injects, and broadcasts. It **never sees a share** and cannot move funds without the
  quorum. The native `orchestrator` (`konclave serve`) is the equivalent local-mode helper.
- 🗺️ **Roadmap (genuinely open):** a broadcast across separate physical devices, `/net` multi-note
  over the live relay, and social-recovery / inheritance wired into a live vault UI. *(No longer
  roadmap, now shipped: browser broadcast, on-device share persistence, and the single desktop
  binary - Tauri **v0.2.0**, 2026-08-03.)*

## Privacy & security

Shielded-first (Orchard); the coordination server is blind (public/encrypted material only);
secrets never persist outside the OS vault (sealed with XChaCha20-Poly1305, key in the OS
keychain); the loopback bridge is guarded against CSRF/DNS-rebinding; destinations are
validated with an authoritative `zcash_address` decode before any send. See
[`SECURITY.md`](SECURITY.md).

**Tests:** 227 (orchestrator) + 7 (konclave-wasm) + the `helper-server` crate + UI (~236+ across
the Rust crates). Documentation: [`README.md`](README.md), [`docs/`](docs/), [`CLAUDE.md`](CLAUDE.md).
