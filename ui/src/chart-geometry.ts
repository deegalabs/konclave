// The geometry of the treasury charts (charts.tsx), kept apart from the components so it is pure,
// tested without a browser, and the component file exports only components.
//
// It places points and nothing else. Whether a projection runs out is decided once, by
// `projection()` in treasury-metrics.ts, and the chart paints warn from what that says.

export interface FundsGeometry {
  /** x and y of each point in the drawing's own units, in order. */
  xy: { x: number; y: number }[]
  /** y of the zero line; inside the drawing even when every value is above zero. */
  zeroY: number
}

/**
 * Where each point of a free-funds line sits. The scale always includes zero, so a line that falls
 * toward zero is drawn falling toward the zero line, not toward the bottom of whatever range the
 * values happen to span, which would make a slow decline look like a cliff. A value that is not a
 * finite number is refused, rather than drawn as NaN.
 */
export function fundsGeometry(values: readonly number[], width: number, height: number, pad = 8): FundsGeometry {
  if (!values.every(Number.isFinite)) throw new RangeError('fundsGeometry: every value must be a finite number')
  const lo = Math.min(0, ...values)
  const top = Math.max(0, ...values)
  // Every value zero: without a span the zero line would sit at the top; one unit keeps it at the bottom.
  const hi = top === lo ? lo + 1 : top
  const span = hi - lo
  const n = values.length
  const step = n > 1 ? (width - 2 * pad) / (n - 1) : 0
  const y = (v: number) => pad + ((hi - v) / span) * (height - 2 * pad)
  return {
    xy: values.map((v, i) => ({ x: pad + i * step, y: y(v) })),
    zeroY: y(0),
  }
}
