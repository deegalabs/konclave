/// <reference types="node" />
// The desktop version the site names, and the installer links it builds, come from ONE constant: the
// latest PUBLISHED pre-release. The landing named 0.8.0 for weeks after newer installers were out, one of
// them before the device's payment check (central's map, D-03, 2026-10-15).
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { SECTIONS } from './content'
import { DESKTOP_VERSION } from '../desktop-release'
import { codeOf } from '../source-scan'

const SRC = new URL('../', import.meta.url).pathname

/** Every app source file under ui/src, tests and the generated wasm bindings left out. */
function sources(dir = SRC): string[] {
  return readdirSync(dir).flatMap((f) => {
    const p = join(dir, f)
    if (statSync(p).isDirectory()) return f === 'wasm-pkg' ? [] : sources(p)
    return /\.(ts|tsx)$/.test(f) && !/\.test\.tsx?$/.test(f) ? [p] : []
  })
}

/** A typed installer link or asset name: what must never be written by hand. */
function typedInstaller(text: string): string[] {
  return [...text.matchAll(/releases\/(?:download|tag)\/v?\d+\.\d+\.\d+|Konclave_\d+\.\d+\.\d+_/g)].map((m) => m[0])
}

/** A desktop version number written out (v0.13.1, 0.8.0), not an address like 127.0.0.1. */
function versionNumbers(text: string): string[] {
  return [...text.matchAll(/(?<![\d.])v?0\.\d{1,2}\.\d{1,2}(?![\d.])/g)].map((m) => m[0])
}

describe('the desktop version the docs name', () => {
  it('is the published one, the same the landing links to', () => {
    const named = [...JSON.stringify(SECTIONS).matchAll(/\bv(\d+\.\d+\.\d+)\b/g)].map((m) => m[1])
    expect(named.length, 'the docs name a desktop version somewhere').toBeGreaterThan(0)
    expect(named.filter((v) => v !== DESKTOP_VERSION)).toEqual([])
  })

  it('is read by the landing from the same constant, not typed into it', () => {
    const intro = codeOf('./screens/Intro.tsx')
    expect(intro).toMatch(/from '\.\.\/desktop-release'/)
    expect(intro).not.toMatch(/=\s*'\d+\.\d+\.\d+'/)
  })

  it('is the latest published pre-release, 0.13.1 (published 2026-10-15)', () => {
    expect(DESKTOP_VERSION).toBe('0.13.1')
  })

  it('the scans below find what they look for (a positive control)', () => {
    expect(typedInstaller('releases/download/v0.13.1/Konclave_0.13.1_x64_en-US.msi')).toHaveLength(2)
    expect(typedInstaller('see releases/tag/v0.2.0')).toHaveLength(1)
    expect(versionNumbers('the desktop app v0.13.1, or 0.8.0 (pré-release)')).toEqual(['v0.13.1', '0.8.0'])
    expect(versionNumbers('the bridge at 127.0.0.1:4762, 0.0001 ZEC')).toEqual([])
  })

  it('no installer link or asset name is typed anywhere in the app', () => {
    const offenders = sources()
      .filter((f) => !f.endsWith('desktop-release.ts'))
      .flatMap((f) => typedInstaller(readFileSync(f, 'utf8')).map((m) => `${f.slice(SRC.length)}: ${m}`))
    expect(offenders).toEqual([])
  })

  it('the files that name it write no version number of their own, comments included', () => {
    // The stale 0.8.0 sat in a comment, so these are read with their comments.
    const readers = sources().filter((f) => /screens\/Intro\.tsx$|docs\/content\.ts$/.test(f))
    expect(readers, 'both readers found').toHaveLength(2)
    const offenders = readers.flatMap((f) => versionNumbers(readFileSync(f, 'utf8')).map((m) => `${f.slice(SRC.length)}: ${m}`))
    expect(offenders).toEqual([])
  })

  it('builds the installer names the 0.13.1 release carries', () => {
    const intro = codeOf('./screens/Intro.tsx')
    // The asset names as published (gh release view v0.13.1, 2026-10-15).
    const published = ['Konclave_0.13.1_x64_en-US.msi', 'Konclave_0.13.1_aarch64.dmg', 'Konclave_0.13.1_amd64.AppImage']
    const built = [...intro.matchAll(/file: `(Konclave_\$\{VER\}_[^`]+)`/g)].map((m) => m[1]!.replace('${VER}', DESKTOP_VERSION))
    expect(built.sort()).toEqual([...published].sort())
  })

  it('is called a pre-release, never the latest, wherever it is named', () => {
    const lines = [
      ...codeOf('./docs/content.ts').split('\n').filter((l) => l.includes('DESKTOP_VERSION}')),
      // The landing's sentence about the desktop app (the "(v…, a pre-release)" copy), not its links.
      ...codeOf('./screens/Intro.tsx').split('\n').filter((l) => l.includes('(v${VER},')),
    ]
    expect(lines.length, 'the places that name it were found').toBeGreaterThanOrEqual(4)
    for (const line of lines) {
      expect(line, line.trim().slice(0, 80)).toMatch(/pre-release|pré-release/)
      expect(line).not.toMatch(/\blatest\b|última versão/)
    }
  })
})
