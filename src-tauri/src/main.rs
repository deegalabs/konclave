// UNVALIDATED SCAFFOLD. Not compiled or run in this environment (WSLg/GTK does not render a
// webview here, see docs/adr/0004-local-http-bridge.md). Groundwork only; see docs/TAURI-PLAN.md.
//
// Desktop entry point. On Windows release builds this attribute suppresses the console window;
// it is a no-op elsewhere. All the real setup lives in lib.rs so iOS/Android can share it.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    konclave_tauri_lib::run();
}
