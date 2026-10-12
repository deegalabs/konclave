// What actually happened to a send (#280, #626).
//
// The coordinator replies after a blocking build+prove+broadcast that routinely outlives a proxy
// idle timeout. So the most likely gateway error in production is not "nothing happened" - it is
// "the payment went out and the response never came back", and a record with no txid does not say
// otherwise. Rendering that as a failure invites the treasurer to pay twice.
//
// This module is the honest answer: how to read the coordinator's reply (`readReply`), and a
// resolution pass that asks the record instead of guessing, which says *we do not know* rather than
// "nothing was sent". Pure and injected, so the timing and the verdict are unit-tested without a
// network.

/** A proposal as the helper reports it, narrowed to what deciding the outcome needs. */
export type SentProbe = { id: string; state: string; txid?: string | null }

export type Resolution =
  | { kind: 'sent'; txid: string }
  /** Still unresolved after the whole window. Say so; do not downgrade it to a failure. */
  | { kind: 'unresolved' }

/**
 * Did this proposal reach the chain? `null` when the list could not be read at all, which is
 * different from "read it and the proposal is not sent" and must not be collapsed into it.
 */
export function readOutcome(proposals: ReadonlyArray<SentProbe> | null, id: string): Resolution | null {
  if (proposals === null) return null
  const p = proposals.find((x) => x.id === id)
  if (!p) return null // the vault answered but does not know this proposal - learn nothing
  const txid = (p.txid ?? '').trim()
  if (txid) return { kind: 'sent', txid }
  // No txid says nothing either way: the record is never read as "not sent".
  return null
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


/** What the coordinator answered to a send (`executeProposal`, the one place it is read off the wire). */
export type SendReply =
  | { txid: string | null; dry_run: boolean; state: string }
  /** `state` is the payment's state when the coordinator refused because it is not ready to send
   *  (`sent` when another device sent it; `ready` when it says the payment may be on the network). `txid` when
   *  it broadcast and got an error back: the payment may be on the network. */
  | { error: string; state?: string; txid?: string }
  /** The coordinator did not answer, or gave a gateway error with no reason. The money may have
   *  moved. The caller MUST resolve it against the vault before saying anything (#280). */
  | { unknown: true }
  | null

/** How the panel ends a send from the coordinator's answer. `not-sent` is the only ending that
 *  withdraws the signatures and offers Try again; `resolve` asks the record first; `held` says the
 *  money may have moved, with no Try again. */
export type ReplyEnd =
  | { kind: 'sent'; txid: string }
  | { kind: 'not-sent'; why: 'unreachable' }
  | { kind: 'not-sent'; why: 'no-txid' }
  | { kind: 'not-sent'; why: 'not-sendable'; state: string; raw: string }
  | { kind: 'not-sent'; why: 'error'; raw: string }
  /** `sentElsewhere`: the coordinator refused because another device sent it. */
  | { kind: 'resolve'; sentElsewhere?: true }
  | { kind: 'held'; txid?: string }

export function readReply(r: SendReply): ReplyEnd {
  if (!r) return { kind: 'not-sent', why: 'unreachable' }
  if ('unknown' in r) return { kind: 'resolve' }
  // A broadcast that errored carries its txid: the payment may be on the network.
  if ('error' in r && r.txid) return { kind: 'held', txid: r.txid }
  if ('error' in r && r.state === 'sent') return { kind: 'resolve', sentElsewhere: true }
  // Refused while the payment still reads ready: the coordinator says it may be on the network.
  if ('error' in r && r.state === 'ready') return { kind: 'held' }
  if ('error' in r && r.state) return { kind: 'not-sent', why: 'not-sendable', state: r.state, raw: r.error }
  if ('error' in r) return { kind: 'not-sent', why: 'error', raw: r.error }
  if (!r.txid) return { kind: 'not-sent', why: 'no-txid' }
  return { kind: 'sent', txid: r.txid }
}

/** What the signing panel holds about a send. `unresolved`: the money may have moved (`lost`: the
 *  reply never came and the record does not show it sent; `held`: the coordinator says it may be
 *  on the network; `broadcast`: it broadcast and got an error back, with the txid to look
 *  for). */
export type PanelResult =
  | { txid: string | null }
  | { error: string }
  | { unresolved: 'lost' | 'held' | 'broadcast'; txid?: string }
  | null

/** The txid of a payment the panel may show as sent, or null. A txid on an unresolved result is one to
 *  look for, not a send. */
export function sentTxidOf(r: PanelResult): string | null {
  if (!r || 'unresolved' in r || !('txid' in r)) return null
  return r.txid || null
}

/** What each payment's send came to on this page. An outcome is shown only while its
 *  payment is the one on screen, and kept, so a payment that opens again shows its own: a "may have
 *  gone out" that landed while another payment was open is never lost. */
export class OutcomeBook {
  private readonly byId = new Map<string, PanelResult>()

  /** Keep `r` for payment `id`; true when it is the payment on screen (`shown`) and so is shown now. */
  record(id: string, r: PanelResult, shown: string | null): boolean {
    this.byId.set(id, r)
    return shown === id
  }

  restore(id: string): PanelResult {
    return this.byId.get(id) ?? null
  }

  clear(id: string): void {
    this.byId.delete(id)
  }
}

/** Whether another device's failure may replace what the panel shows: never an outcome that says the
 *  money may have moved, or that it went out. */
export function peerFailureMayShow(r: PanelResult): boolean {
  return !r || 'error' in r
}
