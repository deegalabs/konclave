import { readdirSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { codeAt, codeOf } from './source-scan'

// A write acts on the vault the screen SHOWS, handed to it and checked by `shownVault`. The
// selection is shared by every tab of a browser, so a function that reads it itself acts on
// whatever another tab opened. This scan walks every source file, finds each top-level declaration
// that reads the selection (a call, an alias, `withVault(`, or the storage key itself), and fails
// for any that is not in the list of READS below, with a reason and an exact count of reads. A listed
// read holds none of the write markers below. That does not mean it writes nothing: getVault,
// getProposals and readBalance keep their own caches under the id they just read, through other
// functions the markers do not name.
const SRC = fileURLToPath(new URL('.', import.meta.url))

const READS_SELECTION = [
  // Every use of the name, whatever follows it: a call, `?.()`, `.call(`, an alias, an argument, a
  // destructured key. Spelling the name from pieces is the one form left, and no source does it.
  /\bgetSelectedVault\b/,
  /\bwithVault\s*\(/,
  /konclave\.selectedVault/,
  /\bVAULT_KEY\b/,
]
const WRITE_MARKERS = [
  /method:\s*['"]POST['"]/, /['"]POST['"]/, /\bupdateLocal\(/, /\bwriteProof\(/, /\bnetVote\(/, /\bnetRenameMember\(/,
  /\blocalStorage\.(setItem|removeItem)/, /\bupdateVaultMeta\(/,
]

/** "file::name" -> how many times it reads the selection, and why it may. A second read fails. A screen that PINS the selection at mount is a read
 *  of it too, and is listed: what it does afterwards uses the pin. */
export const READS: Record<string, { reads: number; why: string }> = {
  'api.ts::withVault': { reads: 2, why: 'builds the ?vault= of a read' },
  'api.ts::getVault': { reads: 2, why: 'read: the selected vault' },
  'api.ts::getProposals': { reads: 3, why: 'read: the selected vault' },
  'api.ts::readBalance': { reads: 3, why: 'read: the selected vault, or the one asked for' },
  'api.ts::readTransactions': { reads: 2, why: 'read: the selected vault' },
  'api.ts::getLedger': { reads: 2, why: 'read: the selected vault' },
  'api.ts::ledgerCsvUrl': { reads: 1, why: 'read: the link of an export of the selected vault' },
  'api.ts::getBookWithLines': { reads: 1, why: 'read: the selected vault' },
  'api.ts::getProposalDetail': { reads: 1, why: 'read: the selected vault, or the one asked for' },
  'vault-readable.ts::useVaultReadable': { reads: 1, why: 'read: whether the selected vault can be read' },
  'Layout.tsx::Layout': { reads: 2, why: 'the shell that owns the selection: keys the signer and the seat notice by it' },
  'screens/Dashboard.tsx::Dashboard': { reads: 2, why: 'read: the dashboard of the selected vault, no write of its own' },
  'screens/Ceremonies.tsx::Ceremonies': { reads: 2, why: 'read: the ceremonies of the selected vault' },
  'screens/SinceLast.tsx::SinceLast': { reads: 1, why: 'read: what changed in the selected vault' },
  'screens/Settings.tsx::Settings': { reads: 1, why: 'pins the selection at mount' },
  'screens/People.tsx::People': { reads: 1, why: 'pins the selection at mount' },
  'screens/Members.tsx::Members': { reads: 1, why: 'pins the selection at mount' },
  'screens/Proposal.tsx::Proposal': { reads: 1, why: 'pins the selection at mount' },
  'screens/Ledger.tsx::Ledger': { reads: 1, why: 'pins the selection at mount' },
  'screens/NewPayment.tsx::NewPayment': { reads: 1, why: 'pins the selection at mount' },
  'screens/NewPayroll.tsx::NewPayroll': { reads: 1, why: 'pins the selection at mount' },
}
/** Declarations that read the selection AND hold a write that does not use it (a whole screen is one
 *  declaration). Each says why and how many reads of the selection it holds, so a second one fails. */
export const MIXED: Record<string, { reads: number; why: string }> = {
  'screens/Receive.tsx::Receive': { reads: 1, why: 'asks only whether a vault is selected, to word a failed read; its writes name the vault they hold' },
  'screens/NetVault.tsx::NetVault': { reads: 1, why: 'standalone page: restores the selected vault into its own form; its writes act on the vault it holds' },
  'remove-vault.ts::clearVaultTraces': { reads: 1, why: 'removes what the browser kept for the id it is GIVEN; reads the selection only to end it if it names that id' },
}
/** Open items listed with their reason: "file::name" -> reason. */
export const KNOWN_OPEN: Record<string, string> = {}

function files(dir: string): string[] {
  return readdirSync(dir).flatMap((n) => {
    const p = join(dir, n)
    if (statSync(p).isDirectory()) return n === 'wasm-pkg' ? [] : files(p)
    return /\.(ts|tsx)$/.test(n) && !/\.(test|spec)\.|\.d\.ts$/.test(n) ? [p] : []
  })
}

/** Top-level declarations: from a column-0 `function`/`const`/`export` line to the line before the next one. */
export function declarationsOf(code: string): { name: string; body: string }[] {
  const out: { name: string; body: string }[] = []
  const lines = code.split('\n')
  const start = /^(?:export\s+)?(?:default\s+)?(?:async\s+)?(?:function\s+(\w+)|(?:const|let|var)\s+(\w+))/
  const top = /^(?:export|function|async|const|let|var|type|interface|import|class|enum)\b/
  for (let i = 0; i < lines.length; i++) {
    const m = start.exec(lines[i]!)
    if (!m) continue
    let j = i + 1
    while (j < lines.length && !top.test(lines[j]!)) j++
    out.push({ name: m[1] ?? m[2]!, body: lines.slice(i, j).join('\n') })
    i = j - 1
  }
  return out
}

const noImports = (body: string) => body.replace(/^(?:import|export)\b[^;'"]*?\bfrom\s*['"][^'"]*['"]/gm, '')
export const readsSelection = (body: string) => READS_SELECTION.some((r) => r.test(noImports(body)))
export const selectionReads = (body: string) => READS_SELECTION.reduce((n, r) => n + (noImports(body).match(new RegExp(r.source, 'g'))?.length ?? 0), 0)
export const writes = (body: string) => WRITE_MARKERS.some((r) => r.test(body))

/** Every declaration that reads the selection and is in neither list, as "file::name". */
export function unlisted(file: string, code: string, listed: Record<string, unknown>): string[] {
  if (file === 'shown-vault.ts') return []
  return declarationsOf(code).filter((d) => readsSelection(d.body) && !(`${file}::${d.name}` in listed)).map((d) => `${file}::${d.name}`)
}

/** The selection read through a renamed import (`getSelectedVault as x`), in a file other than the one that defines it. */
export const renamedImport = (file: string, code: string): string[] =>
  file !== 'shown-vault.ts' && /\bgetSelectedVault\s+as\s+\w+/.test(code) ? [`${file}::getSelectedVault as`] : []
/** The storage key written in any spelling (whole, split, template, bracket access) outside shown-vault.ts. */
export const spellsKey = (file: string, code: string): string[] =>
  file !== 'shown-vault.ts' && /selectedVault/.test(code) ? [`${file} spells the selection key`] : []
/** Reads of the selection that no declaration holds (an indented declaration before the first one, say). */
export const outsideDeclarations = (file: string, code: string): string[] =>
  file !== 'shown-vault.ts' && selectionReads(code) !== declarationsOf(code).reduce((n, d) => n + selectionReads(d.body), 0) ? [`${file} reads the selection outside a top-level declaration`] : []

const ALL = Object.fromEntries(files(SRC).map((p) => [relative(SRC, p), codeAt(p)]))

describe('a function that reads the selection is a listed read', () => {
  it('no source file reads the selection outside the list', () => {
    const found = Object.entries(ALL).flatMap(([f, code]) => unlisted(f, code, { ...READS, ...MIXED, ...KNOWN_OPEN }))
    expect(found, 'add the vault the screen shows as a parameter (shownVault), or list a READ with its reason').toEqual([])
  })

  it('no source file imports the read under another name, spells its key, or reads it outside a declaration', () => {
    const found = Object.entries(ALL).flatMap(([f, code]) => [...renamedImport(f, code), ...spellsKey(f, code), ...outsideDeclarations(f, code)])
    expect(found).toEqual([])
  })

  it('the scan sees a renamed import, a split key, bracket access and an indented declaration', () => {
    expect(renamedImport('x.ts', "import { getSelectedVault as pick } from './api'\n")).toHaveLength(1)
    expect(renamedImport('x.ts', "export { getSelectedVault as pick } from './shown-vault'\n")).toHaveLength(1)
    expect(renamedImport('x.ts', "import { getSelectedVault } from './api'\n")).toEqual([])
    expect(spellsKey('x.ts', "const k = 'konclave.' + 'selectedVault'\n")).toHaveLength(1)
    expect(spellsKey('x.ts', "localStorage['konclave.selectedVault']\n")).toHaveLength(1)
    expect(spellsKey('x.ts', "const k = `konclave.${'selectedVault'}`\n")).toHaveLength(1)
    expect(spellsKey('shown-vault.ts', "const k = 'konclave.selectedVault'\n")).toEqual([])
    expect(outsideDeclarations('x.ts', "import a from 'a'\n function sneaky() { return getSelectedVault() }\nexport function ok() { return 1 }\n")).toHaveLength(1)
  })

  it('a listed read holds no write marker, reads the selection exactly as often as listed, and still exists', () => {
    const bad: string[] = []
    for (const key of Object.keys(READS)) {
      const [f, name] = key.split('::') as [string, string]
      const d = declarationsOf(ALL[f] ?? '').find((x) => x.name === name)
      if (!d) bad.push(`${key} (gone)`)
      else if (writes(d.body)) bad.push(`${key} (holds a write marker)`)
      else if (selectionReads(d.body) !== READS[key]!.reads) bad.push(`${key} (reads the selection ${selectionReads(d.body)} times, listed ${READS[key]!.reads})`)
    }
    for (const [key, m] of Object.entries(MIXED)) {
      const [f, name] = key.split('::') as [string, string]
      const d = declarationsOf(ALL[f] ?? '').find((x) => x.name === name)
      if (!d) bad.push(`${key} (gone)`)
      else if (selectionReads(d.body) !== m.reads) bad.push(`${key} (reads the selection ${selectionReads(d.body)} times, listed ${m.reads})`)
    }
    expect(bad).toEqual([])
  })

  it('the scan sees each way of reading the selection, and a read that is listed passes', () => {
    const planted: Record<string, string> = {
      call: "export async function a() {\n  const id = getSelectedVault()\n}\n",
      alias: "const pick = getSelectedVault\nexport function b() { return pick() }\n",
      arrowConst: "export const c = async (x: string) => {\n  return fetch(withVault(x), { method: 'POST' })\n}\n",
      arrowWith: "const d = (x: string) => x + getSelectedVault()\n",
      withVaultPost: "export async function e() {\n  await fetch(`${BASE}${withVault('/api/x')}`, { method: 'POST' })\n}\n",
      direct: "export function f() {\n  return localStorage.getItem('konclave.selectedVault')\n}\n",
      passed: "export function g() {\n  return use(getSelectedVault)\n}\n",
      optional: "export function o() {\n  return getSelectedVault?.()\n}\n",
      called: "export function c() {\n  return getSelectedVault.call(null)\n}\n",
      destructured: "export function k() {\n  const { getSelectedVault: pick } = ns\n  return pick()\n}\n",
    }
    for (const [k, code] of Object.entries(planted)) expect(unlisted('x.ts', code, {}), k).toHaveLength(1)
    expect(unlisted('x.ts', planted.call!, { 'x.ts::a': 'read' })).toEqual([])
    expect(unlisted('x.ts', "import { getSelectedVault } from './api'\nexport function h() { return 1 }\n", {})).toEqual([])
    expect(unlisted('shown-vault.ts', planted.direct!, {})).toEqual([])
  })

  it('the scan sees a write in a listed read', () => {
    expect(writes("fetch(x, { method: 'POST' })")).toBe(true)
    expect(writes("fetch(x, { method: \"POST\" })")).toBe(true)
    expect(writes("localStorage.removeItem(k)")).toBe(true)
    expect(writes("return await readLocal(id, 'benef')")).toBe(false)
  })

  it('the scan finds the declarations of the real files (it is not scanning nothing)', () => {
    const names = declarationsOf(codeOf('api.ts')).map((d) => d.name)
    for (const n of ['addBeneficiary', 'deleteBeneficiary', 'renameSelf', 'adoptSelfName', 'voteProposal', 'createProposal', 'unlockVault']) expect(names).toContain(n)
    expect(declarationsOf(codeOf('recent-payees.ts')).map((d) => d.name)).toContain('pushRecentPayee')
  })

  it('the answer-about-the-pinned-vault comparison lives in pinnedAnswer only', () => {
    expect(codeOf('shown-vault.ts')).toMatch(/got\.id === pinned/)
    for (const f of ['screens/Settings.tsx', 'screens/NewPayment.tsx', 'screens/NewPayroll.tsx', 'screens/Members.tsx', 'screens/Proposal.tsx']) {
      expect(codeOf(f), f).not.toMatch(/\.id\s*===\s*pinned/)
      expect(codeOf(f), f).toMatch(/pinnedAnswer\(/)
    }
  })
})
