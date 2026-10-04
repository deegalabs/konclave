// What the signing screen calls each output a device read from the transaction (#610).
//
// An output's address label is optional and outside what the signature covers: the builder can
// leave it off any output, and the WASM can only check a label that is there. So a missing label
// says nothing about where the money goes. The first version of the screen called every unlabelled
// output "back to the vault (change)", which, under a refusal, presented a payment to an outsider
// stripped of its label as the vault's own change, on the screen the member is told to compare with
// the proposal. An unlabelled output is the vault's change only when it pays one of the vault's own
// receivers, decided by the same `ourReceivers` the money gate uses; anything else is unnamed.

import type { SignPreview } from './signing-machine'

export type ReadingTo = { kind: 'address'; addr: string } | { kind: 'vault' } | { kind: 'unnamed' }
export interface ReadingRow {
  zat: number
  to: ReadingTo
}

/** @param isOurs whether a receiver is one of the vault's own; `() => false` where the device does
 *  not know them (the legacy `/net` route), which names no output change. */
export function readingRows(what: SignPreview, isOurs: (recipient: string | null) => boolean): ReadingRow[] {
  return what.outputs.map((o) => ({
    zat: o.zat,
    to: o.addr !== null ? { kind: 'address', addr: o.addr } : isOurs(o.recipient) ? { kind: 'vault' } : { kind: 'unnamed' },
  }))
}
