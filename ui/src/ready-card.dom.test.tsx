// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest'
import { cleanup, render } from '@testing-library/react'
import { I18nProvider } from './i18n'
import { en } from './i18n/en'
import { ReadyCard } from './ready-card'
import { payReadiness } from './pay-readiness'
import { codeOf } from './source-scan'

// #693: the card said "Cannot pay right now: 0 of 2 seats present" with both members there and no
// payment open, because its count was the signing room's, which exists only while a panel is open
// (and, after one was opened and closed, kept its last value).
const base = { threshold: 2, total: 3, hasBal: true, backendsUp: true, freeZat: 5_000_000 as number | null }
const show = (p: Partial<typeof base> = {}) =>
  render(<I18nProvider><ReadyCard {...base} {...p} /></I18nProvider>).container

describe('the Dashboard readiness card (#693)', () => {
  afterEach(() => cleanup())

  it('free funds and a live coordinator: ready, with no presence count and the quorum as a fact', () => {
    const c = show()
    expect(c.textContent).not.toMatch(/\d+ of \d+ seats present/)
    expect(c.textContent).toContain(en['dashboard.readyYes'])
    expect(c.textContent).toContain('a payment needs 2 of 3 members to sign')
    const row = [...c.querySelectorAll('.chk')].find((e) => e.textContent?.includes('needs 2 of 3'))!
    expect(row.className).toBe('chk') // neutral: neither y nor n
    expect(row.textContent).not.toMatch(/[✓!]/)
  })

  it('nothing free: cannot pay, and the reason is the funds row', () => {
    const c = show({ freeZat: 0 })
    expect(c.textContent).toContain(en['dashboard.readyNo'])
    expect(c.textContent).toContain(en['dashboard.readyNoFree'])
  })

  it('balance not read yet: cannot pay, the funds row says it does not know', () => {
    const c = show({ freeZat: null, hasBal: false })
    expect(c.textContent).toContain(en['dashboard.readyNo'])
    expect(c.textContent).toContain(en['dashboard.readyFreeUnknown'])
  })

  it('coordinator not answering: cannot pay, the backends row says so', () => {
    const c = show({ backendsUp: false })
    expect(c.textContent).toContain(en['dashboard.readyNo'])
    expect(c.textContent).toContain(en['dashboard.readyBackendsDown'])
  })

  it('writes no quorum line before the vault is read (never "0 of 3")', () => {
    expect(show({ threshold: 0 }).textContent).not.toContain('needs')
  })

  it('the rule has no presence input', () => {
    expect(payReadiness({ hasFree: true, backendsUp: true }).canPay).toBe(true)
    expect(Object.keys(payReadiness({ hasFree: true, backendsUp: true }))).toEqual(['canPay'])
  })

  it('the Dashboard keeps no copy of the rule and reads no seat count', () => {
    const src = codeOf('./screens/Dashboard.tsx')
    expect(src).not.toMatch(/quorumReachable|canPay|seatCount|seatsHere|dashboard\.readySeats/)
    expect(src).toMatch(/<ReadyCard /)
  })
})
