// Detect the Tauri desktop shell. Tauri v2 always injects `__TAURI_INTERNALS__` into the webview
// (and `__TAURI__` when `withGlobalTauri` is on); on the plain web both are absent. Used to open
// the desktop app straight on the product (the vaults), not the marketing landing.
export const isDesktop =
  typeof window !== 'undefined' &&
  ('__TAURI_INTERNALS__' in window || '__TAURI__' in window)
