#!/usr/bin/env node
// verify-web.mjs - is the web app at www.konclave.xyz a published release? (#605)
//
// Fetches every file the release's manifest lists from the live site and compares each SHA-256 with
// the manifest of the version the site says it is. No dependencies, read-only, Node 22+ (global fetch and WebCrypto).
//
//   node scripts/verify-web.mjs
//   node scripts/verify-web.mjs --site=https://www.konclave.xyz --expect-version=0.22.0
//   node scripts/verify-web.mjs --manifest=web-manifest.json      (a file you downloaded or built)
//
// By default the manifest is the `web-manifest.json` attached to the GitHub release of the version
// the site claims. How to check that manifest itself (the attestation, or a rebuild): docs/VERIFY-WEB.md.
//
// EXIT CODES: 0 every file matched; 1 a file, a header, the version or the commit did not match
// (NOT A RELEASE is a 1); 2 inconclusive (network, or no published manifest yet: a draft release is
// not downloadable, or a server error); 3 usage, or a malformed manifest. What a PASS does and does
// not prove is at the top of web-verify.mjs, and every run ends with it.
import { readFileSync } from 'node:fs'
import { verifyWeb, fetchManifest, EXIT, LIMITS } from './web-verify.mjs'

const opt = (name) => process.argv.find((a) => a.startsWith(`--${name}=`))?.slice(name.length + 3)
const known = ['site', 'manifest', 'expect-version']
const bad = process.argv.slice(2).filter((a) => !known.some((k) => a.startsWith(`--${k}=`)))
if (bad.length) {
  console.error(`unknown argument ${bad[0]}; use ${known.map((k) => `--${k}=`).join(' ')}`)
  console.error(LIMITS)
  process.exit(EXIT.USAGE)
}

let manifest
const m = opt('manifest')
if (m !== undefined) {
  if (/^[a-z]+:\/\//i.test(m)) {
    const got = await fetchManifest(m)
    if (got.line) { console.error(got.line); console.error(LIMITS); process.exit(got.code) }
    manifest = { bytes: got.bytes, from: m }
  } else {
    try { manifest = { bytes: new Uint8Array(readFileSync(m)), from: m } } catch (e) { console.error(`USAGE ${e.message}`); console.error(LIMITS); process.exit(EXIT.USAGE) }
  }
}

const { code, lines } = await verifyWeb({ site: opt('site'), manifest, expectVersion: opt('expect-version') })
for (const l of lines) console.log(l)
process.exit(code)
