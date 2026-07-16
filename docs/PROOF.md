# Proof — Konclave's mainnet transactions are real

This document lets a judge independently confirm, from public block explorers,
that the Zcash mainnet transactions Konclave claims are genuine. It also states
plainly what on-chain data can and cannot prove, so nothing here is overclaimed.

## What the proof shows

Konclave claims five real Zcash **mainnet** transactions:

| Role | Transaction ID | Block |
|---|---|---|
| Application-driven 2-of-3 quorum payment (FROST-signed, broadcast through the app) | `43433a109d3f2a078c0a9269ccb156392ade7a1f7ac1532981611eda1e59a572` | mined |
| Gate-1 CLI-driven vertical-slice payment | `f63ee64d7bc086a8286631d03936ec2ca2ca57f4e4c63712fc95c1f02c522360` | 3,396,616 |
| 2-of-3 FROST payment from a freshly created and funded vault (reproduced end to end) | `6c898239e05fdd1ccce5d650fa25eeabb10d1645a3fdbc36ab5fd3ac8d4fd35f` | 3,413,636 |
| Private multi-output payroll (3 outputs, one encrypted memo each), 2-of-3 FROST | `b1e24c07fcd629e6e6ea6809ffeb5d2e311054781740c6a5db73dabc94d0e1b4` | 3,413,648 |
| 2-of-3 FROST send from a **real DKG-generated vault** (key never reconstituted) | `aab00f903b65e32d1adac317820a85fc97d15c2dcd788b3657ce36773e230ff3` | 3,413,792 |

The verifier queries independent public explorers and confirms each transaction
exists and is mined on mainnet, reporting the block height, confirmations, and
whatever shielded/output metadata the explorer exposes.

## How to run

Requires Node 18 or newer (uses the built-in `fetch`, no dependencies, no
`npm install`).

```
node scripts/verify-proof.mjs
```

The script exits `0` only if the transactions are confirmed found and mined. It
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
- Fresh-vault payment `6c898239...d4fd35f`
  - zcashexplorer: https://mainnet.zcashexplorer.app/transactions/6c898239e05fdd1ccce5d650fa25eeabb10d1645a3fdbc36ab5fd3ac8d4fd35f
  - Blockchair: https://blockchair.com/zcash/transaction/6c898239e05fdd1ccce5d650fa25eeabb10d1645a3fdbc36ab5fd3ac8d4fd35f
- Private multi-output payroll `b1e24c07...94d0e1b4`
  - zcashexplorer: https://mainnet.zcashexplorer.app/transactions/b1e24c07fcd629e6e6ea6809ffeb5d2e311054781740c6a5db73dabc94d0e1b4
  - Blockchair: https://blockchair.com/zcash/transaction/b1e24c07fcd629e6e6ea6809ffeb5d2e311054781740c6a5db73dabc94d0e1b4
- DKG-vault FROST send `aab00f90...3e230ff3`
  - zcashexplorer: https://mainnet.zcashexplorer.app/transactions/aab00f903b65e32d1adac317820a85fc97d15c2dcd788b3657ce36773e230ff3
  - Blockchair: https://blockchair.com/zcash/transaction/aab00f903b65e32d1adac317820a85fc97d15c2dcd788b3657ce36773e230ff3

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

- two of these are attested as coming from **real Distributed Key Generation** vaults,
  where the key was never reconstituted on any one machine: the application-driven
  transaction, and the dedicated DKG-vault send `aab00f90...` (whose 2-of-3 group key was
  produced by a live DKG ceremony among three participants, then funded and spent by a FROST
  ceremony). The other three evidence transactions used a trusted-dealer 2-of-3 vault, stated
  plainly;
- the signature was assembled by a FROST ceremony among the members who approved
  the proposal, coordinated through a blind relay that sees only public material;
- the build and ceremony paths are covered by the repository's test suite.

The honest claim is therefore layered: the **chain** proves these are real, mined,
shielded mainnet transactions; the **build and ceremony** establish that they were
produced by a 2-of-3 FROST quorum, and that two of them (the application-driven payment
and the dedicated DKG-vault send) came from vaults whose key was generated by real DKG and
never reconstituted. This document does not ask a judge to take the threshold nature on
faith from the chain, because the chain cannot show it, by design.
