import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { codeOf } from './source-scan'
import { en } from './i18n/en'
import { ptBR } from './i18n/pt-BR'

// #320, the toast and Receive half: a close button a finger can hit, a dismiss label in the
// member's language, "Copied" announced, and a QR that could not be drawn saying so.
describe('toast and Receive polish (#320)', () => {
  it('the toast close button is at least 24 x 24 (WCAG 2.5.8)', () => {
    const css = readFileSync(new URL('./App.css', import.meta.url), 'utf8')
    const rule = css.slice(css.indexOf('.kc-toast-close{'), css.indexOf('.kc-toast-close:hover'))
    expect(rule).toMatch(/min-width:\s*24px/)
    expect(rule).toMatch(/min-height:\s*24px/)
  })

  it('the dismiss label comes from the dictionary, and Escape lives on the document', () => {
    const src = codeOf('./toast.tsx')
    expect(src).not.toContain('aria-label="Dismiss"')
    expect(src).toContain("aria-label={t('toast.dismiss')}")
    expect(src).toMatch(/document\.addEventListener\('keydown', onKey\)/)
  })

  it('Receive announces "Copied" and says when the QR could not be drawn', () => {
    const src = codeOf('./screens/Receive.tsx')
    expect(src).toMatch(/<span className="visually-hidden" role="status">\{copied \? t\('receive\.copied'\) : ''\}<\/span>/)
    expect(src).toMatch(/qrSvg\s*\?[\s\S]*role="img"[\s\S]*:\s*<div className="rcv-qr rcv-qr-off">[\s\S]*t\('receive\.qrFailed'\)/)
  })

  it('the copy exists in both languages', () => {
    for (const k of ['toast.dismiss', 'receive.qrFailed']) {
      expect(en[k], k).toBeTruthy()
      expect(ptBR[k], k).toBeTruthy()
    }
  })
})
