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
As of this writing, seven verifiable mainnet txids. Only ONE is from a real DKG vault.

| Transaction | Evidence | Key origin |
|---|---|---|
| Application-driven 2-of-3 quorum payment (`43433a10…`) | proven on-chain | trusted-dealer |
| Gate-1 CLI vertical-slice payment (`f63ee64d…`) | proven on-chain | trusted-dealer |
| Fresh-vault 2-of-3 payment (`6c898239…`) | proven on-chain | trusted-dealer |
| Private multi-output payroll, 3 outputs (`b1e24c07…`) | proven on-chain | trusted-dealer |
| **DKG-vault send (`aab00f90…`)** | proven on-chain | **DKG** |
| Orchard→Ironwood migration, V6/NU6.3 (`54266f47…`) | proven on-chain | trusted-dealer |
| First Ironwood-pool spend, V6/NU6.3 (`36c60f1e…`) | proven on-chain | trusted-dealer |

Any statement of the form "the app payment used DKG" is **false**. Only `aab00f90…` is DKG.

## Honest limits to keep stated (never hide)
- The seven mainnet sends were signed on a **single machine** (shares co-located at signing).
- Distributed cross-machine signing is demonstrated by `/net` over a blind relay, **verified
  but not broadcast**.
  - The helper-assisted broadcast path (Architecture B) is now **wired end to end in code**: a
    blind helper (`orchestrator::net_send`) publishes a sign-request into the relay room, the
    browser (`/net`) consumes it, runs the ceremony under the request's real alpha, and posts the
    aggregate signature back for the helper to inject and broadcast. This is **single-spend and
    unit-tested** (`net_send` + `net-flow` suites); the **live broadcast** (a funded browser-DKG
    vault over the relay) is still pending, so the claim above stays "verified but not broadcast".
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
- So: the live `/net` ceremony signs a real Orchard sighash under the transaction's real alpha
  (`by test` at the crypto layer). It is still **not broadcastable**: the sample PCZT belongs to a
  different vault, so the signature verifies under `ak+alpha` but is not for a transaction this
  vault owns. A real broadcast needs the operator to create/prove a PCZT for the `/net` vault's own
  address, plus the browser broadcast. Both are `roadmap`.
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
    against public explorers.
  - The testnet Ironwood spend (`069f4260…`, block 4,202,966) remains the earlier proof-of-concept;
    mainnet is now the authoritative proof. Konclave has **7** `proven on-chain` mainnet txids.

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
