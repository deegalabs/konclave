// What "What changed" last showed for a vault (#151, #125): the proposals' states by id when the
// member last marked them as seen on this device. One module for the key, so the screen that writes
// it and the removal that clears it (`clearVaultTraces`) cannot name it differently.
import type { Snapshot } from './since-last'

export type Seen = { at: number; states: Snapshot }

export const seenKey = (id: string) => `konclave.seen.${id}`

export function readSeen(id: string): Seen | null {
  try {
    const raw = localStorage.getItem(seenKey(id))
    if (!raw) return null
    const d = JSON.parse(raw) as Partial<Seen>
    return typeof d.at === 'number' && d.states && typeof d.states === 'object' ? { at: d.at, states: d.states } : null
  } catch { return null }
}

export function writeSeen(id: string, seen: Seen): void {
  try { localStorage.setItem(seenKey(id), JSON.stringify(seen)) } catch { /* a device that cannot keep it compares nothing */ }
}

export function clearSeen(id: string): void {
  try { localStorage.removeItem(seenKey(id)) } catch { /* storage unavailable */ }
}
