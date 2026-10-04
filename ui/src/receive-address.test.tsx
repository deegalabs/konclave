import { describe, expect, it } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import { I18nProvider } from './i18n'
import { en } from './i18n/en'
import { ptBR } from './i18n/pt-BR'
import { AddressNotice } from './screens/Receive'
import { codeOf } from './source-scan'

// A9 (#610 review). Which address Add funds shows is decided once, in `getVault`, and tested there
// (selected-vault.test.ts). What this file pins is what the screens say about it: the warning when
// the coordinator answered with another address, the note when there is no address, and that the
// screens take the address from `getVault` and nowhere else. The notice is rendered for real; the
// screens' wiring is read from their source with comments removed, since they load the vault in an
// effect that server rendering never runs.
const render = (differs: boolean, missing: boolean) =>
  renderToStaticMarkup(<I18nProvider><AddressNotice differs={differs} missing={missing} id="n1" /></I18nProvider>)

describe('what Add funds says about the address', () => {
  it('warns, as the vault warning banner, when the coordinator answered with another address', () => {
    const html = render(true, false)
    expect(html).toContain('class="banner-warn rcv-warn" role="alert" id="n1"')
    expect(html).toContain('<span class="ow-ic" aria-hidden="true">⚠︎</span>') // text, not emoji
    expect(html).toContain('<b>Use only the address below.</b>')
    expect(html).toContain('which can mean the coordinator was compromised')
    expect(html).toContain('ask them to stop using it')
  })

  it('says nothing when the coordinator agrees with the record', () => {
    expect(render(false, false)).toBe('')
  })

  it('explains, instead of warning, when this device has no address to show', () => {
    const html = render(false, true)
    expect(html).toContain('This device has no saved address for this vault, or could not read it')
    expect(html).toContain('If this vault is not in this device’s list, you can import it')
    expect(html).toContain('>Reload</button>')
    expect(html).not.toContain('role="alert"')
    expect(render(true, true)).toBe(html) // nothing is shown, so there is nothing to warn about
  })

  it('says it in both languages', () => {
    expect(en['receive.addressDiffers']).toMatch(/Ask the other members to compare this address with the one their device shows/)
    expect(ptBR['receive.addressDiffers']).toMatch(/confira se era este e, se não era, peça que deixem de usá-lo/)
    expect(ptBR['receive.addressDiffers']).toMatch(/o coordenador foi comprometido/)
    expect(ptBR['receive.noAddress']).toMatch(/ou não conseguiu lê-lo, então não mostra nenhum/)
  })
})

describe('the screens take the address from getVault and say what they know before showing it', () => {
  const receive = codeOf('./screens/Receive.tsx')

  it('Add funds takes the address from getVault, the one rule for it', () => {
    expect(receive).toMatch(/const address = vault\?\.orchard_address \?\? ''/)
    // No other source: not the coordinator's answer, not a record's field (the label key aside).
    expect(receive.replaceAll("'receive.address'", '')).not.toMatch(/netGetVault|\.address\b/)
  })

  it('Add funds puts the notice right under the header, and no QR, copy or note without an address', () => {
    expect(receive).toMatch(
      /<PageHeader title=\{t\('receive\.title'\)\} subtitle=\{address \? t\('receive\.lead'\) : undefined\} \/>\s*<AddressNotice differs=\{!!vault\.served_address_differs\} missing=\{!address\} id=\{noticeId\} \/>\s*\{address && \(\s*<div className="rcv-grid">/,
    )
    expect(receive).toMatch(/\{address && <p className="rcv-note">\{t\('receive\.note'\)\}<\/p>\}/)
  })

  it('ties the warning to every control that hands the address on', () => {
    expect(receive).toMatch(/const describedBy = vault\?\.served_address_differs \? noticeId : undefined/)
    expect(receive.match(/aria-describedby=\{describedBy\}/g)?.length).toBe(3)
  })

  it('the dashboard and Settings show a dash, not an empty frame or the shielded seal, when there is no address', () => {
    const dashboard = codeOf('./screens/Dashboard.tsx')
    const branch = /\{vault\?\.orchard_address \? \(\s*<>\s*<code>\{shortAddr\(vault\.orchard_address\)\}<\/code>([\s\S]*?)<\/>\s*\) : \(\s*<span className="dim">-<\/span>\s*\)\}/.exec(dashboard)
    expect(branch, 'the address and its seal only when there is an address').not.toBeNull()
    expect(branch![1]).toContain('className="orchard"')
    expect(dashboard.match(/className="orchard"/g)?.length).toBe(1)
    expect(codeOf('./screens/Settings.tsx')).toMatch(
      /\{vault\?\.orchard_address \? <Secret sm>\{shortAddr\(vault\.orchard_address\)\}<\/Secret> : '-'\}/,
    )
  })

  it('every vault warning banner is the one component', () => {
    expect(codeOf('./screens/Dashboard.tsx')).toMatch(/<BannerWarn>\{t\('dashboard\.openBanner'\)\}<\/BannerWarn>/)
    // No screen writes the banner by hand: the markup lives in components.tsx only.
    for (const f of ['./screens/Dashboard.tsx', './screens/Receive.tsx', './screens/Settings.tsx', './screens/Vaults.tsx']) {
      expect(codeOf(f), f).not.toMatch(/banner-warn/)
    }
  })
})
