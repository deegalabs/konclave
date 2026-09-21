import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

// `npm i` in this pnpm workspace must fail, and it must fail BEFORE it does anything.
//
// It happened on 2026-09-21: `npm i vercel` instead of `npm i -g vercel`, prompted by the CLI's own
// "new version available" notice. npm SUCCEEDED and left three things - a `package-lock.json`, a
// stray dependency in `package.json`, and an npm install layered into pnpm's `node_modules`, which
// then held both `.pnpm/` and `.package-lock.json`. Nothing broke, which is why it was still there
// when someone happened to read `git status` for an unrelated reason.
//
// NO CI GATE COULD HAVE CAUGHT IT. Two of the three artefacts were gitignored or never committed. A
// check on what is COMMITTED cannot see a mess that never leaves the machine, so the refusal has to
// happen at the moment of the install.
//
// THE OBVIOUS FIX DOES NOT WORK ANY MORE, and that is worth recording. `preinstall` with
// `npx only-allow pnpm` is the standard advice; npm 11.16 does not run the root `preinstall` at all
// (verified with `ignore-scripts=false` and a script that could only be missed by not running). It
// was written, tested in simulation, passed, and then failed the moment it was run for real - which
// is the only reason it is not in this repo.
//
// What does work is `engines` + `engine-strict`, and it needs BOTH halves: the field alone is a
// warning, the setting alone has nothing to enforce. So this test holds them together.
const ROOT = join(new URL('.', import.meta.url).pathname, '..', '..')

describe('npm cannot install in this pnpm workspace', () => {
  const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')) as {
    engines?: Record<string, string>
    packageManager?: string
  }
  const npmrc = readFileSync(join(ROOT, '.npmrc'), 'utf8')

  it('declares an npm engine no npm can satisfy', () => {
    const range = pkg.engines?.npm
    expect(range, 'engines.npm is gone; npm installs again and leaves a lockfile behind').toBeTruthy()
    // Deliberately not a version range. npm prints the requirement verbatim in its EBADENGINE
    // error, so the string IS the error message the person reads - `>=999` would refuse them
    // without telling them what to do instead.
    expect(range, 'the range must read as an instruction, since npm shows it to the user')
      .toMatch(/pnpm/i)
  })

  it('and turns the declaration into a refusal', () => {
    // Without this, `engines` is advisory: npm prints a warning and installs anyway.
    expect(npmrc, '.npmrc lost engine-strict; engines.npm becomes a warning nobody reads')
      .toMatch(/^engine-strict\s*=\s*true$/m)
  })

  it('still says which pnpm the repo expects', () => {
    // The guard refuses the wrong tool; this names the right one, and Corepack reads it.
    expect(pkg.packageManager ?? '').toMatch(/^pnpm@/)
  })
})
