/** Deterministic geometric identicon (symmetric grid) — steel-blue palette, so a
 *  member/person reads as a face instead of a hex key. Shared across screens. */
export function Identicon({ seed, size = 26 }: { seed: string; size?: number }) {
  let h = 2166136261
  for (let i = 0; i < seed.length; i++) { h ^= seed.charCodeAt(i); h = Math.imul(h, 16777619) }
  h = h >>> 0
  const hue = 198 + (h % 52) // blues / steels
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
    <svg className="idc" width={size} height={size} viewBox={`0 0 ${size} ${size}`}>
      <rect width={size} height={size} rx={size * 0.28} fill={bg} />
      {cells.map(([x, y], i) => <rect key={i} x={x * c} y={y * c} width={c} height={c} fill={fg} />)}
    </svg>
  )
}
