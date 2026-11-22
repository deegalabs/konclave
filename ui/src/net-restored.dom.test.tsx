// @vitest-environment jsdom
import 'fake-indexeddb/auto'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, render, screen } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { I18nProvider } from './i18n'

vi.setConfig({ testTimeout: 30_000 })
vi.mock('./wasm-ready', () => ({ ensureWasm: async () => {} }))
vi.mock('./api', async (orig) => ({ ...(await orig<typeof import('./api')>()), getSelectedVault: () => 'vault-1' }))
vi.mock('./session', async (orig) => ({
  ...(await orig<typeof import('./session')>()),
  getUnlockedShare: () => ({ groupKey: new Uint8Array(32), roster: ['Alice', 'Bob'] }),
}))
vi.mock('./signing', async (orig) => ({
  ...(await orig<typeof import('./signing')>()),
  decodeBundle: () => ({ keyPackage: new Uint8Array(1), pubkeys: new Uint8Array(1), groupVk: new Uint8Array(32), seat: 1, n: 2, t: 2 }),
}))

const { default: NetVault } = await import('./screens/NetVault')

afterEach(() => cleanup())

describe('the restored vault screen on /net', () => {
  it('opens the Dashboard and offers no signing session', async () => {
    render(<MemoryRouter><I18nProvider><NetVault /></I18nProvider></MemoryRouter>)
    expect(await screen.findByRole('button', { name: /open the vault \(dashboard\)/i })).toBeTruthy()
    expect(screen.queryByText(/start a session/i)).toBeNull()
    expect(screen.queryByPlaceholderText(/session code/i)).toBeNull()
    expect(screen.queryByText(/sign with this vault/i)).toBeNull()
    expect(document.body.textContent).not.toMatch(/signing session/i)
  })
})
