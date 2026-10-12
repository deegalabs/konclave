// Leaving a vault creation half-way loses this device's part of the key: nothing is saved before the
// passphrase step. While a creation is in progress, a stray click, Esc or reload must ask first.
import { describe, expect, it } from 'vitest'
import { creationBusy, closeIntent } from './creation-guard'
import { codeOf } from './source-scan'

describe('a vault creation in progress', () => {
  it('is in progress from the invite until it finished, unless it stopped', () => {
    expect(creationBusy('idle', false, false)).toBe(false)
    for (const p of ['roster', 'confirm', 'dkg', 'done'] as const) expect(creationBusy(p, false, false)).toBe(true)
    expect(creationBusy('done', true, false)).toBe(false) // finished: every member saved
    expect(creationBusy('done', false, false, true)).toBe(false) // this device saved its part
    expect(creationBusy('dkg', false, false, true)).toBe(true) // 'saved' only counts once round 3 is done
    expect(creationBusy('dkg', false, true)).toBe(false) // stopped: nothing left to lose
    expect(creationBusy('error', false, false)).toBe(false)
  })
})

describe('what closing the create dialog means', () => {
  it('asks during a creation, opens the new vault once it finished, and otherwise just closes', () => {
    expect(closeIntent({ busy: true, finished: false })).toBe('ask')
    expect(closeIntent({ busy: false, finished: true })).toBe('open-vault')
    expect(closeIntent({ busy: false, finished: true, backupPending: true })).toBe('ask-backup') // no copy taken yet
    expect(closeIntent({ busy: true, finished: false, backupPending: true })).toBe('ask')
    expect(closeIntent({ busy: false, finished: false })).toBe('close')
  })
  it('a backdrop click or Esc goes through that one rule; the open-vault answer is the button\'s own path', () => {
    const v = codeOf('./screens/Vaults.tsx')
    expect(v).toMatch(/onDismiss=\{\(\) => setLeaveAsk\(\(n\) => n \+ 1\)\}/)
    const n = codeOf('./screens/NetVault.tsx')
    expect(n).toMatch(/const intent = closeIntent\(\{ busy, finished, backupPending \}\)/)
    expect(n).toMatch(/if \(intent === 'ask' \|\| intent === 'ask-backup'\) setLeaving/)
    // The whole reaction, exactly: a branch inserted before the rule (say, closing when finished)
    // would bypass it while every line above still matched.
    // Seeded with the counter's value at mount, so a fresh screen never takes an old close as its own.
    expect(n).toMatch(/const seenAsk = useRef\(leaveAsk\)/)
    const body = n.slice(n.indexOf('if (!leaveAsk || leaveAsk === seenAsk.current) return'), n.indexOf('}, [leaveAsk])')).replace(/\s+/g, ' ').trim()
    expect(body).toBe("if (!leaveAsk || leaveAsk === seenAsk.current) return seenAsk.current = leaveAsk const intent = closeIntent({ busy, finished, backupPending }) if (intent === 'ask' || intent === 'ask-backup') setLeaving((l) => !l) else if (intent === 'open-vault') openDashboard() else onLeave?.()")
    expect(n).toMatch(/if \(intent === 'open-vault'\) openDashboard\(\)/)
  })
})

describe('closing the create dialog while a creation is in progress', () => {
  it('the dialog sends a backdrop click and Esc to onDismiss, not straight to onClose', () => {
    const c = codeOf('./components.tsx')
    expect(c).toMatch(/if \(e\.key === 'Escape'\) \{ e\.preventDefault\(\); dismissRef\.current\(\); return \}/)
    expect(c).toMatch(/<div className=\{className\} onClick=\{\(\) => dismissRef\.current\(\)\}>/)
  })
  it('a reload or tab close warns while the creation is in progress', () => {
    const n = codeOf('./screens/NetVault.tsx')
    expect(n).toMatch(/if \(!busy\) return[\s\S]{0,300}addEventListener\('beforeunload'/)
    // The app's own reload (change the invite or PIN) does not set the warning off.
    expect(n).toMatch(/if \(allowUnloadRef\.current\) return/)
    expect(n).toMatch(/allowUnloadRef\.current = true; window\.location\.reload\(\)/)
  })
})
