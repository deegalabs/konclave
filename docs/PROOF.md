# Proof - Konclave's mainnet transactions are real

This document lets a judge independently confirm, from public block explorers,
that the Zcash mainnet transactions Konclave claims are genuine. It also states
plainly what on-chain data can and cannot prove, so nothing here is overclaimed.

## What the proof shows

Konclave claims seven real Zcash **mainnet** transactions:

| Role | Transaction ID | Block |
|---|---|---|
| Application-driven 2-of-3 quorum payment (FROST-signed, broadcast through the app) | `43433a109d3f2a078c0a9269ccb156392ade7a1f7ac1532981611eda1e59a572` | mined |
| Gate-1 CLI-driven vertical-slice payment | `f63ee64d7bc086a8286631d03936ec2ca2ca57f4e4c63712fc95c1f02c522360` | 3,396,616 |
| 2-of-3 FROST payment from a freshly created and funded vault (reproduced end to end) | `6c898239e05fdd1ccce5d650fa25eeabb10d1645a3fdbc36ab5fd3ac8d4fd35f` | 3,413,636 |
| Private multi-output payroll (3 outputs, one encrypted memo each), 2-of-3 FROST | `b1e24c07fcd629e6e6ea6809ffeb5d2e311054781740c6a5db73dabc94d0e1b4` | 3,413,648 |
| 2-of-3 FROST send from a **real DKG-generated vault** (key never reconstituted) | `aab00f903b65e32d1adac317820a85fc97d15c2dcd788b3657ce36773e230ff3` | 3,413,792 |
| Post-Ironwood (NU6.3) **V6** tx: 2-of-3 FROST **Orchard→Ironwood migration** (seeds the Ironwood pool) | `54266f478505160adfb039c7c76f5615f1536a34059ab30e9f24781ec2e5c494` | 3,428,205 |
| First **Ironwood-pool spend** on mainnet: 2-of-3 FROST spend **from** the Ironwood pool (V6/NU6.3) | `36c60f1e3f602c2ac13c9f5b0687f248522499fc5a8b69311605336457226c95` | 3,428,246 |
| First **browser-signed** mainnet broadcast: browser-DKG 2-of-2 vault, each **tab** signing **in the browser** with only its own share over the blind relay (Architecture B), Ironwood pool. *Two tabs on one machine* - the cross-device broadcast is the open milestone. | `3022420a8bcf17ffd5511163c18ee9b5996a3ba44747e4eff6794bdd3f04ccee` | 3,429,922 |

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
- Orchard→Ironwood migration `54266f47...c2e5c494`
  - zcashexplorer: https://mainnet.zcashexplorer.app/transactions/54266f478505160adfb039c7c76f5615f1536a34059ab30e9f24781ec2e5c494
  - Blockchair: https://blockchair.com/zcash/transaction/54266f478505160adfb039c7c76f5615f1536a34059ab30e9f24781ec2e5c494
- Ironwood-pool FROST spend `36c60f1e...57226c95`
  - zcashexplorer: https://mainnet.zcashexplorer.app/transactions/36c60f1e3f602c2ac13c9f5b0687f248522499fc5a8b69311605336457226c95
  - Blockchair: https://blockchair.com/zcash/transaction/36c60f1e3f602c2ac13c9f5b0687f248522499fc5a8b69311605336457226c95
- Browser-signed broadcast `3022420a...3f04ccee`
  - zcashexplorer: https://mainnet.zcashexplorer.app/transactions/3022420a8bcf17ffd5511163c18ee9b5996a3ba44747e4eff6794bdd3f04ccee
  - Blockchair: https://blockchair.com/zcash/transaction/3022420a8bcf17ffd5511163c18ee9b5996a3ba44747e4eff6794bdd3f04ccee

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

- exactly one of these is attested as coming from a **real Distributed Key Generation**
  vault, where the key was never reconstituted on any one machine: the dedicated DKG-vault
  send `aab00f90...` (whose 2-of-3 group key was produced by a live DKG ceremony among three
  participants, then funded and spent by a FROST ceremony). The other four evidence
  transactions, including the application-driven payment, used a trusted-dealer 2-of-3 vault,
  stated plainly;
- the signature was assembled by a FROST ceremony among the members who approved
  the proposal, coordinated through a blind relay that sees only public material;
- the build and ceremony paths are covered by the repository's test suite.

One honest note on the evidence, stated plainly. The first **seven** mainnet sends were
signed on a **single machine**: the participants' shares were co-located as separate
processes at signing time. The ceremony was real; its distribution across independent
devices was not part of those broadcasts. The **eighth** send (`3022420a…`) closes that
gap: it was signed **across two independent browser devices** over a blind relay (the
`/net` page), each contributing only its own share, and then broadcast - the ceremony run
distributed AND settled on-chain in one motion. The honest remaining edge is that this
live browser-signed broadcast is proven **single-spend**; multi-spend over the live relay
is still test-only.

The honest claim is therefore layered: the **chain** proves these are real, mined,
shielded mainnet transactions; the **build and ceremony** establish that they were
produced by a 2-of-3 FROST quorum, and that one of them (the dedicated DKG-vault send) came
from a vault whose key was generated by real DKG and never reconstituted. This document does
not ask a judge to take the threshold nature on
faith from the chain, because the chain cannot show it, by design.
