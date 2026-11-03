// Why a read failed. Every read in the app returns the data or `null`, and forty call sites depend
// on that shape; what they could not do was tell "empty" from "could not read", nor "no network"
// from "access denied". Rather than change the shape, the reason is recorded here, per path, by the
// two read routines (api.ts for the bridge, helper.ts for the coordinator), and a screen asks for it
// right after its read, the same way `lastHelperPostFailure` already works for writes.
//
// Single-threaded and read immediately after the await, so there is no interleaving to worry about.

export type ReadFailure =
  /** The browser reports no network. */
  | 'offline'
  /** The request was cut by the timeout. */
  | 'timeout'
  /** The service answered that this device may not read this (401, 403). */
  | 'denied'
  /** The service answered that there is nothing there (404). */
  | 'missing'
  /** The service did not answer, or answered that it cannot (5xx, a refused connection). */
  | 'unavailable'
  /** The service answered something that is not the JSON the app expects. */
  | 'malformed'

/** Who was asked: the local bridge (the Konclave on this device), the hosted coordinator (the vault's
 *  server), or this browser's own storage, where the vaults on this device are kept. */
export type ReadSource = 'bridge' | 'coordinator' | 'device'

export type ReadFailureInfo = { reason: ReadFailure; source: ReadSource }

const last = new Map<string, ReadFailureInfo>()

/** The path without its query string: one memory per route, whatever the vault in the query. */
const key = (path: string) => path.split('?')[0] ?? path

/** Record the outcome of a read of `path`: a reason and who was asked, or `null` when it succeeded. */
export function recordRead(path: string, reason: ReadFailure | null, source: ReadSource = 'coordinator'): void {
  if (reason) last.set(key(path), { reason, source })
  else last.delete(key(path))
}

/** Why the most recent read of `path` failed and who was asked, or `null` when it succeeded (or never ran). */
export function lastReadFailure(path: string): ReadFailureInfo | null {
  return last.get(key(path)) ?? null
}

/** The reason, from the error thrown or the status answered. */
export function classifyRead(outcome: { error?: unknown; status?: number }): ReadFailure {
  const { error, status } = outcome
  if (error instanceof DOMException && error.name === 'AbortError') return 'timeout'
  if (error instanceof SyntaxError) return 'malformed'
  if (error !== undefined) {
    const online = typeof navigator === 'undefined' || navigator.onLine !== false
    return online ? 'unavailable' : 'offline'
  }
  if (status === 401 || status === 403) return 'denied'
  if (status === 404) return 'missing'
  return 'unavailable'
}
