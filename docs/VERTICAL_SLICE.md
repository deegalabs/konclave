# Vertical Slice — first FROST transaction on Zcash mainnet

**Status:** ✅ Gate 1 achieved (2026-07-01).

This documents the known-good, end-to-end flow the vertical slice proved: a
2-of-3 FROST-controlled Orchard vault sending a real transaction on **Zcash
mainnet**, entirely headless via the official tools + the `konclave-signer` bridge.

## On-chain proof

| | |
|---|---|
| **TXID** | `f63ee64d7bc086a8286631d03936ec2ca2ca57f4e4c63712fc95c1f02c522360` |
| **Block** | 3,396,616 (2026-07-01 02:24:58 UTC) |
| **Explorer** | https://mainnet.zcashexplorer.app/transactions/f63ee64d7bc086a8286631d03936ec2ca2ca57f4e4c63712fc95c1f02c522360 |
| **Vault address (Orchard-only)** | `u1vjgxlvz4ewnt43rkq6fzexpl639745spx369tc4j9n9l0qnt9rufxdt2pxe3jtku7lqv4gtzfqafxtf7gal5y9gmz84nkza6z5d406dr` |
| **Quorum** | 2-of-3 (trusted-dealer, RedPallas / Rerandomized FROST) |

Being Orchard/shielded, the explorer shows the transaction exists but reveals no
amounts or addresses — privacy by default, exactly the product thesis.

## Components (all built in WSL2/Ubuntu, rustc 1.96.1)

- **`frostd`, `frost-client`, `zcash-sign`** — ZcashFoundation/frost-tools @ `3d2985c`
- **`zcash-devtool`** — zcash/zcash-devtool @ `91ba536` (wallet/sync/PCZT/broadcast)
- **`konclave-signer`** — our bridge (this repo), pinned to devtool's stack

## The flow

```text
# --- one-time setup ---
frost-client init          -> alice.toml, bob.toml, carol.toml   (comm keypairs)
frost-client trusted-dealer -C redpallas -t 2 -n 3               (2-of-3 shares; DKG in Phase 2)
frost-client groups        -> group public key (the Orchard ak)
zcash-sign generate --ak <group-pk> --network main               -> Orchard address + UFVK
zcash-devtool wallet init-fvk --fvk <UFVK>                       -> view-only wallet
# fund the Orchard address with real ZEC, then:
zcash-devtool wallet sync                                        -> balance

# --- per payment (must complete within the ~40-block expiry window) ---
zcash-devtool pczt create --address <to> --value <zat>  > tx1.pczt
zcash-devtool pczt prove                < tx1.pczt      > tx2.pczt
konclave-signer extract tx2.pczt        -> SIGHASH + RANDOMIZER <idx>

# FROST ceremony (frostd over TLS; participants confirm with `y`):
frost-client coordinator -c alice.toml --server-url 127.0.0.1:2744 \
    --group <group-pk> -S <alice-pk>,<bob-pk> -m - -r - -o sig.raw   # feed SIGHASH, RANDOMIZER
frost-client participant -c alice.toml --server-url 127.0.0.1:2744 --group <group-pk>
frost-client participant -c bob.toml   --server-url 127.0.0.1:2744 --group <group-pk>
#   -> sig.raw (64-byte redpallas threshold signature)

konclave-signer inject tx2.pczt tx3-signed.pczt --sig <idx>:<sig-hex>   # apply_signature VERIFIES
zcash-devtool pczt send < tx3-signed.pczt                              -> broadcast -> txid
```

## Hard-won lessons (encoded for the Orquestrador, Phase 3)

1. **Version gap:** frost-tools (pczt 0.5) and zcash-devtool (pczt 0.7) don't
   interoperate; we own the bridge (`konclave-signer`). See [ADR-0002](adr/0002-pczt-frost-bridge.md).
2. **Expiry window:** a PCZT expires ~40 blocks (~50 min) after creation. The whole
   create→ceremony→broadcast must run inside it. Do NOT create the PCZT long before
   signing. (Our first attempt failed with "greater than its expiry Height".)
3. **frostd needs TLS:** frost-client hardcodes `https://` and uses
   `rustls-tls-native-roots` (system trust store). For local runs: a local CA +
   leaf cert for `127.0.0.1` installed via `update-ca-certificates`. A self-signed
   cert used directly fails with `CaUsedAsEndEntity`.
4. **Participants are interactive:** they prompt `sign it? (y/n)` — feed `y`.
5. **Stale sessions:** cancelled ceremonies leave sessions on frostd; restart it
   (in-memory) or pass an explicit session id.
6. **Confirmations:** an externally-received note needs ~10 confirmations before it
   is spendable.
7. **Share storage (security debt):** `frost-client` stores shares in cleartext in
   `~/.local/frost/credentials.toml`. The product must encrypt at rest / use the OS
   keychain (Phase 3).
8. **Dummy spends:** Orchard pads with zero-value dummy actions; only real spends
   need a FROST signature (the bridge filters by value). Dummies are handled by the
   wallet's IO finalizer.

## Phase 2 — Real DKG (distributed key generation)

The slice used `trusted-dealer` (a scaffold that briefly holds the whole key). The
product uses **DKG**, where the key is **never reconstituted anywhere**. Proven
2026-07-01:

```text
# each participant, fresh:
frost-client init -c a2.toml            # (and b2.toml, c2.toml)
frost-client export -c a2.toml --name alice   -> contact string (encodes comm pubkey)
# everyone imports everyone else's contact:
frost-client import -c a2.toml <bob-contact>  # etc. (DKG encrypts round packages between peers)

# DKG ceremony over frostd/TLS (all concurrent):
frost-client dkg -c a2.toml -C redpallas -t 2 -d "..." -s 127.0.0.1:2744 -S <bob-pk>,<carol-pk>  # creator
frost-client dkg -c b2.toml -C redpallas -t 2 -d "..." -s 127.0.0.1:2744                          # joiner
frost-client dkg -c c2.toml -C redpallas -t 2 -d "..." -s 127.0.0.1:2744                          # joiner
#   -> each config gets its own share; group key derived; full key never exists
```

**Result:** DKG group key `0ab93649e62dd68858ed57af1e7f7743cc2a4912110d7fb547d35c8c8494ee34`
→ Orchard address `u1t2qphc0vktmflteelztv5l3v4ylw8kls3ja0ujj49ycvrvg579kv3pv6nllqga6k0s47whk7lrx86yd88pepkyvhfl8qqhlygg836yl2`.
A 2-of-3 signing ceremony over the DKG shares produced a valid signature, proving the
shares are functional. The spend pipeline is identical to Gate 1 (only the key source
changes), so a DKG vault spends the same way.

DKG notes: participants must hold each other as contacts; the creator passes the other
participants via `-S`; `yes |` auto-confirms the interactive prompts; restart frostd
between ceremonies to clear in-memory sessions.

## Phase 5d — the same flow, now driven by the application (not the CLI)

The Gate-1 flow above was run by hand across terminals. Phase 5d automates the entire
recipe inside the Orquestrador (`src/send.rs`) and exposes it over the local HTTP bridge
(`POST /api/proposals/{id}/send`), so a payment is proposed, approved to quorum, signed by
the FROST ceremony, and broadcast **entirely through the app**. `frostd` is started fresh
per call; coordinator + participants run as concurrent threads (one box; separate devices
in the product); a `dry_run` flag signs without broadcasting (validates the ceremony with
no funds moved).

**Second on-chain proof — first UI/orchestrator-driven mainnet tx:**

| | |
|---|---|
| **TXID** | `43433a109d3f2a078c0a9269ccb156392ade7a1f7ac1532981611eda1e59a572` |
| **From** | the slice vault (2-of-3 trusted-dealer, RedPallas) — self-send |
| **Path** | UI → `/api/proposals/{id}/send` → create → prove → extract → coordinator+participants → inject → broadcast |
| **Key** | never reconstituted (threshold signature over the shares) |
