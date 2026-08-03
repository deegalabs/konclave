# NATIVE-STORAGE-BRIDGE.md: one share-store, two backends

**Status: DESIGN + WIRED RUST COMMANDS (logic-tested), JS SWAP NOT YET APPLIED.** The Rust side
(`src-tauri/src/share_store.rs` + the four `#[tauri::command]`s in `src-tauri/src/lib.rs`) is
written and its keychain logic passes a real headless test run against `keyring`'s in-memory mock.
The JS `share-store.ts` below is specified but deliberately NOT added to `ui/`, because a live
`.ts` that imports `@tauri-apps/api` would break `npm --prefix ui run build` and CI until the Tauri
dependency is installed. This doc is the exact contract so the swap is mechanical when the Tauri
work lands. It does not change the web path, which stays the tested default (ADR-0005).

## 1. The problem it solves

`ui/src/storage.ts` persists a `/net` vault's per-device FROST share in encrypted IndexedDB
(PBKDF2 -> AES-GCM). IndexedDB is origin-scoped and evictable: storage pressure, "clear site
data", private windows, and iOS Safari's ~7-day inactivity eviction can all drop it. A treasurer
losing a share to a cleared cache is a real failure mode. The OS keychain is durable, OS-account
protected, and survives browser resets. The native shell should let the SAME UI persist its share
in the keychain instead, with no screen rewrite.

## 2. The abstraction

A narrow `StorageBackend` interface both backends satisfy. `ui/src/storage.ts` already has the
right shape (`saveVault` / `loadVault` / `listVaults` / `deleteVault`), so the web backend is that
module verbatim; the native backend forwards ciphertext to the keychain via `invoke`.

```ts
// SKETCH for ui/src/share-store.ts -- NOT added to the repo yet (see status note above).
import { invoke } from '@tauri-apps/api/core'
import {
  saveVault, loadVault, listVaults, deleteVault,
  type VaultData, type VaultLoaded, type VaultPublic,
} from './storage'

export interface StorageBackend {
  save(id: string, data: VaultData, passphrase: string): Promise<void>
  load(id: string, passphrase: string): Promise<VaultLoaded>
  list(): Promise<VaultPublic[]>
  remove(id: string): Promise<void>
}

/** Tauri injects this global into the webview; the same bundle detects it at runtime. */
export function isTauri(): boolean {
  return typeof (globalThis as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__ !== 'undefined'
}

/** Web backend: the existing, tested module unchanged (storage.ts + storage.test.ts). */
export const webBackend: StorageBackend = {
  save: saveVault, load: loadVault, list: listVaults, remove: deleteVault,
}

/** Runtime selection. The web path is the default and stays fully tested. */
export const shareStore: StorageBackend = isTauri() ? nativeBackend : webBackend
```

## 3. The native backend and its `invoke` shapes

The UI stays the encryptor in BOTH backends. The native backend derives the key and seals the
share with the SAME WebCrypto PBKDF2 -> AES-GCM as `storage.ts` (WebCrypto is available in every
Tauri webview), then hands only CIPHERTEXT (as base64) to the keychain. The keychain is durable
at-rest storage, not the encryptor. Public metadata (`groupKey`, `address`, `roster`, `createdAt`)
carries no secret and stays in IndexedDB so vaults can be listed for unlock exactly as today.

The Rust commands are in `src-tauri/src/lib.rs`; their argument names below are exactly what
`invoke` must send (Tauri maps a Rust `snake_case` parameter to the same key in the JS args
object).

| JS call | Rust command | Args | Returns |
|---|---|---|---|
| `invoke('secure_store', { id, shareB64 })` | `secure_store(id: String, share_b64: String)` | `id`, `share_b64` (base64 ciphertext) | `void` (rejects on invalid base64 / backend error) |
| `invoke('secure_load', { id })` | `secure_load(id: String) -> String` | `id` | base64 ciphertext, or rejects `"no share stored on this device for id ..."` |
| `invoke('secure_delete', { id })` | `secure_delete(id: String)` | `id` | `void` (idempotent: deleting an absent id succeeds) |
| `invoke('secure_list')` | `secure_list() -> Vec<String>` | none | array of vault ids that have a share on this device |

> Tauri's JS `invoke` camelCases nothing automatically for custom keys: a Rust parameter named
> `share_b64` is sent as `share_b64`. To use `shareB64` in JS, either rename the Rust parameter or
> pass the key as `share_b64`. The table above assumes the Rust names; the sketch below shows the
> exact keys.

```ts
const nativeBackend: StorageBackend = {
  async save(id, data, passphrase) {
    // Same sealing path as storage.ts: derive key from passphrase, AES-GCM encrypt sealedShare.
    const cipher = await sealShare(data.sealedShare, passphrase) // Uint8Array of ciphertext
    await invoke('secure_store', { id, share_b64: toBase64(cipher) })
    await putPublicMeta(id, data) // public metadata stays in IndexedDB
  },
  async load(id, passphrase) {
    const shareB64 = await invoke<string>('secure_load', { id })
    const sealedShare = await openShare(fromBase64(shareB64), passphrase) // AES-GCM decrypt
    return { ...(await getPublicMeta(id)), sealedShare }
  },
  list: listVaults, // public metadata still lives in IndexedDB
  async remove(id) {
    await invoke('secure_delete', { id })
    await deleteVault(id) // drop the public metadata too
  },
}
```

`sealShare` / `openShare` / `toBase64` / `fromBase64` are the existing helpers factored out of
`storage.ts` (the AES-GCM + PBKDF2 body is already there; only the persistence target changes).

## 4. The one-line consumer change

`ui/src/screens/NetVault.tsx` imports the four storage functions directly today. The swap is to
import `shareStore` and call `shareStore.save/load/list/remove`. Mechanical, non-breaking, and
deferred until the Tauri deps exist so `npm run build` and CI stay green.

## 5. Why base64 (not raw bytes) at the boundary

`invoke` marshals JSON; strings cross cleanly, byte arrays would arrive as `number[]` and cost a
conversion on both ends. The Rust command decodes the base64 to raw bytes and stores those in the
keychain (via `keyring`'s `set_secret`), so the keychain holds real bytes, not doubly-encoded
text. `share_store.rs` carries the tiny dependency-free base64 codec and a round-trip test.

## 6. `secure_list` and the id index (honest note)

`keyring` has no portable "list all credentials for a service" API. `secure_list` is therefore
served from an INDEX entry the Rust store maintains under a reserved keychain account, holding the
newline-joined set of vault ids. Vault ids are PUBLIC identifiers (never secret material), so
keeping that index in the clear does not weaken the threat model. `store` adds an id to the index,
`delete` removes it, and the reserved index account can never be used as a vault id (guarded).

## 7. Graceful degradation

On a host with no keychain backend (headless Linux with no Secret Service daemon), the native
command errors clearly rather than losing data silently. The shell must fall back to `webBackend`
(IndexedDB) in that case: `isTauri()` gates the choice, and a failed `secure_*` call is a
recoverable, human-readable error (§6.11), never a silent share loss (§6.8).
