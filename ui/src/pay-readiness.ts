// Can this vault pay right now? One function, so the Dashboard keeps no copy of the rule (#693).
export interface ReadinessInput {
  threshold: number
  seatsHere: number
  hasFree: boolean
  backendsUp: boolean
}

export function payReadiness(i: ReadinessInput) {
  const quorumReachable = i.threshold > 0 && i.seatsHere >= i.threshold
  return { quorumReachable, canPay: quorumReachable && i.hasFree && i.backendsUp }
}
