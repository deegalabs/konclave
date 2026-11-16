import { describe, expect, it } from 'vitest'
import { codeOf } from './source-scan'
import { en } from './i18n/en'
import { ptBR } from './i18n/pt-BR'

// #927: protecting a share sets the passphrase that opens it; a typo there locks the member out of
// their own share. So it is typed twice, the save waits until the two agree, and the strength check
// stays on the first.
describe('protecting the vault asks for the passphrase twice (#927)', () => {
  it('both /net protect forms have a confirmation and refuse while the two differ', () => {
    const src = codeOf('screens/NetVault.tsx')
    expect(src.match(/value=\{savePass2\}/g) ?? []).toHaveLength(2)
    // The save button of each form is disabled while they differ, and the save itself refuses too.
    expect(src.match(/disabled=\{[^}]*savePass !== savePass2/g) ?? []).toHaveLength(2)
    expect(src).toMatch(/if \(newPassphraseProblem\(savePass\) \|\| savePass !== savePass2\) return/)
    expect(src.match(/savePass2 && savePass !== savePass2 \? tt\('net\.save\.passMismatch'\) : ''/g) ?? []).toHaveLength(2)
    // The strength meter and the generator stay on the first field only.
    expect(src).toMatch(/<PassphraseField inputClassName="cv-input" choosing=\{false\}\s*placeholder=\{tt\('net\.save\.passConfirm'\)\}/)
    // A password manager is told both are a new passphrase (it must not fill the confirmation for you).
    expect(src.match(/autoComplete="new-password"/g)?.length ?? 0).toBeGreaterThanOrEqual(2)
  })
  it('says so in both languages', () => {
    for (const d of [en, ptBR]) {
      expect(d['net.save.passConfirm']).toBeTruthy()
      expect(d['net.save.passMismatch']).toBeTruthy()
    }
  })
})
