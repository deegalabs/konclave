import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { PAYROLL_TITLE_MAX, TITLE_BIDI_RANGES, proposalName, titleProblem } from './proposal-name'
import { codeAt } from './source-scan'
import { humanError } from './api'
import { en } from './i18n/en'
import { ptBR } from './i18n/pt-BR'

describe('the name a proposal is shown under (#296)', () => {
  it("a payroll's own title wins over its memo", () => {
    expect(proposalName({ title: 'Payroll · April 2026', memo: 'old description' }, 'Payroll')).toBe('Payroll · April 2026')
  })

  it('with no title, the memo still names it (a payment, or a payroll from the local bridge)', () => {
    expect(proposalName({ memo: 'rent' }, 'Payment')).toBe('rent')
    expect(proposalName({ title: null, memo: 'Folha - 3 pagamentos' }, 'Payroll')).toBe('Folha - 3 pagamentos')
  })

  it('with neither, the current label, so an old record reads exactly as before', () => {
    expect(proposalName({}, 'Payroll')).toBe('Payroll')
    expect(proposalName({ title: '  ', memo: ' ' }, 'Payroll')).toBe('Payroll')
  })

  it('counts characters the way the coordinator does, not UTF-16 units', () => {
    expect(titleProblem('ç'.repeat(PAYROLL_TITLE_MAX))).toBeNull()
    expect(titleProblem('😀'.repeat(PAYROLL_TITLE_MAX))).toBeNull() // 240 UTF-16 units, 120 characters
    expect(titleProblem('a'.repeat(PAYROLL_TITLE_MAX + 1))).toBe('long')
    expect(titleProblem(`  ${'a'.repeat(PAYROLL_TITLE_MAX)}  `)).toBeNull()
  })

  // Pasted spreadsheet text is where these come from: a TAB between cells, a direction mark from a
  // right-to-left sheet. The coordinator refuses them; the screen has to say so first, in words.
  it('refuses the characters the coordinator refuses', () => {
    for (const bad of ['Payroll\tApril', 'Pay\nroll', 'Pay\rroll', 'Pay\u0000roll', 'Payroll \u202Elirpa', 'Pay\u2066roll\u2069', 'Pay\u200Froll', 'Pay\u061Croll']) {
      expect(titleProblem(bad), JSON.stringify(bad)).toBe('chars')
    }
    expect(titleProblem('Folha · abril/2026 · bônus')).toBeNull()
    expect(titleProblem('   ')).toBeNull()
  })
})

// The rule existed eight times, once per screen, which is how the web payroll ended up nameless on
// all of them at once. A screen that names a proposal from its memo on its own is a second copy.
describe('no screen names a proposal from its memo on its own', () => {
  const dir = join(fileURLToPath(new URL('.', import.meta.url)), 'screens')
  const own = /\.memo(\?\.trim\(\))?\s*\|\|\s*(\(|t\()/
  for (const f of readdirSync(dir).filter((n) => n.endsWith('.tsx') && !n.includes('.test.'))) {
    it(f, () => {
      const hit = codeAt(join(dir, f)).split('\n').find((l) => own.test(l))
      expect(hit, `${f} names a proposal from its memo; use proposalName`).toBeUndefined()
    })
  }
})

// The screen refuses an over-long name before it asks, with words, rather than letting the
// coordinator's 400 arrive as a generic refusal.
describe('the payroll screen checks the bound before it sends (#296)', () => {
  it('titleProblem runs on the name before createPayroll', () => {
    const code = codeAt(join(fileURLToPath(new URL('.', import.meta.url)), 'screens', 'NewPayroll.tsx'))
    const check = code.indexOf('titleProblem(desc)')
    const send = code.indexOf('await createPayroll(')
    expect(check, 'no titleProblem(desc) in NewPayroll').toBeGreaterThan(-1)
    expect(check).toBeLessThan(send)
  })
})

// The bound and the character rule are the coordinator's (orchestrator::helper::payroll_title). Read
// from there, so the day one side changes and the other does not, this fails instead of the screen
// letting through a name the coordinator answers with a raw 400.
describe('the screen and the coordinator agree on the title rule (#296)', () => {
  const rust = readFileSync(new URL('../../orchestrator/src/helper.rs', import.meta.url), 'utf8')
  it('the same bound', () => {
    const m = /pub const PAYROLL_TITLE_MAX_CHARS: usize = (\d+);/.exec(rust)
    expect(m, 'PAYROLL_TITLE_MAX_CHARS not found in helper.rs').not.toBeNull()
    expect(Number(m![1])).toBe(PAYROLL_TITLE_MAX)
  })
  it('the same refused characters', () => {
    const body = rust.slice(rust.indexOf('pub fn payroll_title('), rust.indexOf('Ok(Some(t.to_string()))'))
    expect(body, 'payroll_title not found in helper.rs').toContain('c.is_control()') // Unicode Cc, as \p{Cc}
    const cps = new Set<number>()
    const hex = (h: string) => parseInt(h, 16)
    for (const r of body.matchAll(/'\\u\{([0-9A-Fa-f]+)\}'\.\.='\\u\{([0-9A-Fa-f]+)\}'/g)) for (let c = hex(r[1]!); c <= hex(r[2]!); c++) cps.add(c)
    for (const r of body.matchAll(/(?<!\.\.=)'\\u\{([0-9A-Fa-f]+)\}'(?!\.\.)/g)) cps.add(hex(r[1]!))
    const ours = new Set<number>()
    for (const [lo, hi] of TITLE_BIDI_RANGES) for (let c = lo; c <= hi; c++) ours.add(c)
    expect(cps.size).toBeGreaterThan(0)
    expect([...ours].sort()).toEqual([...cps].sort())
  })
})

// What the coordinator answers, in the member's words, on either refusal: an older screen, or a
// rule that drifted, must not surface a raw English 400.
describe("the coordinator's title refusals read as the screen's own (#296)", () => {
  const t = (k: string) => k
  it('too long', () => {
    expect(humanError(t, `payroll title is longer than ${PAYROLL_TITLE_MAX} characters`)).toBe('payroll.errTitleTooLong')
  })
  it('a control or direction character', () => {
    expect(humanError(t, 'payroll title contains a control character')).toBe('payroll.errTitleChars')
  })
  it("the coordinator's own Display text, read from helper.rs, maps to the same words", () => {
    const rust = readFileSync(new URL('../../orchestrator/src/helper.rs', import.meta.url), 'utf8')
    const said = [...rust.matchAll(/"(payroll title [^"]+)"/g)].map((m) => m[1]!.replace('{PAYROLL_TITLE_MAX_CHARS}', String(PAYROLL_TITLE_MAX)))
    expect(said.map((e) => humanError(t, e))).toEqual(['payroll.errTitleTooLong', 'payroll.errTitleChars'])
  })
  it('both locales have the words', () => {
    for (const k of ['payroll.errTitleTooLong', 'payroll.errTitleChars']) {
      expect(en[k], k).toBeTruthy()
      expect(ptBR[k], k).toBeTruthy()
    }
  })
})

// The desk's lead line names the proposal it shows. A payroll's name is never its memo (on a single
// payment the memo is the one on the chain), and with neither it is the kind label, so the line
// must not call what it shows a memo.
describe("the desk does not call a proposal's name its memo (#296)", () => {
  it('the lead line uses neutral words, in both locales', () => {
    const code = codeAt(join(fileURLToPath(new URL('.', import.meta.url)), 'screens', 'Dashboard.tsx'))
    const m = /tr\('([\w.]+)', \{ \w+: whatOf\(lead\.p, t\)/.exec(code)
    expect(m, 'the lead line was not found').not.toBeNull()
    const key = m![1]!
    expect(en[key], key).toBeTruthy()
    expect(en[key]).not.toMatch(/memo/i)
    expect(ptBR[key]).not.toMatch(/memo/i)
  })
})
