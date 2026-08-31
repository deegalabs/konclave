---
name: konclave-architecture
description: Use when working anywhere in the Konclave repo - to know which crate owns a rule, which files a change touches, what must not be duplicated, which invariants are load-bearing, and how to verify. Read before editing the orchestrator, helper-server, relay-server, konclave-wasm, or ui.
---

# Konclave: how this repo is put together

Konclave is a **collective Zcash treasury**: a `t`-of-`n` FROST vault where the group key is never
reconstituted and each share never leaves its owner's device. The delivery that ships is the
**browser** path; a Tauri desktop shell also exists.

The one thing to internalise: **two backends serve the same product, and they share one core.**
Get that wrong and you will duplicate a rule.

## The map

| Path | What it is |
|---|---|
| `orchestrator/` | The Rust **core**. Domain rules live here. Also contains `server.rs`, the local loopback bridge. |
| `helper-server/` | The **hosted blind helper** (Architecture B). A thin HTTP shell; it `use`s `orchestrator::helper` for the actual logic. |
| `relay-server/` | The **blind relay**: an in-memory room mailbox of opaque bytes. Zero disk. |
| `konclave-wasm/` | The browser crypto core (FROST ceremony, DKG, PCZT bridge, room auth), compiled into `ui/src/wasm-pkg/`. |
| `konclave-signer/` | CLI: `extract` (PCZT → material to sign), `inject` (apply FROST sigs), `build-payroll`. |
| `konclave-seal/` | The confidential-channel primitive (ECIES over X25519) + device-key derivation. |
| `ui/` | Vite/React frontend. |
| `mcp-server/` | An AI assistant surface: reads and drafts, **no** approve/sign/broadcast tool. |
| `sdk/` | `@konclave/frost`, the WASM core as a reusable browser library. |
| `engine/` | Official Zcash Foundation binaries, pinned by SHA. Never reimplement this crypto. |

## Where a rule lives, and where it does not

`helper-server` depends on the `orchestrator` crate (`helper-server/Cargo.toml`) and already imports
its governance functions; the bridge (`server.rs`) lives *inside* that same crate. So the shared home
already exists and is already used this way.

- **A rule goes in `orchestrator`** - the answer to *"is this valid?"*. Existing examples:
  `proposal.rs` (state machine), `validation.rs` + `address.rs` (destination/amount/memo),
  `money.rs` (`Zatoshis`, never floating point), `reconcile.rs` (on-chain-wins), and
  `helper.rs::read_authorized` (the #388 read gate, called by the helper).
- **Transport and presentation stay per-backend** - HTTP parsing, status codes, error shape, the
  bridge's session/CSRF gate, logging.

Why it matters, practically: written twice, a rule gets **fixed in one place and forgotten in the
other**, and the same user action then behaves differently on web and on desktop. This is not a
repo-wide architectural scheme to apply everywhere - apply it when the duplication is real.

## Backend surface

**Hosted helper** (`helper-server`). 🔒 = read gated behind `readKey` (#388, `X-Konclave-Read`
header). ⚠ = write, not yet authenticated (#288).

- `GET /api/health` · `GET /api/vault` · `POST /api/vault` (register)
- `POST /api/vault/devicekey` (#63 X25519 pubkey) · `POST /api/vault/readkey` (#388)
- 🔒 `GET /api/vault/{balance,transactions,ceremonies,proposals,ledger,ledger.csv,members}`
- `POST /api/vault/members` (**write-once** roster) · ⚠ `POST /api/vault/members/rename`
- `POST /api/vault/{proposals,payroll}` · ⚠ `POST /api/vault/proposals/{id}/{approve,refuse}`
- `POST /api/vault/proposals/{id}/send` (opens the FROST ceremony and broadcasts)

**Bridge** (`orchestrator/src/server.rs`) mirrors this locally for the desktop path
(`/api/proposals`, `/api/payroll`, `/api/vault/{dkg,unlock,delete,reconcile}`, `/api/beneficiaries`,
`/api/proposals/{id}/{approve,refuse,send}`), behind `handle_secured` (session + CSRF).

**Relay**: `GET|HEAD|POST /api/relay/{room}` (MAX 512 messages, 128 KiB, TTL 3600s) + `/health`.

## Invariants that are load-bearing

Breaking one of these is a security regression, not a style change.

1. **The share never leaves the device.** It is sealed at rest and used only on-device.
2. **The helper never receives, derives or stores a share** (ADR-0006). It is trusted for
   *availability*, never for secrets or authority. It **is** view-only over the chain (it holds the
   UFVK), so it is *not* content-blind - do not claim it is.
3. **The relay is a blind mailbox.** Since #63 the SignRequest is sealed to the devices' keys.
   Residual: governance messages (`armed`/`unarmed`) are still cleartext (#340).
4. **On-device sighash binding (H1).** Every signer recomputes the ZIP-244 sighash from **its own**
   PCZT and refuses on mismatch, in **both** rounds (`signing-machine.ts`). Never sign a wire value.
5. **The money gate.** Every fund-moving action has a preview and an explicit confirmation. One
   click never sends.
6. **Writes are not yet authenticated** (#288). The decision for fixing it is
   [ADR-0011](../../../docs/adr/0011-authenticated-writes-device-identity.md): a per-device identity
   key (Ed25519, HKDF from the share), **separate from the FROST share**, matching the ZF
   `frost-client` pattern of a dedicated communication key.

## Before you change anything: do not duplicate these

The repo already has these primitives. Reuse them; do not invent a parallel one.

| Need | Already exists |
|---|---|
| Derive a key from a share | `konclave-seal::device_key_from_share` - HKDF-SHA256 over the share with a distinct info label. Add a new label, not a new module. |
| Same, client side | `ui/src/vault-secret.ts::deriveReadKey` - HKDF-SHA256 via WebCrypto. |
| Domain-separated signing | `konclave-wasm` uses `DOMAIN = b"konclave-room-v1\0"` prepended before signing (#401). Mirror the shape. |
| A fail-open per-vault gate | `orchestrator/src/helper.rs::read_authorized` - open until the vault registers a key, then required. This is the migration pattern (#388, #63): never break existing vaults. |
| Device key registry | `load_device_keys` / `add_device_key`. **Extend it**; do not add a second registry file beside it. |
| Sending an authenticated request | `ui/src/helper.ts::readAuthHeaders` injects into the shared request path. Do it in **one** place, not per call site. |

Also: the roster write (`claim_members`) is **write-once** - a different roster on an already-rostered
vault is refused. Do not "fix" it into an overwrite.

## Testing

**TDD, red first.** Write the failing test, *see it fail*, then write the code. Destructive tests are
the house style: encode the attack, not the happy path.

- Rust: tests live in `#[cfg(test)] mod tests` at the bottom of the same file. The helper's router
  tests call `handle(...)`, which is a `#[cfg(test)]` shim over `handle_with_token`.
- UI: `ui/src/*.test.ts` (vitest).

**Verify with the real commands, never by assertion:**

```
cargo fmt --manifest-path <crate>/Cargo.toml -- --check
cargo clippy --manifest-path <crate>/Cargo.toml --all-targets -- -D warnings   # -D warnings: dead code fails
cargo test  --manifest-path <crate>/Cargo.toml
cd ui && pnpm exec tsc --noEmit && pnpm exec vitest run                        # pnpm, not npm
```

`pnpm build` (tsc -b, `noUncheckedIndexedAccess`) catches things `tsc --noEmit` does not. CI runs
fmt → clippy → build → test in one job, so a fmt failure hides everything after it.

## Honesty discipline

`docs/PROOF.md` + `scripts/verify-proof.mjs` are authoritative for mainnet txids; `docs/CLAIMS.md`
is authoritative for what may be claimed. Never restate a count or an attribution that differs from
them. Label capabilities as `proven on-chain` / `dry-run` / `by test` / `roadmap`, and say what is
*not* covered. Understating is acceptable; overstating is not.

---

**Verified against the code on 2026-08-31.** Re-check by reading `helper-server/src/main.rs`
(routes), `orchestrator/src/helper.rs` (rules), `orchestrator/src/lib.rs` (module list) and
`docs/adr/` before relying on any statement here.
