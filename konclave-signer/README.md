# konclave-signer

The **FROST ↔ PCZT bridge** — the seed of the Konclave Orquestrador (Layer 2).

## Why it exists

The two official Zcash tools that must cooperate for a headless Orchard FROST
spend currently sit on **different library versions and do not interoperate**:

- **`zcash-sign`** (ZcashFoundation/frost-tools) can inject FROST signatures, but
  only reads PCZTs at its (older) `pczt 0.5` / `orchard 0.11-fork` stack, and its
  Ywallet plan path is disabled.
- **`zcash-devtool`** (zcash) creates/proves/broadcasts PCZTs at `pczt 0.7` /
  `orchard 0.14`, but its `pczt update-with-signature` returns `TODO` for the
  Orchard pool (only transparent is implemented).

So neither tool alone completes the Orchard FROST spend, and `zcash-sign` cannot
read `zcash-devtool`'s PCZT (`into_effects()` fails across the version gap).

`konclave-signer` bridges exactly that seam. It is **glue, not crypto**: it calls
the official `orchard`/`pczt`/`zcash_primitives` libraries (pinned to the same
`git rev 08334ebe` as `zcash-devtool`, so the PCZT wire format matches), and the
FROST math stays entirely in `frost-core`. It mirrors `zcash-sign`'s proven logic
at the versions used by `zcash-devtool`.

## What it does

```
# 1. Read a proven PCZT (from `zcash-devtool pczt prove`) and print what FROST must sign:
konclave-signer extract <proven.pczt>
#   -> SIGHASH <hex>
#   -> RANDOMIZER <action_index> <hex>     (per real spend; dummies filtered out)

# 2. After the FROST ceremony, apply the external redpallas signature(s):
konclave-signer inject <proven.pczt> <signed.pczt> --sig <action_index>:<128-hex>
#   -> apply_signature() VERIFIES the signature against the randomized key rk,
#      then writes the signed PCZT (ready for `zcash-devtool pczt send`).
```

## Proven end-to-end (mainnet)

This bridge produced the first Konclave FROST transaction on Zcash mainnet:
txid `f63ee64d7bc086a8286631d03936ec2ca2ca57f4e4c63712fc95c1f02c522360`
(block 3,396,616). Full flow: [docs/VERTICAL_SLICE.md](../docs/VERTICAL_SLICE.md).

## Status

Standalone helper crate for the vertical slice. It will be folded into the
Orquestrador (`src-tauri/`) as the signing module. Build (in the Linux/WSL2 build
environment): `cargo build --release`.

## License

Dual Apache-2.0 / MIT, matching the rest of Konclave.
