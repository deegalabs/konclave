// The seed-path round 2 takes the device's own message, so the rule lives in the module. What the
// module cannot see is WHERE the message a caller passes came from. This pins the callers: any new
// file that reaches `participantRound2(` in the app has to be added here on purpose, by someone
// who has looked at where its message comes from. Comments are stripped before looking (the shared
// reader), since a scan that can be satisfied by a comment checks nothing.
import { readdirSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { codeOf } from './source-scan'

// Self-contained demos: one process holds both the coordinator and the participants.
const DEMOS = ['screens/Recovery.tsx', 'screens/WasmSigner.tsx']

function walk(dir: URL, rel: string, out: string[]) {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    if (e.isDirectory()) {
      if (e.name !== 'wasm-pkg' && e.name !== 'node_modules') walk(new URL(`${e.name}/`, dir), `${rel}${e.name}/`, out)
    } else if (/\.(ts|tsx)$/.test(e.name) && !/\.test\./.test(e.name) && !/\.d\.ts$/.test(e.name)) {
      out.push(`${rel}${e.name}`)
    }
  }
}

describe('who calls the seed-path round 2', () => {
  it('only the self-contained demos do, and the money path never does', () => {
    const files: string[] = []
    walk(new URL('./', import.meta.url), '', files)
    const callers = files
      .filter((f) => /\bparticipantRound2\(/.test(codeOf(`./${f}`)))
      .sort()
    expect(callers).toEqual(DEMOS)
  })
})
