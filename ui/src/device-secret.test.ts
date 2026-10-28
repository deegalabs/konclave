/// <reference types="node" />
// The device key a creation ceremony announces stays inside the wasm module: there is no export
// that returns it, and nothing in the app asks for one or stores it. Comments are stripped before
// looking (the shared reader), since a scan a comment can satisfy checks nothing.
import { readFileSync, readdirSync } from 'node:fs'
import { beforeAll, describe, expect, it } from 'vitest'
import init, { DeviceKey } from './wasm-pkg/konclave_wasm.js'
import { codeOf } from './source-scan'

beforeAll(async () => {
  await init(readFileSync(new URL('./wasm-pkg/konclave_wasm_bg.wasm', import.meta.url)))
})

function walk(dir: URL, rel: string, out: string[]) {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    if (e.isDirectory()) {
      if (e.name !== 'wasm-pkg' && e.name !== 'node_modules') walk(new URL(`${e.name}/`, dir), `${rel}${e.name}/`, out)
    } else if (/\.(ts|tsx)$/.test(e.name) && !/\.test\./.test(e.name) && !/\.d\.ts$/.test(e.name)) {
      out.push(`${rel}${e.name}`)
    }
  }
}

describe('the creation device key stays inside the module', () => {
  it('the module has no export that returns a device key\'s secret', () => {
    const k = new DeviceKey()
    expect((k as unknown as { secretBytes?: unknown }).secretBytes).toBeUndefined()
    // The public half is what travels, and it still does.
    expect(k.publicBytes().length).toBe(32)
  })

  it('nothing in the app asks for it, and no sealed bundle is written with it', () => {
    const files: string[] = []
    walk(new URL('./', import.meta.url), '', files)
    expect(files.length, 'the scan found the sources').toBeGreaterThan(20)
    const asks = files.filter((f) => /\bsecretBytes\b/.test(codeOf(`./${f}`)))
    expect(asks).toEqual([])
    const writes = files.filter((f) => /\bdeviceSecret\b/.test(codeOf(`./${f}`)))
    expect(writes, 'the bundle carries the share and the public bytes, not the device key').toEqual([])
  })
})
