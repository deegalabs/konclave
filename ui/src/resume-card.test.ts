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
  it('decides "unlocked" by the share in session, not by the unlocked mark a passkey also sets', () => {
    // The share in session, through the one function the panel and the signer ask too (16/10).
    expect(vl).toMatch(/const hasShare = \(id: string\) => unlockedHere\(id\)/)
    const panel = vl.slice(vl.indexOf('async function doResume'), vl.indexOf('async function openUnlocked'))
    expect(panel).not.toMatch(/isVaultUnlocked/)
  })
  it('one registration at a time, the passphrase leaves state when it is spent, and progress shows', () => {
    expect(vl).toMatch(/if \(concluding\.current\.has\(id\)\) return false\s*concluding\.current\.add\(id\)/)
    expect(vl).toMatch(/finally \{[^}]*setResumePass\(''\)/)
    expect(vl).toMatch(/resumeBusy === v\.id && <p role="status"/)
    expect(vl).toMatch(/finally \{\s*setBackupPass\(''\)/)
  })
  it('the copied label is a key that exists', () => {
    expect(vl).not.toMatch(/common\.copied/)
    expect(vl).toMatch(/t\('receive\.copied'\)/)
  })
  it('offers a finish by the record, through the one predicate, never by pending alone', () => {
    expect(vl).toMatch(/const resumableRec = \(id: string\) => \{ const r = recs\[id\]; return !!r && resumable\(r\) \}/)
    expect(vl).toMatch(/\(v\.pending \|\| resumableRec\(v\.id\)\)/)
  })
  it('a record of the earlier flow keeps its warning and gets no finish control', () => {
    expect(vl).toMatch(/oldFlow = !!rec && !isCurrentFlow\(rec\)\s*\n/)
    expect(vl).toMatch(/\{!oldFlow && canResume && resumeFor === v\.id/)
    expect(vl).toMatch(/\{!oldFlow && canResume && resumeFor !== v\.id && rec\.allSaved/)
    expect(vl).toMatch(/\{!oldFlow && \(\(rec\?\.cp \?\? 0\) < 3 \|\| canResume\) && !\(canResume/)
  })
  it('opening an unlocked vault concludes it with no question only when allSaved is recorded and the coordinator is the same', () => {
    expect(vl).toMatch(/rec && rec\.allSaved && resumable\(rec\) && sameCoord\(rec\) && hasShare\(row\.v\.id\)[^)]*\) \{[\s\S]{0,200}?await runConclude\(row\.v\.id, pass\)\s*return\s*\}/)
    // and it never leaves the card on success: no navigation between the registration and the backup
    expect(vl.slice(vl.indexOf('async function openUnlocked'), vl.indexOf('async function openUnlocked') + 700)).toMatch(/await runConclude\(row\.v\.id, pass\)\s*return\s*\}\s*nav\('\/dashboard'\)/)
    expect(vl).toMatch(/if \(isVaultUnlocked\(v\.id\)\) \{ void openUnlocked\(row\); return \}/)
    expect(vl).toMatch(/await openUnlocked\(unlocking, used\)/)
  })
  it('a record without allSaved reaches the registration only through the members\' answer', () => {
    // The sole other way into the panel is the armed checkbox of the question.
    const opens = [...vl.matchAll(/setResumeFor\(v\.id\)/g)].length
    expect(opens).toBe(2) // the allSaved button, and the question's checkbox
    expect(vl).toMatch(/disabled=\{finishArmed !== v\.id\}[\s\S]{0,400}?if \(canResume\) \{ setFinishing\(null\); setResumeFor\(v\.id\)/)
  })
  it('names the coordinator it will register with, and asks again when it is not the recorded one', () => {
    expect(vl).toMatch(/t\('vaults\.resumeConfirm', \{ server: helperBase\(\) \}\)/)
    expect(vl).toMatch(/\(!sameCoord\(rec\) && !resumeAck\)/)
    expect(vl).toMatch(/sameCoordinator\(rec\.coordinator, helperBase\(\)\)/)
  })
  it('asks the passphrase when the vault is locked, and builds the backup with it through the shared builder', () => {
    expect(vl).toMatch(/!hasShare\(v\.id\) && \(\s*<>\s*<p>\{t\('vaults\.resumePassAsk'\)\}/)
    expect(vl).toMatch(/await buildVaultBackup\(id, pass, recs\[id\]\?\.name\)/)
  })
  it('no coordinator configured keeps today\'s local finish for a pending record', () => {
    expect(vl).toMatch(/void updateVaultMeta\(v\.id, \{ pending: false \}\)/)
    // and the local finish is what a record the predicate does not accept falls to
    expect(vl).toMatch(/if \(canResume\) \{[^}]*return \}\s*void updateVaultMeta\(v\.id, \{ pending: false \}\)/)
  })
})

describe('the code-first gate', () => {
  it('the card, its opening and the finish screen all go through it', () => {
    expect(vl).toMatch(/<CodeFirst code=\{recs\[v\.id\]\?\.viewingFingerprint\} compared=\{!mustCompareCode\(recs\[v\.id\]\)\}/)
    expect(vl).toMatch(/function enter\(row: Row\) \{\s*const \{ v, src \} = row\s*if \(mustCompareCode\(recs\[v\.id\]\)\) return/)
    expect(nv).toMatch(/<CodeFirst code=\{viewingCode \?\? undefined\} compared=\{codeCompared\}/)
  })
})

describe('the signing panel', () => {
  it('says when the coordinator list is not the one this device holds', () => {
    const panel = codeOf('./screens/SigningPanel.tsx')
    expect(panel).toMatch(/vault\?\.roster_differs && <p[^>]*role="alert">\{t\('members\.rosterDiffers'\)\}/)
  })
})

describe('the rest of what a device says', () => {
  it('the proposal says when the lists differ', () => {
    expect(codeOf('./screens/Proposal.tsx')).toMatch(/setRosterDiffers\(!!v\.roster_differs\)[\s\S]*rosterDiffers && <p[^>]*role="alert">/)
  })
  it('an imported vault is read back like every other, never shown with the file\'s address', () => {
    const code = codeOf('./screens/Vaults.tsx')
    const imp = code.slice(code.indexOf('async function doImport()'), code.indexOf('const startCreate'))
    expect(imp).toMatch(/setReload\(\(x\) => x \+ 1\)/)
    expect(imp).not.toMatch(/orchard_address: meta\.address/)
  })
  it('Receive says when the compare could not be recorded', () => {
    const code = codeOf('./screens/Receive.tsx')
    expect(code).not.toMatch(/codeCompared: true \}\)[^\n]*\.catch\(\(\) => \{\}\)/)
    expect(code).toMatch(/onCompared=\{\(\) => \{ setCompareErr\(null\); void updateVaultMeta\(vault\.id, \{ codeCompared: true \}\)[^\n]*\.catch\(\(e\) => setCompareErr\(/)
    expect(code).toMatch(/compareErr && \(\s*<p[^>]*role="alert">\{compareErr\}/)
  })
  it('Settings says when a backup is incomplete', () => {
    expect(codeOf('./screens/Settings.tsx')).toMatch(/if \(!b\.complete\) setXpErr\(t\('vaults\.resumeBackupIncomplete'\)\)/)
    expect(codeOf('./screens/Settings.tsx')).toMatch(/xpErr && <div[^>]*role="alert">\{xpErr\}/)
  })
})

describe('Settings', () => {
  it('mounts the repair, or a member could not reach it', () => {
    expect(codeOf('./screens/Settings.tsx')).toMatch(/<ReceiversRepair rec=\{localRec\}/)
  })
})
describe('the card address', () => {
  it('reads through the one rule getVault uses', () => {
    expect(vl).toMatch(/orchard_address: verifiedAddress\(s\)/)
    expect(codeOf('./api.ts')).toMatch(/verifiedAddress\(rec\)/)
  })
})

describe('what these screens read, where only their source can be pinned', () => {
  it('the finish screen starts with the code not compared, and reads it from the record', () => {
    expect(nv).toMatch(/\[codeCompared, setCodeCompared\] = useState\(false\)/)
    expect(nv).toMatch(/setViewingCode\(held\?\.viewingFingerprint \?\? null\)/)
  })
  it('the signing panel names seats through the one rule, and Settings shows the code', () => {
    expect(codeOf('./screens/SigningPanel.tsx')).toMatch(/const roster = seatRoster\(vault\)/)
    expect(codeOf('./screens/Settings.tsx')).toMatch(/\{localRec\?\.viewingFingerprint && \(/)
  })
  it('the shell says when this device was refused', () => {
    expect(codeOf('./Layout.tsx')).toMatch(/\{refusedCode && \(\s*<p className="unlock-err" role="alert">/)
  })
})

