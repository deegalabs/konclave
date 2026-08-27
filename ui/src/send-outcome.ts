// What actually happened to a send, when the coordinator stopped answering (#280).
//
// The helper persists a proposal as `sent` WITH its txid before it replies, and the reply comes
// after a blocking build+prove+broadcast that routinely outlives a proxy idle timeout. So the most
// likely gateway error in production is not "nothing happened" - it is "the payment went out and
// the response never came back". Rendering that as a failure invites the treasurer to retry a
// payment that is already on the chain.
//
// This module is the honest answer: a third outcome that says *we do not know yet*, and a
// resolution pass that asks the chain instead of guessing. Pure and injected, so the timing and the
// verdict are unit-tested without a network.

/** A proposal as the helper reports it, narrowed to what deciding the outcome needs. */
export type SentProbe = { id: string; state: string; txid?: string | null }

export type Outcome =
  /** The coordinator answered and the transaction is on the network. */
  | { kind: 'sent'; txid: string }
  /** The coordinator answered with a reason. Nothing was broadcast. */
  | { kind: 'failed'; error: string }
  /**
   * The coordinator did not answer, or answered with a gateway error that carries no reason. The
   * money may or may not have moved, and until we know, the UI must not claim either.
   */
  | { kind: 'unknown' }

export type Resolution =
  | { kind: 'sent'; txid: string }
  /** Checked, and the proposal is still open with no txid: nothing was broadcast. */
  | { kind: 'not-sent' }
  /** Still unresolved after the whole window. Say so; do not downgrade it to a failure. */
  | { kind: 'unresolved' }

/**
 * Did this proposal reach the chain? `null` when the list could not be read at all, which is
 * different from "read it and the proposal is not sent" and must not be collapsed into it.
 */
export function readOutcome(proposals: SentProbe[] | null, id: string): Resolution | null {
  if (proposals === null) return null
  const p = proposals.find((x) => x.id === id)
  if (!p) return null // the vault answered but does not know this proposal - learn nothing
  const txid = (p.txid ?? '').trim()
  if (txid) return { kind: 'sent', txid }
  // `sent` with no txid is a half-written record, not a settled fact: keep waiting rather than
  // reporting a send with nothing to verify.
  if (p.state === 'sent') return null
  return { kind: 'not-sent' }
}

export type ResolveDeps = {
  /** Re-read the vault's proposals. Returns null when it could not be reached. */
  list: () => Promise<SentProbe[] | null>
  /** Sleep, injected so tests do not wait. */
  wait: (ms: number) => Promise<void>
  /** Called before each attempt with how many are left, so the UI can count down honestly. */
  onAttempt?: (left: number) => void
}

/** How long to keep asking, and how often. About 30s, which covers a proxy timeout plus a block. */
export const RESOLVE_ATTEMPTS = 10
export const RESOLVE_DELAY_MS = 3000

/**
 * Ask the vault, repeatedly, what became of a send whose response was lost. Stops at the first
 * definite answer. Returns `unresolved` rather than guessing when the window closes - the caller
 * must then tell the user plainly that it does not know, and must keep Retry blocked.
 */
export async function resolveOutcome(
  id: string,
  deps: ResolveDeps,
  attempts = RESOLVE_ATTEMPTS,
  delayMs = RESOLVE_DELAY_MS,
): Promise<Resolution> {
  for (let i = 0; i < attempts; i++) {
    deps.onAttempt?.(attempts - i)
    const r = readOutcome(await deps.list(), id)
    if (r) return r
    if (i < attempts - 1) await deps.wait(delayMs)
  }
  return { kind: 'unresolved' }
}

/**
 * Is it safe to offer Retry? Only when we know nothing moved. Retrying an `unknown` or an
 * `unresolved` send is an attempt to spend the same notes twice.
 */
export function canRetry(r: Resolution | Outcome | null): boolean {
  if (!r) return false
  return r.kind === 'not-sent' || r.kind === 'failed'
}
