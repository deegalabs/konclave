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
import { useBackgroundSigner, type BackgroundSignerState } from './useBackgroundSigner'
import { makeSigningGate } from './signing-gate'

interface VaultSignerCtx {
  bg: BackgroundSignerState
  vault: Vault | null
  threshold: number
  /** The proposal whose ceremony the panel is showing, or null when the panel is closed. */
  active: Proposal | null
  open: (p: Proposal) => void
  close: () => void
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
  const [active, setActive] = useState<Proposal | null>(null)

  useEffect(() => {
    let on = true
    void (async () => {
      const v = await getVault()
      if (on) setVault(v)
    })()
    return () => { on = false }
  }, [])

  // The signer runs only while the ceremony panel is OPEN (active != null), not always-on on every
  // screen: an app-wide relay session on every navigation was churny and destabilized the vault
  // session. Scoped to the panel, both members open "Sign this payment" to seat + sign together.
  // Requires a browser-native (/net) vault, unlocked in this session; otherwise inert.
  const unlocked = active && IS_NET && vault && isVaultUnlocked(vault.id) ? { id: vault.id } : null

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
    active,
    open: setActive,
    close: () => setActive(null),
  }
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>
}
