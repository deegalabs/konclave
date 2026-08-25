// In-vault signing ceremony (K11, ADR-0009): mount the tested background signer ONCE at the app
// shell so any present device is armed and contributing, and expose a right-side SigningPanel that
// runs the ceremony in place - no /net redirect. The heavy lifting is the already-validated
// BackgroundSigner stack (issue #49, /lab/background-signer); this is the product wiring.
//
// The money gate lands on the initiator's broadcast (a preview + explicit confirm in SigningPanel).
// A present signer contributing its share automatically is NOT a new money decision: it already
// happened when that member APPROVED the proposal (K4). See ADR-0009 and the ceremony design.

import { createContext, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { getVault, isVaultUnlocked, IS_NET, type Proposal, type Vault } from './api'
import { listVaults } from './storage'
import { useBackgroundSigner, type BackgroundSignerState } from './useBackgroundSigner'
import { ARM_TTL_MS, armIsLive, makeSigningGate } from './signing-gate'

interface VaultSignerCtx {
  bg: BackgroundSignerState
  vault: Vault | null
  threshold: number
  /** This device's own member name, from the on-device record (reflects a rename). The panel uses
   *  it to identify "you" in the roster - authoritative over the (possibly staler) session share. */
  myName: string | null
  /** The proposal whose ceremony the panel is showing, or null when the panel is closed. */
  active: Proposal | null
  open: (p: Proposal) => void
  close: () => void
  /** Re-run the background signer after the share is unlocked in-session (the panel unlock form). */
  reseat: () => void
  /** This device's owner explicitly signed the proposal now on screen. */
  armed: boolean
  /** Withdraw every signature for the open proposal (an attempt failed; nothing moved). */
  unarmActive: () => Promise<void>
  /** Sign the active proposal from this device: arm the gate, then tell the room. */
  armActive: () => Promise<void>
  /** When this device's signature stops counting (epoch ms), or null when it is not armed. */
  armedUntil: number | null
}

const Ctx = createContext<VaultSignerCtx | null>(null)

/** Access the in-vault signer + panel controls. Safe to call from any in-vault screen. */
export function useVaultSigner(): VaultSignerCtx {
  const ctx = useContext(Ctx)
  if (!ctx) throw new Error('useVaultSigner must be used within a VaultSignerProvider')
  return ctx
}

export function VaultSignerProvider({ children }: { children: ReactNode }) {
  const [vault, setVault] = useState<Vault | null>(null)
  const [myName, setMyName] = useState<string | null>(null)
  const [active, setActive] = useState<Proposal | null>(null)
  // The proposal THIS device's owner explicitly signed. Nothing signs without this: a present device
  // is no longer enough (it used to sign on its own the moment a request appeared). Every member
  // performs the act, and the one who completes the quorum is the one who sends.
  const [armedProposal, setArmedProposal] = useState<string | null>(null)
  const [armedAt, setArmedAt] = useState<number | null>(null)
  // Bumped after the panel unlocks the share in-session, so useBackgroundSigner re-runs and seats.
  const [nonce, setNonce] = useState(0)

  // Re-load on `nonce` too (a reseat), so a same-session rename+unlock refreshes both the roster and
  // this device's own name before the panel resolves presence.
  useEffect(() => {
    let on = true
    void (async () => {
      const v = await getVault()
      if (on) setVault(v)
      if (v) {
        try {
          const rec = (await listVaults()).find((s) => s.id === v.id)
          if (on) setMyName(rec?.myName ?? null)
        } catch { /* no on-device record (local-bridge) - panel falls back to the session share */ }
      }
    })()
    return () => { on = false }
  }, [nonce])

  // The signer runs only while the ceremony panel is OPEN (active != null), not always-on on every
  // screen: an app-wide relay session on every navigation was churny and destabilized the vault
  // session. Scoped to the panel, both members open "Sign this payment" to seat + sign together.
  // Requires a browser-native (/net) vault, unlocked in this session; otherwise inert.
  const unlocked = active && IS_NET && vault && isVaultUnlocked(vault.id) ? { id: vault.id, nonce } : null

  // MANUAL: this device contributes its share only for a payment its owner explicitly signed on
  // this screen. Approval (K4) is consent to the payment; signing is the act that spends, and it is
  // now a deliberate, per-payment click on every device - not something a present tab does silently.
  //
  // Arming is tracked per PROPOSAL because that is what the owner sees and clicks. Binding it to the
  // payment's own sighash (so the gate cannot be fooled by a swapped transaction under the same
  // proposal label) is issue #281 and is NOT claimed here.
  const armedRef = useRef<string | null>(null)
  armedRef.current = armedProposal
  const armedAtRef = useRef<number | null>(null)
  armedAtRef.current = armedAt
  const activeIdRef = useRef<string | null>(null)
  activeIdRef.current = active?.id ?? null
  const gate = useMemo(
    () => makeSigningGate({
      mode: () => 'manual',
      isApproved: () => true,
      isArmed: () => {
        // The deadline lives with the gate it guards (signing-gate.ts), where it is tested.
        if (!armIsLive(armedAtRef.current, Date.now())) return false // expired: sign again
        return !!activeIdRef.current && armedRef.current === activeIdRef.current
      },
    }),
    [],
  )
  // Let the arming expire on its own, so the screen and the gate agree: the button comes back and
  // the share stops counting at the same moment, with no stale "you signed" left on screen.
  useEffect(() => {
    if (armedAt === null) return
    const left = ARM_TTL_MS - (Date.now() - armedAt)
    const clear = () => { setArmedProposal(null); setArmedAt(null) }
    if (left <= 0) { clear(); return }
    const id = window.setTimeout(clear, left)
    return () => window.clearTimeout(id)
  }, [armedAt])

  const bg = useBackgroundSigner(unlocked, gate)

  // Scope the signer to the payment on screen. Without this the room's whole history counts: it is
  // permanent, so the previous payment's signatures replayed as a full quorum for the new one.
  const setProposal = bg.setProposal
  useEffect(() => {
    setProposal(active?.id ?? null)
  }, [active?.id, bg.ready, setProposal])

  const value: VaultSignerCtx = {
    bg,
    vault,
    threshold: vault?.threshold ?? 0,
    myName,
    active,
    // Closing and reopening the SAME payment must not un-sign you: only a different payment
    // starts over. (A full reload does clear it - the share is session-scoped too, so that path
    // goes back through the passphrase and the signature is offered again.)
    open: (p: Proposal) => {
      setArmedProposal((cur) => {
        if (cur === p.id) return cur
        setArmedAt(null)
        return null
      })
      setActive(p)
    },
    close: () => setActive(null),
    reseat: () => setNonce((n) => n + 1),
    armed: !!active && armedProposal === active.id,
    unarmActive: async () => {
      if (!active) return
      setArmedProposal(null)
      setArmedAt(null)
      armedRef.current = null
      armedAtRef.current = null
      await bg.unarm(active.id)
    },
    armedUntil: armedAt === null ? null : armedAt + ARM_TTL_MS,
    armActive: async () => {
      if (!active) return
      // Arm BEFORE announcing, so a request that lands the instant the room hears us is already
      // allowed through the gate. Then re-drive the signer in case the request arrived first.
      const now = Date.now()
      setArmedProposal(active.id)
      setArmedAt(now)
      armedRef.current = active.id
      armedAtRef.current = now
      await bg.arm(active.id)
      await bg.retry()
    },
  }
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>
}
