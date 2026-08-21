// In-vault signing ceremony (K11, ADR-0009): mount the tested background signer ONCE at the app
// shell so any present device is armed and contributing, and expose a right-side SigningPanel that
// runs the ceremony in place - no /net redirect. The heavy lifting is the already-validated
// BackgroundSigner stack (issue #49, /lab/background-signer); this is the product wiring.
//
// The money gate lands on the initiator's broadcast (a preview + explicit confirm in SigningPanel).
// A present signer contributing its share automatically is NOT a new money decision: it already
// happened when that member APPROVED the proposal (K4). See ADR-0009 and the ceremony design.

import { createContext, useContext, useEffect, useMemo, useState, type ReactNode } from 'react'
import { getVault, isVaultUnlocked, IS_NET, type Proposal, type Vault } from './api'
import { listVaults } from './storage'
import { useBackgroundSigner, type BackgroundSignerState } from './useBackgroundSigner'
import { makeSigningGate } from './signing-gate'

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

  // A ready proposal is quorum-approved, so the gate approves it; `auto` means a present device
  // contributes its share on its own (the approval was the consent). Per-vault manual mode is a
  // follow-up (governance surface); auto is the honest default for a quorum vault.
  const gate = useMemo(
    () => makeSigningGate({ mode: () => 'auto', isApproved: () => true, isArmed: () => true }),
    [],
  )
  const bg = useBackgroundSigner(unlocked, gate)

  const value: VaultSignerCtx = {
    bg,
    vault,
    threshold: vault?.threshold ?? 0,
    myName,
    active,
    open: setActive,
    close: () => setActive(null),
    reseat: () => setNonce((n) => n + 1),
  }
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>
}
