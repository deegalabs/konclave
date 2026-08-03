// UNVALIDATED SCAFFOLD (the command wiring), LOGIC-TESTED CORE (share_store.rs).
//
// This file has NOT been compiled or run anywhere in this project: the `tauri` crate needs a
// system webview (webkit2gtk/glib), which is absent on this machine (docs/adr/0004-local-http-bridge.md),
// and no macOS/iOS/Android build host was available. Do not read a green CI signal into the Tauri
// wiring: there is none yet. What IS proven is the keychain logic it delegates to -- `share_store`
// has no `tauri` dependency and its tests run headlessly against `keyring`'s in-memory mock (the
// same technique `orchestrator::secrets::KeychainStore` uses). See docs/TAURI-PLAN.md.
//
// What it does when it DOES build on proper hardware:
//   - opens a native webview whose content is the already-built Vite/React UI
//     (tauri.conf.json -> build.frontendDist -> ../ui/dist), so the entire browser-proven app
//     (the /net DKG + FROST flow, the relay/helper protocol, the konclave-wasm crypto) runs
//     unchanged inside the OS webview;
//   - exposes four `invoke` commands (secure_store / secure_load / secure_delete / secure_list)
//     that let the SAME UI persist its per-device FROST share in the OS keychain instead of
//     browser IndexedDB (ui/src/storage.ts). Only ENCRYPTED share bytes (already sealed by the
//     UI) and public vault ids cross this boundary; plaintext key material never does.
//
// The share still never leaves the device (principle §6.3); the keychain is simply a more durable,
// OS-backed at-rest store than a browser origin's IndexedDB. The JS side of this contract is
// specified in docs/NATIVE-STORAGE-BRIDGE.md (exact invoke shapes).

mod share_store;

use share_store::{b64, unb64, KeychainShareStore, ShareStore, StoreError};

/// Map a storage failure to a UI-ready string. The UI turns these into human messages (§6.11).
fn msg(e: StoreError) -> String {
    e.to_string()
}

/// Persist the (already-encrypted) share bytes for `id` in the OS keychain.
/// `share_b64` is base64 of ciphertext produced by the UI; this command does not encrypt or
/// decrypt, and never sees plaintext key material (boundary validation of the base64, §6.8).
#[tauri::command]
fn secure_store(id: String, share_b64: String) -> Result<(), String> {
    let bytes = unb64(&share_b64)?;
    KeychainShareStore::default().store(&id, &bytes).map_err(msg)
}

/// Return the stored share bytes (base64) for `id`, or an explicit "not found" error.
#[tauri::command]
fn secure_load(id: String) -> Result<String, String> {
    let bytes = KeychainShareStore::default().load(&id).map_err(msg)?;
    Ok(b64(&bytes))
}

/// Remove the stored share for `id` from this device's keychain (idempotent).
#[tauri::command]
fn secure_delete(id: String) -> Result<(), String> {
    KeychainShareStore::default().delete(&id).map_err(msg)
}

/// List the vault ids that have a share stored on this device (public ids only).
#[tauri::command]
fn secure_list() -> Result<Vec<String>, String> {
    KeychainShareStore::default().list().map_err(msg)
}

// Mobile (iOS/Android) enters through this function; desktop uses the same path via main.rs.
#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .invoke_handler(tauri::generate_handler![
            secure_store,
            secure_load,
            secure_delete,
            secure_list,
        ])
        .run(tauri::generate_context!())
        .expect("error while running the Konclave Tauri application");
}
