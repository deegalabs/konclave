import { describe, expect, it } from 'vitest'
import { codeOf } from './source-scan'
import { en } from './i18n/en'
import { ptBR } from './i18n/pt-BR'

// #928: after "Protect the vault" the passphrase fields stayed editable, and on success were
// emptied. The seal was never affected (see the doSave scan below); the defect is what the screen
// shows. NOTE: every test here except the build-backup and PassphraseField ones is a SOURCE SCAN of
// NetVault.tsx. NetVault cannot be mounted at phase 'done' in a test (it needs a real DKG, the relay
// and the wasm), so these pin the structure, not the behavior. They are red by mutation.
const src = codeOf('screens/NetVault.tsx')

function doSaveBody(): string {
  const start = src.indexOf('const doSave = useCallback(')
  const end = src.indexOf('}, [savePass, savePass2', start)
  expect(start).toBeGreaterThan(-1)
  expect(end).toBeGreaterThan(start)
  return src.slice(start, end)
}

describe('the passphrase locks once the member pressed Protect the vault (#928)', () => {
  it('one passLocked, defined once, on all four fields of both forms', () => {
    expect(src.match(/const passLocked = /g) ?? []).toHaveLength(1)
    expect(src).toMatch(/const passLocked = saveState !== 'idle'/)
    expect(src.match(/readOnly=\{passLocked\}/g) ?? []).toHaveLength(4)
  })
  it('the embedded form replaces its fields with a status line once saved', () => {
    expect(src).toMatch(/saveState === 'saved' \? \(\s*<p[^>]*tabIndex=\{-1\}[^>]*>\{tt\('net\.save\.locked'\)\}<\/p>/)
    // that status line is not a live region: the WaitLine is the one
    expect(src).not.toMatch(/<p[^>]*role="status"[^>]*>\{tt\('net\.save\.locked'\)/)
  })
  it('the seal takes the passphrase of the press: no await before saveVault, same identifier at both uses', () => {
    const body = doSaveBody()
    const at = body.indexOf('await saveVault(') // the call's own await is the first one allowed
    expect(at).toBeGreaterThan(-1)
    expect(body.slice(0, at)).not.toMatch(/\bawait\b/)
    expect(body).toMatch(/saveVault\(vaultId, \{[^\n]*\}, savePass\)\n/)
    expect(body.match(/savePassRef\.current = savePass\b(?!\w)/g) ?? []).toHaveLength(1)
    expect(src.match(/savePassRef\.current = (?!'')/g) ?? []).toHaveLength(1)
  })
  it('a failure unlocks: the fields are cleared only after saved, never in the catch', () => {
    const body = doSaveBody()
    const caught = body.slice(body.indexOf('catch (e)'))
    expect(caught).not.toMatch(/setSavePass/)
    expect(caught).toMatch(/setSaveState\('idle'\)/)
    expect(body.indexOf("setSaveState('saved')")).toBeLessThan(body.indexOf("setSavePass('')"))
  })
  it('a failed save keeps no passphrase and is announced; focus returns to the button', () => {
    const caught = doSaveBody().slice(doSaveBody().indexOf('catch (e)'))
    expect(caught).toMatch(/savePassRef\.current = ''/)
    expect(src).toMatch(/<p className="set-err" role="alert">\{saveErr\}<\/p>/)
    expect(src).toMatch(/if \(saveErr && saveState === 'idle'\) saveBtnRef\.current\?\.focus\(\)/)
    expect(src.match(/ref=\{saveBtnRef\}/g) ?? []).toHaveLength(2)
  })
  it('both forms share one focus target for the saved note, and the three focus calls are the only ones added', () => {
    expect(src.match(/ref=\{savedNoteRef\}/g) ?? []).toHaveLength(2)
    expect(src.match(/savedNoteRef\.current\?\.focus\(\)/g) ?? []).toHaveLength(1)
    expect(src.match(/backupTitleRef\.current\?\.focus\(\)/g) ?? []).toHaveLength(1)
    expect(src).toMatch(/saveState === 'saved'\) \{ savedNoteRef\.current\?\.focus\(\); setLeaving\(false\) \}/)
    expect(src).toMatch(/if \(backup\) backupTitleRef\.current\?\.focus\(\)/)
  })
  it('Saving is announced through the WaitLine', () => {
    expect(src).toMatch(/const saveWait = saveState === 'saving' \? tt\('net\.save\.saving'\)/)
  })
  it('a stop during the stretching does not leave the passphrase in the ref', () => {
    const body = doSaveBody()
    const branch = body.slice(body.indexOf('if (cer.aborted)'))
    expect(branch.slice(0, branch.indexOf('return'))).toMatch(/savePassRef\.current = ''/)
  })
  it('says what happened in both languages, and says nothing about the backup or the others', () => {
    for (const d of [en, ptBR]) {
      expect(d['net.save.locked']).toBeTruthy()
      expect(d['net.save.locked']).not.toMatch(/backup|others|outros|cópia/i)
    }
  })
})
