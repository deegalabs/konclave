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
As of this writing, five verifiable mainnet txids. Only ONE is from a real DKG vault.

| Transaction | Evidence | Key origin |
|---|---|---|
| Application-driven 2-of-3 quorum payment (`43433a10…`) | proven on-chain | trusted-dealer |
| Gate-1 CLI vertical-slice payment (`f63ee64d…`) | proven on-chain | trusted-dealer |
| Fresh-vault 2-of-3 payment (`6c898239…`) | proven on-chain | trusted-dealer |
| Private multi-output payroll, 3 outputs (`b1e24c07…`) | proven on-chain | trusted-dealer |
| **DKG-vault send (`aab00f90…`)** | proven on-chain | **DKG** |

Any statement of the form "the app payment used DKG" is **false**. Only `aab00f90…` is DKG.

## Honest limits to keep stated (never hide)
- The five mainnet sends were signed on a **single machine** (shares co-located at signing).
- Distributed cross-machine signing is demonstrated by `/net` over a blind relay, **verified
  but not broadcast**.
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
- **Ironwood (NU6.3):** the Ironwood-pool spend path was validated **on testnet** — a FROST
  2-of-3 spend from a testnet vault, built + proved for the vault's own address, signed by the
  quorum, broadcast, and **mined into a block** (testnet tx `069f4260…`, block 4,202,966). That
  is `testnet, mined`, which is NOT `proven on-chain` in the mainnet sense and NOT mainnet. All
  five `proven on-chain` mainnet txids remain pre-Ironwood Orchard. The mainnet Ironwood send
  path is prepared but held until activation (see the ROADMAP). Do not state or imply an Ironwood
  **mainnet** spend until a mainnet Ironwood txid exists.

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
