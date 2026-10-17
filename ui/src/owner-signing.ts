// The owner's side of signing on this device, in one place the provider only calls (VaultSigner):
// the consent a click gives (one click covers one transaction, `signing-gate.ts`), and this device's
// record of what it signed (`signed-record.ts`, judged by the rule in WASM). The record outlives a
// reload, a closed panel and a withdrawal, so a second transaction for an approval this device already
// signed is never signed unless its owner signs again knowing it ("Sign again"), and then only once.
//
// A coordinator that says a send failed cannot make that second signature silent: the failure ends
// the click, not the record.
import { claimConsent, consentAllows, giveConsent, newConsent, withdrawConsent, type OwnerConsent } from './signing-gate'
import { decideFor, recordSigned, type RecordStore } from './signed-record'

export type Claim = 'ok' | 'second' | 'refused' | 'unreadable'

export class OwnerSigning {
  readonly consent: OwnerConsent = newConsent()
  /** What its owner chose to sign again, knowing the approval was signed before: the transaction
   *  they were shown when it was refused (its sighash), for that approval, once. */
  private again: { proposal: string; sighash: string } | null = null
  /** The transaction this consent cleared, and for which approval: the only one a share may go into,
   *  recorded under that approval whatever the screen shows by then. Gone when the consent is
   *  withdrawn; a new click on the same payment keeps it, so a ceremony under way is not cut. */
  private claimed: { vault: string; proposal: string; sighash: string } | null = null
  /** The last second transaction refused, for the screen: which approval, and until when the first stays valid. */
  lastSecond: { proposal: string; firstExpiry: number; firstUntil: number; byEpoch: boolean; sighash: string } | null = null

  private readonly store: RecordStore
  private readonly now: () => number

  constructor(store: RecordStore, now: () => number = () => Date.now()) {
    this.store = store
    this.now = now
  }

  /** The owner signs `proposal`; `again` when they confirmed signing a second transaction for it. */
  give(proposal: string, at: number, opts: { again?: boolean } = {}): void {
    giveConsent(this.consent, proposal, at)
    const shown = this.lastSecond
    this.again = opts.again && shown?.proposal === proposal ? { proposal, sighash: shown.sighash } : null
    this.lastSecond = null
  }

  withdraw(): void {
    withdrawConsent(this.consent)
    this.again = null
    this.claimed = null
  }

  /** Another payment opened: a click for the previous one covers nothing here. */
  open(proposal: string): void {
    if (this.consent.proposal !== proposal) this.withdraw()
  }

  /** Whether this device's owner signed the payment open now, within their window (the gate). */
  allows(activeId: string | null): boolean {
    return consentAllows(this.consent, activeId, this.now())
  }

  /** The machine cleared `sighashHex` (expiring at `expiry`) for `activeId` on `vault`. */
  async claim(vault: string, activeId: string | null, sighashHex: string, _expiry: number): Promise<Claim> {
    if (!activeId || !consentAllows(this.consent, activeId, this.now())) return 'refused'
    let decision
    try {
      decision = await decideFor(this.store, vault, activeId, sighashHex)
    } catch {
      // Not knowing what this device signed never reads as having signed nothing. Its own answer,
      // so the screen says what happened rather than "already signed".
      this.consent.spent = true
      return 'unreadable'
    }
    const h = sighashHex.trim().toLowerCase()
    if (decision.kind === 'second' && !(this.again?.proposal === activeId && this.again.sighash === h)) {
      this.consent.spent = true
      this.lastSecond = { proposal: activeId, firstExpiry: decision.firstExpiry, firstUntil: decision.untilUnix, byEpoch: decision.byEpoch, sighash: h }
      return 'second'
    }
    if (!claimConsent(this.consent, activeId, this.now(), sighashHex)) return 'refused'
    if (decision.kind === 'second') this.again = null
    this.claimed = { vault, proposal: activeId, sighash: sighashHex.trim().toLowerCase() }
    return 'ok'
  }

  /** This device's share goes into `sighashHex`: record it before the share leaves, under the approval
   *  it was claimed for. Throws `[withdrawn]` when no live consent claimed this transaction (its owner
   *  withdrew after the claim, or it is another one), and when the record cannot be written: either
   *  way, no share. */
  async record(sighashHex: string, expiry: number, branch: number): Promise<void> {
    const c = this.claimed
    // The same test the gate makes, read now: the screen's timer may never have run (a device that
    // slept), and a package held back by the relay must not outlive the owner's window.
    if (!c || c.sighash !== sighashHex.trim().toLowerCase() || !consentAllows(this.consent, c.proposal, this.now(), sighashHex)) {
      throw new Error('[withdrawn] no live consent for this transaction')
    }
    await recordSigned(this.store, c.vault, c.proposal, sighashHex, expiry, branch)
  }
}
