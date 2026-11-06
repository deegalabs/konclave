// #784: whether a listed vault still carries the viewing key in the clear on this device. The flag
// is derived in storage.ts (`listVaults`), presence only; the value never leaves the store.
import type { VaultPublic } from './storage'

export function holdsPlainViewingKey(v: Pick<VaultPublic, 'plainViewingKey'>): boolean {
  return v.plainViewingKey === true
}
