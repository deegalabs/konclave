# Proof — Konclave's mainnet transactions are real

This document lets a judge independently confirm, from public block explorers,
that the Zcash mainnet transactions Konclave claims are genuine. It also states
plainly what on-chain data can and cannot prove, so nothing here is overclaimed.

## What the proof shows

Konclave claims two real Zcash **mainnet** transactions:

| Role | Transaction ID | Block |
|---|---|---|
| Application-driven 2-of-3 quorum payment (FROST-signed, broadcast through the app) | `43433a109d3f2a078c0a9269ccb156392ade7a1f7ac1532981611eda1e59a572` | mined |
| Gate-1 CLI-driven vertical-slice payment | `f63ee64d7bc086a8286631d03936ec2ca2ca57f4e4c63712fc95c1f02c522360` | 3,396,616 |

The verifier queries independent public explorers and confirms each transaction
exists and is mined on mainnet, reporting the block height, confirmations, and
whatever shielded/output metadata the explorer exposes.

## How to run

Requires Node 18 or newer (uses the built-in `fetch`, no dependencies, no
`npm install`).

```
node scripts/verify-proof.mjs
```

The script exits `0` only if both transactions are confirmed found and mined. It
exits `1` on a verification failure, and also exits `1` (with an INCONCLUSIVE
verdict) if the network is unavailable, so a connectivity problem is never
mistaken for a proof failure.

## Explorer links

Verify by hand as well as by script:

- Application-driven payment `43433a10...c522360`
  - zcashexplorer: https://mainnet.zcashexplorer.app/transactions/43433a109d3f2a078c0a9269ccb156392ade7a1f7ac1532981611eda1e59a572
  - Blockchair: https://blockchair.com/zcash/transaction/43433a109d3f2a078c0a9269ccb156392ade7a1f7ac1532981611eda1e59a572
- Gate-1 slice payment `f63ee64d...c522360`
  - zcashexplorer: https://mainnet.zcashexplorer.app/transactions/f63ee64d7bc086a8286631d03936ec2ca2ca57f4e4c63712fc95c1f02c522360
  - Blockchair: https://blockchair.com/zcash/transaction/f63ee64d7bc086a8286631d03936ec2ca2ca57f4e4c63712fc95c1f02c522360

The script uses Blockchair's API as its primary source
(`https://api.blockchair.com/zcash/dashboards/transaction/<txid>`) and
zcashexplorer.app as a fallback, so a single explorer being down does not block
verification.

## What on-chain verification CAN prove

- **Existence.** The transaction is a real object recorded on the Zcash mainnet
  chain, retrievable by any independent explorer.
- **Mined.** It is included in a block at a known height, with confirmations
  accumulating on top of it. It is not a local mock or a dry-run.
- **Shielded / indistinguishable.** Being an Orchard shielded transaction, it
  reveals nothing on-chain about amounts, senders, or recipients. That absence of
  detail is the privacy guarantee working as intended, not missing data.

## What on-chain verification CANNOT prove alone

On-chain data does **not**, by itself, prove that the payment was authorized by a
2-of-3 **threshold (FROST)** signature rather than by an ordinary single signer.

The reason is structural, not a gap in the tooling. FROST produces a single
aggregated signature that is valid under the group's public key. For Orchard
(rerandomized FROST / redpallas), that aggregated signature is
**cryptographically indistinguishable** from a signature produced by one person
holding one key. The chain sees one valid Orchard signature either way. This
indistinguishability is itself a privacy property: an observer cannot tell that
funds are under shared custody, how many participants exist, or what the threshold
is.

Because of that, the threshold nature is attested by artifacts **off-chain**:

- the vault's key material was produced by a real Distributed Key Generation (the
  key was never reconstituted on one machine);
- the signature was assembled by a FROST ceremony among the members who approved
  the proposal, coordinated through a blind relay that sees only public material;
- the build and ceremony paths are covered by the repository's test suite.

The honest claim is therefore layered: the **chain** proves these are real, mined,
shielded mainnet transactions; the **build and ceremony** establish that the
application-driven one was produced by a 2-of-3 FROST quorum. This document does
not ask a judge to take the threshold nature on faith from the chain, because the
chain cannot show it, by design.
