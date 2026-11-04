/// <reference types="node" />
// The lab pages are a demonstration of the engine, and none of them may reach a vault a member owns.
// /lab/background-signer did: it listed the device's vaults, unlocked one (which registers its keys
// with the coordinator), joined that vault's real signing room and could publish a test request into
// it. It now runs on a vault of its own (lab-vault.ts). This scan keeps every lab page that way.
//
// What it can and cannot see. It reads each lab page's OWN imports and calls, comments removed. It
// does not follow them: signing-machine.ts imports ./net and signing.ts imports ./storage, so those
// modules stay in the graph of the lab through the signing core, as they do for every screen. That
// the lab never CALLS them is held by a run, in lab-vault.test.ts, with the network and IndexedDB
// taken away.
import { readdirSync } from 'node:fs'
import ts from 'typescript'
import { describe, expect, it } from 'vitest'
import { codeOf } from './source-scan'

/** Every page reachable from /lab: the hub and the four demonstrations it links to. */
const LAB_PAGES = [
  './screens/Lab.tsx',
  './screens/BackgroundSignerLab.tsx',
  './screens/WasmSigner.tsx',
  './screens/Recovery.tsx',
  './screens/Inheritance.tsx',
]

/** The modules that reach a member's real vault: its storage, its session, its unlock, the relay and
 *  the coordinator, and the hook that wires all of them to a vault's signing room. */
const FORBIDDEN_MODULES = [
  '../storage',
  '../unlock',
  '../session',
  '../net',
  '../api',
  '../helper',
  '../device-registration',
  '../useBackgroundSigner',
]

/** The calls that do it, by name, wherever they are imported from. */
const FORBIDDEN_CALLS = [
  'listVaults',
  'loadVault',
  'unlockOnDevice',
  'unlockWith',
  'getUnlockedShare',
  'setUnlockedShare',
  'RelaySession',
  'relayPost',
  'useBackgroundSigner',
  'indexedDB',
  'fetch',
  'WebSocket',
]

function importsOf(path: string): string[] {
  // Through source-scan, like every read of our source: a commented-out import is not an import.
  const src = codeOf(path)
  const sf = ts.createSourceFile(path, src, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX)
  const out: string[] = []
  sf.forEachChild((n) => {
    if ((ts.isImportDeclaration(n) || ts.isExportDeclaration(n)) && n.moduleSpecifier && ts.isStringLiteral(n.moduleSpecifier)) {
      out.push(n.moduleSpecifier.text)
    }
  })
  // A dynamic import is an import too.
  for (const m of src.matchAll(/import\(\s*['"]([^'"]+)['"]\s*\)/g)) out.push(m[1]!)
  return out
}

describe('the lab pages never reach a real vault', () => {
  for (const page of LAB_PAGES) {
    it(`${page} imports none of the modules that reach one`, () => {
      const hits = importsOf(page).filter((m) => FORBIDDEN_MODULES.includes(m.replace(/\.(ts|tsx|js)$/, '')))
      expect(hits).toEqual([])
    })

    it(`${page} calls none of the functions that do it`, () => {
      const code = codeOf(page)
      const hits = FORBIDDEN_CALLS.filter((name) => new RegExp(`\\b${name}\\b`).test(code))
      expect(hits).toEqual([])
    })
  }

  // The scan has to see what it is looking for, or a green run means nothing: run it on the page
  // that held the defect, as it was, and on the product's signer, which is meant to do all of it.
  it('catches the defect it exists for', () => {
    const before = [
      "import { listVaults, type VaultPublic } from '../storage'",
      "import { getUnlockedShare } from '../session'",
      "import { unlockOnDevice } from '../unlock'",
      "import { useBackgroundSigner } from '../useBackgroundSigner'",
    ].join('\n')
    const sf = ts.createSourceFile('before.tsx', before, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX)
    const mods: string[] = []
    sf.forEachChild((n) => { if (ts.isImportDeclaration(n) && ts.isStringLiteral(n.moduleSpecifier)) mods.push(n.moduleSpecifier.text) })
    expect(mods.filter((m) => FORBIDDEN_MODULES.includes(m))).toEqual(['../storage', '../session', '../unlock', '../useBackgroundSigner'])
    expect(FORBIDDEN_CALLS.filter((name) => new RegExp(`\\b${name}\\b`).test(codeOf('./VaultSigner.tsx')))).toContain('useBackgroundSigner')
  })

  // The lab vault holds a DKG driver of its own, exempt from the rule that app code creates vaults
  // through CreationSession (dkg-ceremony.test.ts). That exemption is safe only while the lab is the
  // one thing that can reach it: one importer, and a fixed set of exports that hands out no DKG.
  it('only the lab screen imports the lab vault', () => {
    const SRC = new URL('.', import.meta.url).pathname
    const importers: string[] = []
    const walk = (dir: string) => {
      for (const e of readdirSync(SRC + dir, { withFileTypes: true })) {
        if (e.isDirectory()) { if (e.name !== 'wasm-pkg') walk(`${dir}${e.name}/`); continue }
        if (!/\.(ts|tsx)$/.test(e.name) || /\.test\.tsx?$/.test(e.name)) continue
        const path = `./${dir}${e.name}`
        if (importsOf(path).some((m) => /(^|\/)lab-vault(\.ts)?$/.test(m))) importers.push(path)
      }
    }
    walk('')
    expect(importers).toEqual(['./screens/BackgroundSignerLab.tsx'])
  })

  it('the lab vault exports exactly its fixed list, and re-exports nothing', () => {
    const sf = ts.createSourceFile('lab-vault.ts', codeOf('./lab-vault.ts'), ts.ScriptTarget.Latest, true, ts.ScriptKind.TS)
    const names: string[] = []
    let reexports = 0
    sf.forEachChild((n) => {
      if (ts.isExportDeclaration(n) || ts.isExportAssignment(n)) { reexports++; return }
      const exported = ts.canHaveModifiers(n) && ts.getModifiers(n)?.some((m) => m.kind === ts.SyntaxKind.ExportKeyword)
      if (!exported) return
      if (ts.isVariableStatement(n)) n.declarationList.declarations.forEach((d) => names.push(d.name.getText(sf)))
      else if ((ts.isClassDeclaration(n) || ts.isFunctionDeclaration(n) || ts.isInterfaceDeclaration(n) || ts.isTypeAliasDeclaration(n)) && n.name) names.push(n.name.text)
    })
    expect(reexports).toBe(0)
    expect(names.sort()).toEqual(['LabDevice', 'LabVault', 'LabVaultOptions'])
  })

  it('the lab vault itself opens no relay, no coordinator and no storage', () => {
    const mods = importsOf('./lab-vault.ts').map((m) => m.replace(/\.(ts|tsx|js)$/, ''))
    expect(mods.filter((m) => FORBIDDEN_MODULES.includes(m.replace(/^\.\//, '../')))).toEqual([])
    const code = codeOf('./lab-vault.ts')
    expect(FORBIDDEN_CALLS.filter((name) => new RegExp(`\\b${name}\\b`).test(code))).toEqual([])
  })
})
