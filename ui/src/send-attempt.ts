// The signing panel's memory of the send it fired, and what each way a send can end does to it
// (#626). The send fires from an effect when the room names this device, so the panel keeps which
// payment it already fired for and fires once per attempt. The panel stays mounted while it is
// closed, so the memory lasts for the page: closing and reopening the panel keeps it, a reload does
// not.
//
// The panel and the who-sends simulator (signer-sim.ts) both go through this module, so the model
// the property test checks is the panel's own rule, not a copy of it.

export interface SendAttempt {
  /** The payment a send was fired for on this page, while that send has not ended with nothing sent. */
  fired: string | null
}

export function newSendAttempt(): SendAttempt {
  return { fired: null }
}

/** The room named this device the sender of `id`. True when the panel fires the send now; false
 *  when a send of this payment already ran on this page. */
export function takeSend(a: SendAttempt, id: string): boolean {
  if (a.fired === id) return false
  a.fired = id
  return true
}

/** How a fired send ended. `not-sent`: the coordinator said nothing went out, and the panel
 *  withdraws this device's signature. `sent`, or `unknown` when the money may have moved. */
export type SendEnd = 'sent' | 'not-sent' | 'unknown'

/** A send that ended with nothing sent releases the memory, so the next time the room names this
 *  device for the payment it sends. A send that went out, or may have, keeps it. */
export function endSend(a: SendAttempt, id: string, end: SendEnd): void {
  // Only the payment whose send ended: another payment's failure never releases this one.
  if (end === 'not-sent' && a.fired === id) a.fired = null
}
