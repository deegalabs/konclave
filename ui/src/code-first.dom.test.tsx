// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { I18nProvider } from './i18n'
import { en as dict } from './i18n/en'
import { CodeFirst } from './screens/CodeFirst'
import { mustCompareCode } from './creation-protocol'
import { seatRoster, mySeatName } from './seat-labels'

afterEach(cleanup)

describe('the code before the address', () => {
  const show = (code: string | undefined, compared: boolean, on = () => {}) => render(
    <I18nProvider><CodeFirst code={code} compared={compared} onCompared={on}><span>the-address</span></CodeFirst></I18nProvider>,
  )
  it('a code not compared hides the address, and the click says so', () => {
    const on = vi.fn()
    show('AAAAA-BBBBB', false, on)
    expect(screen.queryByText('the-address')).toBeNull()
    expect(screen.getByText('AAAAA-BBBBB')).toBeTruthy()
    fireEvent.click(screen.getByText(dict['set.viewingCodeSeen']!))
    expect(on).toHaveBeenCalledTimes(1)
  })
  it('a click in it does not reach the card behind it, and it asks for every group', () => {
    const behind = vi.fn()
    render(<I18nProvider><div onClick={behind}><CodeFirst code="AAAAA" compared={false} onCompared={() => {}}><span /></CodeFirst></div></I18nProvider>)
    fireEvent.click(screen.getByText(dict['set.viewingCodeSeen']!))
    expect(behind).not.toHaveBeenCalled()
    expect(screen.getByText(dict['set.viewingCodeHintFull']!)).toBeTruthy()
  })
  it('once compared, or with no code to compare, the address shows and the card does not', () => {
    show('AAAAA', true)
    expect(screen.getByText('the-address')).toBeTruthy()
    expect(screen.queryByText('AAAAA')).toBeNull()
    cleanup()
    show(undefined, false)
    expect(screen.getByText('the-address')).toBeTruthy()
  })
})

describe('who must compare', () => {
  it('a verified protocol-3 vault with a code, until the member says so', () => {
    const r = { cp: 3, receiversState: 'verified', viewingFingerprint: 'C' }
    expect(mustCompareCode(r)).toBe(true)
    expect(mustCompareCode({ ...r, codeCompared: true })).toBe(false)
    expect(mustCompareCode({ ...r, receiversState: 'refused' })).toBe(false)
    expect(mustCompareCode({ ...r, viewingFingerprint: undefined })).toBe(false)
    expect(mustCompareCode({ cp: 2, viewingFingerprint: 'C' })).toBe(false)
    expect(mustCompareCode(undefined)).toBe(false)
  })
})

describe('the seats a device names', () => {
  const list = [{ name: 'Served1', pubkey: 'a' }, { name: 'Served2', pubkey: 'b' }]
  it('its own list where the lists differ, the served one otherwise', () => {
    expect(seatRoster({ member_list: list, own_members: ['Own1', 'Own2'] }).map((m) => m.name)).toEqual(['Own1', 'Own2'])
    expect(seatRoster({ member_list: list }).map((m) => m.name)).toEqual(['Served1', 'Served2'])
    expect(seatRoster(null)).toEqual([])
  })
  it('its own seat by number where it can, whatever its name became', () => {
    expect(mySeatName(['Own1', 'Own2'], 2, 'Renamed')).toBe('Own2')
    expect(mySeatName(undefined, 2, 'Renamed')).toBe('Renamed')
    expect(mySeatName(['Own1'], undefined, 'Renamed')).toBe('Renamed')
    expect(mySeatName(['Own1'], 5, null)).toBe(null)
  })
})
