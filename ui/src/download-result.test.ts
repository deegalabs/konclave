import { describe, expect, it } from 'vitest'
import { readdirSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { codeOf } from './source-scan'

// #983: downloadText / downloadBlob answer whether the browser took the file. A caller that drops
// the answer can tell a member a backup or an export was saved when nothing was. Every call uses it.
const here = fileURLToPath(new URL('.', import.meta.url)).replace(/\/$/, '')
function sources(dir = here): string[] {
  const out: string[] = []
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const path = `${dir}/${e.name}`
    if (e.isDirectory()) { if (!['wasm-pkg', 'node_modules'].includes(e.name)) out.push(...sources(path)); continue }
    if (/\.(ts|tsx)$/.test(e.name) && !/\.test\.tsx?$/.test(e.name)) out.push(path.slice(here.length + 1))
  }
  return out
}

describe('every download call acts on whether the file was taken (#983)', () => {
  it('no call to downloadText or downloadBlob throws its answer away', () => {
    const dropped: string[] = []
    for (const f of sources()) {
      if (f === 'download.ts') continue
      const src = codeOf(f)
      for (const m of src.matchAll(/(?<![A-Za-z0-9_.])download(Text|Blob)\(/g)) {
        const before = src.slice(Math.max(0, m.index! - 40), m.index).replace(/\s+$/, '')
        // Used: in a condition, returned, assigned, or negated. Dropped: a bare statement or an arrow body.
        if (!/(\(|!|=(?!>)|return|\?|&&|\|\|)$/.test(before)) dropped.push(`${f}: ${src.slice(m.index!, m.index! + 40)}`)
      }
    }
    expect(dropped).toEqual([])
  }, 30_000)

  it('the /net backup is taken only when the file was, and a refusal is said', () => {
    const src = codeOf('screens/NetVault.tsx')
    expect(src).toMatch(/const ok = downloadText\(backup\.name, backup\.json\)\s*setBackupDownloadFailed\(!ok\)\s*if \(ok\) setBackupTaken\(true\)/)
    expect(src).toMatch(/\{backupDownloadFailed && <p className="net-tip" role="alert">\{tt\('export\.errDownload'\)\}<\/p>\}/)
  })

  it('the resume backup in Vaults says a refused download', () => {
    const src = codeOf('screens/Vaults.tsx')
    expect(src).toMatch(/setResumeDownloadFailed\(!downloadText\(resumeDone\[v\.id\]!\.name, resumeDone\[v\.id\]!\.json\)\)/)
    expect(src).toMatch(/\{resumeDownloadFailed && <p className="hint err" role="alert">\{t\('export\.errDownload'\)\}<\/p>\}/)
  })

  it('the Ledger says a refused export', () => {
    const src = codeOf('screens/Ledger.tsx')
    expect(src).toMatch(/const saved = kind === 'xlsx' \? await exportLedgerXlsx\(data\) : await exportLedgerCsv\(data, locale\)\s*setExportFailed\(!saved\)/)
    expect(src).toMatch(/\{exportFailed && <p className="hint err" role="alert">\{t\('download\.failed'\)\}<\/p>\}/)
  })
})
