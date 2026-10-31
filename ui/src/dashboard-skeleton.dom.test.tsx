// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest'
import { cleanup, render, screen } from '@testing-library/react'
import { I18nProvider } from './i18n'
import { en } from './i18n/en'
import { DashboardSkeleton } from './dashboard-skeleton'
import { codeOf } from './source-scan'

// #320: the Dashboard's first load was one spinner in an empty page, and the layout jumped when the
// real page replaced it. It now loads in the page's own shape, and says "Loading" once.
describe('the Dashboard before its first read', () => {
  afterEach(() => cleanup())

  it('says "Loading" once, and nothing else is heard', () => {
    const { container } = render(<I18nProvider><DashboardSkeleton /></I18nProvider>)
    const said = screen.getAllByRole('status')
    expect(said).toHaveLength(1)
    expect(said[0]!.textContent).toBe(en['skeleton.loading'])
    for (const el of container.querySelectorAll('.skel, .skel-rows, .skel-stat, .skel-detail, .page-header')) {
      expect(el.closest('[aria-hidden="true"]'), el.className).not.toBeNull()
    }
  })

  it('is laid out as the page it stands for: header, desk, movements, balance', () => {
    const { container } = render(<I18nProvider><DashboardSkeleton /></I18nProvider>)
    for (const sel of ['.page-header', '.dash-cols .dash-main .needyou', '.dash-main .ledger .skel-rows', '.dash-aside .entry .skel-stat']) {
      expect(container.querySelector(sel), sel).not.toBeNull()
    }
  })

  it('is what the screen shows until the first read lands, and a page-wide load is said once', () => {
    const src = codeOf('screens/Dashboard.tsx')
    expect(src).toMatch(/if \(!firstLoaded\) \{\s*return <DashboardSkeleton \/>/)
    // the desk and the balance stay quiet while the movements say it
    expect(src).toMatch(/<section className="needyou calm"><SkeletonDetail rows=\{2\} status=\{false\} \/><\/section>/)
    expect(src).toMatch(/<SkeletonStat status=\{!loading\} \/>/)
  })
})
