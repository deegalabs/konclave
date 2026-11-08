// The treasury charts follow STYLE.md "Charts (treasury)". These pin the parts of that rule a
// change could quietly break: the scale holds zero, the projection is dashed and labelled, below
// zero is warn (never danger or success), and every figure is there as text with its source.
import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import { fundsGeometry } from './chart-geometry'
import { FundsLine, SpendBars } from './charts'
import { codeOf } from './source-scan'

const ZEC = 100_000_000

describe('fundsGeometry', () => {
  it('always puts zero inside the drawing, so a slow decline does not look like a cliff', () => {
    const g = fundsGeometry([10 * ZEC, 9.9 * ZEC, 9.8 * ZEC], 300, 120, 8)
    expect(g.zeroY).toBe(112) // the bottom edge of the drawing, not off it
    // 10 -> 9.8 ZEC is a 2% fall, drawn as about 2% of the height, not the whole of it
    expect(g.xy[2]!.y - g.xy[0]!.y).toBeCloseTo(0.02 * 104, 5)
    expect(g.crosses).toBe(false)
  })

  it('places a point below zero below the zero line and reports the crossing', () => {
    const g = fundsGeometry([2 * ZEC, 1 * ZEC, -1 * ZEC], 300, 120, 8)
    expect(g.xy[2]!.y).toBeGreaterThan(g.zeroY)
    expect(g.xy[0]!.y).toBeLessThan(g.zeroY)
    expect(g.crosses).toBe(true)
  })

  it('treats exactly zero as run out', () => {
    expect(fundsGeometry([ZEC, 0], 200, 100).crosses).toBe(true)
  })

  it('spreads points evenly between the paddings and survives a flat zero line', () => {
    const g = fundsGeometry([0, 0, 0], 216, 100, 8)
    expect(g.xy.map((p) => p.x)).toEqual([8, 108, 208])
    expect(g.xy.every((p) => Number.isFinite(p.y))).toBe(true)
  })
})

const base = {
  nowLabel: 'Now',
  projectedLabel: 'Projected',
  title: 'Free funds, now and projected',
  source: "From the vault's book. Month by proposal date. Network fee not included. Incoming money not shown.",
}

describe('FundsLine', () => {
  it('draws nothing without a projected point', () => {
    expect(renderToStaticMarkup(<FundsLine {...base} now={{ label: 'nov', zat: ZEC }} ahead={[]} />)).toBe('')
  })

  it('marks the book solid and the projection dashed, labels both, and carries the source', () => {
    const html = renderToStaticMarkup(
      <FundsLine {...base} now={{ label: 'nov', zat: 3 * ZEC }} ahead={[{ label: 'dez', zat: 2 * ZEC }, { label: 'jan', zat: ZEC }]} />,
    )
    expect((html.match(/class="funds-pt rec"/g) ?? []).length).toBe(1)
    expect((html.match(/class="funds-proj"/g) ?? []).length).toBe(1)
    expect(html).not.toContain('funds-proj below')
    expect(html).toContain('>Now 3.0000 ZEC<')
    expect(html).toContain('>Projected 1.0000 ZEC<')
    expect(html).toContain(`<figcaption class="chart-src">${base.source.replace("'", '&#x27;')}</figcaption>`)
  })

  it('puts nothing in the tab order inside the image: a screen reader reads the figures from the table', () => {
    const html = renderToStaticMarkup(
      <FundsLine {...base} now={{ label: 'nov', zat: 3 * ZEC }} ahead={[{ label: 'dez', zat: 2 * ZEC }]} />,
    )
    expect(html).toContain('role="img"')
    expect(html).not.toMatch(/tabindex/i)
  })

  it('gives every figure as text, exact to the zatoshi, in a table', () => {
    const html = renderToStaticMarkup(
      <FundsLine {...base} now={{ label: 'nov', zat: 123_456_789 }} ahead={[{ label: 'dez', zat: -1 }]} />,
    )
    expect(html).toContain('<th scope="row">Now (nov)</th><td>1.23456789 ZEC</td>')
    expect(html).toContain('<th scope="row">Projected (dez)</th><td>-0.00000001 ZEC</td>')
  })

  it('trims the figures as the rest of the screen does, and keeps every zatoshi', () => {
    const html = renderToStaticMarkup(<FundsLine {...base} now={{ label: 'nov', zat: 3 * ZEC }} ahead={[{ label: 'dez', zat: 2 * ZEC }]} />)
    expect(html).toContain('<td>3.0000 ZEC</td>')
    expect(html).not.toContain('3.00000000')
  })

  it('shows the amount where the line starts and where it ends, not only in a tooltip', () => {
    const html = renderToStaticMarkup(
      <FundsLine {...base} now={{ label: 'nov', zat: 3 * ZEC }} ahead={[{ label: 'dez', zat: 2 * ZEC }, { label: 'jan', zat: ZEC / 2 }]} />,
    )
    expect(html).toMatch(/<div class="funds-tags mono" aria-hidden="true"><span[^>]*>Now 3\.0000 ZEC<\/span><span[^>]*>Projected 0\.5000 ZEC<\/span>/)
  })

  it('labels the zero line, the only scale the chart has', () => {
    const html = renderToStaticMarkup(<FundsLine {...base} now={{ label: 'nov', zat: ZEC }} ahead={[{ label: 'dez', zat: -ZEC }]} />)
    expect(html).toMatch(/<span class="funds-zero-lab mono" aria-hidden="true" style="top:[\d.]+%">0<\/span>/)
  })

  it('names the figure by its title, and keeps the source as its caption', () => {
    const html = renderToStaticMarkup(<FundsLine {...base} now={{ label: 'nov', zat: ZEC }} ahead={[{ label: 'dez', zat: ZEC }]} />)
    const id = html.match(/<figure class="chart" aria-labelledby="([^"]+)">/)?.[1]
    expect(id).toBeTruthy()
    expect(html).toContain(`<caption id="${id}">${base.title}</caption>`)
  })

  it('hides the table in a block, so it cannot widen the page on a phone', () => {
    const html = renderToStaticMarkup(<FundsLine {...base} now={{ label: 'nov', zat: ZEC }} ahead={[{ label: 'dez', zat: ZEC }]} />)
    expect(html).toContain('<div class="visually-hidden"><table>')
    expect(html).not.toContain('<table class="visually-hidden">')
    const bars = renderToStaticMarkup(<SpendBars data={[{ label: 'set', zec: 1 }, { label: 'out', zec: 2 }]} />)
    expect(bars).toContain('<div class="visually-hidden"><table>')
    expect(bars).not.toContain('<table class="visually-hidden">')
  })

  it('names running out in words only when the line actually reaches zero', () => {
    const runsOut = 'Runs out in January at this pace.'
    const crosses = renderToStaticMarkup(
      <FundsLine {...base} runsOut={runsOut} now={{ label: 'nov', zat: ZEC }} ahead={[{ label: 'dez', zat: 0 }]} />,
    )
    expect(crosses).toContain(`<p class="chart-warn">${runsOut}</p>`)
    expect(crosses).toContain('funds-proj below')
    const holds = renderToStaticMarkup(
      <FundsLine {...base} runsOut={runsOut} now={{ label: 'nov', zat: 2 * ZEC }} ahead={[{ label: 'dez', zat: ZEC }]} />,
    )
    expect(holds).not.toContain('chart-warn')
  })
})

describe('SpendBars', () => {
  it('shows a source line only when the screen gives one, so the Dashboard reads as before', () => {
    const data = [{ label: 'set', zec: 1 }, { label: 'out', zec: 2 }]
    expect(renderToStaticMarkup(<SpendBars data={data} />)).not.toContain('chart-src')
    expect(renderToStaticMarkup(<SpendBars data={data} source="From the vault's book." />)).toContain('class="chart-src"')
  })
})

describe('the chart rule in the styles', () => {
  const css = readFileSync(new URL('./App.css', import.meta.url), 'utf8')
  const rules = (sel: RegExp) => (css.match(new RegExp(`${sel.source}[^{]*\\{[^}]*\\}`, 'g')) ?? []).join('\n')
  const chartCss = rules(/\.(funds|chart|spend)[\w-]*/)

  it('draws the zero line at 3:1 against the background (the strong line), not the soft one', () => {
    expect(rules(/\.funds-zero(?!-)/)).toContain('stroke:var(--line-strong)')
  })

  it('never puts success or danger in a chart, and keeps them still', () => {
    expect(chartCss).not.toBe('')
    expect(chartCss).not.toMatch(/--success|--danger/)
    expect(chartCss).not.toMatch(/animation|transition|gradient|box-shadow:\s*0 \d+px \d+px/)
  })

  it('dashes the projection and gives the accent to the hovered point alone', () => {
    expect(rules(/\.funds-proj/)).toContain('stroke-dasharray')
    const accent = css.split('\n').filter((l) => /\.(funds|chart|spend)/.test(l) && l.includes('--accent'))
    expect(accent).toEqual(['.funds-pt:hover{background:var(--accent); border-color:var(--accent)}'])
  })

  it('takes no colour literal in the chart component', () => {
    expect(codeOf('charts.tsx')).not.toMatch(/#[0-9a-fA-F]{3,8}\b|rgba?\(/)
  })
})
