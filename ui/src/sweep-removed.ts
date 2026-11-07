// What this browser still keeps for vaults it no longer holds, cleared when the app opens (#813).
//
// Removing a vault clears everything the device kept for it (`clearVaultTraces`). A vault removed
// BEFORE that was fixed left its traces behind: the people saved for it, its passkey wrap, its
// payroll draft, its recent addresses, what the vault list and "What changed" last showed. Nothing
// ever came back for them. This sweep does, once per start, through the same function a removal
// uses, so what a sweep clears cannot differ from what a removal clears. The signed record stays,
// for the reason it stays on removal (see remove-vault.ts).
//
// It FAILS CLOSED, and that is the property worth keeping:
//   - it reads the vault records with `readVaults`, which refuses rather than answering `[]` when
//     storage will not open; a refused or failed read clears NOTHING, because "could not read the
//     vaults" must never be taken for "this device holds no vaults";
//   - on the local bridge the bridge's own list is added, and a bridge that does not answer stops
//     the sweep the same way;
//   - the keys are listed BEFORE the records are read, so a vault created while the sweep runs is
//     never a candidate.
// The prefixes are taken from the functions that build each key, not spelled again here.
import { IS_NET, getVaults } from './api'
import { prfKey } from './prf-store'
import { draftKey } from './payroll-draft'
import { recentPayeesKey } from './recent-payees'
import { clearVaultTraces } from './remove-vault'
import { seenKey } from './seen-store'
import { beneficiariesKey, readVaults } from './storage'
import { statusKey } from './vault-status'

const TRACES: ReadonlyArray<(id: string) => string> = [beneficiariesKey, draftKey, recentPayeesKey, seenKey, statusKey, prfKey]

/** The vault ids that some per-vault key in `keys` belongs to. */
export function tracedVaultIds(keys: readonly string[]): Set<string> {
  const prefixes = TRACES.map((k) => k(''))
  const ids = new Set<string>()
  for (const key of keys) {
    for (const prefix of prefixes) {
      if (!key.startsWith(prefix)) continue
      const id = key.slice(prefix.length)
      // A longer key that merely starts like this one is not a vault id ("folha.rascunho" under a
      // shorter prefix, say): an id has no dot in it.
      if (id && !id.includes('.')) ids.add(id)
    }
  }
  return ids
}

/** Every vault this device holds: its records, and on the local bridge the bridge's list. Throws
 *  when either cannot be read, which stops the sweep. */
export async function heldVaultIds(
  src: { records: () => Promise<{ id: string }[]>; net: boolean; bridge: () => Promise<{ id: string }[] | null> } = { records: readVaults, net: IS_NET, bridge: getVaults },
): Promise<Set<string>> {
  const held = new Set((await src.records()).map((v) => v.id))
  if (!src.net) {
    const bridge = await src.bridge()
    if (bridge === null) throw new Error('the bridge did not list its vaults')
    for (const v of bridge) held.add(v.id)
  }
  return held
}

function storageKeys(): string[] {
  try {
    const out: string[] = []
    for (let i = 0; i < localStorage.length; i++) {
      const k = localStorage.key(i)
      if (k !== null) out.push(k)
    }
    return out
  } catch {
    return []
  }
}

/** Clear the traces of every vault this device no longer holds. Returns the ids it cleared; none
 *  when nothing is left over or the vaults could not be read. */
export async function sweepRemovedVaults(held: () => Promise<Set<string>> = heldVaultIds): Promise<string[]> {
  const candidates = tracedVaultIds(storageKeys())
  if (candidates.size === 0) return []
  let holding: Set<string>
  try {
    holding = await held()
  } catch {
    return []
  }
  const gone = [...candidates].filter((id) => !holding.has(id))
  for (const id of gone) clearVaultTraces(id)
  return gone
}
