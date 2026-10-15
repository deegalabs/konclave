import { describe, expect, it } from 'vitest'
import { codeOf } from './source-scan'

// Who may finish a registration, and when. The screens have no harness of their own, so these pin
// the places each rule must stay (a removed line is a red test, not a silent gap).
const nv = codeOf('./screens/NetVault.tsx')
const vl = codeOf('./screens/Vaults.tsx')

describe('the end of a creation records what it proved before it asks the coordinator anything', () => {
  it('writes allSaved and the coordinator it is about to use, ahead of the registration call', () => {
    expect(nv).toMatch(/updateVaultMeta\(saved\.vaultId, \{ allSaved: true, coordinator: helperBase\(\) \}\)/)
    expect(nv.indexOf('allSaved: true')).toBeLessThan(nv.indexOf('await concludeRegistration('))
  })
  it('the creation calls the shared registration with the id, not a copy of the record', () => {
    expect(nv).toMatch(/await concludeRegistration\(saved\.vaultId\)/)
  })
})

describe('the vault card', () => {
  it('offers a finish by the record, through the one predicate, never by pending alone', () => {
    expect(vl).toMatch(/const resumableRec = \(id: string\) => \{ const r = recs\[id\]; return !!r && resumable\(r\) \}/)
    expect(vl).toMatch(/\(v\.pending \|\| resumableRec\(v\.id\)\)/)
  })
  it('a record of the earlier flow keeps its warning and gets no finish control', () => {
    expect(vl).toMatch(/oldFlow = !!rec && protocolOfRecord\(rec\) === undefined/)
    expect(vl).toMatch(/\{!oldFlow && canResume && resumeFor === v\.id/)
    expect(vl).toMatch(/\{!oldFlow && canResume && resumeFor !== v\.id && rec\.allSaved/)
    expect(vl).toMatch(/\{!oldFlow && !\(canResume/)
  })
  it('opening an unlocked vault concludes it with no question only when allSaved is recorded and the coordinator is the same', () => {
    expect(vl).toMatch(/rec && rec\.allSaved && resumable\(rec\) && sameCoordinator\(rec\)[^)]*\)? ?\{\s*const ok = await runConclude\(/)
    expect(vl).toMatch(/if \(isVaultUnlocked\(v\.id\)\) \{ void openUnlocked\(row\); return \}/)
    expect(vl).toMatch(/await openUnlocked\(unlocking, pass\)/)
  })
  it('a record without allSaved reaches the registration only through the members\' answer', () => {
    // The sole other way into the panel is the armed checkbox of the question.
    const opens = [...vl.matchAll(/setResumeFor\(v\.id\)/g)].length
    expect(opens).toBe(2) // the allSaved button, and the question's checkbox
    expect(vl).toMatch(/disabled=\{finishArmed !== v\.id\}[\s\S]{0,400}?if \(canResume\) \{ setFinishing\(null\); setResumeFor\(v\.id\)/)
  })
  it('names the coordinator it will register with, and asks again when it is not the recorded one', () => {
    expect(vl).toMatch(/t\('vaults\.resumeConfirm', \{ server: helperBase\(\) \}\)/)
    expect(vl).toMatch(/!sameCoordinator\(rec\) && !resumeAck/)
    expect(vl).toMatch(/rec\.coordinator \|\| rec\.coordinator === helperBase\(\)|!rec\.coordinator \|\| rec\.coordinator === helperBase\(\)/)
  })
  it('asks the passphrase when the vault is locked, and builds the backup with it through the shared builder', () => {
    expect(vl).toMatch(/!isVaultUnlocked\(v\.id\) && \(\s*<>\s*<p>\{t\('vaults\.resumePassAsk'\)\}/)
    expect(vl).toMatch(/await buildVaultBackup\(id, pass, getUnlockedShare\(id\), recs\[id\]\?\.name\)/)
  })
  it('no coordinator configured keeps today\'s local finish for a pending record', () => {
    expect(vl).toMatch(/void updateVaultMeta\(v\.id, \{ pending: false \}\)/)
    // and the local finish is what a record the predicate does not accept falls to
    expect(vl).toMatch(/if \(canResume\) \{[^}]*return \}\s*void updateVaultMeta\(v\.id, \{ pending: false \}\)/)
  })
})
