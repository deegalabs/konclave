import { describe, expect, it } from 'vitest'
import { readdirSync } from 'node:fs'
import { join } from 'node:path'
import { codeAt, codeOf } from './source-scan'

// #1067: one rule for a member's coordinator or relay address, and no second copy of it. Every
// non-test source file under src/ is read with its comments stripped (source-scan), so neither a
// comment that names the old check nor a commented-out call can pass or fail this.
//
// What is matched, precisely:
// - the old screens' regex, by its escaped text `https:\/\/\S` (any regex literal or string that
//   carries it), anywhere;
// - the two storage keys, `konclave.coord.url` and `konclave.relay.url`, as text, anywhere but
//   service-url.ts: storing or reading them elsewhere would skip the rule;
// - and, in the other direction, that both screens call `parseServiceUrl` and that both setters and
//   both readers go through `storeServiceUrl` / `readServiceUrl`.
// `new URL(...)` elsewhere (HostNotice, the share links) is not an address a member stores, and is not
// matched. Test files are excluded on purpose: about twenty of them seed `konclave.coord.url` straight
// into storage to exercise the reader, which is the checked path, and none of them reaches the bundle.
const src = join(__dirname)
const files = (dir: string): string[] =>
  readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const p = join(dir, e.name)
    if (e.isDirectory()) return e.name === 'wasm-pkg' ? [] : files(p)
    return /\.(ts|tsx)$/.test(e.name) && !/\.test\.tsx?$/.test(e.name) ? [p] : []
  })
const rel = (f: string) => f.slice(src.length + 1)

describe('one rule for a service address (#1067)', () => {
  it('the old regex is gone, and the storage keys live only in service-url.ts', () => {
    const offenders: string[] = []
    let walked = 0
    for (const f of files(src)) {
      walked++
      const code = codeAt(f)
      if (code.includes('https:\\/\\/\\S')) offenders.push(`${rel(f)}: the old address regex`)
      if (rel(f) !== 'service-url.ts' && /konclave\.(coord|relay)\.url/.test(code)) offenders.push(`${rel(f)}: a stored address key`)
    }
    expect(offenders).toEqual([])
    expect(walked).toBeGreaterThan(100) // the walk saw the app, so an empty walk cannot pass
    expect(codeOf('service-url.ts')).toMatch(/konclave\.coord\.url/)
  })

  it('both screens, both setters and both readers go through the rule', () => {
    expect(codeOf('screens/Settings.tsx')).toMatch(/parseServiceUrl\(/)
    expect(codeOf('screens/Vaults.tsx')).toMatch(/parseServiceUrl\(/)
    const fn = (file: string, name: string) => {
      const code = codeOf(file)
      const at = code.indexOf(`export function ${name}(`)
      expect(at, `${file}: ${name}`).toBeGreaterThan(-1)
      return code.slice(at, code.indexOf('\n}', at))
    }
    expect(fn('helper.ts', 'setCoordMode')).toMatch(/storeServiceUrl\('coordinator'/)
    expect(fn('net.ts', 'setRelay')).toMatch(/storeServiceUrl\('relay'/)
    expect(fn('helper.ts', 'getCustomHelper')).toMatch(/readServiceUrl\('coordinator'\)/)
    expect(fn('net.ts', 'getCustomRelay')).toMatch(/readServiceUrl\('relay'\)/)
    expect(fn('helper.ts', 'helperBase')).toMatch(/getCustomHelper\(\)/)
    expect(fn('net.ts', 'relayBase')).toMatch(/getCustomRelay\(\)/)
  })
})
