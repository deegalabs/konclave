// #784: whether a stored vault record still carries the viewing key in the clear (as imports wrote
// it from #447 until #599). Presence only: the value is never read out, shown or logged.
export function holdsPlainViewingKey(record: unknown): boolean {
  return typeof record === 'object' && record !== null && typeof (record as { ufvk?: unknown }).ufvk === 'string'
}
