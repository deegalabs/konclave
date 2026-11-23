import { describe, expect, it } from 'vitest'
import { readdirSync, statSync } from 'node:fs'
import { join, relative, sep } from 'node:path'
import { codeOf } from './source-scan'

// A console is copied into bug reports and read by extensions. What a device logs names public
// vault material only: never a signing room, nor anything derived from the vault's access secret S
// (the read key, the room, the secret itself). One rule, written once, over every source file.
// The scan matches names, not values: a call that logs a whole object carrying a room, or a
// renamed variable, is not caught. It guards against the forms this app has used, not every form.
const PRIVATE = /\b(room|rooms|roomId|signRoom|signingRoom|accessSecret|readKey|readSecret|secret|tableKey)\b/

/** Every console call in `code` with its argument text (balanced parentheses, one level of nesting
 *  is enough for the calls this app makes, and a longer call is still caught by its first line). */
export function consoleCalls(code: string): string[] {
  const out: string[] = []
  const re = /\bconsole\s*\.\s*(log|info|warn|error|debug|trace)\s*\(/g
  for (let m = re.exec(code); m; m = re.exec(code)) {
    let depth = 1
    let i = re.lastIndex
    for (; i < code.length && depth > 0; i++) {
      if (code[i] === '(') depth++
      else if (code[i] === ')') depth--
    }
    out.push(code.slice(re.lastIndex, i - 1))
  }
  return out
}

// A vault id is a bearer credential for the vault's metadata (and, for an old vault with no read key,
// for its books), so a console names it by its first 8 characters only, as every other call does.
// A key named `vaultId:` is fine; the value it carries is what is checked.
const FULL_ID = /(\b(vaultId|vault_id|groupKey|group_pubkey)\b|\b(record|vault)\.id\b|(?<![.\w$])id\b)(?!\s*:)(?!\s*\.slice\(0,\s*8\))/

function sourceFiles(): string[] {
  const src = join(process.cwd(), 'src')
  const files: string[] = []
  const walk = (d: string) => {
    for (const n of readdirSync(d)) {
      const p = join(d, n)
      if (statSync(p).isDirectory()) { if (n !== 'wasm-pkg') walk(p) } else if (/\.tsx?$/.test(n) && !/\.test\.|\.d\.ts$/.test(n)) files.push(relative(src, p).split(sep).join('/'))
    }
  }
  walk(src)
  return files
}

describe('the console names no private signing detail', () => {
  it('finds a planted call that logs a room, and passes a public one', () => {
    expect(consoleCalls("console.info('x', { proposal: id, room: args.room })").some((a) => PRIVATE.test(a))).toBe(true)
    expect(consoleCalls("console.warn('x', readKey)").some((a) => PRIVATE.test(a))).toBe(true)
    expect(consoleCalls("console.info('[konclave] send: start', { proposal: id, phase })").some((a) => PRIVATE.test(a))).toBe(false)
  })

  it('no source file logs a room or anything derived from the access secret', () => {
    const offenders = sourceFiles().flatMap((f) => consoleCalls(codeOf(f)).filter((a) => PRIVATE.test(a)).map((a) => `${f}: ${a.slice(0, 80)}`))
    expect(offenders).toEqual([])
  })
})

describe('the console names a vault by its first 8 characters only', () => {
  it('finds a planted call with a whole id, and passes a cut one', () => {
    expect(consoleCalls("console.error('x', { action, vaultId, error: e })").some((a) => FULL_ID.test(a))).toBe(true)
    expect(consoleCalls("console.error('x', { vault: vaultId.slice(0, 8) })").some((a) => FULL_ID.test(a))).toBe(false)
    expect(consoleCalls("console.error('x', { vaultId: vaultId.slice(0, 8) })").some((a) => FULL_ID.test(a))).toBe(false)
    expect(consoleCalls("console.error('x', { id: record.id })").some((a) => FULL_ID.test(a))).toBe(true)
    expect(consoleCalls("console.error('x', { id })").some((a) => FULL_ID.test(a))).toBe(true)
    expect(consoleCalls("console.error('x', { id: id.slice(0, 8), p: args.proposalId })").some((a) => FULL_ID.test(a))).toBe(false)
  })

  it('no source file logs a whole vault id', () => {
    const offenders = sourceFiles().flatMap((f) => consoleCalls(codeOf(f)).filter((a) => FULL_ID.test(a)).map((a) => `${f}: ${a.slice(0, 80)}`))
    expect(offenders).toEqual([])
  })
})
