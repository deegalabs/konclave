// What this browser still keeps for vaults it no longer holds, cleared when the app opens (#813).
//
// Removing a vault clears everything the device kept for it (`clearVaultTraces`). A vault removed
// BEFORE v0.18.0 left the people saved for it and, removed from Settings or the create and join
// screen, its passkey wrap; nothing ever came back for them. This sweep does, once per start, through
// the same function a removal uses, so what a sweep clears cannot differ from what a removal clears
// (it clears every per-vault key that function knows, whichever of them are still there). The signed record stays,
// for the reason it stays on removal (see remove-vault.ts).
//
// It FAILS CLOSED, and that is the property worth keeping:
//   - it reads the vault records with `readVaults`, which refuses rather than answering `[]` when
//     storage will not open; a refused or failed read clears NOTHING, because "could not read the
//     vaults" must never be taken for "this device holds no vaults" (`listVaults` answers `[]` there,
//     which is why it is not the reader here);
//   - on the local bridge the bridge's own list is added, and a bridge that does not answer stops
//     the sweep the same way;
//   - when the bridge was NOT asked (a hosted coordinator, even on the bridge's own origin), only ids
//     shaped like a browser record are candidates; a bridge vault's id is not one, so its traces stay;
//   - the keys are listed BEFORE anything is read, the bridge is read first and the records last, and
//     the records are read once more just before clearing, so a vault created or imported meanwhile
//     (in this tab or another) is never cleared.
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
      // A longer key that merely starts like this one is not a vault id (a later version of a key,
      // `konclave.status.v2.<id>` say, would start with `konclave.status.`): an id has no dot in it.
      if (id && !id.includes('.')) ids.add(id)
    }
  }
  return ids
}

/** A vault id as this browser's own records carry it: the group key, 64 hex characters. */
const BROWSER_ID = /^[0-9a-f]{64}$/

/** Where the sweep learns which vaults this device holds. Injectable for the tests. */
export type HeldSources = {
  records: () => Promise<{ id: string }[]>
  net: boolean
  bridge: () => Promise<{ id: string }[] | null>
}
export const defaultSources: HeldSources = { records: readVaults, net: IS_NET, bridge: getVaults }

/** Every vault this device holds: on the local bridge the bridge's list (read first), then the
 *  records (read last). Throws when either cannot be read, which stops the sweep. `bridgeAsked`
 *  says whether the bridge's vaults are in `ids`. */
export async function heldVaultIds(src: HeldSources = defaultSources): Promise<{ ids: Set<string>; bridgeAsked: boolean }> {
  const ids = new Set<string>()
  if (!src.net) {
    const bridge = await src.bridge()
    if (bridge === null) throw new Error('the bridge did not list its vaults')
    for (const v of bridge) ids.add(v.id)
  }
  for (const v of await src.records()) ids.add(v.id)
  return { ids, bridgeAsked: !src.net }
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
export async function sweepRemovedVaults(src: HeldSources = defaultSources): Promise<string[]> {
  const candidates = tracedVaultIds(storageKeys())
  if (candidates.size === 0) return []
  let gone: string[]
  try {
    const held = await heldVaultIds(src)
    gone = [...candidates].filter((id) => !held.ids.has(id) && (held.bridgeAsked || BROWSER_ID.test(id)))
    if (gone.length === 0) return []
    // Once more, just before clearing: a vault imported meanwhile, in another tab say, keeps its traces.
    const now = new Set((await src.records()).map((v) => v.id))
    gone = gone.filter((id) => !now.has(id))
  } catch {
    return []
  }
  for (const id of gone) clearVaultTraces(id)
  return gone
}
