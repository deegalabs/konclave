# Konclave: claims discipline

This file is the **single source of truth for what Konclave claims** about on-chain
activity and about what is proven versus pending. Its purpose is to keep every surface
(README, SUBMISSION, `docs/PROOF.md`, the in-app `/docs`, CLAUDE.md) consistent, so no
document ever asserts something another contradicts.

## The canonical sources
- **`scripts/verify-proof.mjs`** and **`docs/PROOF.md`** are authoritative for the mainnet
  transaction IDs and their status. Every other document **references** them; it must never
  restate a different count or a different attribution.
- **`docs/VERTICAL_SLICE.md`** and **`CLAUDE.md`** are authoritative for how each vault was
  generated (DKG vs trusted-dealer) and how each transaction was produced.

## Status labels (use them everywhere)
Every stated capability must carry two orthogonal labels, and the labels must match across
all documents:

1. **Evidence level** — one of:
   - `proven on-chain` — a verifiable mainnet txid exists.
   - `dry-run` — signs and verifies locally, does not broadcast.
   - `by test` — covered by an automated test, no network artifact.
   - `roadmap` — not yet built.
2. **Key origin** (for anything about a vault) — one of:
   - `DKG` — key born by real Distributed Key Generation, never reconstituted anywhere.
   - `trusted-dealer` — a dealer briefly held the whole key at setup, then split it.

## Mainnet transactions (authoritative attribution)
As of this writing, eight verifiable mainnet txids. **Two** are from real DKG vaults (the CLI
DKG-vault send and the browser-DKG browser-signed broadcast); the rest are trusted-dealer.

| Transaction | Evidence | Key origin |
|---|---|---|
| Application-driven 2-of-3 quorum payment (`43433a10…`) | proven on-chain | trusted-dealer |
| Gate-1 CLI vertical-slice payment (`f63ee64d…`) | proven on-chain | trusted-dealer |
| Fresh-vault 2-of-3 payment (`6c898239…`) | proven on-chain | trusted-dealer |
| Private multi-output payroll, 3 outputs (`b1e24c07…`) | proven on-chain | trusted-dealer |
| **DKG-vault send (`aab00f90…`)** | proven on-chain | **DKG** (CLI) |
| Orchard→Ironwood migration, V6/NU6.3 (`54266f47…`) | proven on-chain | trusted-dealer |
| First Ironwood-pool spend, V6/NU6.3 (`36c60f1e…`) | proven on-chain | trusted-dealer |
| **Browser-signed broadcast, V6/NU6.3 (`3022420a…`)** | proven on-chain | **DKG** (browser) |

Any statement of the form "the app payment used DKG" is **false**. Only `aab00f90…` (CLI DKG) and
`3022420a…` (browser DKG) came from keys born by real DKG.

## Honest limits to keep stated (never hide)
- The first seven mainnet sends were signed on a **single machine** (shares co-located at signing).
- **Browser-signed distributed broadcast — PROVEN on mainnet (2026-07-30).** `/net` over a blind
  relay is no longer "verified but not broadcast": a browser-DKG **2-of-2** vault (created live in
  two browser tabs over the hosted relay, key never reconstituted) was funded, restored on-device
  by both seats, and **signed a real Ironwood transaction IN THE BROWSER** — each device
  contributing only its own share over the blind relay — after which the blind helper
  (`orchestrator::net_send`, Architecture B) injected and broadcast it. Mined: txid
  `3022420a8bcf17ffd5511163c18ee9b5996a3ba44747e4eff6794bdd3f04ccee` (block 3,429,922, V6/NU6.3).
  - The unlock: `konclave-wasm` was ported to the Ironwood librustzcash pin (pczt v2, pool-aware
    `extract_randomizers`/`inject_sigs` for Orchard **and** Ironwood), staying wasm-clean (0
    secp256k1). Before this the browser WASM could not parse a V6 PCZT (`UnknownVersion(2)`).
  - The Architecture B path (`orchestrator::net_send` publishes a sign-request; the browser runs
    the ceremony under the request's real alpha and posts the aggregate signature back for the
    helper to inject + broadcast) is single-spend proven live here; **multi-spend** over the live
    relay remains unit-tested only (`net_send` + `net-flow` suites).
- The threshold nature is **not** provable from chain data alone (a FROST-aggregated Orchard
  signature is indistinguishable on-chain from a single-signer one); it is attested off-chain.
- Two browser signing paths exist and must not be conflated:
  - **randomizer path** (`participantRound2WithRandomizer` / `aggregateWithRandomizer`) signs
    under the transaction's OWN alpha (read from the PCZT with `extractRandomizers`) and verifies
    under `ak+alpha` — the real Orchard spend-authorization mechanism. This is what the **live**
    `/net` ceremony uses today.
  - **seed path** (`participantRound2` / `Coordinator.aggregate`) derives its own randomizer from
    the commitments. It proves group signing over a message but is **not** a valid Orchard spend
    authorization. Used only by the `/signer` group-signing demo.
- So: the live `/net` ceremony signs a real Orchard/Ironwood sighash under the transaction's real
  alpha (the randomizer path). As of 2026-07-30 this is **broadcastable and broadcast**: the helper
  builds/proves a PCZT for the `/net` vault's **own** address, the browser signs it under that real
  alpha, and the helper broadcasts (txid `3022420a…` above). The old "sample PCZT belongs to a
  different vault, not broadcastable" caveat applied to the `/signer` demo vector and no longer
  describes the live `/net` path.
- **Ironwood (NU6.3) — PROVEN on mainnet (2026-07-28, activation day).** After activation
  (block 3,428,144) the #10 port was merged and the rebuilt engine was validated live. Two real,
  mined, **V6/NU6.3** mainnet transactions, each a FROST 2-of-3 ceremony:
  - **`54266f478505160adfb039c7c76f5615f1536a34059ab30e9f24781ec2e5c494`** (block 3,428,205) — an
    **Orchard→Ironwood migration**: it spends all of the vault's legacy Orchard notes and lands the
    funds in the Ironwood pool, seeding it.
  - **`36c60f1e3f602c2ac13c9f5b0687f248522499fc5a8b69311605336457226c95`** (block 3,428,246) — the
    **first Ironwood-pool spend**: a FROST 2-of-3 spend **from** the Ironwood pool. This is the
    headline (spending Ironwood, not just migrating into it).
  - Earlier the same day, a naive single-note Orchard self-send failed cleanly at extract-and-store
    (`Orchard MissingSpendAuthSig`, nothing broadcast, no funds moved): post-activation, spending a
    single legacy Orchard note produces a migration tx whose Orchard **dummy** spend (bundle padding)
    is not signed by the FROST flow. The fix that unblocked it: **`create-max` spends ALL the vault's
    Orchard notes at once**, so every Orchard action is a real spend (no dummy to sign). The
    Ironwood-pool path signs its own dummy correctly. Both txids were verified by `verify-proof.mjs`
    against public explorers. **This is a known, already-fixed upstream issue — not a Konclave bug:**
    librustzcash **#2777** (`create_pczt_from_proposal` did not stamp the ZIP32 derivation on
    wallet-controlled zero-value spends, so external signers could not sign them), fixed on
    librustzcash `main` by commit `51385a15` (2026-07-27). `create-max` is our interim workaround for
    the current engine pin; the proper fix arrives with an engine pin bump.
  - The testnet Ironwood spend (`069f4260…`, block 4,202,966) remains the earlier proof-of-concept;
    mainnet is now the authoritative proof. Konclave has **8** `proven on-chain` mainnet txids
  (the eighth, `3022420a…`, is the first browser-signed broadcast — see the honest-limits section).

## Rules for changes
1. When the proven-vs-pending state of anything changes, update `scripts/verify-proof.mjs`
   and `docs/PROOF.md` **first**, then update every referencing surface **in the same commit**.
2. Never introduce a new claim in one document without checking it against this file.
3. Never derive a viewing key as a hash of a value the product asks users to share; viewing
   keys go through ZIP-32 / official tooling.
4. Sensitive or external material (competitive analysis, third-party correspondence, private
   evaluation) stays out of the versioned repository. Working notes live in `temp/`, which is
   gitignored. Committed docs describe only Konclave's own code, tests, and verifiable
   on-chain artifacts.
