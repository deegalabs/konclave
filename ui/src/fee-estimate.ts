// The network fee a screen shows before a payment is built: ZIP 317, 5000 zatoshis per logical
// action, at least two, counting one spend, the destinations and the change. One function, so the
// proposal page, the payroll form and the signing panel cannot show three different figures.
//
// This is an ESTIMATE and always will be: only the wallet knows its note selection (#206, #293).
// What the device signs is checked against the transaction itself, in WASM, and must be exactly the
// ZIP 317 fee of the actions it carries.
export function estimatedFeeZat(destinations: number): number {
  return 5000 * Math.max(2, Math.max(1, destinations) + 1)
}
