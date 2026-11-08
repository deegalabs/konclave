// The geometry of the treasury charts (charts.tsx), kept apart from the components so it is pure,
// tested without a browser, and the component file exports only components.

export interface FundsGeometry {
  /** x and y of each point in the drawing's own units, in order. */
  xy: { x: number; y: number }[]
  /** y of the zero line; inside the drawing even when every value is above zero. */
  zeroY: number
  /** True when some point is at or below zero, which the screen must also say in words. */
  crosses: boolean
}

/**
 * Where each point of a free-funds line sits. The scale always includes zero, so a line that falls
 * toward zero is drawn falling toward the zero line, not toward the bottom of whatever range the
 * values happen to span, which would make a slow decline look like a cliff. Pure, so the drawing
 * is tested without a browser.
 */
export function fundsGeometry(values: readonly number[], width: number, height: number, pad = 8): FundsGeometry {
  const hi = Math.max(0, ...values)
  const lo = Math.min(0, ...values)
  const span = hi - lo || 1
  const n = values.length
  const step = n > 1 ? (width - 2 * pad) / (n - 1) : 0
  const y = (v: number) => pad + ((hi - v) / span) * (height - 2 * pad)
  return {
    xy: values.map((v, i) => ({ x: pad + i * step, y: y(v) })),
    zeroY: y(0),
    crosses: values.some((v) => v <= 0),
  }
}
