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

1. **Evidence level** - one of:
   - `proven on-chain` - a verifiable mainnet txid exists.
   - `dry-run` - signs and verifies locally, does not broadcast.
   - `by test` - covered by an automated test, no network artifact.
   - `roadmap` - not yet built.
2. **Key origin** (for anything about a vault) - one of:
   - `DKG` - key born by real Distributed Key Generation, never reconstituted anywhere.
   - `trusted-dealer` - a dealer briefly held the whole key at setup, then split it.

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
- **Signing-path gap - transaction-swap (H1). Partly shipped, one piece still stubbed.** Keep
  two things distinct:
  - **Shipped ([ADR-0007](adr/0007-ceremony-security-invariants.md), #67 / #68, live-validated
    2-tab):** PIN-gated room admission + a vault fingerprint each signer checks, which close the
    invite-as-bearer / wrong-room concern, and the on-device ZIP-244 sighash-binding **primitive**
    (proven byte-exact against the signer).
  - **Still stubbed (#62):** the live `/net` signing path does not yet recompute the ZIP-244
    sighash **on-device from its own PCZT** and compare it to what it signs. Until that lands, a
    compromised **helper** or **coordinator device** could in principle display a benign PCZT while
    the signed sighash targets an attacker output. So do **not** claim "the helper is blind and
    cannot steal": the helper is blind to *secrets* (round-2 is sealed) and cannot spend without the
    quorum, but the live path is not yet fully blind to *transaction substitution* by a malicious
    coordinator.
  - **Scope of the caveat:** this is about running the ceremony under an **untrusted third-party
    helper/coordinator**. It does **not** contradict the proven mainnet browser broadcast
    (`3022420a…`), which used the project's own blind helper and per-device `describeOutputs`
    review; it is why we do not yet recommend a real-money `/net` send driven by a helper you do not
    control until #62 ships. (Zkool ships the recompute defense; we are closing it.)
- **Signing-request metadata leak (H2, being fixed).** The `/net` signing request (`sighash`,
  `alpha`, `pczt_hex`) is currently posted to the relay in **plaintext**; the PCZT decodes to the
  recipient address and amount. Unlike the DKG round-2 packages (ECIES-sealed), it is not yet sealed,
  so a curious relay operator or room-code holder can read who a shielded vault pays and how much.
  Sealing it requires distributing the seated devices' X25519 keys to the (blind) helper - a
  handshake change, not a one-liner ([ADR-0007](adr/0007-ceremony-security-invariants.md) I3, issue
  #63). Until then, do not claim `/net` hides send metadata from the relay.
- **All eight mainnet sends so far were signed on a single machine.** The first seven used
  co-located CLI shares; the eighth (`3022420a…`) used **two browser tabs on one machine**. So the
  distributed browser-signing *protocol* is proven (separate shares, a blind relay, the key never
  reconstituted), but a broadcast across **separate, independently-controlled physical devices**,
  carried to a confirmed txid, is **still the open milestone** - the exact next step an independent
  review of the ZecHub FROST projects (2026-07-29) named as the meaningful one, and which none of the
  six had reached at that cutoff.
- **Browser-signed broadcast (two tabs, one machine) - PROVEN on mainnet (2026-07-30).** `/net` over
  a blind relay is no longer "verified but not broadcast": a browser-DKG **2-of-2** vault (created
  live in two browser tabs - both on one machine - over the hosted relay, key never reconstituted)
  was funded, restored on-device by both seats, and **signed a real Ironwood transaction IN THE
  BROWSER** - each **tab** contributing only its own share over the blind relay - after which the
  blind helper (`orchestrator::net_send`, Architecture B) injected and broadcast it. Mined: txid
  `3022420a8bcf17ffd5511163c18ee9b5996a3ba44747e4eff6794bdd3f04ccee` (block 3,429,922, V6/NU6.3).
  What it does **not** yet show: those two tabs on **separate devices** (see the open milestone above).
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
    under `ak+alpha` - the real Orchard spend-authorization mechanism. This is what the **live**
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
- **Hosted browser-native vault (self-service blind helper) - PROVEN on TESTNET (2026-07-31).**
  The `3022420a…` proof above used the *local* orchestrator bridge as the helper. This milestone
  proves the same Architecture B over the **hosted, public, share-blind helper** (`helper-server`,
  deployed on Railway, ADR-0006 Rung A) plus the hosted blind relay. A browser-DKG **2-of-2** vault,
  created live in two browser tabs over the PUBLIC relay, was **registered** with the helper (which
  derived its Orchard view-only address + wallet from the group key), **funded** with real testnet
  TAZ, and then **signed a real testnet Ironwood self-send IN THE BROWSER** (each tab contributing
  only its own share over the blind relay), which the helper injected and **broadcast**. Confirmed:
  txid `88128d56f60f2c9c661c2a821a8562e28452a92a4c92650300016ccdee80dce1` (testnet), verified two
  ways: the helper's ceremony record (`dry_run:false`, a fresh sighash + the 64-byte aggregate
  signature + the txid, which the helper writes only after `pczt send` returns) AND the vault's
  view-only balance dropping by exactly the ZIP-317 fee (10000 zat) after an independent sync. This
  is the full self-service pipeline (register, receive, balance, sign, broadcast, ceremony record) a
  real user anywhere would drive, over public infrastructure, proven end to end.
  - Still **testnet, not mainnet**, and still **two browser tabs on one machine**, not separate
    physical devices (the open milestone at the top of this section stands unchanged).
  - **Deployment update (2026-08):** the hosted share-blind helper is now **deployed on Zcash
    mainnet** on Railway (non-root container, durable volume) and serves **~23 live vaults**. That is
    a deployment fact, not a send proof: there is **no mainnet hosted-helper send txid yet**, so the
    Architecture-B end-to-end send above remains **proven on testnet only**. The mainnet proof set
    stands at **8 txids** (`docs/PROOF.md`), unchanged by this deployment.
  - Two hosted-helper bugs were found and fixed in the process: the helper image shipped without
    `curl` (its relay transport shells out to curl, so the publish step failed at "curl spawn"); and
    the helper's signing-collection window (`max_polls`) was too short for the browser ceremony over
    the public relay (120s, now 300s). Both redeployed.
  - Two findings noted (not blockers): the **restore then sign** path can deadlock live (a fresh-DKG
    session signs cleanly; restoring both seats then signing sometimes hangs, which matches the
    "signing-after-restore is unit-tested, live multi-device proof pending" caveat). And
    `zcash-sign generate` derives a **non-deterministic UFVK** for a given group key (re-deriving
    gives a different viewing key), so the persisted registration's stored UFVK is authoritative and
    a freshly re-derived view-only wallet sees nothing.
- **Ironwood (NU6.3) - PROVEN on mainnet (2026-07-28, activation day).** After activation
  (block 3,428,144) the #10 port was merged and the rebuilt engine was validated live. Two real,
  mined, **V6/NU6.3** mainnet transactions, each a FROST 2-of-3 ceremony:
  - **`54266f478505160adfb039c7c76f5615f1536a34059ab30e9f24781ec2e5c494`** (block 3,428,205) - an
    **Orchard→Ironwood migration**: it spends all of the vault's legacy Orchard notes and lands the
    funds in the Ironwood pool, seeding it.
  - **`36c60f1e3f602c2ac13c9f5b0687f248522499fc5a8b69311605336457226c95`** (block 3,428,246) - the
    **first Ironwood-pool spend**: a FROST 2-of-3 spend **from** the Ironwood pool. This is the
    headline (spending Ironwood, not just migrating into it).
  - Earlier the same day, a naive single-note Orchard self-send failed cleanly at extract-and-store
    (`Orchard MissingSpendAuthSig`, nothing broadcast, no funds moved): post-activation, spending a
    single legacy Orchard note produces a migration tx whose Orchard **dummy** spend (bundle padding)
    is not signed by the FROST flow. The fix that unblocked it: **`create-max` spends ALL the vault's
    Orchard notes at once**, so every Orchard action is a real spend (no dummy to sign). The
    Ironwood-pool path signs its own dummy correctly. Both txids were verified by `verify-proof.mjs`
    against public explorers. **This is a known, already-fixed upstream issue - not a Konclave bug:**
    librustzcash **#2777** (`create_pczt_from_proposal` did not stamp the ZIP32 derivation on
    wallet-controlled zero-value spends, so external signers could not sign them), fixed on
    librustzcash `main` by commit `51385a15` (2026-07-27). `create-max` is our interim workaround for
    the current engine pin; the proper fix arrives with an engine pin bump.
  - The testnet Ironwood spend (`069f4260…`, block 4,202,966) remains the earlier proof-of-concept;
    mainnet is now the authoritative proof. Konclave has **8** `proven on-chain` mainnet txids
  (the eighth, `3022420a…`, is the first browser-signed broadcast - see the honest-limits section).

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
