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
import { SECTIONS } from './docs/content'

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
  it('renders the host it is given, in its own element', () => {
    const html = render('konclave.app')
    expect(html).toContain('<strong class="host-notice-host">konclave.app</strong>')
    expect(html).toContain('Konclave only lives at www.konclave.xyz.')
  })

  it('uses the warning style and an alert on a host that is not official, and says so in words', () => {
    const html = render('konclave.app')
    expect(html).toContain('host-notice warn')
    expect(html).toContain('role="alert"')
    expect(html).toContain('Check the address')
    expect(html).toContain('id="host-notice"')
  })

  it('drops the alert role (not the warning) while an error is on the same screen', () => {
    const html = renderToStaticMarkup(<I18nProvider><HostNotice host="konclave.app" alert={false} /></I18nProvider>)
    expect(html).not.toContain('role="alert"')
    expect(html).toContain('host-notice warn')
  })

  it.each([
    'www.konclave.xyz.evil.com', 'evilwww.konclave.xyz', 'konclave.xyz', 'xn--konclve-8nf.xyz',
    'www.konclave.xyz.', 'tauri.localhost', 'konclave-demo.vercel.app', 'konclave-git-x-team.vercel.app',
  ])('warns on %s (a preview host is not allowed)', (h) => {
    const html = render(h)
    expect(html).toContain('host-notice warn')
    expect(html).toContain('role="alert"')
  })

  it.each(['www.konclave.xyz', 'WWW.KONCLAVE.XYZ', 'www.konclave.xyz:443', 'localhost:5173', 'localhost', '127.0.0.1:4173'])('does not warn on %s', (h) => {
    const html = render(h)
    expect(html).not.toContain('warn')
    expect(html).not.toContain('role=')
    expect(html).toContain(h)
  })

  it('reads location.host by default', () => {
    vi.stubGlobal('location', { host: 'konclave.app:8080' })
    expect(renderToStaticMarkup(<I18nProvider><HostNotice /></I18nProvider>)).toContain('konclave.app:8080')
  })

  it('the Shell passes the alert flag, and the Vaults dialogs point at it', () => {
    expect(codeOf('screens/NetVault.tsx')).toContain('<HostNotice alert={!error} />')
    const v = codeOf('screens/Vaults.tsx')
    expect((v.match(/describedBy=\{HOST_NOTICE_ID\}/g) ?? []).length).toBe(3)
    expect((v.match(/<HostNotice \/>/g) ?? []).length).toBe(2) // import and unlock; create is the Shell's
  })
})

describe('copy', () => {
  it.each(['host.notice', 'host.notice.warn'])('both locales have %s', (k) => {
    expect(en[k]).toBeTruthy()
    expect(ptBR[k]).toBeTruthy()
  })

  it('both locales end the first sentence with a full stop, and carry the host placeholder', () => {
    for (const d of [en, ptBR]) {
      expect(d['host.notice']).toMatch(/\{host\}.*www\.konclave\.xyz\.$/)
    }
  })

  it('the FAQ names the address bar, the desktop app, and that invites point to the real app, in both languages', () => {
    const faq = SECTIONS.find((x) => x.id === 'faq')!
    const text = JSON.stringify(faq.blocks)
    for (const frag of ['address bar', 'barra do navegador', 'desktop app', 'app de mesa', 'www.konclave.xyz']) expect(text).toContain(frag)
  })
})
