---
name: zcash-tooling
description: Use when invoking, parsing or integrating the official Zcash tooling Konclave orchestrates - zcash-devtool (PCZT + wallet), zcash-sign, frostd/frost-client, zcash_client_backend - or when deciding which node/indexer to build against. Read before shelling out to any engine binary or writing a parser for its output.
---

# The engine: the official tools, as actually invoked

Konclave **orchestrates** these; it never reimplements their crypto. They are pinned by git rev in
`engine/versions.lock`, and that pin is load-bearing: `zcash-devtool`'s own README says *"The
command-line API that this tool exposes can and will change at any time and without warning"* and
*"DO NOT USE THIS IN PRODUCTION!!!"*. After any engine bump, re-verify the flags below against the
source at the new rev - do not assume they survived.

## The one rule: structured output, never screen-scraping

| Where JSON exists | Shape |
|---|---|
| `zcash-devtool wallet balance --json` | `{total, sapling_spendable, orchard_spendable, ironwood_spendable, transparent_spendable, chain_tip_height}` - raw zatoshis; ignores `--convert` |
| `zcash-devtool wallet list-tx --json` | `[{txid, mined_height}]`, `mined_height` null when unmined; takes precedence over `--mode` |
| `zcash-devtool wallet get-info` | always JSON: `{server_uri, chain_name, chain_tip_height}` |
| `frostd` (whole API) | JSON over HTTP(S) |

Everything else is prose for humans. `wallet balance` without `--json` prints a Rust `{:#?}` debug
dump of the wallet summary - never parse it. `list-tx --mode csv` is the only other machine shape.
`frost-client`'s machine-readable surface is its **TOML config file**, not its stdout.

## `zcash-devtool` - what builds and broadcasts

Top level: `wallet`, `pczt`, `inspect`, `migration`, `zip48`, `create-multisig-address` (plus
`keystone` under the `pczt-qr` feature). `wallet` and `pczt` take `-w/--wallet-dir`. Anything that
touches the network takes `-s/--server` (`ywallet`, `zecrocks`, or a comma-separated `host:port`
list; default `zecrocks`) and `--connection direct|tor|socks5://host:port` (default `direct`;
`--disable-tor` is deprecated).

**The PCZT pipeline**, in the order the official walkthrough uses it (`doc/walkthrough.md`):

| Step | Command | Notes |
|---|---|---|
| create | `pczt -w <view> create [ACCOUNT_ID] --address <a> --value <zatoshis> [--memo] [--output]` | view-only wallet is enough; stdout if no `--output`. `--target-note-count` (4) and `--min-split-output-value` (10000000) govern change splitting |
| inspect | `pczt inspect < file` | read-only |
| prove | `pczt -w <view> prove [IN] [--output]` | `-i/--identity` or `--sapling-proof-generation-key` needed **only** if the PCZT has Sapling spends |
| sign | `pczt -w <signing> sign --identity <age-file>` | for a seed wallet. Konclave signs with FROST instead |
| combine | `pczt combine -i signed -i proven [-o]` | needs no wallet |
| send | `pczt -w <view> send [-s <server>] [IN]` | extracts, stores in the wallet DB, broadcasts |

**Prove and sign both consume the *created* PCZT**, in parallel, and are reconciled by `combine`.
Signing the proven PCZT is the classic mistake.

Gotchas:
- `pczt extract` reads **stdin only** and prints just the txid. It does not emit a raw transaction;
  `send` is what broadcasts.
- `pczt update-with-signature <POOL> <INDEX> <SIG_HEX>` computes a **v5** sighash only - unusable for
  v6/Ironwood. `zcash-sign` is the tool that handles both.
- `wallet sync` is stateful and slow: it writes a block cache (`FsBlockDb`) beside the wallet. It is
  not a query.
- `balance --convert <CURRENCY>` spins up a Tor client for an exchange rate; `--json` deliberately
  skips that.
- `wallet init-fvk --name --fvk --birthday --seed-fingerprint --hd-account-index` is how a
  **view-only** wallet is created - the shape a view-only helper needs.
- `migration {plan,commit,status,advance}` moves funds Orchard → Ironwood. `advance`'s own doc
  comment says it stops before broadcast/rebuild because "those steps aren't implemented yet".

## `zcash-sign` - group key → address, FROST signature → PCZT

```
zcash-sign generate --ak <hex> [--network main|test] [--danger-dummy-sapling]
zcash-sign sign -i/--tx-plan <in> -o/--tx <out> [--ufvk <ufvk>] [--network main|test]
```

`generate` takes `ak` = the FROST group `VerifyingKey` (an Orchard `SpendValidatingKey`) and prints
two lines: `Orchard-only unified address: "<ua>"` and `Unified Full Viewing Key: "<ufvk>"`. Both are
printed with Rust's `{:?}`, so the values arrive **wrapped in double quotes** - strip them.

- The other half of the key is **random on every call**: the address and UFVK are *not* reproducible
  from the group key. A backup of the share does not restore the vault identity.
- `--danger-dummy-sapling` exists only because Ywallet cannot handle Orchard-only keys; its own help
  warns that sending to that Sapling address makes the funds unspendable.

`sign` auto-detects its input: PCZT first, else a Ywallet JSON plan. On the current source **Ywallet
signing is disabled** (it returns an error) - PCZT only, and `--ufvk` is unused on that path. Despite
the flag name, `-o/--tx` receives a **serialized signed PCZT**, not a raw transaction.

`sign` is **interactive**, and that is the integration contract - drive stdin, do not scrape:

1. prints `SIGHASH: <64 hex>` - this is the message FROST must sign;
2. for each real spend awaiting a signature, prints `Randomizer #<idx> (<pool>): <hex>` then
   `Input hex-encoded signature #<idx> (<pool>): ` and reads one 64-byte hex signature per line.

The randomizer is that spend's `alpha`. Dummy spends were already signed by the IO finalizer during
`pczt create`, so only spends with `spend_auth_sig == None` are prompted. Injection calls
`apply_signature`, which **verifies against the spend's `rk` before accepting** - a bad signature
fails here, not at broadcast. Sighash dispatch: v6 → v6 hash, v5-with-Orchard-bundle → v5 hash. A v6
transaction has two Orchard-shaped bundles (Orchard and Ironwood) and asking the wrong signer entry
point yields **no spends rather than an error**, so track which pool each spend lives in.

## `frostd` - the coordination server

Axum, JSON over HTTP(S). All endpoints are `POST`: `/challenge`, `/login`, `/logout`,
`/create_new_session`, `/list_sessions`, `/get_session_info`, `/send`, `/receive`, `/close_session`.
Flags: `-i/--ip` (default `0.0.0.0`), `-p/--port` (default `2744`), `-c/--tls-cert`, `-k/--tls-key`,
`--no-tls-very-insecure` (its help: do not set this unless you terminate TLS yourself).

Auth: `POST /challenge` → a UUID; sign that challenge's bytes with **XEdDSA** using the communication
private key; `POST /login {challenge, pubkey, signature}` → `access_token` UUID; then
`Authorization: Bearer <token>`. Hard limits in the source: challenge valid 10 s, access token 1 h,
session 24 h, `MAX_MSG_SIZE = 65535`.

**Its blindness is a client obligation, not a server guarantee.** The official docs are explicit:
*"Messages MUST be end-to-end encrypted between recipients. The server can't enforce this and if you
fail to encrypt them then the server could read all the messages."* It routes by pubkey and nothing
else. Both `frostd` and `frost-client` have been audited by Least Authority (per their READMEs).

## `frost-client` - identity, DKG, ceremony

Config defaults to `$HOME/.local/frost/credentials.toml`; every subcommand takes `-c/--config`.
Subcommands: `init`, `export --name`, `import <contact>`, `contacts`, `remove-contact --pubkey`,
`trusted-dealer`, `dkg`, `groups`, `remove-group`, `sessions [--close-all]`, `coordinator`,
`participant`.

```
frost-client init -c alice.toml
frost-client dkg -c alice.toml -d "<desc>" -s <server_url> -t <threshold> -C redpallas [-S <pk>,<pk>]
frost-client coordinator -c alice.toml --server-url <url> --group <group-pubkey> -S <pk>,<pk> -m - -r - [-o -]
frost-client participant -c bob.toml --server-url <url> --group <group-pubkey> [-S <session>]
```

- `-S` on `dkg` is passed **only** by the participant who creates the session.
- `-m`/`-r`/`-o` accept a file path, or `-`/`""` for stdin/stdout as hex.
- `trusted-dealer` is test-only by its own help: participants cannot verify the shares it writes.
- The README warns it stores secrets **unencrypted** in the config, and recommends *"building their
  own tools using frost-client as a base"* - which is what Konclave does.
- `--cli` (JSON to stdout, copy-paste transport) belongs to the **legacy** `coordinator`, `participant`,
  `dkg`, `trusted-dealer` binaries in the same package - not to `frost-client`'s subcommands.
- Stale help worth not chasing: `participant --server-url` refers to a `login` subcommand that does
  not exist; login is automatic in the challenge/signature flow.

### The communication key - keep it straight from the share

`frost-client init` generates **only** a communication keypair: an X25519 static keypair from `snow`,
stored as `communication_key = { privkey, pubkey }`. That one key does two jobs:

- **Transport.** A `Noise_K_25519_ChaChaPoly_BLAKE2s` session per peer, per direction (initiator for
  send, responder for receive). `frostd` sees ciphertext. Decryption authenticates the `sender` field,
  so a tampered sender simply fails to decrypt.
- **Identity.** The same private key is converted to XEd25519 to sign the `frostd` login challenge.

It is **not** the FROST signing share. In the config, `group.<verifying-key>.key_package` is the
share; `group.<vk>.participant.<name>` holds `{identifier, pubkey}` - the FROST identifier and the
communication pubkey side by side. **On the wire a participant is addressed by its communication
pubkey**; the FROST identifier is a local mapping. Noise_K means both sides must already know each
other's static key, which is exactly what `export`/`import` contacts is for - the roster is exchanged
out of band before any ceremony.

### `-C redpallas`

Selects `reddsa::frost::redpallas::PallasBlake2b512` (ciphersuite ID `FROST(Pallas, BLAKE2b-512)`);
the default is `ed25519`, which is useless for Zcash. It is a `RandomizedCiphersuite`: the signature
is made under a re-randomized key, and **the randomizer must be the PCZT spend's `alpha`** - the one
`zcash-sign` printed. If none is passed, the coordinator generates a random one, and the resulting
signature will not verify against the spend's `rk`. The ciphersuite is recorded per group in the
config and the coordinator dispatches on it.

## `zcash_client_backend` (librustzcash) - linked, not shelled out

Traits: `WalletRead`, `WalletWrite`, `InputSource`, `WalletCommitmentTrees`, `Account`.
`zcash_client_sqlite` (`WalletDb`, `FsBlockDb`) is the storage implementation `zcash-devtool` uses.

- **Construction:** `propose_transfer` / `propose_standard_transfer_to_address` / `propose_shielding`
  produce a proposal; then `create_pczt_from_proposal` (PCZT path) or `create_proposed_transactions`
  (in-wallet path). `extract_and_store_transaction_from_pczt` finishes a PCZT into a stored
  transaction. `redact_pczt_for_signer` strips what a signer must not see.
- **Sync:** `data_api::chain::scan_cached_blocks` over a block cache, speaking lightwalletd's gRPC
  `CompactTxStreamer` (`zcash_client_backend::proto::service`).
- **Fees:** `zcash_client_backend::fees` (`StandardFeeRule`, `SplitPolicy`, `DustOutputPolicy`,
  `MultiOutputChangeStrategy`). Use them; do not recompute ZIP 317 by hand.
- Detail worth copying from `pczt send`: it passes `None` for the Orchard verifying key so the
  extractor builds one for the PCZT's own consensus branch, because the pre- and post-NU6.3 circuits
  differ.

## Node and indexer reality

- **`zcashd` is end-of-life.** Every 6.20.0 node halted at block **3,417,100** (2026-07-18) and
  refuses to restart; it does not support NU6.3, and *"All `zcashd` users that don't need the `zcashd`
  wallet should migrate to Zebra immediately"* (zcash.github.io end-of-life page). Never write code
  against a `zcashd` RPC assumption.
- **Zebra** is the Rust consensus full node. It has **no wallet**; its own compatibility page points
  shielded wallet flows at the Z3 stack (Zallet / Zaino / librustzcash).
- **Zaino** is the Rust indexer that serves *"all functionality currently in the LightWallet gRPC
  service (`CompactTxStreamer`), currently served by Lightwalletd"*, reading from a Zebra validator.
  Same gRPC contract, so `zcash_client_backend` sync works against lightwalletd or Zaino unchanged.
- `zcash-devtool`'s `ywallet` / `zecrocks` shortcuts are third-party hosted lightwallet endpoints:
  they see your IP and your queries. `--connection tor` exists for that reason.

---

**Verified on 2026-08-31** by reading the sources directly: `ZcashFoundation/frost-tools` @
`06c0dbd` (`frost-client/src/{cli/args.rs,cipher.rs,api.rs,cli/config.rs}`, `frostd/src/*`,
`zcash-sign/src/{args,main,sign,generate}.rs`), `zcash/zcash-devtool` @ `5a26ee8`
(`src/commands/**`, `src/remote.rs`, `README.md`, `doc/walkthrough.md`), `zcash/librustzcash`
(`zcash_client_backend/src/data_api{,/wallet}.rs`, `pczt/`), `ZcashFoundation/reddsa`
(`src/frost/redpallas.rs`), `ZcashFoundation/zebra` (`book/src/user/zcashd-compat.md`),
`zingolabs/zaino` (README), `frost.zfnd.org/zcash/{ywallet-demo,server}.html`, and
`zcash.github.io/zcash/user/end-of-life.html`. Both CLI repos churn - re-read the args files at the
pinned rev before trusting a flag here.
