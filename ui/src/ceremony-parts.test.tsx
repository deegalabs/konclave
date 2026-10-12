// The code-check screen is where the members' check happens; these pin what it lets through.
import { describe, expect, it } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import { CodeCheck, confirmReady } from './screens/CeremonyParts'
import { codeOf } from './source-scan'

const pe = (_pt: string, en: string) => en

describe('the code check', () => {
  it('confirms only once every other listed person is checked', () => {
    expect(confirmReady([false, false, false], 1)).toBe(false)
    expect(confirmReady([false, true, false], 1)).toBe(false)
    expect(confirmReady([false, true, true], 1)).toBe(true) // this device's own row needs no tick
  })

  it('starts with confirm disabled, no checkbox for this device, and a warning for an unnamed seat', () => {
    const html = renderToStaticMarkup(
      <CodeCheck code="ABC-DEF-GHJ" names={['Ana', '', 'Caio']} mySeat={1} onConfirm={() => {}} onMismatch={() => {}} pe={pe} />,
    )
    expect(html).toMatch(/<button[^>]*disabled=""[^>]*>Everyone read the same code/)
    expect((html.match(/type="checkbox"/g) ?? []).length).toBe(2)
    expect(html).toContain('Person 2 gave no name')
    expect(html).toContain('3 people are in this vault')
    expect(html).toContain('Ask them to read their code to you first')
  })

  it('flags two members with the same name', () => {
    const html = renderToStaticMarkup(
      <CodeCheck code="ABC-DEF-GHJ" names={['Ana', 'Bia', 'bia ']} mySeat={1} onConfirm={() => {}} onMismatch={() => {}} pe={pe} />,
    )
    expect((html.match(/Two members are called/g) ?? []).length).toBe(2)
    // The warning describes the box; the label still says what ticking means.
    expect(html).toContain('aria-describedby="cv-check-2-twice"')
    expect(html).toContain('bia  (person 3) read me the same code')
  })
})

describe('the invite card', () => {
  it('shares, copies and draws the QR of one link, made by inviteLink', () => {
    const c = codeOf('./screens/CeremonyParts.tsx')
    expect((c.match(/inviteLink\(/g) ?? []).length).toBe(1)
    expect(c).toMatch(/const link = inviteLink\(code\)/)
    expect(c).toMatch(/navigator\.share\(\{ url: link \}\)/)
    expect(c).toMatch(/copyText\(what === 'code' \? code : link\)/)
    expect(c).toMatch(/encodeQR\(link, 'svg'\)/)
  })
})

