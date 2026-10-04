// How the signing panel words an error the background signer reports.
//
// The signing machine reports through an injected `tt`, and the background path passes the
// identity, so what reaches the panel is an i18n KEY, sometimes followed by the engine's own
// sentence. The panel used to print it inside "Could not send: {reason}" untranslated.
//
// Three kinds of report arrive, and they must not be confused.
//  - A REFUSAL ends the transaction on this device: it is reported after the machine took the
//    transaction up and before the gate cleared it, and from then on the machine answers nothing
//    about it (signing-machine.ts, `cleared`). It gets its own wording, stays on screen over the
//    send's later failure, and offers no Try again. The list is checked against the machine's source
//    (signing-refusal.test.ts), so it cannot drift from where the refusals are made.
//  - A NOTICE is a message the device ignored (a package from a seat that does not coordinate, or
//    one over another transaction): the honest round may follow and be signed. Shown as a refusal
//    it told the member "nothing was signed" while the device went on and signed (#610 review), so
//    it is worded as something ignored and shown beside the progress, never in its place.
//  - Anything else is a failed send.

/** The device's refusals of a transaction: each is final for that transaction on this device. */
export const REFUSALS: ReadonlySet<string> = new Set([
  'net.err.unreadableSpends',
  'net.err.notApproved',
  'net.err.approvalUnknown',
  'net.err.unreadablePczt',
  'net.err.feeTooHigh',
  'net.err.outputMismatch',
  'net.err.labelMismatch',
  'net.err.unexpectedShape',
])

/** Messages the device ignored while the transaction may still be signed. */
export const NOTICES: ReadonlySet<string> = new Set(['net.err.notCoordinator', 'net.err.sighashMismatch'])

export type SigningErrorKind = 'refusal' | 'notice' | 'failure'

export function describeSigningError(
  errMsg: string,
  t: (key: string, params?: Record<string, string | number>) => string,
): { text: string; kind: SigningErrorKind } {
  const space = errMsg.indexOf(' ')
  const head = space === -1 ? errMsg : errMsg.slice(0, space)
  const rest = space === -1 ? '' : errMsg.slice(space)
  if (REFUSALS.has(head)) return { text: t(head) + rest, kind: 'refusal' }
  if (NOTICES.has(head)) return { text: t(head) + rest, kind: 'notice' }
  // Any other machine key is still translated, never shown raw.
  if (head.startsWith('net.err.')) return { text: t(head) + rest, kind: 'failure' }
  return { text: t('signing.failed', { reason: errMsg }), kind: 'failure' }
}
