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
As of this writing, fifteen verifiable mainnet txids. **Nine** are from real DKG vaults (one CLI
DKG-vault send and eight browser-DKG browser-signed sends); the other six are trusted-dealer.

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
| Everyone-signs / last-signer-sends 2-of-2 (`64f94d29…`) | proven on-chain | **DKG** (browser) |
| **3-of-4** browser vault, largest quorum (`b496fc3c…`) | proven on-chain | **DKG** (browser) |
| Private payroll on the web, 2 beneficiaries (`7c4c1dd5…`) | proven on-chain | **DKG** (browser) |
| Across separate physical machines, over the internet (`aec83baf…`) | proven on-chain | **DKG** (browser) |
| Signed from a phone via the PWA (`2d861b8f…`) | proven on-chain | **DKG** (browser) |
| Survived a live bogus-response injection, #394 (`ef80a181…`) | proven on-chain | **DKG** (browser) |
| Relay blind to the payment, #63 (`047fe6ca…`) | proven on-chain | **DKG** (browser) |

Any statement of the form "the app payment used DKG" is **false**. The DKG-born sends are `aab00f90…`
(CLI DKG) and the eight browser-DKG sends (`3022420a…`, `64f94d29…`, `b496fc3c…`, `7c4c1dd5…`,
`aec83baf…`, `2d861b8f…`, `ef80a181…`, `047fe6ca…`); the app-payment, CLI-slice, fresh-vault, payroll
and both Ironwood-migration sends are trusted-dealer.

## Honest limits to keep stated (never hide)
- **Signing-path transaction-swap defense (H1) - SHIPPED on the primary path (#62 closed, live since
  2026-08-27).** Keep two things distinct:
  - **Shipped and live:** the app's background signer drives `SigningMachine`, which recomputes the
    ZIP-244 sighash **on-device from its own PCZT** and refuses the ceremony if it disagrees with what
    it is asked to sign - in **both** rounds (round 2's gap, where `onSp` overwrote the local sighash
    unchecked, was closed in #355), and it decodes and shows what the transaction pays before
    contributing a share. Plus ([ADR-0007](adr/0007-ceremony-security-invariants.md), #67 / #68,
    live-validated 2-tab): PIN-gated room admission + a vault fingerprint each signer checks, which
    close the invite-as-bearer / wrong-room concern. So on the path the app actually sends over, a
    hostile helper or coordinator **cannot** swap the transaction under a signer.
  - **Residual (open, #363):** the legacy standalone `/net` route (`NetVault.tsx`) is a **diverged**
    ceremony driver that does **not** recompute the sighash. That is #363, not #62. Do not drive a
    real-money send through that legacy route under a helper you do not control; the shipped
    background-signer path is the one the app uses. (Zkool ships the recompute defense too.)
- **Signing-request metadata leak (H2) - SHIPPED (#63), proven live 2026-08-29.** This bullet used to
  read: the `/net` signing request (`sighash`, `alpha`, `pczt_hex`) was posted to the relay in
  **plaintext**, so a curious relay operator or room-code holder could read who a shielded vault pays
  and how much. That is now closed. Each device derives a persistent comms key from its share and
  registers it; the (blind) helper **hybrid-seals** the SignRequest to the seated devices; and the
  ceremony no longer re-broadcasts the PCZT ([ADR-0007](adr/0007-ceremony-security-invariants.md) I3).
  The relay is blind to the payment - proof `047fe6ca…` (block 3,464,505), attested by the captured
  room trace (`docs/proof/2026-08-29-relay-blind.md`), not by the block. **Origin authentication of the
  signing room has since landed (#392, closed in #401):** an id-only outsider can no longer hijack a
  seat or forge room messages; residual ceremony-DoS vectors are #399/#400. Separately, the helper's
  write endpoints (voting) remain unauthenticated (#288).
- **A leaked vault id no longer opens the books or the signing room (#388, shipped and live).** Keep
  the nuance exact, because it is easy to overstate:
  - **What was leaking was never the chain.** A Konclave vault's on-chain data is Orchard-shielded:
    amounts, parties and memos are encrypted on mainnet and always were. The exposure was at the
    **helper**, which holds a *view-only* decryption of the vault (its UFVK) and used to answer reads
    - balance, transactions, ceremonies, proposals, ledger, members - to anyone who presented the
    public **vault id** (the group verifying key). The id was, in effect, a bearer **read** capability.
    It was never a spend capability: spending has always required a quorum of shares.
  - **What #388 changed.** Every seated member now holds a per-vault secret **S** - fresh 256-bit
    randomness minted by the creator at the DKG and sealed to members over the ceremony's encrypted
    channel (the #63 device-comms keys), persisted sealed at rest like the share. **S is not derived
    from the DKG** (anything DKG-derived crosses the relay and so would not be secret). The helper now
    gates its private reads behind `readKey = HKDF-SHA256(S)` in an `X-Konclave-Read` header
    (constant-time compared), and a migrated vault meets in a signing room derived from S
    (`SHA-256("konclave-sign-s " + S)[:16]`), not the public group key - so an id-only outsider can
    neither read the books nor find, join or observe the room.
  - **This is a product access-control lock, not a new cryptographic guarantee about the chain**
    (§6.14). It controls **who may ask the helper** and **who can find the room**; it does not change
    what the chain reveals (nothing) or the spend rule (a quorum). "Private outside, transparent
    inside" now holds for the helper's view too, not only for the chain.
  - **Still open, do not claim closed:** the gate is **per-vault and opt-in on registration** - a
    vault with no registered `readKey` stays **open** so the pre-#388 live vaults keep working, and
    migrating the remaining legacy vaults is #406. **Write** endpoints are still unauthenticated
    (anyone with a vault id can still vote): that is #288, a different axis from this read gate. (The
    signing-room seat-hijack #392 was closed in #401; residual ceremony-DoS is #399/#400.) A live
    external user created a #388-protected vault on 2026-08-30.
- **The vault export is one opaque encrypted blob (#214/#405, shipped).** v1 left the vault's identity
  in the clear (id/group key, address, member names, beneficiaries) even though the share was
  encrypted, so a leaked backup doxxed the vault. v2 encrypts the **entire** payload - metadata, share,
  the #388 secret S, and the beneficiaries - under the passphrase; only a non-sensitive envelope
  (format, version, salt, IV) is cleartext, so a leaked v2 backup reveals nothing, not even the vault
  id. Import reads both v1 (legacy) and v2. Honest limit unchanged: the share export restores the
  **signing seat**, not the vault's on-chain **identity** (the address/UFVK are random at registration
  and not reproducible from the share); the full kit is the share export **plus** the helper's
  `registration.json` (see [`RECOVERY.md`](RECOVERY.md), #214).
- **"Audited" needs its scope, and the scope excludes our variant.** The Zcash Foundation's
  `ZcashFoundation/frost` README says the code base has been *"partially audited by NCC"* and states
  the exclusion explicitly: *"This does not include frost-secp256k1-tr and **rerandomized FROST**."*
  Rerandomized FROST (RedPallas) is precisely the variant Zcash - and therefore Konclave - uses for
  Orchard/Ironwood spend authorization. `frostd`/`frost-client` carry a separate Least Authority
  audit, which covers the *coordination tooling*, not the ceremony cryptography we depend on. So do
  not write "the cryptography is audited" without that scope: two audits exist, and neither one
  covers the signing variant on our money path. (Verified against the ZF repo README, 2026-08-31.)
- **The AI assistant cannot move money - state the guarantee precisely, and its limit.** What is
  true and checkable: `mcp-server/` registers exactly **eight** tools - six read-only (`list_vaults`,
  `get_vault`, `get_balance`, `get_transactions`, `list_proposals`, `get_ledger`) and two draft
  (`propose_payment`, `propose_payroll`) - and there is **no** approve, sign, send or broadcast tool
  among them; a drafted proposal is created *awaiting approval* and moves zero funds. The guarantee is **structural** - the capability
  does not exist - not a behavioural promise about a model. What it does **not** claim: that an
  assistant cannot influence an outcome. It can draft a proposal with a destination or an amount a
  human should refuse, and if the quorum approves it, the money moves. The defence there is the same
  as for any proposal: the preview, the explicit confirmation, and the on-device sighash check (H1) -
  not the MCP boundary. Related, and worth saying because outside readers assume otherwise: the MCP
  server is **not** the coordinator of the FROST ceremony (that is the blind helper); an AI is never
  on the critical path of a spend.
- **The cross-device milestone is now closed on mainnet.** The first eight mainnet sends were signed
  on a single machine (seven with co-located CLI shares; the eighth, `3022420a…`, two browser tabs on
  one machine). Since then a broadcast across **separate, independently-controlled physical devices**,
  carried to a confirmed txid, has been proven: `aec83baf…` (proposed and approved by Michael,
  co-signed by Daniel on a different computer in a different place) and `2d861b8f…` (the closing
  signature made on an **Android phone**). This was the exact next step an independent review of the
  ZecHub FROST projects (2026-07-29) named as the meaningful one, and which none of the six had
  reached at that cutoff.
- **Browser-signed broadcast (two tabs, one machine) - PROVEN on mainnet (2026-07-30).** `/net` over
  a blind relay is no longer "verified but not broadcast": a browser-DKG **2-of-2** vault (created
  live in two browser tabs - both on one machine - over the hosted relay, key never reconstituted)
  was funded, restored on-device by both seats, and **signed a real Ironwood transaction IN THE
  BROWSER** - each **tab** contributing only its own share over the blind relay - after which the
  blind helper (`orchestrator::net_send`, Architecture B) injected and broadcast it. Mined: txid
  `3022420a8bcf17ffd5511163c18ee9b5996a3ba44747e4eff6794bdd3f04ccee` (block 3,429,922, V6/NU6.3).
  It was two tabs on **one machine**; the separate-physical-devices milestone was closed later on
  mainnet (`aec83baf…`, `2d861b8f…`, above).
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
  - That specific proof was **testnet** and **two browser tabs on one machine**. The cross-device,
    mainnet milestone it left open has since been closed on mainnet (`aec83baf…`, separate physical
    machines; `2d861b8f…`, an Android phone).
  - **Update (2026-08-30):** the hosted share-blind helper runs on Zcash **mainnet** (Railway,
    non-root container, durable volume) and, after a census that reversibly retired disposable test
    vaults, serves **5 active vaults** (was ~26). Architecture B is now **proven on mainnet**, not only
    on testnet: browser-signed sends over the hosted, public, share-blind helper, including **across
    separate physical machines** (`aec83baf…`) and with the **relay blind to the payment**
    (`047fe6ca…`). The mainnet proof set stands at **15 txids** (`docs/PROOF.md`).
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
