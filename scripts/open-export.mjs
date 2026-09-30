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
//
// It reads BOTH formats. v2 is one opaque blob; v1 (pre-#405) left the metadata in the clear and
// encrypted only the share. Legacy vaults still exist, so a tool that refuses their backups is a
// tool that fails exactly the person it was written for.
//
// And every failure here is a SENTENCE, not a stack trace. This runs when the laptop is dead or the
// browser will not start; a `node:fs` trace at that moment tells the reader their last resort is
// broken too. The reader is not debugging this script, they are trying to open their money.
//
// It is still ONE file, so it can be copied anywhere on its own. The decisions are exported so the
// app's tests can open an export the app really wrote and check what this says about it; run as a
// program, it behaves exactly as it always has.

import { readFileSync, realpathSync } from 'node:fs'
import { webcrypto as crypto } from 'node:crypto'
import { createInterface } from 'node:readline'
import { fileURLToPath } from 'node:url'

/** A failure the reader gets as one sentence. `code` 2 = could not even start, 1 = it did not open. */
export class Refusal extends Error {
  constructor(message, code = 1) {
    super(message)
    this.code = code
  }
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

const unhex = (h, what) => {
  if (typeof h !== 'string' || h.length % 2 !== 0 || /[^0-9a-f]/i.test(h)) {
    throw new Refusal(`The export's ${what} is not valid hex, so the file has been altered or truncated.`)
  }
  return Uint8Array.from(h.match(/../g).map((x) => parseInt(x, 16)))
}

/** Die with one sentence and no stack. `code` 2 = could not even start, 1 = it did not open. */
function stop(msg, code = 1) {
  console.error(`\n${msg}\n`)
  process.exit(code)
}

/**
 * Where an export keeps its salt, iv and cipher, and which format it is. Refuses anything that is
 * not an export this tool can open, before a passphrase is asked for.
 *
 * v1 kept salt/iv/cipher one level down, under `vault`, with the metadata beside them in the clear.
 * Normalising here means the decrypt has one shape to handle instead of two.
 */
export function envelopeOf(bundle) {
  if (bundle === null || typeof bundle !== 'object' || bundle.format !== 'konclave-vault-export') {
    throw new Refusal('This does not look like a Konclave vault export.\n\nAn export is a JSON object whose "format" is "konclave-vault-export".')
  }
  const v1 = bundle.version === 1
  const env = v1 ? bundle.vault : bundle
  if (!env || typeof env !== 'object') {
    throw new Refusal('The export declares version 1 but carries no "vault" object. The file is incomplete.')
  }
  if (bundle.version !== 1 && bundle.version !== 2) {
    throw new Refusal(`Unsupported export version: ${JSON.stringify(bundle.version)}. This tool reads v1 and v2.`)
  }
  for (const f of ['salt', 'iv', 'cipher']) {
    if (typeof env[f] !== 'string' || !env[f]) throw new Refusal(`The export is missing "${f}". The file is incomplete or corrupt.`)
  }
  return { v1, env }
}

const hex = (u) => [...u].map((b) => b.toString(16).padStart(2, '0')).join('')

/** Decrypt an export. Returns the payload in the v2 shape whichever format the file is. */
export async function openExport(bundle, passphrase) {
  const { v1, env } = envelopeOf(bundle)

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
      salt: unhex(env.salt, 'salt'),
      // The count comes FROM THE FILE. An export written before that field existed has none, and
      // 210000 is what it was sealed with (#435). Assuming today's number would fail on old backups.
      iterations: env.kdfIters ?? 210_000,
      hash: 'SHA-256',
    },
    base,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt'],
  )

  const open = (ivHex, cipherHex, what) =>
    crypto.subtle.decrypt({ name: 'AES-GCM', iv: unhex(ivHex, 'iv') }, key, unhex(cipherHex, what))

  let payload
  try {
    const plain = await open(env.iv, env.cipher, 'cipher')
    // The two formats differ in WHAT is encrypted, not how. v2 seals the whole payload as JSON; v1
    // sealed only the share and left the metadata beside it in the clear, which is the flaw #405
    // closed. So v1 is reassembled here into the shape the report below already expects.
    payload = v1
      ? {
          name: env.name, myName: env.myName, creatorName: env.creatorName,
          governance: env.governance, groupKey: env.groupKey, address: env.address,
          roster: env.roster, createdAt: env.createdAt, beneficiaries: env.beneficiaries,
          share: hex(new Uint8Array(plain)),
          // v1 predates both, so they are absent by construction, never merely missing.
          accessSecret: null,
        }
      : JSON.parse(new TextDecoder().decode(plain))
    if (v1 && env.secretCipher && env.secretIv) {
      try {
        payload.accessSecret = hex(new Uint8Array(await open(env.secretIv, env.secretCipher, 'secretCipher')))
      } catch (e) {
        // S is optional on v1; its absence is not a failure to open the backup. A field that is not
        // even hex is a damaged file, though, and says so.
        if (e instanceof Refusal) throw e
      }
    }
  } catch (e) {
    if (e instanceof Refusal) throw e
    // AES-GCM authenticates, so this is not "decrypted to garbage" - it refused. Wrong passphrase or
    // an altered file, and there is no way to tell which, which is the point of an authenticated mode.
    throw new Refusal('It did not open: wrong passphrase, or the file has been altered.')
  }
  return { v1, env, payload }
}

// The share is a JSON bundle the create screen wrote: the key package, the seat, and the (n, t) the
// ceremony agreed on. Reading it back is the only check here that can catch an export whose SHARE
// disagrees with its own metadata - a corrupted or hand-edited file - rather than one that is merely
// missing a field.
export function shareFacts(hex) {
  try {
    const bytes = Uint8Array.from(hex.match(/../g).map((x) => parseInt(x, 16)))
    const b = JSON.parse(new TextDecoder().decode(bytes))
    return typeof b === 'object' && b ? b : null
  } catch {
    return null
  }
}

/**
 * The quorum a backup belongs to. An export records it in ONE place, the share. `governance` is
 * 'open' or 'quorum', a policy and not a number, and nothing else in the payload holds t or n; this
 * used to read `governance.threshold`, so every backup reported its quorum as missing.
 */
function quorumOf(share) {
  if (!share) return null
  const { t, n } = share
  return Number.isInteger(t) && Number.isInteger(n) && t > 0 && n > 0 ? { t, n } : null
}

/** What this tool can say about a payload that opened: the share, the quorum, and what disagrees. */
export function examine(payload) {
  const share = payload.share ? shareFacts(payload.share) : null
  const quorum = quorumOf(share)
  const roster = Array.isArray(payload.roster) ? payload.roster : []

  // The failures that are NOT "a field is missing", and that nothing else here would notice.
  const problems = []
  if (share === null && payload.share) {
    problems.push(`The share does not decode. The file opened - the passphrase is right and the
    ciphertext is intact - but what came out is not the bundle this device wrote. Do not rely on
    this backup; take a fresh one.`)
  }
  // The ceremony that made the share fixed the member count, and the roster is the names it
  // seated, one per member. The threshold has no second record in an export, so only the count can
  // be cross-checked.
  if (quorum && roster.length && quorum.n !== roster.length) {
    problems.push(`The share says the vault has ${quorum.n} members; the roster lists ${roster.length}. They
    must agree - the share was made by a ceremony that fixed that number - so one of the two is wrong
    and this file cannot be trusted to rebuild anything.`)
  }
  // Seats start at 1: seat N is roster[N - 1] (`seat_holder` in orchestrator/src/write_auth.rs), and
  // the create screen writes 0 for a device the ceremony never seated. Counting from 0 flagged the
  // last member's backup and passed a share that was never seated.
  if (share?.seat !== undefined && roster.length
      && !(Number.isInteger(share.seat) && share.seat >= 1 && share.seat <= roster.length)) {
    problems.push(`The share holds seat ${share.seat}, but the roster lists ${roster.length}
    members. A seat outside the roster cannot be restored.`)
  }
  return { share, quorum, problems }
}

const yes = (v) => (v ? '  yes' : '  NO')

/** The report, one string per block the program prints. */
export function reportLines(bundle, env, v1, payload, showSecrets = false) {
  const { share, quorum, problems } = examine(payload)
  const lines = []
  lines.push(`
  Konclave export · v${bundle.version} · sealed ${new Date(bundle.exportedAt).toISOString().slice(0, 10)} · PBKDF2 ${env.kdfIters ?? 210_000}

  Vault      ${payload.name ?? '(unnamed)'}
  You        ${payload.myName ?? '(unrecorded)'}
  Members    ${(payload.roster ?? []).join(', ') || '(none recorded)'}
  Address    ${payload.address ?? '(none)'}

  Quorum     ${quorum ? `${quorum.t} of ${quorum.n}` : '(not recorded)'}

  What a rebuild needs
    your share                  ${yes(payload.share)}${share?.seat !== undefined ? `   (seat ${share.seat})` : ''}
    the quorum it belongs to    ${yes(quorum)}
    the vault's address         ${yes(payload.address)}
    the viewing key (#447)      ${yes(payload.ufvk)}
    the scan floor (#480)       ${yes(payload.birthday !== undefined)}${
  payload.birthday !== undefined ? `   (block ${payload.birthday})` : ''
}
    the read secret (#388)      ${yes(payload.accessSecret)}
`)

  for (const p of problems) lines.push(`  INCONSISTENT: ${p.replace(/\s+/g, ' ')}\n`)

  if (!payload.accessSecret) {
    lines.push(`  No read secret. This vault is OPEN, or this device never received one.

    A restore from this file can SIGN but cannot READ: every private read on a protected
    vault answers 401, and the signing room cannot be derived. If the vault IS protected,
    this backup is not enough on its own.
`)
  }

  if (!payload.ufvk || payload.birthday === undefined) {
    lines.push(`  This backup restores the SEAT but not the whole vault.

    Without the viewing key, a rebuilt wallet cannot detect the vault's notes at all.
    Without the scan floor, it scans from NOW and never sees the ones it already holds -
    and there is no rescan. Take a fresh export from a device that can reach the helper.
`)
  }
  if (v1) {
    lines.push(`  This is a v1 export. Its metadata - the vault name, the members, the address -
  was NOT encrypted: anyone holding this file can read all of it without the passphrase.
  #405 replaced that format, and a fresh export from Settings is one opaque blob.
`)
  }
  if (showSecrets) {
    lines.push('  --- secrets ---')
    lines.push(JSON.stringify(payload, null, 2))
  } else {
    lines.push('  Run again with --show-secrets to print the share and keys themselves.\n')
  }
  return lines
}

async function main() {
  const args = process.argv.slice(2)
  const file = args.find((a) => !a.startsWith('--'))
  const showSecrets = args.includes('--show-secrets')

  if (!file) {
    console.error('usage: node scripts/open-export.mjs <export.json> [--show-secrets]')
    process.exit(2)
  }

  let raw
  try {
    raw = readFileSync(file, 'utf8')
  } catch (e) {
    if (e.code === 'ENOENT') stop(`No file at ${file}\n\nCheck the path. The export is the .konclave.json you downloaded when the vault was created, or from Settings.`, 2)
    if (e.code === 'EISDIR') stop(`${file} is a directory, not an export file.`, 2)
    if (e.code === 'EACCES') stop(`No permission to read ${file}.`, 2)
    stop(`Could not read ${file}: ${e.message}`, 2)
  }

  let bundle
  try {
    bundle = JSON.parse(raw)
  } catch {
    // A truncated download and a wrong file both land here, and the difference matters to the reader.
    const head = raw.trim().slice(0, 40).replace(/\s+/g, ' ')
    stop(`${file} is not valid JSON, so it is not an export.\n\nIt starts with: ${head || '(empty file)'}`, 2)
  }

  // Refuse a file that is not an export BEFORE asking for a passphrase.
  envelopeOf(bundle)
  const passphrase = await askPassphrase()
  const { v1, env, payload } = await openExport(bundle, passphrase)
  for (const block of reportLines(bundle, env, v1, payload, showSecrets)) console.log(block)
}

/** True when Node was asked to run THIS file, as opposed to a test importing it. Compared on real
 *  paths, so a path with spaces, a symlink or a Windows drive letter still counts as this file. */
function runAsProgram() {
  try {
    return !!process.argv[1] && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url))
  } catch {
    return false
  }
}

if (runAsProgram()) {
  main().catch((e) => {
    if (e instanceof Refusal) stop(e.message, e.code)
    throw e
  })
}
