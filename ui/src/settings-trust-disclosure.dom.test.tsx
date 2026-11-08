// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, render, screen } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { I18nProvider } from './i18n'
import { ToastProvider } from './toast'
import { en as dict } from './i18n/en'
import { ptBR } from './i18n/pt-BR'
const en = (k: string): string => dict[k] ?? k

// Settings, mounted for real over a private vault (#779 follow-up, the v0.19 plan): no section
// index beside the page, and the trust panel as a native disclosure. On the page: the badge, one
// line saying what the panel is, and the link to the security page. Inside the disclosure, closed
// until the member opens it: the intro, the table, the limits.
vi.mock('./api', async (orig) => ({
  ...(await orig<typeof import('./api')>()),
  health: async () => true,
  getVault: async () => ({ id: 'v', name: 'Treasury', threshold: 2, total: 2, member_list: [] }),
  getSelectedVault: () => 'v',
}))
vi.mock('./storage', async (orig) => ({
  ...(await orig<typeof import('./storage')>()),
  listVaults: async () => [{ id: 'v', name: 'Treasury', governance: 'quorum', myName: 'Ana', groupKey: 'ab'.repeat(32), roster: ['Ana', 'Bia'], secured: true }],
}))
const { default: Settings } = await import('./screens/Settings')

const show = async () => {
  const r = render(<MemoryRouter><I18nProvider><ToastProvider><Settings /></ToastProvider></I18nProvider></MemoryRouter>)
  await screen.findByRole('heading', { name: en('set.secTrust') })
  return r.container
}

describe('Settings without an index, the trust panel as a disclosure', () => {
  beforeEach(() => { localStorage.clear(); localStorage.setItem('konclave.locale', 'en') })
  afterEach(() => cleanup())

  it('no section index; the sections keep their anchors', async () => {
    const page = await show()
    expect(page.querySelector('.set-index')).toBeNull()
    expect(page.querySelector('nav a[href^="#s-"]')).toBeNull()
    for (const id of ['s-vault', 's-access', 's-trust', 's-remove']) expect(page.querySelector('#' + id), id).not.toBeNull()
  })

  it('the table and the limits sit in a closed disclosure, named for what it holds', async () => {
    const page = await show()
    const details = page.querySelector('details.trust-details') as HTMLDetailsElement
    expect(details).not.toBeNull()
    expect(details.open).toBe(false)
    const summary = details.querySelector(':scope > summary')!
    expect(summary.textContent).toBe(en('trust.disclosure'))
    expect(details.querySelector('table.trust-grid')).not.toBeNull()
    expect(details.querySelector('ul.trust-limits')).not.toBeNull()
    expect(details.textContent).toContain(en('trust.intro'))
    expect(details.textContent).toContain(en('trust.limitsNotAll'))
  })

  it('on the page, outside it: the badge, the one-line summary and the security link', async () => {
    const page = await show()
    const details = page.querySelector('details.trust-details')!
    const line = screen.getByText(en('trust.summary'))
    expect(details.contains(line)).toBe(false)
    const badge = page.querySelector('.trust-badge')!
    expect(badge.textContent).toBe(en('vaults.securedBadge'))
    expect(details.contains(badge)).toBe(false)
    const more = screen.getByRole('link', { name: en('trust.more') })
    expect(more.getAttribute('href')).toBe('/docs/security')
    expect(details.contains(more)).toBe(false)
  })
})

describe('the copy', () => {
  it('reads as reviewed, in both languages', () => {
    expect(dict['trust.disclosure']).toBe('Who sees what, and the known limits')
    expect(ptBR['trust.disclosure']).toBe('Quem vê o quê, e os limites conhecidos')
    expect(dict['trust.summary']).toBe('Who reads the vault’s books and who can move its money, as this device knows it.')
    expect(ptBR['trust.summary']).toBe('Quem lê os livros do cofre e quem pode mover o dinheiro, pelo que este aparelho sabe.')
  })
})
