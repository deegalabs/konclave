import { describe, expect, it } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import { I18nProvider } from './i18n'
import { en } from './i18n/en'
import { ptBR } from './i18n/pt-BR'
import { AddressNotice, HistoryStatus, historyReadKind } from './screens/Receive'
import { WALLET_BUSY } from './helper'
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

// Daniel (16/10): the history list filled in a while after the screen opened, and nothing said it was
// being read, so the empty list read as an answer. The status shows when a read is in flight and when
// the list last answered, on every refresh. Nothing is announced (a11y audit: a status changing every
// 15 s talked over the member); the time stays visible while a read runs (GSP critique).
describe('the on-chain history says when it is being read', () => {
  const at1041 = new Date(2026, 9, 16, 10, 41).getTime()
  const status = (checking: boolean, checkedAt: number | null) =>
    renderToStaticMarkup(<I18nProvider><HistoryStatus checking={checking} checkedAt={checkedAt} /></I18nProvider>)

  it('shows a spinner and says it is checking while a read is in flight, without hiding the time', () => {
    const html = status(true, at1041)
    expect(html).toContain('class="rcv-hist-checking" aria-hidden="true"><span class="loader-ring sm"></span>Checking the network…')
    expect(html).toMatch(/<span>Last checked at 10:41/)
  })

  it('says only when the list was last read once a read has answered', () => {
    const html = status(false, at1041)
    expect(html).toMatch(/<span>Last checked at 10:41/)
    expect(html).not.toContain('loader-ring')
    expect(html).not.toContain('Checking')
  })

  it('is not a live region: a status that changes every 15 s would talk over the screen', () => {
    expect(status(true, at1041)).not.toContain('role=')
    expect(status(false, at1041)).not.toContain('aria-live')
  })

  it('says it in both languages, and the empty list no longer reads as final', () => {
    expect(en['receive.historyChecking']).toBe('Checking the network…')
    expect(ptBR['receive.historyChecking']).toBe('Consultando a rede…')
    expect(ptBR['receive.historyChecked']).toBe('Conferido às {time}')
    expect(en['receive.historyEmpty']).toMatch(/this list checks again on its own/)
    expect(ptBR['receive.historyEmpty']).toMatch(/esta lista confere de novo sozinha/)
  })

  it('the screen marks every history read, not only the first', () => {
    const receive = codeOf('./screens/Receive.tsx')
    expect(receive).toMatch(/setChecking\(true\)[\s\S]*readTransactions\(\)[\s\S]*setChecking\(false\)/)
    expect(receive).toMatch(/<HistoryStatus checking=\{checking\} checkedAt=\{checkedAt\} failed=\{failed\} \/>/)
  })
})

// Daniel (16/10): right after unlocking, the history said "Nothing has arrived yet" and "Last checked
// at" for 20 to 40 seconds on a vault that had three transactions. A read that FAILS (a 401 before the
// read key is in the session, a timeout, a 5xx) comes back as null, and the screen took null for an
// empty answer. A failure is not an answer: it must not empty the list, must not be shown as a check,
// and is retried soon rather than at the next 15 s poll.
describe('a history read that fails is not an answer', () => {
  it('tells the three outcomes apart', () => {
    expect(historyReadKind(WALLET_BUSY)).toBe('busy')
    expect(historyReadKind(null)).toBe('failed')
    expect(historyReadKind([])).toBe('answer')
    expect(historyReadKind([{ txid: 'ab', mined_height: 1 } as never])).toBe('answer')
  })

  it('the screen fills the list and the time only from an answer, and retries a failure soon', () => {
    const receive = codeOf('./screens/Receive.tsx')
    expect(receive).toMatch(/const kind = historyReadKind\(r\)/)
    expect(receive).toMatch(/if \(kind === 'answer'\) \{\s*setTxs\(r\)\s*setTxLoaded\(true\)\s*setCheckedAt\(Date\.now\(\)\)/)
    expect(receive).toMatch(/setFailed\(kind === 'failed'\)/)
    expect(receive).toMatch(/if \(kind === 'failed'\) retry = setTimeout\(\(\) => void loadTx\(\), 3_000\)/)
    expect(receive).not.toMatch(/keepOnBusy/)
  })

  it('says so, beside the title once loaded and in place of the list before', () => {
    const html = renderToStaticMarkup(<I18nProvider><HistoryStatus checking={false} checkedAt={null} failed /></I18nProvider>)
    expect(html).toContain('Could not check, trying again…')
    expect(en['receive.historyUnreadable']).toMatch(/Could not read the history yet/)
    expect(ptBR['receive.historyUnreadable']).toMatch(/Não deu para ler o histórico ainda/)
    expect(ptBR['receive.historyRetry']).toBe('Não deu para conferir, tentando de novo…')
    expect(codeOf('./screens/Receive.tsx')).toMatch(/failed \? <p className="rcv-note">\{t\('receive\.historyUnreadable'\)\}<\/p> : <Loading \/>/)
  })
})
