---
name: zcash-consensus-zips
description: Use when building, validating, signing, fee-estimating or broadcasting a Zcash shielded transaction - to know which pool an output may land in post-NU6.3, what ZIP 326 forbids, why a signer recomputes its own ZIP 244 sighash, how the ZIP 317 fee is computed, and what PCZT roles guarantee. Read before touching destination validation, fee math, or the PCZT/signing path.
---

# Zcash consensus rules that bind a wallet

Everything here is traced to a ZIP at zips.z.cash or to `zcash/librustzcash`. **Status is part of
the rule.** A Draft is the current best description of intent, not a settled guarantee - and one of
the rules below lives in a ZIP that has *no text at all* yet.

## The ZIPs that bind you

| ZIP | Title | Status | Upgrade |
|---|---|---|---|
| 244 | Transaction Identifier Non-Malleability | **Final** | NU5 |
| 317 | Proportional Transfer Fee Mechanism | **Rev 0 Active**; Rev 1 (NU6.3) Draft; Rev 2 Draft | - / NU6.3 |
| 258 | Deployment of the NU6.3 Network Upgrade | Draft | NU6.3 |
| 229 | Version 6 Transaction Format | Draft | NU6.3 |
| 2005 | Ironwood Quantum Recoverability | Proposed | NU6.3 |
| 2006 | Restricting Transfers into the Orchard Pool | **Reserved - header only, no spec text** | NU6.3 |
| 326 | NU6.3 Consequences for Wallets | Draft (Category: Wallet) | NU6.3 |
| 318 | Orchard to Ironwood Migration | Draft (Category: Wallet) | NU6.3 |
| 374 | Partially Created Zcash Transaction Format | Draft | - (Wallet) |
| 218 | 25-second Block Target Spacing | Draft | **NU7 - not active** |

NU6.3 activation (ZIP 258): Mainnet `3428143`, Testnet `4134000`, consensus branch ID `0x37A5165B`.

## The pools, and which one a new receive lands in

Sprout → Sapling → **Orchard** → **Ironwood**. Ironwood is new in NU6.3: an *Orchard-protocol*
successor pool that reuses Orchard's circuit and address format, with a new note plaintext lead byte
(`0x03` vs Orchard's `0x02`) and quantum recoverability (ZIP 2005, Proposed).

The single most misread fact, straight from ZIP 326:

> "A receiver, and the corresponding incoming viewing key, is scoped to the Orchard *protocol*, not
> to a pool: the same ivk is used to trial-decrypt both *Orchard-pool* and *Ironwood-pool* note
> ciphertexts."

> "Once an Orchard-protocol receiver has been exposed, no party can be prevented from sending funds
> to it in either pool, subject to the consensus rules."

So **the address does not choose the pool - the sender does.** An Orchard receiver in a Unified
Address is a perfectly valid destination after NU6.3; what changes is which pool *you* put the
output in. Address parsing and pool selection are two different decisions.

**Transaction versions (ZIP 229, Draft).** V6 adds the Ironwood component to V5's layout; Sapling
and Orchard components remain. `"[NU6.3 onward] The transaction version number MUST be 4 or 5 or
6."` V5 stays valid. Ironwood requires V6 (`version_group_id` `0xD884B698`). V6 also moves the
Sapling/Orchard/Ironwood anchors from effecting data into *authorizing* data, which is what lets a
v6 PCZT be signed before anchors and proofs exist.

---

# What you must not do

### 1. Do not create a new payment output in the Orchard pool

ZIP 326 (**Draft**, Wallet), *Wallet key-generation restrictions*, verbatim:

> "A wallet MUST NOT send funds to any external receiver (including its own) in the *Orchard pool*
> after NU6.3 activation."

Note precisely what that sentence restricts: the **pool the funds land in**, not the receiver you
parsed. Rejecting an address because it carries an Orchard receiver is the wrong fix and breaks
legitimate payments; routing the output into Ironwood is the right one. ZIP 326 says the send-path
routing decision itself is "out of scope here; see the migration ZIP" (ZIP 318).

Same section, also normative: a wallet `"MUST generate keys with the same value of use_qsk - either
all true or all false, never a mixture"` (per ZIP 32 account); a wallet generating `use_qsk = true`
keys `"MUST NOT send Orchard-pool funds to them at any point"` and `"MUST NOT expose the
corresponding Orchard-protocol receivers or viewing keys before NU6.3 activation"`; and `"a
production wallet MUST NOT generate use_qsk = true keys at all before NU6.3 has activated on
Mainnet."`

**Honesty flag.** ZIP 326 states plainly that these `"concern only how a wallet generates and uses
keys; they are not consensus rules."` The consensus-level restriction is ZIP 2006, whose status is
**Reserved**: the file at zips.z.cash is a header block with **no specification text**. ZIP 229
references its `enableCrossAddress` flag (bit 2 of `flagsOrchard`/`flagsIronwood`), and ZIP 326
carries the same-address restriction on ZIP 2006's behalf, marked *"until that ZIP is written"*. So:
enforce the ZIP 326 MUST NOT, and do **not** claim to know the consensus text - it does not exist yet.

### 2. Do not spend in the Orchard pool without the fabricated same-address output

ZIP 326, stated on ZIP 2006's behalf: after NU6.3 every Orchard-pool Action is subject to a
same-address restriction - each Action's output receiver must equal its spent-note receiver. A
wallet spending in Orchard pairs each real spend with a **fabricated, zero-valued output** to the
spent note's own receiver, and:

> "the wallet MUST fill the note ciphertext `enc_ciphertext` with random bytes, rather than with a
> real encryption of the note plaintext to the spent note's receiver."

A real encryption there would trial-decrypt under the spent note's ivk in the same Action carrying
that spend's nullifier - linking them for anyone holding the ivk. This is the shape of an
Orchard→Ironwood migration spend (ZIP 318, Draft), which also requires that
`"The destination of a migration MUST be the user's internal change address in the Ironwood pool."`

### 3. Do not sign a digest you were handed - recompute it

**ZIP 244 (Final, NU5)** defines three digests: the **txid digest** (effecting data, no
witnesses/proofs), the **signature digest** (what you sign), and the **authorizing data commitment**
(proofs and signatures). The txid tree is personalised `"ZcashTxHash_" || CONSENSUS_BRANCH_ID` over
`header_digest`, `transparent_digest`, `sapling_digest`, `orchard_digest`.

The load-bearing sentence, verbatim from *Signature Digest*:

> "For transactions without transparent inputs, this algorithm has the exact same output as the
> transaction digest algorithm, thus the txid may be signed directly."

Read the consequence carefully: for a fully shielded transaction **the sighash is the txid**. A
signer that accepts a sighash off the wire is not "trusting a hash" - it is letting the sender pick
which transaction gets authorized, with no residual binding to the amounts and recipients it just
displayed. The signature digest commits to all Sapling and Orchard data and (absent
`SIGHASH_SINGLE`/`SIGHASH_NONE`) all transparent outputs, so recomputing it locally from your own
copy is what ties the signature to what the user saw. No cheaper check gets the same property.

Also normative: `"MUST NOT use any undefined hash_type"`; `"MUST NOT use SIGHASH_SINGLE without a
corresponding output at matching index"`.

### 4. Do not sign a PCZT you have not inspected

**ZIP 374 (Draft)** exists because transaction creation is not monolithic - offline and hardware
signers cannot prove, provers must not see spending keys, and multiparty flows need deterministic
merging. Its premise: `"Signers must be able to determine, from the PCZT alone, exactly what they
are authorizing: amounts, recipients, and the correspondence between the fields they sign over and
the values shown to the user."`

Roles, in dependency order: **Creator** → **Constructor** (inputs/outputs) → **IO Finalizer** (closes
the I/O set, signs dummy spends, clears dummy key material) → **Updater** (derivation paths,
witnesses, anchors) → **Prover** and **Signer** (independent, may run in parallel) → **Combiner**
(merges parallel contributions; **Redactor** strips fields a signer does not need) → **Spend
Finalizer** → **Transaction Extractor**. PCZT v1 carries v5; **v2 carries v5 and v6** and adds the
`IronwoodBundle`.

Before signing, verbatim:

> "MUST reject a PCZT that contains `dummy_ask` or `dummy_sk` values (the IO Finalizer signs dummy
> spends and clears these fields; their presence means the Signer is being asked to parse spending
> key material)."

> "MUST, for each output carrying a `user_address`, parse that address and confirm that it contains
> the output's `recipient` (either directly, or e.g. as a receiver within a Unified Address)."

> "SHOULD verify that the explicit values and note data it relies upon for user confirmation are
> consistent with the effecting data being signed."

And the v5/v6 split, which bites: `"For a v6 transaction, a Signer MAY sign a PCZT whose shielded
bundle anchors, witnesses, or proofs are absent: signatures commit to none of these."` A signer
asked to do so SHOULD know `"a spend whose witness is absent may be of a note that does not yet
exist on chain - the signature authorizes the spend regardless."` **For v5, anchors are part of the
signature hash and MUST be present before signing.** Combiner rule worth knowing: globals
(`tx_version`, `version_group_id`, `consensus_branch_id`, `expiry_height`) `"MUST be equal in all
inputs"` or the merge fails.

### 5. Do not invent a fee - compute the ZIP 317 conventional fee

**ZIP 317 Revision 0 is Active**; Revision 1 (NU6.3, adds Ironwood) and Revision 2 (memo bundles,
needs ZIP 248) are Draft.

```
conventional_fee = marginal_fee · max(grace_actions, logical_actions)

marginal_fee  = 5000 zatoshis per logical action
grace_actions = 2                       →  floor of 10000 zatoshis (0.0001 ZEC)

logical_actions = max( ceiling(tx_in_total_size / 150),
                       ceiling(tx_out_total_size / 34) )   # transparent
                + 2 · nJoinSplit                            # Sprout
                + max(nSpendsSapling, nOutputsSapling)      # Sapling
                + nActionsOrchard                           # Orchard
                + nActionsIronwood                          # Ironwood (Revision 1)
```

Confirmed against `librustzcash/zcash_primitives/src/transaction/fees/zip317.rs`: `MARGINAL_FEE =
5_000`, `GRACE_ACTIONS = 2`, `P2PKH_STANDARD_INPUT_SIZE = 150`, `P2PKH_STANDARD_OUTPUT_SIZE = 34`,
`MINIMUM_FEE = 10_000`, and the same `max`/`ceildiv` shape with Orchard and Ironwood action counts
summed. (librustzcash omits the Sprout term - it does not build Sprout.)

ZIP 317 is normatively a **SHOULD**, not consensus: `"It is not a consensus requirement that fees
follow this formula; however, wallets SHOULD create transactions that pay this fee, in order to
reduce information leakage, unless overridden by the user."` A non-conventional fee is a **privacy
leak** (it fingerprints the wallet) before it is a relay problem.

**Estimating an N-recipient shielded payroll.** Fully shielded, so the transparent term is 0 and the
fee is `5000 · max(2, nActions)`. An Action pairs one spend with one output, so
`nActions = max(spends, outputs)` with outputs = N recipients **+ change**. On top of that the
builder applies bundle padding (`BundlePadding::DEFAULT` vs `UNPADDED`, per pool, derived - see
`zcash_client_backend/src/fees/common.rs`, `transactional_action_count`). **Take the action count
from the builder; do not hand-compute the padding floor.** A 10-recipient payroll with change from
one note lands near 11 actions ≈ 55,000 zatoshis - a sanity check on the builder's number, never a
substitute for it.

### 6. Do not assume a per-transaction action cap exists today

**ZIP 218 is Draft and targets NU7, which is not active.** It is titled *25-second Block Target
Spacing*; the action limits are a DoS side-effect of the faster blocks, and they are **per block,
not per transaction**: `"The total number of Orchard actions across all transactions in the block
MUST NOT exceed 330"` (Sapling inputs+outputs 300; Sprout JoinSplits 25; combined shielded cost
330). It imposes no per-transaction limit, and the existing 2 MB block size limit continues to apply.

So today, the ceiling on a large payroll is **transaction size** (and ZIP 229's `"nActionsIronwood
MUST be less than..."` bound), not ZIP 218. If NU7 activates, a 330-action *block* cap becomes a
throughput and confirmation-latency concern for a big payroll competing with other transactions -
still not a hard per-transaction cap. Do not cite ZIP 218 as current law.

---

## What is deliberately not here

Not covered because it belongs to other skills: the FROST protocol and ZIP 312 (Draft, Category
Wallet, no target upgrade), the engine binaries, and this repo's own code. Left out for lack of a
primary source: NU7 activation heights (ZIP 218 says deployment is a separate ZIP; no activation
height is published), ZIP 2006's consensus text (Reserved, empty), and the exact Orchard/Ironwood
bundle padding floor (builder-determined in librustzcash, not stated as a ZIP rule).

---

**Verified against zips.z.cash and zcash/librustzcash on 2026-08-31.** Re-check by refetching
`zips.z.cash/zip-0326`, `-0244`, `-0317`, `-0374`, `-0229`, `-0258`, `-0218` (statuses change; three
of the NU6.3 ZIPs are still Draft and ZIP 2006 is still unwritten) and
`zcash_primitives/src/transaction/fees/zip317.rs` before relying on any constant here.
