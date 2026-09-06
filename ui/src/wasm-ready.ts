// Making sure the WASM is loaded before anything calls into it (#483).
//
// `init(wasmUrl)` was awaited in exactly one place, `useBackgroundSigner`, so every WASM call in the
// product worked only because the signer happened to have run first. #481 gave the EXPORT a reason
// to touch WASM - it opens the sealed viewing key - and the export runs on a screen the signer never
// touches. The failure is not a readable one either: `Cannot read properties of undefined (reading
// '__wbindgen_malloc')`, which says nothing about initialisation to whoever hits it.
//
// So this is idempotent and shared: any caller can await it without knowing whether someone else
// already did, and the answer to "did somebody initialise the WASM?" stops depending on which screen
// the member visited first.

import init from './wasm-pkg/konclave_wasm.js'
import wasmUrl from './wasm-pkg/konclave_wasm_bg.wasm?url'

let started: Promise<unknown> | null = null

/**
 * Load the WASM module once, and resolve as soon as it is ready.
 *
 * The promise is memoised rather than a boolean flag, so two callers racing at startup both await
 * the SAME load instead of starting a second one - and the second caller waits for the first to
 * finish rather than proceeding against a half-initialised module.
 *
 * A failed load is not cached: the next caller retries. A member whose first attempt failed on a
 * flaky network should not be locked out of the feature for the life of the tab.
 */
export function ensureWasm(): Promise<unknown> {
  if (!started) {
    started = init(wasmUrl).catch((e) => {
      started = null
      throw e
    })
  }
  return started
}
