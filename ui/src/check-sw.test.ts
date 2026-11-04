/// <reference types="node" />
import { describe, expect, it } from 'vitest'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
// @ts-expect-error - a plain .mjs script, deliberately not part of the app's TS build
import { swKind, checkSw } from '../../scripts/check-sw.mjs'

// The check both workflows run on the `sw.js` they are about to ship (desktop-release.yml: the
// self-destroying one; ci.yml: the web's workbox one). The fixtures are cut from real builds of this
// repo, with and without KONCLAVE_DESKTOP_BUILD=1.

const DESKTOP_SW = `
self.addEventListener('install', (e) => {
  self.skipWaiting();
});
self.addEventListener('activate', (e) => {
  self.registration.unregister()
    .then(() => self.clients.matchAll())
    .then((clients) => {
      clients.forEach((client) => {
        if (client instanceof WindowClient)
          client.navigate(client.url);
      });
      return Promise.resolve();
    })
});`

const WEB_SW = `if(!self.define){let s,e={};}define(["./workbox-2fbc6a65"],function(s){"use strict";self.addEventListener("message",s=>{s.data&&"SKIP_WAITING"===s.data.type&&self.skipWaiting()}),s.precacheAndRoute([{url:"mark-maskable.svg",revision:"1bcda424"}],{}),s.cleanupOutdatedCaches()});`

describe('which service worker a build produced', () => {
  it('tells the self-destroying worker from the workbox one', () => {
    expect(swKind(DESKTOP_SW)).toBe('desktop')
    expect(swKind(WEB_SW)).toBe('web')
  })

  it('a file with both calls, or neither, is neither kind', () => {
    expect(swKind(DESKTOP_SW + WEB_SW)).toBe('unknown')
    expect(swKind('')).toBe('unknown')
  })

  it('passes each build only with its own worker, and says what to check when it fails', () => {
    expect(checkSw('desktop', DESKTOP_SW)).toBeNull()
    expect(checkSw('web', WEB_SW)).toBeNull()
    expect(checkSw('desktop', WEB_SW)).toMatch(/KONCLAVE_DESKTOP_BUILD=1/)
    expect(checkSw('web', DESKTOP_SW)).toMatch(/KONCLAVE_DESKTOP_BUILD set for a web build/)
    expect(checkSw('desktop', DESKTOP_SW + WEB_SW)).toMatch(/'unknown'/)
  })

  it('refuses an expectation it does not know, rather than passing it', () => {
    expect(checkSw('Desktop', DESKTOP_SW)).toMatch(/must be 'desktop' or 'web'/)
  })
})

// What the workflows actually run. A check that skipped itself would exit 0 and pass every build, so
// the exit codes are asserted by running the file, not by calling the function.
describe('the command the workflows run', () => {
  const cli = fileURLToPath(new URL('../../scripts/check-sw-cli.mjs', import.meta.url))
  const dir = mkdtempSync(join(tmpdir(), 'check-sw-'))
  const file = (name: string, src: string) => { const f = join(dir, name); writeFileSync(f, src); return f }
  const run = (...args: string[]) => spawnSync(process.execPath, [cli, ...args], { encoding: 'utf8' })

  it('exits 0 only for the worker each build must ship', () => {
    const desk = file('desk.js', DESKTOP_SW)
    const web = file('web.js', WEB_SW)
    expect(run('desktop', desk).status).toBe(0)
    expect(run('web', web).status).toBe(0)
    expect(run('desktop', web).status).toBe(1)
    expect(run('web', desk).status).toBe(1)
  })

  it('exits 1 for a missing file or no arguments, never 0', () => {
    expect(run('desktop', join(dir, 'missing.js')).status).toBe(1)
    expect(run().status).toBe(1)
  })
})
