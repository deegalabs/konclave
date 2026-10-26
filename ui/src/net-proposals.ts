// When the /net screen may read a vault's proposals from the coordinator.
//
// Only once the coordinator knows the vault. During a creation that is after the registration: the
// list used to load as soon as the group key existed, and every new member got a 404. A vault opened
// from this device (`restored`) or in a signing session is already registered, so it reads at once.

export type NetPhase = 'idle' | 'roster' | 'confirm' | 'dkg' | 'done' | 'error' | 'restored' | 'signsession'
export type HostedState = 'idle' | 'registering' | 'registered' | 'failed'

export function proposalsReadable(phase: NetPhase, hosted: HostedState): boolean {
  return hosted === 'registered' || phase === 'restored' || phase === 'signsession'
}
