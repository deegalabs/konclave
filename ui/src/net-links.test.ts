/// <reference types="node" />
import { describe, expect, it } from 'vitest'
import { readdirSync } from 'node:fs'
import { codeOf } from './source-scan'

// #627 retires the standalone /net page. The first step removed the last screen link that sent a
// member there (Proposal.tsx, a branch the hosted path never reached). This keeps a new one from
// appearing while the page is being taken apart: only NetVault.tsx itself may name /net as a place
// to go. The route in App.tsx is a definition, not a link, and is not matched.
//
// BackgroundSignerLab.tsx was allowed here until its lab link went (#833, which now points the lab
// at /vaults). The entry is gone with it, so the lab is held to the rule like every other screen.
const ALLOWED = new Set(['screens/NetVault.tsx'])

// A navigation to /net (or #/net, /#/net), with or without a query: a router call, a link or
// anchor attribute, or a location write. Help text naming `/net` in quotes is not a navigation.
const TARGET = String.raw`['"\`](?:/?#)?/net\b`
const NAVIGATES_TO_NET = new RegExp([
  String.raw`\b(?:nav|navigate)\(\s*` + TARGET,
  String.raw`\b(?:to|href)=\{?\s*` + TARGET,
  String.raw`\blocation\.(?:hash|href)\s*=\s*` + TARGET,
  String.raw`\blocation\.(?:assign|replace)\(\s*` + TARGET,
].join('|'))

function sourceFiles(): string[] {
  const dir = new URL('./', import.meta.url)
  const files: string[] = []
  const walk = (sub: string) => {
    for (const e of readdirSync(new URL(sub, dir), { withFileTypes: true })) {
      if (e.isDirectory()) { if (e.name !== 'wasm-pkg') walk(`${sub}${e.name}/`) }
      else if (/\.tsx?$/.test(e.name) && !/\.test\.tsx?$/.test(e.name) && !e.name.endsWith('.d.ts')) files.push(`${sub}${e.name}`)
    }
  }
  walk('')
  return files
}

describe('nothing sends a member to /net (#627)', () => {
  it('the pattern catches every form of a navigation to /net, and not a mention of it', () => {
    for (const hit of [
      "if (x) { nav('/net'); return }",
      'navigate(`/net?join=${code}`)',
      '<Link to="/net">/net</Link>',
      "<Link to={'/net'}>",
      '<a href="#/net">',
      '<a href="/#/net?join=abc">',
      "window.location.hash = '#/net'",
      "location.assign('/#/net')",
    ]) expect(hit, hit).toMatch(NAVIGATES_TO_NET)
    for (const miss of [
      "import { b64 } from './net'",
      '<Route path="/net" element={<NetVault />} />',
      "en: 'Two paths. **`/net`** signs the real PCZT'",
      "nav('/network')",
      "nav('/vaults')",
    ]) expect(miss, miss).not.toMatch(NAVIGATES_TO_NET)
  })

  it('no source file but NetVault.tsx navigates to /net', () => {
    const files = sourceFiles()
    expect(files.length).toBeGreaterThan(100)
    const offenders = files.filter((f) => !ALLOWED.has(f) && NAVIGATES_TO_NET.test(codeOf(`./${f}`)))
    expect(offenders).toEqual([])
  })
})
