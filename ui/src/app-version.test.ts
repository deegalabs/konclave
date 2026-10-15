/// <reference types="node" />
import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { codeOf } from './source-scan'
import { parseVersionFile, updateLine } from './app-version'

// Three items from Daniel's look at production (14/10): the update banner sat under the mobile menu,
// it named the version already running instead of the one arriving, and the version was only in
// Settings.
describe('the update banner names the version that is arriving', () => {
  it('reads the new build from version.json, and nothing it cannot read', () => {
    expect(parseVersionFile({ version: '0.13.0', commit: 'abc1234' })).toEqual({ version: '0.13.0', commit: 'abc1234' })
    expect(parseVersionFile({ version: '0.13.0' })).toBeNull()
    expect(parseVersionFile({ version: 1, commit: 'abc' })).toBeNull()
    expect(parseVersionFile(null)).toBeNull()
    expect(parseVersionFile({ version: '<b>', commit: 'abc1234' })).toBeNull()
    expect(parseVersionFile({ version: '0.13.0', commit: 'abc 1234' })).toBeNull()
    expect(parseVersionFile({ version: 'x0.13.0', commit: 'abc1234' })).toBeNull()
    expect(parseVersionFile({ version: '0.13.0<b>', commit: 'abc1234' })).toBeNull()
    expect(parseVersionFile({ version: '0.13.0', commit: 'abc1234;' })).toBeNull()
    expect(parseVersionFile({ version: '0.13.0', commit: '<b>abc1234' })).toBeNull()
  })
  it('says from which version to which, and nothing until the new one is known', () => {
    const cur = { version: '0.12.0', commit: '2e1728c' }
    expect(updateLine(cur, { version: '0.13.0', commit: 'abc1234' })).toBe('v0.12.0 → v0.13.0')
    // Same version number, another build: the commits tell them apart.
    expect(updateLine(cur, { version: '0.12.0', commit: 'abc1234' })).toBe('v0.12.0 · 2e1728c → v0.12.0 · abc1234')
    // Not known yet, or the same build: nothing that could read as the new version.
    expect(updateLine(cur, null)).toBe('')
    expect(updateLine(cur, { version: '0.12.0', commit: '2e1728c' })).toBe('')
  })
  it('the build writes version.json, and the banner fetches it past every cache', () => {
    const vite = codeOf('../vite.config.ts')
    expect(vite).toMatch(/fileName: 'version\.json'/)
    expect(vite).toMatch(/JSON\.stringify\(\{ version: pkg\.version, commit: commitSha \}\)/)
    expect(vite).not.toMatch(/name: 'konclave-version-file',\s*apply:/)
    const prompt = codeOf('./UpdatePrompt.tsx')
    expect(prompt).toMatch(/fetch\(`\/version\.json\?t=\$\{Date\.now\(\)\}`, \{ cache: 'no-store' \}\)/)
    expect(prompt).toMatch(/updateLine\(\{ version: __APP_VERSION__, commit: __COMMIT_SHA__ \}, next\)/)
    expect(prompt).toMatch(/\.then\(\(j\) => \{ if \(on\) setNext\(parseVersionFile\(j\)\) \}\)/)
    // Announced once, as a status, with a sentence a screen reader can say; the arrow line is visual.
    // The live region stays in the page; the banner comes and goes inside it, so it is announced.
    expect(prompt).toMatch(/<div role="status">\s*\{needRefresh && \(\s*<div className="pwa-update">/)
    // The same version number arriving again is said as a newer build, not "0.13.1 arriving" twice.
    expect(prompt).toMatch(/next\.version === __APP_VERSION__ \? 'pwa\.versionsBuild' : 'pwa\.versions'/)
    // Each half of the line stays on one row, and the line can still break between them: the arrow
    // sits outside both halves (code audit 6445e5c I1: inside one, the line had no break at all).
    expect(prompt).toMatch(/<span className="nw">\{was\}<\/span>\{' → '\}<span className="nw">\{now\}<\/span>/)
    expect(prompt).toMatch(/<span className="pwa-update-ver mono" aria-hidden="true">/)
  })
})

describe('the version is in the app frame, once', () => {
  it('the frame carries it (the rail on a desktop, the More sheet on a phone), not each page end', () => {
    const layout = codeOf('./Layout.tsx')
    expect(layout).toMatch(/<div className="rail-ver"><VersionBadge \/><\/div>/)
    expect(layout).toMatch(/<div className="more-ver"><VersionBadge \/><\/div>/)
    expect(layout).not.toContain('shell-ver')
    expect(codeOf('./screens/Settings.tsx')).not.toContain('<VersionBadge')
  })
  it('its commit link says it opens a new tab', () => {
    expect(codeOf('./UpdatePrompt.tsx')).toMatch(/aria-label=\{t\('version\.commitLink', \{ sha: __COMMIT_SHA__ \}\)\}/)
  })
  it('the landing page shows it too', () => {
    expect(codeOf('./screens/Intro.tsx')).toContain('<VersionBadge />')
  })
})

describe('the update banner sits above the mobile menu', () => {
  it('where the bottom menu exists, the banner clears it', () => {
    const css = ['lacre.css', 'App.css'].map((f) => readFileSync(new URL(`./${f}`, import.meta.url), 'utf8')).join('\n').replace(/\/\*[\s\S]*?\*\//g, '')
    const body = [...css.matchAll(/([^{}]+)\{([^{}]*)\}/g)].filter((m) => m[1]!.trim() === 'body:has(.railnav) .pwa-update').map((m) => m[2]!).join(';')
    expect(body).toMatch(/bottom:\s*calc\(env\(safe-area-inset-bottom,\s*0px?\) \+ (\d+)px\)/)
    const px = Number(/\+ (\d+)px\)/.exec(body)?.[1] ?? 0)
    expect(px).toBeGreaterThanOrEqual(80)
    // Only where the menu is at the bottom: the same breakpoint as the menu itself.
    expect(css).toMatch(/@media\(max-width:900px\)\{\s*body:has\(\.railnav\) \.pwa-update\{/)
    // The banner sits below the More sheet, which must stay usable while it shows.
    const banner = [...css.matchAll(/([^{}]+)\{([^{}]*)\}/g)].filter((m) => m[1]!.trim() === '.pwa-update').map((m) => m[2]!).join(';')
    expect(Number(/z-index:\s*(\d+)/.exec(banner)?.[1])).toBeLessThan(60)
    // On a phone the rail's version hides (the More sheet carries it there).
    expect(css).toMatch(/@media\(max-width:900px\)\{\s*\.rail-ver\{display:none\}\s*\}/)
  })
  it('the page makes room for the banner, so it covers no content', () => {
    const css = ['lacre.css', 'App.css'].map((f) => readFileSync(new URL(`./${f}`, import.meta.url), 'utf8')).join('\n')
    const desk = /body:has\(\.pwa-update\) \.page\{padding-bottom:(\d+)px\}/.exec(css)
    expect(Number(desk?.[1])).toBeGreaterThanOrEqual(100)
    expect(css).toMatch(/body:has\(\.pwa-update\) \.applayout \.page\{padding-bottom:calc\(80px \+ env\(safe-area-inset-bottom, 0px\) \+ \d{3}px\)\}/)
  })
})

describe('the banner and the menu above it (delta audits on 6445e5c)', () => {
  const css = ['lacre.css', 'App.css'].map((f) => readFileSync(new URL(`./${f}`, import.meta.url), 'utf8')).join('\n').replace(/\/\*[\s\S]*?\*\//g, '')
  it('the rail, which holds the More sheet, stacks above the banner in both layouts', () => {
    // The sheet is above the banner only because it lives inside the rail's stacking context.
    const rails = [...css.matchAll(/(?:^|\})\s*\.rail\{([^}]*)\}/g)].map((m) => Number(/z-index:\s*(\d+)/.exec(m[1]!)?.[1]))
    expect(rails.length).toBeGreaterThanOrEqual(2)
    const banner = Number(/\.pwa-update\{[^}]*z-index:\s*(\d+)/.exec(css)?.[1])
    for (const z of rails) expect(z).toBeGreaterThan(banner)
  })
  it('a half wider than the column still wraps rather than running under the button', () => {
    expect(css).toMatch(/\.pwa-update-ver\{[^}]*overflow-wrap:anywhere/)
  })
  it('the landing\'s commit link keeps the muted colour whatever stylesheet loads last', () => {
    expect(css).toMatch(/\.lv-docs \.version-badge a\{border-bottom:0; color:var\(--text-muted\)\}/)
  })
  it('Escape closes the More sheet, so the keyboard never sits under it', () => {
    expect(codeOf('./Layout.tsx')).toMatch(/if \(e\.key === 'Escape'\) setMoreOpen\(false\)/)
  })
})
