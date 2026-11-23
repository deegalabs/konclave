import { readdirSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { codeOf } from './source-scan'
import { approvalsShown, countedNames, hasVoted, myStance, myUncounted, pendingNames, people, rowOf, uncountedNames, type Stance } from './stance'

const row = (seat: number, name: string, stance: Stance['stance'], counted: boolean): Stance => ({ seat, name, stance, counted })

describe('stance (#575): who stands where, from the answer', () => {
  // The case still open in #575, as the coordinator now answers it: bob's approval was recorded
  // unsigned before the vault required signatures, alice's is signed. One approval counts.
  const planted = {
    stances: [row(1, 'alice', 'approved', true), row(2, 'bob', 'approved', false)],
  }

  it('counts only what the coordinator counts, and shows the rest apart', () => {
    expect(countedNames(planted, 'approved')).toEqual(['alice'])
    expect(uncountedNames(planted, 'approved')).toEqual(['bob'])
  })

  it('an uncounted vote is not a vote yet: its member still has to cast one', () => {
    expect(myStance(planted, { name: 'bob' })).toBe('none')
    expect(hasVoted(planted, { name: 'bob' })).toBe(false)
    expect(myUncounted(planted, { name: 'bob' })).toBe('approved')
    expect(hasVoted(planted, { name: 'alice' })).toBe(true)
    expect(pendingNames(planted, ['alice', 'bob'])).toEqual(['bob'])
  })

  it('two seats under one name are two members, and a name alone cannot pick between them', () => {
    const twin = { stances: [row(1, 'bob', 'approved', true), row(2, 'bob', 'none', false)] }
    expect(myStance(twin, { seat: 1, name: 'bob' })).toBe('approved')
    expect(myStance(twin, { seat: 2, name: 'bob' })).toBe('none')
    expect(rowOf(twin, { name: 'bob' })).toBeNull()
    expect(people(twin, ['bob', 'bob'])).toHaveLength(2)
  })

  it('reads rows without a seat by name (the bridge, a vault with no roster)', () => {
    const bridge = { stances: [row(0, 'Ana', 'approved', true)] }
    expect(myStance(bridge, { name: 'Ana ' })).toBe('approved')
    expect(pendingNames(bridge, ['Ana', 'Bruno'])).toEqual(['Bruno'])
    expect(people(bridge, ['Ana', 'Bruno']).map((s) => s.name)).toEqual(['Ana', 'Bruno'])
  })

  it('reads a proposal with no stances (an older bridge or coordinator) as no rows, never a crash', () => {
    const old = {} as { stances?: Stance[] }
    expect(countedNames(old, 'approved')).toEqual([])
    expect(myStance(old, { name: 'Ana' })).toBeNull() // unknown, not 'none': it claims nothing about Ana
    expect(pendingNames(old, ['Ana', 'Bruno'])).toEqual(['Ana', 'Bruno'])
    expect(people(old, ['Ana']).map((s) => s.name)).toEqual(['Ana'])
  })

  it('shows the coordinator count, or a dash when an older coordinator did not say', () => {
    expect(approvalsShown({ approvals_count: 2 })).toBe(2)
    expect(approvalsShown({ approvals_count: 0 })).toBe(0)
    expect(approvalsShown({ approvals_count: null })).toBe('—')
  })

  it('makes no claim for a device that does not know who it is', () => {
    expect(myStance(planted, { name: null })).toBeNull()
  })
})

// The pin: no screen counts or finds approvals by name. One reader, `stance.ts`; test files are
// excluded on purpose (#468: counting them rebuilt the blind spot).
const FORBIDDEN = [
  /\bapprovals\.includes\(/,
  /\brefusals\.includes\(/,
  /\bapprovals\.length\b/,
  /\brefusals\.length\b/,
  /\bapprovals\.join\(/,
  /\brefusals\.join\(/,
  /\bapprovals\[/,
  /\brefusals\[/,
  /\.\.\.\s*\w+\.approvals\b/,
  /\.\.\.\s*\w+\.refusals\b/,
]

describe('the pin: approvals are read from stances, never by name (#575)', () => {
  it('no source file in ui/src reads the name lists to count or find a member', () => {
    const hits: string[] = []
    const walk = (sub: string) => {
      for (const e of readdirSync(new URL(sub, new URL('./', import.meta.url)), { withFileTypes: true })) {
        if (e.isDirectory()) { if (e.name !== 'wasm-pkg') walk(`${sub}${e.name}/`) }
        else if (/\.tsx?$/.test(e.name) && !/\.test\.tsx?$/.test(e.name) && e.name !== 'test-stances.ts') {
          const code = codeOf(`./${sub}${e.name}`)
          for (const re of FORBIDDEN) if (re.test(code)) hits.push(`${sub}${e.name}: ${re}`)
        }
      }
    }
    walk('')
    expect(hits).toEqual([])
  })

  it('the pin can fail: it catches the read #575 removed', () => {
    const old = 'approvals_count: p.approvals.length, const v = p.approvals.includes(me)'
    expect(FORBIDDEN.some((re) => re.test(old))).toBe(true)
  })
})
