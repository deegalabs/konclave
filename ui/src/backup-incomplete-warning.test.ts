import { describe, expect, it } from 'vitest'
import { codeOf } from './source-scan'

// The incomplete-backup warning on the "keep your backup" screen. A source scan: NetVault does not
// mount at this phase in a test (passphrase-locked-after-protect.test.ts). It pins where the warning
// sits and how the title points at it; it cannot prove what a screen reader says (not verified).
describe('the incomplete-backup warning', () => {
  const src = codeOf('screens/NetVault.tsx')
  const at = src.indexOf('ref={backupTitleRef}')
  const screenSrc = src.slice(at, src.indexOf("tt('net.backup.savedOpen')", at))
  it('comes before the backup buttons, so reading on from the title meets it first', () => {
    const warn = screenSrc.indexOf('className="cv-warn"')
    expect(warn).toBeGreaterThan(-1)
    expect(warn).toBeLessThan(screenSrc.indexOf('className="cv-backup"'))
    expect(warn).toBeGreaterThan(screenSrc.indexOf('className="cv-lead"'))
  })
  it('is not a role="status" region mounted already filled', () => {
    expect(screenSrc).not.toMatch(/className="cv-warn"[^>]*role="status"/)
  })
  it('the title describes itself by the same id, only while the backup is incomplete', () => {
    const id = /<p id="([\w-]+)" className="cv-warn"/.exec(screenSrc)?.[1]
    expect(id, 'the warning has an id').toBeTruthy()
    expect(screenSrc).toContain(`aria-describedby={!backup.complete ? '${id}' : undefined}`)
    expect(screenSrc).toMatch(/\{!backup\.complete && \(\s*<p id=/)
  })
})
