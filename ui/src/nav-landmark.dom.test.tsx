// @vitest-environment jsdom
// #318: the shell's navigation landmark is named in the member's language and says what it is. It
// was named "Konclave", a brand, which a screen reader announces as "Konclave navigation" in English
// on a Portuguese screen. The real Layout, the rest stood in.
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, render, screen } from '@testing-library/react'
import { MemoryRouter, Route, Routes } from 'react-router-dom'

vi.mock('./api', async (orig) => ({
  ...(await orig<typeof import('./api')>()),
  getVault: async () => null, health: async () => true, getSelectedVault: () => 'v1', isVaultUnlocked: () => true,
}))
vi.mock('./storage', async (orig) => ({ ...(await orig<typeof import('./storage')>()), listVaults: async () => [] }))
vi.mock('./vault-lock', async (orig) => ({ ...(await orig<typeof import('./vault-lock')>()), needsUnlock: () => false, securedLocally: async () => false }))
vi.mock('./seat-registration', () => ({ useSeatRefusalCode: () => null }))
vi.mock('./usePoll', async (orig) => ({ ...(await orig<typeof import('./usePoll')>()), startVisiblePoll: () => () => {} }))
vi.mock('./VaultSigner', () => ({ VaultSignerProvider: ({ children }: { children: React.ReactNode }) => children }))
vi.mock('./screens/SigningPanel', () => ({ default: () => null }))
vi.mock('./UpdatePrompt', () => ({ VersionBadge: () => null }))
vi.mock('./AppPrefs', () => ({ default: () => null }))
vi.mock('./LockOverlay', () => ({ default: () => null }))

const { default: Layout } = await import('./Layout')
const { I18nProvider } = await import('./i18n')
const { en } = await import('./i18n/en')
const { ptBR } = await import('./i18n/pt-BR')

describe('the shell navigation landmark (#318)', () => {
  afterEach(() => { cleanup(); localStorage.clear() })
  for (const [locale, dict] of [['pt-BR', ptBR], ['en', en]] as const) {
    it(`is named in ${locale}, not with the brand`, () => {
      localStorage.setItem('konclave.locale', locale)
      render(<MemoryRouter><I18nProvider><Routes><Route path="*" element={<Layout />} /></Routes></I18nProvider></MemoryRouter>)
      expect(screen.getByRole('navigation', { name: dict['nav.vaultNav'] })).toBeTruthy()
      expect(screen.queryByRole('navigation', { name: 'Konclave' })).toBeNull()
    })
  }
})
