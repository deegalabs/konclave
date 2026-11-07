// What the removal confirm promises about the record this device keeps after a vault is removed.
// That record says which vault it was and which of its payments this device signed, to anyone who can
// read this browser's storage, so the confirm must not call it harmless ("no names or amounts").
import { describe, expect, it } from 'vitest'
import { en } from './i18n/en'
import { ptBR } from './i18n/pt-BR'

describe('the removal confirm, on what stays', () => {
  it('does not call the record of signed payments harmless', () => {
    expect(en['dashboard.deleteConfirmBody']).not.toMatch(/no names or amounts/i)
    expect(ptBR['dashboard.deleteConfirmBody']).not.toMatch(/sem nomes nem valores/i)
  })

  it('says the record identifies the vault and the payments this device signed', () => {
    expect(en['dashboard.deleteConfirmBody']).toMatch(/which vault it was and which of its payments this device signed/)
    expect(ptBR['dashboard.deleteConfirmBody']).toMatch(/qual era o cofre e quais pagamentos dele este aparelho assinou/)
  })
})
