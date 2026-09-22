import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
// @ts-expect-error - a plain .mjs script, deliberately not part of the app's TS build
import { OWNERS } from '../../scripts/changelog-gate.mjs'

// One heading per category, per section.
//
// #540 collapsed fourteen `###` headings in the root file and explained why it matters:
// `release.mjs --notes` reads a section VERBATIM, so a release cut with three separate "Fixed"
// blocks publishes three separate "Fixed" blocks. And scattered across them, nobody scanning can
// see that a section holds nine security entries.
//
// IT CAME STRAIGHT BACK. Within two days `ui/CHANGELOG.md` had `Fixed` three times and `Security`
// twice, and `helper-server/CHANGELOG.md` had `Security` twice - put there by the same person who
// had just fixed it, one PR at a time, each one appending its own block. Caught only because a
// release was about to be cut from it.
//
// That is the lesson worth the test: #540 fixed the instance and not the class. A rule nobody can
// break by accident needs a check, not a cleanup.
const ROOT = join(new URL('.', import.meta.url).pathname, '..', '..')

/** Every `## ...` section of a changelog, as (title, its `###` headings). */
function sections(md: string): Array<[string, string[]]> {
  const out: Array<[string, string[]]> = []
  let title: string | null = null
  let heads: string[] = []
  for (const line of md.split('\n')) {
    if (line.startsWith('## ')) {
      if (title) out.push([title, heads])
      title = line.slice(3).trim()
      heads = []
    } else if (line.startsWith('### ') && title) {
      heads.push(line.slice(4).trim())
    }
  }
  if (title) out.push([title, heads])
  // Only the version sections. A changelog's prose headings ("The categories decide what gets
  // announced") are not release bodies and may repeat whatever they like.
  return out.filter(([t]) => /^\[/.test(t))
}

describe('a changelog section names each category once', () => {
  const files = [...new Set(OWNERS.map(([, f]: [string, string]) => f))] as string[]

  for (const file of files) {
    it(`${file}`, () => {
      for (const [title, heads] of sections(readFileSync(join(ROOT, file), 'utf8'))) {
        const dupes = heads.filter((h, i) => heads.indexOf(h) !== i)
        expect(
          [...new Set(dupes)],
          `${file} · ${title} repeats a category: a release cut from it publishes the same heading twice, and nobody scanning can see how much is under each`,
        ).toEqual([])
      }
    })
  }
})
