import { Children, Fragment, createElement, isValidElement, type ReactNode } from 'react'

// A hidden amount is not drawn under a bar, it is not in the page at all (#838). A bar over drawn
// text hides a value from the eye only: a screen reader reads it, copy takes it, anything that reads
// the page's text gets it. `veil` is the one place that turns what a screen would show into what it
// shows while hidden, so no call site can leave a figure behind.

/** The width of a veiled text, in `ch` (the width of a `0` in the font it sits in).
 *  APPROXIMATE, on purpose: a digit is 1ch where figures are tabular, `. , '` and a space are about
 *  half that, and any other character (a letter of `ZEC`, a sign, a currency symbol) is taken as a
 *  whole one. It keeps the bar near the width of the figure it stands for so the line does not
 *  jump when it is revealed; it cannot be exact in a proportional font, and the bar's own overhang
 *  absorbs the difference. Only the LENGTH of the text is used, never a character of it. */
export function veilWidthCh(s: string): number {
  let w = 0
  for (const ch of s) w += /[0-9]/.test(ch) ? 1 : /[.,'   ]/.test(ch) ? 0.5 : 1
  return w
}

const ph = (text: string, key?: string | number) =>
  text === '' ? null : <span key={key} className="secret-ph" style={{ width: `${veilWidthCh(text)}ch` }} />

/** What `children` shows with the text taken out. Each text leaf becomes an empty placeholder of
 *  about its width. A plain element is rebuilt keeping its `className` and nothing else (a `title`,
 *  an `aria-label`, a `data-*`, a `value` or `dangerouslySetInnerHTML` could each carry the value),
 *  and anything this does not recognise (a component, an iterable) becomes a fixed placeholder
 *  rather than being rendered as it came. */
export function veil(node: ReactNode): ReactNode {
  return Children.toArray(node).map((n, i) => {
    if (typeof n === 'string' || typeof n === 'number' || typeof n === 'bigint') return ph(String(n), i)
    if (isValidElement<{ className?: string; children?: ReactNode }>(n)) {
      if (n.type === Fragment) return <Fragment key={n.key ?? i}>{veil(n.props.children)}</Fragment>
      if (typeof n.type === 'string') return createElement(n.type, { key: n.key ?? i, className: n.props.className }, veil(n.props.children))
    }
    return ph('0000', i)
  })
}
