import { describe, expect, it } from 'vitest'
import { SECTIONS } from './content'
import { DESKTOP_VERSION } from '../desktop-release'
import { codeOf } from '../source-scan'

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
})
