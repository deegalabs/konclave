/// <reference types="node" />
// The network-upgrade rules have one home, `konclave-seal::epochs`, and the app reads them through
// WASM (#638). Nothing in the app's own code may carry a row of the table or the margin: it would be a
// second copy that a release changes in one place and not the other.
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { codeOf } from './source-scan'

const SRC = new URL('.', import.meta.url).pathname

function appFiles(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name)
    if (name === 'wasm-pkg' || name === 'node_modules') continue
    if (statSync(p).isDirectory()) appFiles(p, out)
    else if (/\.(ts|tsx)$/.test(name) && !/\.test\.|test-vectors|demo-vector/.test(name)) out.push(p)
  }
  return out
}

describe('the app carries no row of the epoch table', () => {
  it('has no branch id, activation height, anchor time or group id of an upgrade in its own code', () => {
    const literals = ['37a5165b', '77190ad9', '3428143', '1785247643', 'd884b698', '3543405']
    for (const file of appFiles(SRC)) {
      const text = readFileSync(file, 'utf8')
        .split('\n')
        .map((l) => l.split('//')[0])
        .join('\n')
        .toLowerCase()
        .replace(/[_,]/g, '')
      for (const lit of literals) expect(text, `${file}: ${lit} belongs to konclave-seal::epochs`).not.toContain(lit)
    }
  })

  it('does not write its own ten-block margin next to a signed expiry', () => {
    for (const file of appFiles(SRC)) {
      const code = readFileSync(file, 'utf8').split('\n').map((l) => l.split('//')[0]).join('\n')
      expect(code, file).not.toMatch(/\b(expiry|\.e|firstExpiry)\s*\+\s*10\b/)
    }
  })
})

describe('the branch a device records is its own reading', () => {
  const machine = () => codeOf('./signing-machine.ts')
  it('is taken from what readForSigning returned, and from nothing the request carries', () => {
    const src = machine()
    expect(src).toMatch(/this\.branch = read\.branch/)
    // No other assignment of the branch, and no read of one off the wire message.
    expect(src.match(/this\.branch\s*=/g)).toHaveLength(2) // the reading, and the reset in rearm()
    expect(src).not.toMatch(/(parsed|req|request|msg|m)\.(branch|branch_id|b)\b/)
  })
  it('is what the record is written with', () => {
    expect(machine()).toMatch(/this\.d\.record\(bytesToHex\(this\.msg\), this\.expiry, this\.branch\)/)
  })
})
