// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest'
import { cleanup, render } from '@testing-library/react'
import { I18nProvider } from './i18n'
import { en } from './i18n/en'
import { ReadyCard } from './ready-card'

// #693: the card said "Cannot pay right now: 0 of 2 seats present" with both members there and no
// payment open, because its count was the signing room's, which exists only while a panel is open.
const show = (p: Parameters<typeof ReadyCard>[0]) =>
  render(<I18nProvider><ReadyCard {...p} /></I18nProvider>).container

describe('the Dashboard readiness card (#693)', () => {
  afterEach(() => cleanup())
  const ok = { threshold: 2, total: 3, hasBal: true, backendsUp: true }

  it('free funds and a live coordinator: ready, and it claims no presence count', () => {
    const c = show({ ...ok, seatsHere: 0, freeZat: 5_000_000 } as never)
    expect(c.textContent).not.toMatch(/\d+ of \d+ seats present/)
    expect(c.textContent).toContain(en['dashboard.readyYes'])
  })
})
