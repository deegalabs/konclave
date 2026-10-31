import { describe, expect, it } from 'vitest'
import { codeOf } from './source-scan'
import { en } from './i18n/en'
import { ptBR } from './i18n/pt-BR'

/* #320: every action that saves says so, through the one vehicle the app has for it
 * (`toast.tsx`). Before this, Pessoas saved in silence, Signatários showed a line that vanished in
 * 1.8 s, Ajustes copied a backup and changed a passphrase without a word, and Cofres imported and
 * removed a vault with nothing but the list changing. A member who did not watch the list had no
 * way to know the write had landed. What a copy button says is clipboard.test.ts's (#313). */

// The passphrase change is not here on purpose: its dialog already shows a "Done" panel with the
// export reminder, and a toast on top was two notices for one write.
const KEYS = {
  'People.tsx': ["t('toast.personSaved'", "t('toast.personRemoved'"],
  'Members.tsx': ["t('toast.nameSaved')"],
  'Settings.tsx': ["t('toast.backupSaved')", "t('toast.backupCopied')"],
  'Vaults.tsx': ["t('toast.vaultImported'", "t('toast.vaultRemoved'"],
} as const

describe('every action that saves says so (#320)', () => {
  for (const [file, keys] of Object.entries(KEYS)) {
    it(`${file} announces each write through the toast`, () => {
      const src = codeOf(`screens/${file}`)
      expect(src).toMatch(/useToast\(\)/)
      for (const k of keys) expect(src).toContain(`toast.ok(${k}`)
    })
  }

  it('the words exist in both languages', () => {
    const all = [...Object.values(KEYS).flat().map((k) => k.replace(/^t\('/, '').replace(/'\)?$/, '')), 'toast.copyFailed', 'toast.personSavedOldStays']
    for (const k of all) {
      expect(en[k as keyof typeof en], k).toBeTruthy()
      expect(ptBR[k as keyof typeof ptBR], k).toBeTruthy()
    }
  })

  it('Signatários no longer keeps its own vanishing line for the rename', () => {
    expect(codeOf('screens/Members.tsx')).not.toMatch(/setRenamed|renamed &&/)
  })
})
