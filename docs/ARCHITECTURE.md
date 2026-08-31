# Konclave: Architecture

> Architecture document (GSD). Companion to [CLAUDE.md](../CLAUDE.md) and the 3 source docs.
> Reflects the repo as built today; the "what we intend to build" is called out explicitly.

## 1. Three-layer view

```
┌─────────────────────────────────────────────────────────────────────┐
│ Layer 3: UI (Vite + React + TS, static bundle)          ── ui/       │
│   Intro · Create/Join vault · Dashboard · Payment/Payroll ·          │
│   Proposal (approve/refuse) · Sent · Ledger · Members · /net · /docs  │
└───────────────┬───────────────────────────────────┬─────────────────┘
   HTTP /api (loopback bridge, ADR-0004)     direct import (WASM)
┌───────────────▼───────────────────┐   ┌───────────▼─────────────────┐
│ Layer 2a: ORCHESTRATOR (native)    │   │ Layer 2b: WASM CORE          │
│   ── orchestrator/ + konclave-signer/  │   ── konclave-wasm/          │
│   state machine · validation ·     │   │   FROST ceremony · DKG ·     │
│   wallet · ceremony · store ·      │   │   recovery · seal ·          │
│   sealing · `konclave serve`       │   │   pczt_bridge (extract/inject)│
└───────────────┬───────────────────┘   └───────────┬─────────────────┘
   binary invocation / linked lib                relay (public bytes)
┌───────────────▼───────────────────┐   ┌───────────▼─────────────────┐
│ Layer 1: ENGINE (official tools)   │   │ relay-server/ (blind relay)  │
│   ── engine/                       │   │   in-memory room mailbox,    │
│   frostd · frost-client ·          │   │   opaque/encrypted bytes     │
│   zcash-sign · zcash-devtool(PCZT) │   │   (hosted on Railway)        │
│   zcash_client_backend (linked)    │   └──────────────────────────────┘
└────────────────────────────────────┘
                    network: frostd · lightwalletd · Zcash mainnet (NU6.3 Ironwood)
```

The UI (Layer 3) is **one** frontend that already talks to **two** backends depending on the
screen: the native orchestrator over a loopback HTTP bridge, and the WASM core imported directly
into the browser. See §8 for how those become the two delivery shells.

## 2. Repository map

| Path | Role | Layer |
|---|---|---|
| `ui/` | Vite/React frontend; the single UI for every shell. Consumes `src/api.ts` (native) and `src/wasm-pkg/` (WASM). | 3 |
| `orchestrator/` | Native Rust backend: proposal state machine, validation, wallet/sync, ceremony, store, sealing, and the `konclave serve` loopback HTTP bridge (bin `konclave`). | 2a |
| `konclave-signer/` | Native FROST↔PCZT bridge: `extract` (sighash + randomizers), `inject` (apply FROST sigs), `build-payroll`. | 2a |
| `konclave-wasm/` | Browser crypto core compiled to WASM → committed to `ui/src/wasm-pkg/`: FROST ceremony, DKG, recovery (RTS), seal (ECIES), and `pczt_bridge` (extract/inject in the browser). | 2b |
| `relay-server/` | Standalone public **blind relay** (room mailbox of opaque bytes), hosted on Railway. | - |
| `engine/` | Official Zcash Foundation binaries, pinned by SHA in `engine/versions.lock`. Not reimplemented. | 1 |
| `sdk/` | `@konclave/frost` - the WASM core packaged as a reusable browser SDK. | - |
| `mcp-server/` | MCP "AI treasurer": reads + proposes, deliberately **no** sign/send tool (single-agent-proof). | - |
| `helper-server/` | The hosted **view-only helper** (Architecture B, ADR-0006): registers a browser-DKG vault by its group key, keeps a view-only wallet, and builds/proves/broadcasts while the browsers sign. Deployed on Railway. It never receives, derives or stores a share, and since #388 gates its reads behind the per-vault `readKey`. | 2 |
| `src-tauri/` | The desktop shell (Tauri), released as **v0.2.0**. Optional native shell; the web app is the primary delivery (ADR-0005). Per-platform hardware validation is still open (#212). | - |

## 3. What travels vs. what stays (trust model)

| Stays **on the device only** (never leaves) | **Travels over the network** (public) |
|---|---|
| Key share, seed, secrets | DKG round packages, nonce commitments |
| Per-vault access secret **S** (sealed at rest, #388) | Partial signatures |
| Decrypted memos | The final transaction (goes to mainnet) |
| The act of signing | `readKey = HKDF-SHA256(S)` (a one-way derived token, to the helper) |

`frostd` and the `relay-server` are **blind couriers**: they carry public/encrypted envelopes and
open none of them. Compromising either reveals no secrets and grants no ability to spend; at worst
it disrupts coordination (hence the QR/copy-paste fallback on the roadmap).

**The coordinator role, named.** Pure FROST specifies the signing rounds but not message transport,
member identity, or who assembles the transaction - RFC 9591 only requires that the channel be
authenticated. Something must therefore coordinate, and here that is the **blind helper**: it builds
and proves the PCZT, hosts the signing round, injects the aggregate signature and broadcasts. It is
trusted for **availability only** - never for secrets (it never receives a share) and never for
authority (it cannot spend without a quorum). Two consequences worth stating because they are easy to
assume wrongly: the **relay is not the coordinator** (it is a mailbox, and since #63 the signing
request is sealed to the members' device keys, so it carries ciphertext rather than recipient and
amount), and the **MCP server is not the coordinator either** - `mcp-server/` is a read-and-draft
assistant with deliberately no approve/sign/broadcast tool, so an AI never sits on the critical path
of moving money. Member identity, the piece FROST leaves open, is the per-device identity key of
[ADR-0011](adr/0011-authenticated-writes-device-identity.md) (#288).

**Per-vault read access (#388).** A vault id is the public group verifying key, so on its own it is
not a secret - which is why the hosted helper's *view-only* reads (balance, history, ceremonies,
proposals, ledger, members) are gated behind a per-vault secret **S**. S is fresh randomness minted by
the creator at the DKG and sealed to each member over the ceremony's encrypted channel (the #63
device-comms keys), then persisted sealed at rest like the share; it is **not** derived from the DKG
(anything DKG-derived crosses the relay). The helper authorizes a read only if it carries
`readKey = HKDF-SHA256(S)` (the `X-Konclave-Read` header, constant-time compared), and a migrated
vault's signing room is derived from S (`SHA-256("konclave-sign-s " + S)[:16]`) rather than the public
group key, so an id-only outsider can neither read the books nor find the room. The gate is per-vault
and opt-in on registration (a vault with no registered `readKey` stays open, so pre-#388 vaults keep
working; migrating the rest is #406). This is an access-control lock on the **helper**, not a change
to the chain, which is always shielded. **Write** endpoints stay unauthenticated for now (#288; the
signing-room seat-hijack #392 was closed in #401, residual DoS #399/#400).
The vault backup **export** is now one opaque blob too (v2, #214/#405): metadata, share, S and
beneficiaries are all encrypted under a passphrase, so a leaked backup reveals nothing, not even the
vault id (recovery detail in [`RECOVERY.md`](RECOVERY.md)).

## 4. Sources of truth

- **On-chain (mainnet):** final truth about funds. **On-chain always wins.** (Multi-device
  reconciliation - local cache diverging from on-chain - is an open debt, see §9.)
- **Local state (per device):** share, vaults, labels, cache, in-progress proposals.
- **`frostd` / relay:** ephemeral transport of **public** material; not a source of truth.

## 5. Orchestrator module map (`orchestrator/`)

| Module | Responsibility |
|---|---|
| `ceremony` / `dkg` | Real DKG (and trusted-dealer in the slice) via `frost-client` + `frostd` |
| `send` | Ready→Sent flow: chains the tested wrappers (pczt create/prove/send · signer extract/inject · frostd) |
| `wallet` | Sync via UFVK, balance/history, plan construction (PCZT), `zcash_client_backend` linked |
| `proposal` | **State machine** (LOGICA §6), balance reservation, expiry |
| `validation` / `address` | Address/amount/memo/fee (ZIP 317), authoritative recipient decode; explicit failures at every boundary |
| `secrets` | Seal shares at rest (XChaCha20-Poly1305); key in the OS keychain (`KeyStore`) |
| `store` | Local state in SQLite/SQLCipher |
| `server` / `relay` | The loopback HTTP bridge (`/api/*`) and the in-process blind relay |
| `helper` | Everything the hosted view-only helper needs: registration, its proposals, members, the ceremony trail. Private reads are gated behind the per-vault `readKey` (#388: `load_read_key`/`set_read_key`, open until a vault registers one). `helper-server/` is a thin shell over this. |
| `net_send` / `relay_client` | Architecture B: publish the sign request into the vault's relay room and collect the browsers' aggregate signature |
| `money` | Zatoshi arithmetic - money is never summed in floating point |
| `reconcile` | On-chain wins: promote a `sent` proposal whose txid confirmed, invalidate reservations a fresh sync can no longer fund |
| `payroll` / `pczt` / `signer` / `tools` / `inheritance` | Payroll plan validation · PCZT create/prove/send · the `konclave-signer` bridge · subprocess running · the inheritance switch |

> This table lists every module in `orchestrator/src/lib.rs`. It fell five behind once; if you add
> one, add its row.

## 6. Proposal state machine (LOGICA §6)

```
draft ──propose──> awaiting ──quorum──> ready ──broadcast──> sent ──confirms──> confirmed
   │                    │
   │                    ├──refusal makes quorum unreachable──> refused
   │                    ├──expires──> expired
   │                    └──cancel (proposer only)──> cancelled
   discard
```
- Proposer counts as the 1st approval. Quorum = `t`. Approval is idempotent.
- Unreachability: if refusals > (n − t) → automatic `refused`.
- Balance reserved while the proposal is alive (a **product** lock, not a protocol one).
- Payroll = **one** transaction with N outputs → **one** proposal → **one** approval round.

## 7. Transaction flow (the FROST↔PCZT bridge)

```
pczt create ─> prove (Halo2) ─> EXTRACT ─> FROST ceremony ─> INJECT ─> send
                                  │                            │
                          sighash + randomizers          apply sigs, VERIFY
```
1. `wallet` builds the plan → **PCZT**; `prove` adds the Halo2 proofs.
2. **EXTRACT** the shielded sighash + per-spend randomizers (α). The real Orchard spend can sit at
   **any** action index (index 0 is often a dummy pad), so all randomizer lines are parsed.
3. Signing ceremony (`-C redpallas`, Rerandomized FROST) coordinated by `frostd` → one FROST
   signature per real spend. The key is **never reconstituted**.
4. **INJECT** the signatures into the PCZT; injection **verifies** each against the sighash → signed
   tx → broadcast → confirmation.

EXTRACT and INJECT exist in **two** places, each checked against real-mainnet golden vectors:
- **native** - `konclave-signer` (audit C6 tests), used by the desktop/orchestrator path;
- **WASM** - `konclave-wasm::pczt_bridge` (parity tests), used by the browser path.

> **The vectors are not actually shared, and this said they were** (#365). The two directories
> (`konclave-signer/tests/vectors/`, `konclave-wasm/tests/vectors/`) hold byte-identical **copies**:
> distinct inodes, no symlink, each crate `include_bytes!`s its own, and **nothing in the build or
> in CI enforces that they stay equal**. The cross-check sighash is a hardcoded constant in both.
> The duplication is the right design - two independent implementations checked against one vector
> is the correct answer for a byte-exact bridge across two runtimes - but its whole value rests on
> the vector genuinely being one, which today is a convention rather than a guarantee.

## 8. Two shells, one core (delivery)

The signing core is portable; only the **shell** around it changes. Both shells run the same `ui/`
bundle and converge on the same on-chain transaction (guaranteed by the §7 parity).

```
                    ui/ (one frontend)  +  the FROST crypto core
                              │
       ┌──────────────────────┴───────────────────────┐
  SHELL: DESKTOP (Tauri)                     SHELL: WEB (browser)
  src-tauri/ wraps orchestrator/             ui/ served static + relay-server/
  backend = native (orchestrator +           backend = WASM in the page
    konclave-signer + engine)                  (konclave-wasm)
  share custody = OS keychain                 share custody = IndexedDB + WebAuthn
  full flow incl. create/prove/broadcast      signs its own piece; needs the sighash + a
  → the vault OPERATOR's app (secure)           proven PCZT passed in
                                              → any MEMBER, any device, zero-install
                                                (participate / approve / demo)
```

- **Desktop (Tauri)** is the secure primary custody for the person operating the vault - matches the
  §2 closed decision ("local-first desktop, share in the OS secure vault"). It reuses the tested
  `orchestrator/` (7 real mainnet txids); Tauri is an **additive** shell in `src-tauri/`, not a
  rewrite (it hosts the same `ui/` in the system webview and embeds `konclave serve`).
- **Web (browser)** is the reach layer: a member approves/signs from a phone or laptop with no
  install, via the WASM core over the blind relay. Security is by **role**: the browser is for
  participation, not long-term custody; every device verifies **what it is signing** on-device
  (recipient/amount vs. the approved proposal) and the share is protected by WebAuthn.

## 9. Status and what we intend to build

**Built and proven (15 verifiable mainnet txids incl. the Ironwood cycle, the first browser-signed broadcast, a cross-device send across separate physical machines, and a phone-signed send; see `docs/PROOF.md`):**
- Real DKG vaults (key never reconstituted) and trusted-dealer vaults, quorum payment + private
  payroll, all via the native path (orchestrator + konclave-signer + engine).
- The web/WASM core: multi-device DKG + FROST signing over the hosted blind relay (the signed
  message is still a **test digest**), social recovery (RTS), inheritance policy engine.
- The FROST↔PCZT bridge in WASM (`pczt_bridge`), byte-for-byte equal to native (branch
  `feat/wasm-pczt-bridge`).
- **Per-vault read access + S-derived signing room + fully-encrypted v2 export (#388/#214, live).**
  A leaked vault id no longer opens the helper's reads or the ceremony room (see §3); the export is
  one opaque passphrase-encrypted blob. Open: migrating the remaining legacy vaults (#406) and
  authenticating the write endpoints (#288).

**Intend to build (roadmap; details in `temp/PROXIMOS-PASSOS.md`):**
1. **Real browser transaction (slice 2):** on-device "what am I signing" verification + the
   create/prove boundary, then wire `pczt_bridge` into the `/net` ceremony and close with a real
   `pczt send` - a broadcast Orchard tx from the browser.
2. **Desktop shell (Tauri):** shipped as v0.2.0 - a two-click app that embeds
   `orchestrator/` and moves share custody to the OS keychain.
3. **On-device share persistence:** encrypted IndexedDB + WebAuthn (sign-after-restore).
4. **Multi-device reconciliation:** the "on-chain wins" rule + destructive test (the one open item
   of the destructive suite, §4).
5. **Packaging & integrity:** engine binaries as Tauri sidecars per target-triple; CSP + SRI +
   reproducible WASM build for the web shell.
