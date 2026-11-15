/** Deterministic geometric identicon (symmetric grid) - steel-blue palette, so a
 *  member/person reads as a face instead of a hex key. Shared across screens. */
export function Identicon({ seed, size = 26 }: { seed: string; size?: number }) {
  let h = 2166136261
  for (let i = 0; i < seed.length; i++) { h ^= seed.charCodeAt(i); h = Math.imul(h, 16777619) }
  h = h >>> 0
  const hue = 200 + (h % 18) // steel-blue only (200-217); never drift into the banned purple
  const bg = `hsl(${hue} 30% 22%)`
  const fg = `hsl(${hue} 46% 62%)`
  const c = size / 5
  const cells: Array<[number, number]> = []
  let bits = h
  for (let x = 0; x < 3; x++) {
    for (let y = 0; y < 5; y++) {
      if ((bits & 1) === 1) { cells.push([x, y]); if (x < 2) cells.push([4 - x, y]) }
      bits = Math.floor(bits / 2)
    }
  }
  return (
    <svg className="idc" width={size} height={size} viewBox={`0 0 ${size} ${size}`}
      style={{ borderRadius: size * 0.28, boxShadow: '0 0 0 2px var(--surface-1)' }}>
      <rect width={size} height={size} rx={size * 0.28} fill={bg} />
      {cells.map(([x, y], i) => <rect key={i} x={x * c} y={y * c} width={c} height={c} fill={fg} />)}
    </svg>
  )
}

// #315: a MEMBER's face. Seeded by the vault and the seat position, never by the name, so a rename
// does not change it and two members with the same name do not share one. This is NOT a key and not
// derived from one: it cannot tell two devices of one seat apart and does not detect an impostor; the
// name-to-seat pairing is the one the coordinator serves. One person in two vaults has two faces.

/** The seed of the member at `seat` (0-based position in the vault's member list). The seat goes in
 *  as ONE character, so the 15 seats of a vault never share a face (the identicon's grid reads the
 *  hash's low bits, and one character changes them one-to-one). */
export function memberSeed(vaultId: string, seat: number): string {
  return vaultId.trim().toLowerCase() + '\u0000' + String.fromCharCode(seat)
}

/** The face for a member nobody can place: not in the list, named twice, or no list read. */
export const NEUTRAL = 'konclave-member-unplaced'

/** The face for a member known only by name: their seat's, when the name is in the vault's member
 *  list (the coordinator's, the one votes are recorded under) exactly once; otherwise NEUTRAL, never
 *  a face seeded by the name. */
export function seedForName(vaultId: string | null | undefined, list: readonly { name: string }[] | null | undefined, name: string): string {
  if (!vaultId || !list) return NEUTRAL
  const n = name.trim()
  const seats = list.flatMap((m, i) => (m.name.trim() === n ? [i] : []))
  return seats.length === 1 ? memberSeed(vaultId, seats[0]!) : NEUTRAL
}
