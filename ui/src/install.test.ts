import { describe, expect, it } from 'vitest'
import { installOffer, isIos, isStandalone } from './install'

describe('installOffer', () => {
  it('offers nothing to an app that is already installed', () => {
    // Even with a captured prompt: an installed app telling you to install it is a bug, not a nudge.
    expect(installOffer({ standalone: true, deferred: true, ios: false })).toEqual({ kind: 'installed' })
    expect(installOffer({ standalone: true, deferred: false, ios: true })).toEqual({ kind: 'installed' })
  })

  it('offers the real prompt once the browser has handed one over', () => {
    expect(installOffer({ standalone: false, deferred: true, ios: false })).toEqual({ kind: 'prompt' })
  })

  it('teaches the Share sheet on iOS, where no prompt event exists', () => {
    expect(installOffer({ standalone: false, deferred: false, ios: true })).toEqual({ kind: 'ios' })
  })

  it('offers nothing before the event arrives, rather than a button that would do nothing', () => {
    expect(installOffer({ standalone: false, deferred: false, ios: false })).toEqual({ kind: 'none' })
  })

  it('prefers the real prompt over the instruction when both look possible', () => {
    // A Chromium browser on an iPad-reporting device: if we were handed a prompt, use it.
    expect(installOffer({ standalone: false, deferred: true, ios: true })).toEqual({ kind: 'prompt' })
  })
})

describe('isStandalone', () => {
  it('reads the standard display-mode signal', () => {
    expect(isStandalone({ matchMedia: (q) => ({ matches: q.includes('standalone') }) })).toBe(true)
  })

  it('reads Safari\'s own flag, which is the only signal iOS gives', () => {
    expect(isStandalone({ navigator: { standalone: true } })).toBe(true)
  })

  it('is false in a plain browser tab', () => {
    expect(isStandalone({ matchMedia: () => ({ matches: false }), navigator: {} })).toBe(false)
  })

  it('survives an engine with no matchMedia instead of throwing', () => {
    expect(isStandalone({})).toBe(false)
    expect(isStandalone({ matchMedia: () => { throw new Error('nope') } })).toBe(false)
  })
})

describe('isIos', () => {
  it('detects iPhone and iPad', () => {
    expect(isIos({ userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X)' })).toBe(true)
    expect(isIos({ userAgent: 'Mozilla/5.0 (iPad; CPU OS 17_0 like Mac OS X)' })).toBe(true)
  })

  it('detects an iPad that reports itself as a Mac, by its touch points', () => {
    // iPadOS 13+ ships a desktop-class user agent; the touch count is what gives it away.
    expect(isIos({ userAgent: 'Mozilla/5.0 (Macintosh)', platform: 'MacIntel', maxTouchPoints: 5 })).toBe(true)
  })

  it('leaves a real Mac alone', () => {
    expect(isIos({ userAgent: 'Mozilla/5.0 (Macintosh)', platform: 'MacIntel', maxTouchPoints: 0 })).toBe(false)
  })

  it('is false on Android and on a bare navigator', () => {
    expect(isIos({ userAgent: 'Mozilla/5.0 (Linux; Android 14)' })).toBe(false)
    expect(isIos({})).toBe(false)
  })
})
