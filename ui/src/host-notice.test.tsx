// PHISH-DOMAIN: an invite always sends the joiner to the real app, and the create/join dialog says
// which host the member is on, in words (not by colour alone) and in the warning style off-site.
import { afterEach, describe, expect, it, vi } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import { inviteLink } from './net'
import { HostNotice } from './HostNotice'
import { I18nProvider } from './i18n'
import { en } from './i18n/en'
import { ptBR } from './i18n/pt-BR'
import { codeOf } from './source-scan'

const CODE = '0123456789ABCDEFGHJKMNPQRS'
const render = (host: string) => renderToStaticMarkup(<I18nProvider><HostNotice host={host} /></I18nProvider>)

afterEach(() => vi.unstubAllGlobals())

describe('the invite link', () => {
  it('points at the official app even when made on a lookalike or preview host', () => {
    vi.stubGlobal('location', {
      protocol: 'https:', hostname: 'konclave-demo.vercel.app', host: 'konclave-demo.vercel.app',
      origin: 'https://konclave-demo.vercel.app', pathname: '/',
    })
    expect(inviteLink(CODE).startsWith('https://www.konclave.xyz/')).toBe(true)
    expect(inviteLink(CODE)).toBe(`https://www.konclave.xyz/#/vaults?join=${CODE}`)
  })

  it('still takes an explicit base (tests)', () => {
    expect(inviteLink(CODE, 'https://example.test/')).toBe(`https://example.test/#/vaults?join=${CODE}`)
  })
})

describe('the host line', () => {
  it('renders the host it is given', () => {
    const html = render('konclave.app')
    expect(html).toContain('konclave.app')
    expect(html).toContain('Konclave only lives at www.konclave.xyz')
  })

  it('uses the warning style on a host that is not official, and says so in words', () => {
    const html = render('konclave.app')
    expect(html).toContain('host-notice warn')
    expect(html).toContain('Check the address')
  })

  it.each(['www.konclave.xyz', 'localhost:5173', 'localhost', '127.0.0.1:4173'])('does not warn on %s', (h) => {
    const html = render(h)
    expect(html).not.toContain('warn')
    expect(html).toContain(h)
  })

  it('is what the create/join dialog (NetVault Shell) renders, from location.host', () => {
    const src = codeOf('screens/NetVault.tsx')
    expect((src.match(/<HostNotice/g) ?? []).length).toBeGreaterThanOrEqual(1)
    expect(codeOf('HostNotice.tsx')).toContain('location.host')
  })
})

describe('copy', () => {
  it.each(['host.notice', 'host.notice.warn'])('both locales have %s', (k) => {
    expect(en[k]).toBeTruthy()
    expect(ptBR[k]).toBeTruthy()
  })
})
