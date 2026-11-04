// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { downloadText } from './download'
import { codeOf } from './source-scan'

// #320: the backup dialog closed on "Download started" even when the browser refused the download,
// so a member could leave believing a backup existed. The download answers whether it started, and
// Settings keeps the dialog, with "Copy", when it did not.

describe('a download says whether the browser started it', () => {
  afterEach(() => { vi.restoreAllMocks() })

  it('answers false when the browser refuses it', () => {
    vi.spyOn(URL, 'createObjectURL').mockImplementation(() => { throw new Error('blocked') })
    expect(downloadText('backup.json', '{}')).toBe(false)
  })

  it('answers true when the click went out', () => {
    vi.spyOn(URL, 'createObjectURL').mockReturnValue('blob:x')
    vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => {})
    expect(downloadText('backup.json', '{}')).toBe(true)
  })

  it('Settings reports a refused download and keeps the dialog instead of closing it', () => {
    const src = codeOf('screens/Settings.tsx')
    expect(src).toMatch(/if \(!downloadText\(out\.name, out\.json\)\) \{ setXpErr\(t\('export\.errDownload'\)\); return \}/)
  })
})
