// Whether a device may sign a payment again after refusing a new transaction for it because its
// signature already covers an earlier one (`net.err.signedAnother`), and if not, what is in the way.
//
// One function, so the panel cannot offer the button on one condition and explain it on another.
// The failed send that this very refusal caused is not in the way: on the device the room named
// sender, the refusal ends the send, and counting that failure would leave it stuck on it for good.

export type SignAgain = 'offer' | 'short' | 'quorum' | 'busy' | 'none'

export function signAgainState(s: {
  /** The device refused because its signature already covers another transaction for this payment. */
  refusedAsSigned: boolean
  /** This device's signature stands (it signed this round). */
  armed: boolean
  ready: boolean
  quorumHere: boolean
  /** This device's own ceremony is running. NOT its send waiting at the coordinator: on the device the
   *  room named sender, that send stays open for minutes after the refusal, waiting for this very
   *  device's share, and signing again is what completes it. */
  signing: boolean
  arming: boolean
  shortZat: number
  /** The payment went out, or may have: no second signature is offered then. */
  settled: boolean
}): SignAgain {
  if (!s.refusedAsSigned || s.armed || s.settled) return 'none'
  if (s.shortZat > 0) return 'short'
  if (!s.ready || s.signing || s.arming) return 'busy'
  if (!s.quorumHere) return 'quorum'
  return 'offer'
}

/** What the signing panel knows, as it knows it. `againFromPanel` is the one place that turns it into
 *  `signAgainState`'s question, so the panel cannot pass a near-miss of it (its own send for "signing",
 *  an outcome being checked for "not settled"). */
export interface PanelFacts {
  refusedAsSigned: boolean
  armed: boolean
  ready: boolean
  quorumHere: boolean
  /** The signer's phase: 'idle' unless this device's own ceremony runs. */
  phase: 'idle' | 'signing' | 'signed'
  /** This device's send is waiting at the coordinator. Deliberately not "busy": see `signing`. */
  sending: boolean
  arming: boolean
  shortZat: number
  /** The send's result shows the payment sent, or an outcome nobody knows. */
  sent: boolean
  unresolved: boolean
  /** Checks of what a send came to, still running. */
  checking: number
}

export function againFromPanel(f: PanelFacts): SignAgain {
  return signAgainState({
    refusedAsSigned: f.refusedAsSigned,
    armed: f.armed,
    ready: f.ready,
    quorumHere: f.quorumHere,
    signing: f.phase !== 'idle',
    arming: f.arming,
    shortZat: f.shortZat,
    // While the panel checks what a send came to, the payment may be on the network (#280).
    settled: f.sent || f.unresolved || f.checking > 0,
  })
}
