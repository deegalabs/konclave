// The treasury charts follow STYLE.md "Charts (treasury)". These pin the parts of that rule a
// change could quietly break: the scale holds zero, the projection is dashed and labelled, below
// zero is warn (never danger or success) and decided once (by projection()), and every figure is
// there as text with its source, reachable without a mouse.
import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import { fundsGeometry } from './chart-geometry'
import { FundsLine, SpendBars } from './charts'
import { I18nProvider } from './i18n'
import { codeOf } from './source-scan'

const ZEC = 100_000_000
const html = (el: React.ReactElement) => renderToStaticMarkup(<I18nProvider>{el}</I18nProvider>)

describe('fundsGeometry', () => {
  it('always puts zero inside the drawing, so a slow decline does not look like a cliff', () => {
    const g = fundsGeometry([10 * ZEC, 9.9 * ZEC, 9.8 * ZEC], 300, 120, 8)
    expect(g.zeroY).toBe(112) // the bottom edge of the drawing, not off it
    // 10 -> 9.8 ZEC is a 2% fall, drawn as about 2% of the height, not the whole of it
    expect(g.xy[2]!.y - g.xy[0]!.y).toBeCloseTo(0.02 * 104, 5)
  })

  it('places a point below zero below the zero line', () => {
    const g = fundsGeometry([2 * ZEC, 1 * ZEC, -1 * ZEC], 300, 120, 8)
    expect(g.xy[2]!.y).toBeGreaterThan(g.zeroY)
    expect(g.xy[0]!.y).toBeLessThan(g.zeroY)
  })

  it('keeps zero at the top when every value is below it', () => {
    expect(fundsGeometry([-5 * ZEC, -10 * ZEC], 300, 120, 8).zeroY).toBe(8)
  })

  it('keeps zero at the bottom when every value is zero', () => {
    expect(fundsGeometry([0, 0, 0], 216, 100, 8).zeroY).toBe(92)
  })

  it('spreads points evenly between the paddings and survives a flat zero line', () => {
    const g = fundsGeometry([0, 0, 0], 216, 100, 8)
    expect(g.xy.map((p) => p.x)).toEqual([8, 108, 208])
    expect(g.xy.every((p) => Number.isFinite(p.y))).toBe(true)
  })

  it('refuses a value that is not a finite number, rather than drawing NaN', () => {
    expect(() => fundsGeometry([ZEC, Number.NaN], 300, 120)).toThrow(RangeError)
    expect(() => fundsGeometry([ZEC, Number.POSITIVE_INFINITY], 300, 120)).toThrow(RangeError)
  })

  it('no longer decides on its own whether the line runs out: projection() does', () => {
    expect(Object.keys(fundsGeometry([ZEC, 0], 200, 100)).sort()).toEqual(['xy', 'zeroY'])
  })
})

const base = {
  nowLabel: 'Now',
  projectedLabel: 'Projected',
  title: 'Free funds, now and projected',
  source: "From the vault's book. Month by proposal date. Network fee not included. Incoming money not shown.",
  tooShort: 'Not enough history to draw a line.',
  runsOut: null,
}
const runsOutWords = 'Runs out in January at this pace.'

describe('FundsLine', () => {
  it('says why there is no line, instead of drawing nothing, without a projected point', () => {
    const out = html(<FundsLine {...base} now={{ label: 'nov', zat: ZEC }} ahead={[]} />)
    expect(out).toBe(`<p class="hint">${base.tooShort}</p>`)
  })

  it('draws nothing from an amount that is not a whole number of zatoshi', () => {
    for (const bad of [Number.NaN, Number.POSITIVE_INFINITY, 1.5, Number.MAX_SAFE_INTEGER + 2]) {
      expect(html(<FundsLine {...base} now={{ label: 'nov', zat: ZEC }} ahead={[{ label: 'dez', zat: bad }]} />)).toBe('')
    }
  })

  it('draws nothing without a source to show under it', () => {
    expect(html(<FundsLine {...base} source="  " now={{ label: 'nov', zat: ZEC }} ahead={[{ label: 'dez', zat: ZEC }]} />)).toBe('')
  })

  it('marks the book solid and the projection dashed, labels both, and carries the source', () => {
    const out = html(
      <FundsLine {...base} now={{ label: 'nov', zat: 3 * ZEC }} ahead={[{ label: 'dez', zat: 2 * ZEC }, { label: 'jan', zat: ZEC }]} />,
    )
    expect((out.match(/class="funds-pt rec"/g) ?? []).length).toBe(1)
    expect((out.match(/class="funds-proj"/g) ?? []).length).toBe(1)
    expect(out).not.toContain('funds-proj below')
    expect(out).toContain('>Now 3.0000 ZEC<')
    expect(out).toContain('>Projected 1.0000 ZEC<')
    expect(out).toContain(`<figcaption class="chart-src">${base.source.replace("'", '&#x27;')}</figcaption>`)
  })

  it('keeps the drawing out of the tab order and away from a screen reader, which reads the table', () => {
    const out = html(<FundsLine {...base} now={{ label: 'nov', zat: 3 * ZEC }} ahead={[{ label: 'dez', zat: 2 * ZEC }]} />)
    expect(out).toContain('<div class="funds-plot" style="height:120px" aria-hidden="true">')
    expect(out).not.toMatch(/tabindex/i)
  })

  it('gives every figure as text, exact to the zatoshi, in a table', () => {
    const out = html(<FundsLine {...base} now={{ label: 'nov', zat: 123_456_789 }} ahead={[{ label: 'dez', zat: -1 }]} />)
    expect(out).toContain('<th scope="row">Now (nov)</th><td>1.23456789 ZEC</td>')
    expect(out).toContain('<th scope="row">Projected (dez)</th><td>-0.00000001 ZEC</td>')
  })

  it('trims the figures as the rest of the screen does, and keeps every zatoshi', () => {
    const out = html(<FundsLine {...base} now={{ label: 'nov', zat: 3 * ZEC }} ahead={[{ label: 'dez', zat: 2 * ZEC }]} />)
    expect(out).toContain('<td>3.0000 ZEC</td>')
    expect(out).not.toContain('3.00000000')
  })

  it('shows the amount where the line starts and where it ends, in a row that can wrap', () => {
    const out = html(
      <FundsLine {...base} now={{ label: 'nov', zat: 3 * ZEC }} ahead={[{ label: 'dez', zat: 2 * ZEC }, { label: 'jan', zat: ZEC / 2 }]} />,
    )
    expect(out).toContain('<div class="funds-tags mono" aria-hidden="true"><span>Now 3.0000 ZEC</span><span>Projected 0.5000 ZEC</span></div>')
  })

  it('centres each month under its point', () => {
    const out = html(<FundsLine {...base} now={{ label: 'nov', zat: ZEC }} ahead={[{ label: 'dez', zat: ZEC }, { label: 'jan', zat: ZEC }]} />)
    expect(out).toContain('<span style="left:0.80%">nov</span><span style="left:50.00%">dez</span><span style="left:99.20%">jan</span>')
  })

  it('labels the zero line, the only scale the chart has', () => {
    const out = html(<FundsLine {...base} now={{ label: 'nov', zat: ZEC }} ahead={[{ label: 'dez', zat: -ZEC }]} />)
    expect(out).toMatch(/<span class="funds-zero-lab mono" style="top:[\d.]+%">0<\/span>/)
  })

  it('names the figure by its title, and keeps the source as its caption', () => {
    const out = html(<FundsLine {...base} now={{ label: 'nov', zat: ZEC }} ahead={[{ label: 'dez', zat: ZEC }]} />)
    const id = out.match(/<figure class="chart" aria-labelledby="([^"]+)">/)?.[1]
    expect(id).toBeTruthy()
    expect(out).toContain(`<caption id="${id}">${base.title}</caption>`)
  })

  it('offers the figures to a keyboard or a phone with a button that shows the table', () => {
    const out = html(<FundsLine {...base} now={{ label: 'nov', zat: ZEC }} ahead={[{ label: 'dez', zat: ZEC }]} />)
    const ctl = out.match(/<button type="button" class="btn ghost sm-btn chart-figs-btn" aria-expanded="false" aria-controls="([^"]+)">Show figures<\/button>/)?.[1]
    expect(ctl).toBeTruthy()
    // hidden in a block, so the table cannot widen the page on a phone
    expect(out).toContain(`<div id="${ctl}" class="visually-hidden"><table>`)
  })

  it('paints warn from the month projection() names, not from where the line happens to sit', () => {
    // An empty vault that spends nothing: projection() says it never runs out, so nothing is warn,
    // even though every point sits on zero.
    const flat = html(<FundsLine {...base} now={{ label: 'nov', zat: 0 }} ahead={[{ label: 'dez', zat: 0 }, { label: 'jan', zat: 0 }]} />)
    expect(flat).not.toContain('below')
    expect(flat).not.toContain('chart-warn')
    // runsOut.index counts in `ahead`: index 1 is the second projected month, and it and every one
    // after are warn; the recorded point and the first projected month are not.
    const out = html(
      <FundsLine
        {...base}
        runsOut={{ index: 1, words: runsOutWords }}
        now={{ label: 'nov', zat: 2 * ZEC }}
        ahead={[{ label: 'dez', zat: ZEC }, { label: 'jan', zat: 0 }, { label: 'fev', zat: -ZEC }]}
      />,
    )
    expect(out.match(/class="funds-pt[^"]*"/g)).toEqual([
      'class="funds-pt rec"', 'class="funds-pt"', 'class="funds-pt below"', 'class="funds-pt below"',
    ])
    expect(out).toContain('funds-proj below')
    expect(out).toContain(`<p class="chart-warn">${runsOutWords}</p>`)
  })

  it('draws nothing from a runs-out month that is not on the line', () => {
    const out = html(<FundsLine {...base} runsOut={{ index: 3, words: runsOutWords }} now={{ label: 'nov', zat: ZEC }} ahead={[{ label: 'dez', zat: 0 }]} />)
    expect(out).toBe('')
  })
})

describe('SpendBars', () => {
  const data = [{ label: 'set', zec: 1 }, { label: 'out', zec: 2 }]

  it('shows a source line only when the screen gives one, so the Dashboard reads as before', () => {
    expect(html(<SpendBars data={data} />)).not.toContain('chart-src')
    expect(html(<SpendBars data={data} source="From the vault's book." />)).toContain('class="chart-src"')
  })

  it('keeps the bar strip from a screen reader, which reads the amounts from the table', () => {
    expect(html(<SpendBars data={data} />)).toContain('<div class="spend-bars" style="min-height:52px" aria-hidden="true">')
  })

  it('offers the amounts to a keyboard or a phone with a button that shows the table', () => {
    const out = html(<SpendBars data={data} />)
    const ctl = out.match(/<button type="button" class="btn ghost sm-btn chart-figs-btn" aria-expanded="false" aria-controls="([^"]+)">Show figures<\/button>/)?.[1]
    expect(ctl).toBeTruthy()
    expect(out).toContain(`<div id="${ctl}" class="visually-hidden"><table>`)
  })
})

describe('the chart rule in the styles', () => {
  const css = readFileSync(new URL('./App.css', import.meta.url), 'utf8')
  const rules = (sel: RegExp) => (css.match(new RegExp(`${sel.source}[^{]*\\{[^}]*\\}`, 'g')) ?? []).join('\n')
  const chartCss = rules(/\.(funds|chart|spend)[\w-]*/)

  it('sizes the month axis with its text, so at 200% the labels do not spill onto the tags', () => {
    expect(rules(/\.funds-axis(?![\w-])/)).toMatch(/height:1\.4em/)
    expect(rules(/\.funds-axis(?![\w-])/)).not.toMatch(/height:\d+px/)
  })

  it('draws the zero line at 3:1 against the background (the strong line), not the soft one', () => {
    expect(rules(/\.funds-zero(?!-)/)).toContain('stroke:var(--line-strong)')
  })

  it('paints below zero in warn, both the line and its points', () => {
    expect(rules(/\.funds-proj\.below/)).toContain('stroke:var(--warn)')
    expect(rules(/\.funds-pt\.below/)).toContain('border-color:var(--warn)')
  })

  it('never puts success or danger in a chart, and keeps them still', () => {
    expect(chartCss).not.toBe('')
    expect(chartCss).not.toMatch(/--success|--danger/)
    expect(chartCss).not.toMatch(/animation|transition|gradient|drop-shadow|box-shadow:\s*0 \d+px \d+px/)
  })

  it('dashes the projection and gives the accent to the hovered point alone', () => {
    expect(rules(/\.funds-proj/)).toContain('stroke-dasharray')
    const accent = css.split('\n').filter((l) => /\.(funds|chart|spend)/.test(l) && l.includes('--accent'))
    expect(accent).toEqual(['.funds-pt:hover{background:var(--accent); border-color:var(--accent)}'])
  })

  it('fits a 320px screen: the tags wrap, the bars shrink, the panels take the width they have', () => {
    expect(rules(/\.funds-tags(?![\w-])/)).toContain('flex-wrap:wrap')
    expect(rules(/\.spend-col/)).toMatch(/flex:1 1 0;[^}]*min-width:0;[^}]*max-width:52px/)
    expect(rules(/\.dash-charts(?![\w-])/)).toContain('minmax(min(300px,100%),1fr)')
  })

  it('takes no colour literal in the chart component', () => {
    expect(codeOf('charts.tsx')).not.toMatch(/#[0-9a-fA-F]{3,8}\b|rgba?\(/)
  })
})
