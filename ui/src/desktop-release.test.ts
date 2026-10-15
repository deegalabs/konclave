/// <reference types="node" />
// The desktop version the site names and builds installer links from is ONE variable, the latest
// PUBLISHED pre-release. The landing named 0.8.0 for weeks after newer installers were out, one of them
// before the device's payment check (central's map, D-03, 2026-10-15).
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { DESKTOP_VERSION } from './desktop-release'
import { codeOf } from './source-scan'

const SRC = new URL('./', import.meta.url).pathname

function files(dir: string): string[] {
  return readdirSync(dir).flatMap((f) => {
    const p = join(dir, f)
    if (statSync(p).isDirectory()) return f === 'wasm-pkg' ? [] : files(p)
    return /\.(ts|tsx)$/.test(f) && !/\.test\.tsx?$/.test(f) ? [p] : []
  })
}

describe('the desktop version the site names', () => {
  it('is the latest published pre-release, 0.13.1 (published 2026-10-15)', () => {
    expect(DESKTOP_VERSION).toBe('0.13.1')
  })

  it('appears nowhere else as a literal, comments included', () => {
    const offenders: string[] = []
    for (const f of files(SRC)) {
      if (f.endsWith('desktop-release.ts')) continue
      const text = readFileSync(f, 'utf8')
      for (const m of text.matchAll(/releases\/download\/v0\.\d+\.\d+|\bv0\.(?:[89]|1\d)\.\d+\b(?=[^\n]*(?:pre-?release|installer|desktop|\.msi|\.dmg|AppImage))/g)) {
        offenders.push(`${f.slice(SRC.length)}: ${m[0]}`)
      }
    }
    expect(offenders).toEqual([])
  })

  it('builds the installer names the 0.13.1 release carries', () => {
    const intro = codeOf('./screens/Intro.tsx')
    // The asset names as published (gh release view v0.13.1, 2026-10-15).
    const published = ['Konclave_0.13.1_x64_en-US.msi', 'Konclave_0.13.1_aarch64.dmg', 'Konclave_0.13.1_amd64.AppImage']
    const built = [...intro.matchAll(/file: `(Konclave_\$\{VER\}_[^`]+)`/g)].map((m) => m[1]!.replace('${VER}', DESKTOP_VERSION))
    expect(built.sort()).toEqual([...published].sort())
  })

  it('is called a pre-release, never the latest', () => {
    const content = codeOf('./docs/content.ts')
    for (const line of content.split('\n').filter((l) => l.includes('DESKTOP_VERSION}'))) {
      expect(line, line.slice(0, 80)).toMatch(/pre-release|pré-release/)
      expect(line).not.toMatch(/\blatest\b|última versão/)
    }
  })
})
