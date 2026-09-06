#!/usr/bin/env node
// Open a Konclave vault export with NOTHING but Node's own crypto (#484).
//
//   node scripts/open-export.mjs export.json
//   node scripts/open-export.mjs export.json --show-secrets
//
// The encrypted export is the only spare key a member has, so it has to be openable when the thing
// that wrote it is gone: a dead laptop, a browser that will not start, or this project itself. No
// Konclave, no network, no dependencies - if Node runs, the file opens.
//
// It also answers the question a member actually has after taking a backup, which is not "does the
// cipher decrypt" but "is everything I need in there". So it REPORTS the fields a rebuild needs
// rather than dumping the payload: the share, the address, the viewing key (#447) and the scan floor
// (#480). A backup missing the last two restores a seat that cannot see its own money.
//
// Secrets are withheld unless asked for. The common reason to run this is to check a backup, and
// printing a share into a terminal buffer for that is a bad trade.

import { readFileSync } from 'node:fs'
import { webcrypto as crypto } from 'node:crypto'
import { createInterface } from 'node:readline'

const args = process.argv.slice(2)
const file = args.find((a) => !a.startsWith('--'))
const showSecrets = args.includes('--show-secrets')

if (!file) {
  console.error('usage: node scripts/open-export.mjs <export.json> [--show-secrets]')
  process.exit(2)
}

/** Read the passphrase without it landing in shell history or the process list. */
function askPassphrase() {
  return new Promise((resolve) => {
    const rl = createInterface({ input: process.stdin, output: process.stderr, terminal: true })
    // Node has no portable "no echo", so say plainly that it will be visible rather than pretend.
    rl.question('Passphrase (visible as you type): ', (a) => {
      rl.close()
      resolve(a)
    })
  })
}

const unhex = (h) => {
  if (typeof h !== 'string' || h.length % 2 !== 0 || /[^0-9a-f]/i.test(h)) {
    throw new Error('malformed hex in the export')
  }
  return Uint8Array.from(h.match(/../g).map((x) => parseInt(x, 16)))
}

const bundle = JSON.parse(readFileSync(file, 'utf8'))
if (bundle.format !== 'konclave-vault-export') {
  console.error('This does not look like a Konclave vault export.')
  process.exit(1)
}

const passphrase = await askPassphrase()

const base = await crypto.subtle.importKey(
  'raw',
  new TextEncoder().encode(passphrase),
  'PBKDF2',
  false,
  ['deriveKey'],
)
const key = await crypto.subtle.deriveKey(
  {
    name: 'PBKDF2',
    salt: unhex(bundle.salt),
    // The count comes FROM THE FILE. An export written before that field existed has none, and
    // 210000 is what it was sealed with (#435). Assuming today's number would fail on old backups.
    iterations: bundle.kdfIters ?? 210_000,
    hash: 'SHA-256',
  },
  base,
  { name: 'AES-GCM', length: 256 },
  false,
  ['encrypt', 'decrypt'],
)

let payload
try {
  const plain = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: unhex(bundle.iv) }, key, unhex(bundle.cipher))
  payload = JSON.parse(new TextDecoder().decode(plain))
} catch {
  // AES-GCM authenticates, so this is not "decrypted to garbage" - it refused. Wrong passphrase or
  // an altered file, and there is no way to tell which, which is the point of an authenticated mode.
  console.error('\nIt did not open: wrong passphrase, or the file has been altered.')
  process.exit(1)
}

const yes = (v) => (v ? '  yes' : '  NO')
const v1 = bundle.version !== 2

console.log(`
  Konclave export · v${bundle.version} · sealed ${new Date(bundle.exportedAt).toISOString().slice(0, 10)} · PBKDF2 ${bundle.kdfIters ?? 210_000}

  Vault      ${payload.name ?? '(unnamed)'}
  You        ${payload.myName ?? '(unrecorded)'}
  Members    ${(payload.roster ?? []).join(', ') || '(none recorded)'}
  Address    ${payload.address ?? '(none)'}

  What a rebuild needs
    your share                  ${yes(payload.share)}
    the vault's address         ${yes(payload.address)}
    the viewing key (#447)      ${yes(payload.ufvk)}
    the scan floor (#480)       ${yes(payload.birthday !== undefined)}${
  payload.birthday !== undefined ? `   (block ${payload.birthday})` : ''
}
`)

if (!payload.ufvk || payload.birthday === undefined) {
  console.log(`  This backup restores the SEAT but not the whole vault.

    Without the viewing key, a rebuilt wallet cannot detect the vault's notes at all.
    Without the scan floor, it scans from NOW and never sees the ones it already holds -
    and there is no rescan. Take a fresh export from a device that can reach the helper.
`)
}
if (v1) {
  console.log('  This is a v1 export: its metadata was NOT encrypted. #405 replaced that format.\n')
}
if (showSecrets) {
  console.log('  --- secrets ---')
  console.log(JSON.stringify(payload, null, 2))
} else {
  console.log('  Run again with --show-secrets to print the share and keys themselves.\n')
}
