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
mod webview_cleanup;

use share_store::{b64, unb64, KeychainShareStore, ShareStore, StoreError};
use tauri::{path::BaseDirectory, App, Builder, Manager, Runtime, WebviewWindowBuilder};

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
    KeychainShareStore::default()
        .store(&id, &bytes)
        .map_err(msg)
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
    app_builder(Builder::default())
        .run(tauri::generate_context!())
        .expect("error while running the Konclave Tauri application");
}

fn app_builder<R: Runtime>(builder: Builder<R>) -> Builder<R> {
    builder
        .invoke_handler(tauri::generate_handler![
            secure_store,
            secure_load,
            secure_delete,
            secure_list,
        ])
        .setup(|app| setup(app))
}

/// Remove a stale service worker, THEN open the window. Tauri builds `create: true` windows before
/// this hook runs, so the main window is `create: false` in tauri.conf.json and is built here from
/// that same config entry (title, size, scheme unchanged; the CSP is app-wide and also unchanged).
fn setup<R: Runtime>(app: &mut App<R>) -> Result<(), Box<dyn std::error::Error>> {
    if cfg!(target_os = "windows") {
        retire_stale_service_worker(app);
    }
    let deferred: Vec<_> = app
        .config()
        .app
        .windows
        .iter()
        .filter(|w| !w.create)
        .cloned()
        .collect();
    for window in &deferred {
        WebviewWindowBuilder::from_config(app.handle(), window)?.build()?;
    }
    Ok(())
}

/// Windows only: WebView2's user data folder is the folder Tauri forces for it, resolved here with
/// the same call Tauri makes (tauri/src/manager/webview.rs). Never fails startup; logs locally only.
fn retire_stale_service_worker<R: Runtime>(app: &App<R>) {
    let version = app.package_info().version.to_string();
    match app
        .path()
        .resolve(&app.config().identifier, BaseDirectory::LocalData)
    {
        Ok(dir) => eprintln!(
            "konclave: webview cleanup: {}",
            webview_cleanup::retire_service_worker(&dir, &version)
        ),
        Err(e) => eprintln!("konclave: webview cleanup skipped, no data folder: {e}"),
    }
}

#[cfg(test)]
mod tests {
    use tauri::Manager;

    /// The window built in setup() comes from tauri.conf.json (MockRuntime keeps no title or size, so
    /// those rest on Tauri's own from_config), and the page it loads still carries
    /// every source of the configured CSP (Tauri adds hashes, never removes a source).
    #[test]
    fn setup_builds_the_configured_window_with_the_configured_csp() {
        let mut app = super::app_builder(tauri::test::mock_builder())
            .build(tauri::generate_context!())
            .expect("app builds");
        // One iteration runs Tauri's window creation, then our setup hook. Deprecated only for its
        // busy-loop when called in a loop; called once here.
        #[allow(deprecated)]
        app.run_iteration(|_, _| {});
        let windows = app.webview_windows();
        assert_eq!(windows.len(), 1, "exactly one window, built once");
        assert!(
            windows.contains_key("main"),
            "the configured window, by its label"
        );

        let configured = app
            .config()
            .app
            .security
            .csp
            .clone()
            .expect("a CSP is configured");
        let served = app
            .asset_resolver()
            .get("index.html".into())
            .and_then(|a| a.csp_header)
            .expect("the page is served with a CSP header");
        for directive in configured
            .to_string()
            .split(';')
            .map(str::trim)
            .filter(|d| !d.is_empty())
        {
            let mut parts = directive.split_whitespace();
            let name = parts.next().unwrap();
            let got = served
                .split(';')
                .map(str::trim)
                .find(|d| d.split_whitespace().next() == Some(name))
                .unwrap_or_else(|| panic!("{name} missing from the served CSP: {served}"));
            for source in parts {
                assert!(
                    got.split_whitespace().any(|s| s == source),
                    "{name} lost {source}: {got}"
                );
            }
        }
    }
}
