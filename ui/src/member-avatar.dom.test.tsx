// @vitest-environment jsdom
// #315: a member's face comes from the vault and the seat position, never from the name, so a
// rename does not change it and two members with the same name do not share it. It is NOT derived
// from a key: it cannot tell two devices of one seat apart and does not detect an impostor; it only
// keeps one face per seat, on every screen.
import { describe, expect, it } from 'vitest'
import { render } from '@testing-library/react'
import { Identicon, memberSeed, seedForName, NEUTRAL } from './avatar'
import { codeOf } from './source-scan'

// The DRAWING only (which cells are filled), not the colour: a repeated pattern in another hue is
// still the same face to a reader.
const face = (seed: string) =>
  [...render(<Identicon seed={seed} size={40} />).container.querySelectorAll('rect')].slice(1).map((r) => `${r.getAttribute('x')},${r.getAttribute('y')}`).sort().join(' ')

describe('a member face is the seat, not the name (#315)', () => {
  it('every seat of a vault has its own face, and the name plays no part', () => {
    // The last id draws seats 9 and 12 alike under a seed written in decimal ("id:9", "id:12").
    for (const vault of ['ab'.repeat(32), 'cd'.repeat(32), '0123456789abcdef'.repeat(4), '0505e63b335075c4fc44526a3c96937829e993a0ffbc818a8f5ece03503f3948']) {
      const faces = Array.from({ length: 15 }, (_, seat) => face(memberSeed(vault, seat)))
      expect(new Set(faces).size).toBe(15)
    }
    expect(memberSeed('AB'.repeat(32), 2)).toBe(memberSeed('ab'.repeat(32), 2))
  })

  it('a name resolves to its seat only when it is in the list exactly once', () => {
    const v = 'ab'.repeat(32)
    const list = [{ name: 'Ana' }, { name: 'Bia' }, { name: 'Ana' }, { name: 'Caio' }]
    expect(seedForName(v, list, 'Bia')).toBe(memberSeed(v, 1))
    expect(seedForName(v, list, ' Caio ')).toBe(memberSeed(v, 3))
    // Two members named Ana: neither face is guessed.
    expect(seedForName(v, list, 'Ana')).toBe(NEUTRAL)
    // Not in the list, or no list read, or no vault: the neutral face, never one seeded by the name.
    expect(seedForName(v, list, 'Dora')).toBe(NEUTRAL)
    expect(seedForName(v, undefined, 'Bia')).toBe(NEUTRAL)
    expect(seedForName(null, list, 'Bia')).toBe(NEUTRAL)
  })
})

describe('every member avatar goes through the seat rule (#315)', () => {
  // The screens that draw a member's face. Avatars of payees, addresses and vaults are not members.
  const MEMBER_SITES = [
    'screens/Members.tsx', 'MembersPeek.tsx', 'screens/SigningPanel.tsx', 'screens/Vaults.tsx', 'Layout.tsx',
    'screens/Proposals.tsx', 'screens/Dashboard.tsx', 'screens/Proposal.tsx', 'screens/SinceLast.tsx',
  ]
  // Non-member faces in those files, by the exact seed they use.
  const NOT_MEMBERS = ['seed="konclave-encrypted-backup"', 'seed={impParsed.vault.groupKey || impParsed.vault.id}', 'seed={v.id}']

  for (const f of MEMBER_SITES) {
    it(`${f} seeds member faces by seat`, () => {
      const src = codeOf(f)
      const seeds = [...src.matchAll(/<Identicon[^>]*?seed=(\{[^}]*\}|"[^"]*")/g)].map((m) => `seed=${m[1]}`)
      const members = seeds.filter((s) => !NOT_MEMBERS.includes(s))
      expect(members.length).toBeGreaterThan(0)
      // The expression starts with the rule: nothing seeded by a name, with the rule as a fallback.
      const allowed = f === 'Layout.tsx' ? /^seed=\{(memberSeed\(|seedForName\(|NEUTRAL\}|s\})/ : /^seed=\{(memberSeed\(|seedForName\(|NEUTRAL\})/
      for (const s of members) expect(s, f).toMatch(allowed)
    })
  }
  it('the rail\'s faces in Layout.tsx are the seats', () => {
    expect(codeOf('Layout.tsx')).toMatch(/const seeds = vault\?\.member_list\?\.length \? vault\.member_list\.slice\(0, 3\)\.map\(\(_, i\) => memberSeed\(vault\.id, i\)\) : \[\]/)
  })
})
