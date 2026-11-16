// For tests that drive `createProposal` / `createPayroll` on the web path (#591): a device holding
// `seat` of a vault whose coordinator serves `members`. Never imported by the app.
import { setUnlockedShare } from './session'

export function unlockSeatForTest(vault: string, seat: number): void {
  const bundle = { kp: 'AA==', pubkeys: 'AA==', seat, n: 2, t: 2 }
  setUnlockedShare(vault, {
    groupKey: new Uint8Array(32), address: '', roster: [], createdAt: 0,
    sealedShare: new TextEncoder().encode(JSON.stringify(bundle)),
  } as never)
}

/** The coordinator's answer to the member-list read, for a fetch stub to return. */
export const membersAnswer = (members: string[]): Response => new Response(JSON.stringify({ members }), { status: 200 })
