import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { COORDINATOR_CODE_KEYS, refusalKey } from './conclude-registration'
import { codeAt } from './source-scan'
import { en } from './i18n/en'
import { ptBR } from './i18n/pt-BR'

const root = join(__dirname)

function sources(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name)
    if (statSync(path).isDirectory()) return name === 'wasm-pkg' || name === 'i18n' ? [] : sources(path)
    return /\.tsx?$/.test(name) && !/\.test\.tsx?$/.test(name) ? [path] : []
  })
}

describe('what the coordinator refuses with, in words', () => {
  it('every coordinator code maps to one sentence in both languages', () => {
    for (const [code, key] of Object.entries(COORDINATOR_CODE_KEYS)) {
      expect(en[key], code).toBeTruthy()
      expect(ptBR[key], code).toBeTruthy()
      expect(ptBR[key], `${code} is translated`).not.toBe(en[key])
    }
    expect(new Set(Object.values(COORDINATOR_CODE_KEYS)).size, 'one sentence per code').toBe(Object.keys(COORDINATOR_CODE_KEYS).length)
  })

  it('knows every code the coordinator can answer with', () => {
    const server = readFileSync(join(root, '../../helper-server/src/main.rs'), 'utf8').split('#[cfg(test)]\nmod tests')[0] ?? ''
    const said = new Set([...server.matchAll(/coded\(\s*\d+,\s*"([a-z_0-9]+)"/g)].map((m) => m[1] ?? ''))
    expect(said.size, 'the scan reads something').toBeGreaterThan(5)
    for (const code of said) expect(COORDINATOR_CODE_KEYS, code).toHaveProperty(code)
  })

  it('a source scan finds the codes in one file', () => {
    const codes = Object.keys(COORDINATOR_CODE_KEYS)
    const elsewhere = sources(root)
      .filter((f) => !f.endsWith('conclude-registration.ts'))
      .filter((f) => codes.some((c) => codeAt(f).includes(`'${c}'`)))
    expect(elsewhere).toEqual([])
  })

  it('a coded refusal says its sentence, and an uncoded one keeps today', () => {
    expect(refusalKey({ refused: 'coded', code: 'seat_bound' })).toBe(COORDINATOR_CODE_KEYS.seat_bound)
    expect(refusalKey({ refused: 'rejected', status: 400 })).toBe('registration.rejected')
    expect(en[refusalKey({ refused: 'nobundle' })]).toBeTruthy()
  })
})
