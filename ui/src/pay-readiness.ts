// Can this vault pay right now? One function, so the Dashboard keeps no copy of the rule (#693).
// Presence is not a condition: the only count the app has is the signing room's, which exists while
// a payment is open and then only grows (#291), so it cannot answer "who is here" before the click.
export interface ReadinessInput {
  hasFree: boolean
  backendsUp: boolean
}

export function payReadiness(i: ReadinessInput) {
  return { canPay: i.hasFree && i.backendsUp }
}
