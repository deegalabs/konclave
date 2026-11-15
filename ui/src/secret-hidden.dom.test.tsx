// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest'
import { Fragment, type ReactNode } from 'react'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { I18nProvider } from './i18n'
import { en } from './i18n/en'
import { ptBR } from './i18n/pt-BR'
import { RevealProvider } from './reveal'
import { Secret, SentenceWithSecret } from './components'
import { veilWidthCh } from './veil'

// #838: the bar hid a value from the eye only. The value stayed in the page as text, so a screen
// reader read it aloud and copy or a page-text reader got it. While hidden, the value is not in the
// DOM at all. The check is on innerHTML, not textContent, so an attribute that carries the value
// (title, aria-label, data-*, value) is caught too.

const S = '97531.2468' // the sentinel: neither half may appear anywhere in the markup
const leaked = (html: string) => html.includes('97531') || html.includes('2468')
const Comp = () => <b>{S}</b>

const shapes: [string, ReactNode][] = [
  ['a string', S],
  ['a number', 97531.2468],
  ['a bigint', 9753124680n],
  ['a b with a class', <b className="mono">{S}</b>],
  ['a span with title, aria-label, data and value', <span title={S} aria-label={S} data-x={S} data-testid="x">{S}</span>],
  ['an element with dangerouslySetInnerHTML', <span dangerouslySetInnerHTML={{ __html: S }} />],
  ['a Fragment', <Fragment>{S}</Fragment>],
  ['a nested Fragment in a span', <span><Fragment><i>{S}</i></Fragment></span>],
  ['an array', [S, <b key="k">{S}</b>]],
  ['adjacent children, sign and figure', <span>−{S} ZEC</span>],
  ['a component', <Comp />],
  ['a component inside a span', <span><Comp /></span>],
  ['a boolean and null around the value', <span>{false}{null}{S}</span>],
]

const html = (el: ReactNode, initial = false) =>
  render(<I18nProvider><RevealProvider initial={initial}><Secret sm>{el}</Secret></RevealProvider></I18nProvider>).container

describe('a hidden amount is not in the page (#838)', () => {
  afterEach(() => { cleanup(); localStorage.clear() })

  for (const [name, el] of shapes) {
    it(`hidden, ${name} leaves no trace in the markup; revealed, it is there`, () => {
      const hidden = html(el)
      expect(leaked(hidden.innerHTML), hidden.innerHTML).toBe(false)
      expect(hidden.querySelector('button.bar')).not.toBeNull()
      cleanup()
      const shown = html(el, true)
      expect(leaked(shown.innerHTML)).toBe(true)
    })
  }

  it('keeps a wrapper element and only its className', () => {
    const c = html(<b className="mono" title={S}>{S}</b>)
    const b = c.querySelector('b.mono')!
    expect(b).not.toBeNull()
    expect(b.textContent).toBe('')
    expect(b.getAttribute('title')).toBeNull()
  })

  it('says "hidden" once, before the control, and the control keeps its name', () => {
    localStorage.setItem('konclave.locale', 'en')
    const c = html(S)
    const said = c.querySelector('.visually-hidden')!
    expect(said.textContent).toBe(en['secret.hidden'])
    expect(said.compareDocumentPosition(c.querySelector('button.bar')!) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
    expect(screen.getByRole('button', { name: en['secret.reveal']! })).toBeTruthy()
    // The bar is described by the spoken word, so a keyboard user hears the state on the control.
    expect(c.querySelector('button.bar')!.getAttribute('aria-describedby')).toBe(said.id)
    expect(said.id).not.toBe('')
  })

  it('the spoken word and the control name exist in both languages', () => {
    expect(en['secret.hidden']).toBe('amount hidden')
    expect(ptBR['secret.hidden']).toBe('valor oculto')
    expect(en['secret.reveal']).toBe('Reveal amounts')
    expect(ptBR['secret.reveal']).toBe('Revelar valores')
  })

  it('a tip on the bar keeps its own description beside the spoken word', () => {
    const c = render(<I18nProvider><RevealProvider><Secret sm describedBy="tip-1">{S}</Secret></RevealProvider></I18nProvider>).container
    const said = c.querySelector('.visually-hidden')!
    expect(c.querySelector('button.bar')!.getAttribute('aria-describedby')).toBe(`${said.id} tip-1`)
  })

  it('the control keeps one name and aria-pressed carries the state; the spoken word is gone once revealed', () => {
    const c = render(<I18nProvider><RevealProvider><Secret sm label="Alice">{S}</Secret></RevealProvider></I18nProvider>).container
    const bar = c.querySelector('button.bar')!
    const name = bar.getAttribute('aria-label')
    expect(name).toBe(`${en['secret.reveal']}: Alice`)
    fireEvent.click(bar)
    expect(bar.getAttribute('aria-label')).toBe(name)
    expect(bar.getAttribute('aria-pressed')).toBe('true')
    expect(bar.getAttribute('aria-describedby')).toBeNull()
  })

  it('revealing puts the value in, takes the spoken word out and leaves focus on the bar; hiding takes it out again', () => {
    localStorage.setItem('konclave.locale', 'en')
    const c = render(<I18nProvider><RevealProvider><Secret sm><b>{S}</b></Secret></RevealProvider></I18nProvider>).container
    const bar = screen.getByRole('button', { name: en['secret.reveal']! })
    bar.focus()
    fireEvent.click(bar)
    expect(c.textContent).toContain(S)
    expect(c.querySelector('.visually-hidden')).toBeNull()
    const pressed = screen.getByRole('button', { name: en['secret.reveal']! })
    expect(pressed.getAttribute('aria-pressed')).toBe('true')
    expect(document.activeElement).toBe(pressed)
    fireEvent.click(pressed)
    expect(leaked(c.innerHTML)).toBe(false)
    expect(document.activeElement).toBe(pressed)
    expect(pressed.getAttribute('aria-pressed')).toBe('false')
  })
})

describe('veilWidthCh: the placeholder width, approximate by design', () => {
  it('counts a digit as 1, . , \' and space as 0.5, everything else as 1', () => {
    expect(veilWidthCh('1234')).toBe(4)
    expect(veilWidthCh('1.5000')).toBe(5.5)
    expect(veilWidthCh("1,234.5")).toBe(6)
    expect(veilWidthCh("1'234")).toBe(4.5)
    expect(veilWidthCh('1.5 ZEC')).toBe(1 + 0.5 + 1 + 0.5 + 3)
    expect(veilWidthCh('−0.1')).toBe(1 + 1 + 0.5 + 1)
    expect(veilWidthCh('')).toBe(0)
  })
})

describe('SentenceWithSecret: one rule for a sentence whose amount sits under the bar', () => {
  afterEach(() => { cleanup(); localStorage.clear() })
  const mount = (sentence: string, props = {}) =>
    render(<I18nProvider><RevealProvider><SentenceWithSecret sentence={sentence} {...props}><span>{S}</span></SentenceWithSecret></RevealProvider></I18nProvider>).container

  it('puts the amount where the sentence marks it, in either language order, with nothing of it in the markup', () => {
    const a = mount('Free \u0000 ZEC left')
    expect(a.textContent).toContain('Free ')
    expect(a.textContent).toContain(' ZEC left')
    expect(a.querySelector('.secret')).not.toBeNull()
    expect(leaked(a.innerHTML)).toBe(false)
    cleanup()
    const b = mount('\u0000 livres')
    expect(b.firstElementChild!.className).toContain('secret')
  })

  it('turns the dictionary bold around the mark into a b and drops the asterisks', () => {
    const c = mount('free **\u0000** ZEC')
    expect(c.innerHTML).not.toContain('**')
    expect(c.querySelector('b .secret')).not.toBeNull()
    expect(c.textContent).toContain('free ')
    expect(c.textContent).toContain(' ZEC')
  })

  it('passes the veil its label, tip id and handlers, and says the sentence unchanged when it has no mark', () => {
    const c = mount('before \u0000 after', { label: 'Free', describedBy: 'tip-9' })
    expect(c.querySelector('button.bar')!.getAttribute('aria-label')).toBe(`${en['secret.reveal']}: Free`)
    expect(c.querySelector('button.bar')!.getAttribute('aria-describedby')).toContain('tip-9')
    cleanup()
    expect(mount('no mark here').textContent).toBe('no mark here')
  })
})
