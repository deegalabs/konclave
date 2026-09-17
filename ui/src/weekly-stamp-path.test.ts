import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

// Where the "I posted the weekly update" stamp lives is one rule with two implementations, and only
// one of them is in this repo.
//
// `scripts/weekly-update.mjs --posted` WRITES the stamp. A SessionStart hook in `temp/tools/` READS
// it and reports the update as due. #518 moved the generator out of `temp/` and into the repo,
// deliberately leaving the hook behind - the hook is the maintainer's cadence, not a property of the
// project, and one that fires on someone else's clone is a surprise. That reasoning stands.
//
// What came along uninvited was the stamp path. The generator resolved it from its own directory, so
// moving the generator moved the stamp to the REPO ROOT while the hook went on reading `temp/`. The
// command printed "Window moved" and moved nothing; the next session would have reported the same
// week as due. It was caught on 2026-09-17, the first time it ran for real, by an untracked file
// appearing where none belonged - not by the command failing, because the command cannot fail.
//
// The hook is gitignored, so no test can hold BOTH sides. This holds the side the repo owns: the
// script must write the stamp under `temp/`, which is where the hook looks and where an operator's
// own record belongs rather than in the project's history.
describe('the weekly stamp is written where the hook reads it', () => {
  const SRC = readFileSync(
    join(new URL('.', import.meta.url).pathname, '..', '..', 'scripts', 'weekly-update.mjs'),
    'utf8',
  )

  // Only the code. The comment above the line necessarily describes the old path to explain what
  // was fixed, and a scan satisfied or broken by its own comment measures nothing - this repo has
  // shipped that mistake in both directions.
  const CODE = SRC.split('\n')
    .filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l))
    .join('\n')

  it("resolves the stamp under temp/, not the repo root", () => {
    const line = CODE.split('\n').find((l) => l.includes('.weekly-update-stamp'))
    expect(line, 'scripts/weekly-update.mjs no longer names the stamp file').toBeTruthy()
    expect(line, 'the stamp must be joined under temp/, where the hook reads it').toMatch(/'temp'/)
  })

  it('and nothing writes it to the repo root', () => {
    // The shape that broke it: joining straight onto the repo directory. Spelled out rather than
    // inferred, because the failure is silent - the command reports success either way.
    expect(
      /join\(\s*repo\s*,\s*'\.weekly-update-stamp'/.test(CODE),
      'the stamp is being written to the repo root again, where the hook will not find it',
    ).toBe(false)
  })
})
