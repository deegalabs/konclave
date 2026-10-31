import { describe, expect, it } from 'vitest'
import { en } from './i18n/en'
import { ptBR } from './i18n/pt-BR'
import { UPGRADE_NOTICE_AFTER, UPGRADE_NOTICE_BEFORE, upgradeNotice } from './upgrade-notice'

// The dashboard says, before a member tries to pay, that the network is about to upgrade and that
// payments pause around it. It is driven by what the app already reads (the chain tip in the balance
// answer) and by the upgrade height WASM carries from the epoch table, so there is no height typed
// here: the same number the device and the coordinator use.
const A = 3_543_405

describe('the upgrade notice', () => {
  it('shows nothing far from the upgrade, or when the tip is unknown', () => {
    expect(upgradeNotice(undefined, A)).toBeNull()
    expect(upgradeNotice(A - UPGRADE_NOTICE_BEFORE - 1, A)).toBeNull()
    expect(upgradeNotice(A + UPGRADE_NOTICE_AFTER, A)).toBeNull()
    expect(upgradeNotice(A + 50_000, A)).toBeNull()
  })

  it('tells of the upgrade from 300 blocks before it, and of what follows until 2,000 blocks after', () => {
    expect(UPGRADE_NOTICE_BEFORE).toBe(300)
    expect(UPGRADE_NOTICE_AFTER).toBe(2_000)
    expect(upgradeNotice(A - 300, A)).toBe('before')
    expect(upgradeNotice(A - 1, A)).toBe('before')
    expect(upgradeNotice(A, A)).toBe('after')
    expect(upgradeNotice(A + 1_999, A)).toBe('after')
  })

  it('does nothing without an upgrade height (WASM not ready, or no upgrade ahead)', () => {
    expect(upgradeNotice(A - 10, undefined)).toBeNull()
    expect(upgradeNotice(A - 10, 0)).toBeNull()
  })
})

describe('the texts a member reads around the upgrade', () => {
  it('say the same in both languages, and neither promises a send the coordinator may not deliver', () => {
    for (const d of [en, ptBR]) {
      expect(d['error.upgradeHold']).toBeTruthy()
      expect(d['error.coordinatorNotUpdated']).toBeTruthy()
      expect(d['dashboard.upgradeBefore']).toBeTruthy()
      expect(d['dashboard.upgradeAfter']).toBeTruthy()
    }
    // H2: the pause, the approval that stands, no promise of a time.
    expect(en['error.upgradeHold']).toMatch(/paused around the upgrade block/)
    expect(en['error.upgradeHold']).not.toMatch(/can be sent once the upgrade block is mined/)
    expect(ptBR['error.upgradeHold']).toMatch(/em pausa em torno do bloco da atualização/)
    // N2: the approvals last as long as the proposal does.
    expect(en['error.coordinatorNotUpdated']).toMatch(/72 hours/)
    expect(ptBR['error.coordinatorNotUpdated']).toMatch(/72 horas/)
  })

  it('name the block before the upgrade by a parameter, never by a number typed here, and say nothing is lost', () => {
    // The height comes from WASM (the epoch table); a literal in the copy would be a second home of it.
    for (const d of [en, ptBR]) {
      expect(d['dashboard.upgradeBefore']).toContain('{height}')
      expect(d['dashboard.upgradeBefore']).not.toMatch(/3[.,]?543[.,]?405/)
      expect(d['dashboard.upgradeAfter']).not.toMatch(/3[.,]?543[.,]?405/)
    }
    for (const d of [en, ptBR]) expect(d['dashboard.upgradeAfter']).toMatch(/lost|perde/)
  })
})
