import { randomBytes } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { createInterface } from 'node:readline/promises'
import { Writable } from 'node:stream'
import { fileURLToPath } from 'node:url'
import { check, safeFailure } from './inspect.ts'
import { freshReopen } from './fresh.mjs'
import { outputLocation, withHelper, writeExports } from './live.mjs'
import { newPassphraseProblem } from '../src/passphrase.ts'

async function ask(label) {
  check(process.stdin.isTTY && process.stderr.isTTY, 'tty')
  // readline puts the input TTY in raw mode. Its editing/echo output goes only to this sink.
  const silent = new Writable({ write(_chunk, _encoding, done) { done() } })
  const rl = createInterface({ input: process.stdin, output: silent, terminal: true, historySize: 0 })
  const abort = new AbortController()
  rl.once('SIGINT', () => abort.abort())
  rl.once('close', () => abort.abort())
  try {
    check(process.stdin.isRaw, 'tty')
    process.stderr.write(label + ' (hidden): ')
    return await rl.question('', { signal: abort.signal })
  } finally { rl.close(); process.stderr.write('\n') }
}

async function generate(passwords, helper) {
  // Use the workspace's TS and import.meta.env transform without opening a server or reading .env.
  const { createServer } = await import('vite')
  const vite = await createServer({ root: fileURLToPath(new URL('../', import.meta.url)), configFile: false,
    envFile: false, logLevel: 'silent', server: { middlewareMode: true, hmr: false, ws: false, watch: null } })
  try {
    const { generateExports } = await vite.ssrLoadModule('/drill/ceremony.ts')
    const entries = await generateExports(passwords, helper)
    for (const { seat, file } of entries) check(await freshReopen(file, passwords[seat - 1], !helper) === seat, 'child')
    return entries
  } finally { await vite.close() }
}

async function main(args) {
  const [mode, path] = args
  if (mode === 'self-test' && args.length === 1) {
    await generate(Array.from({ length: 3 }, () => randomBytes(32).toString('base64url')))
    console.log('PASS real 2-of-3 DKG, three seat-only exports and three fresh-process reopens.')
    return
  }
  check(args.length === 2 && ['verify', 'generate'].includes(mode), 'usage')
  if (mode === 'verify') {
    const file = JSON.parse(await readFile(path, 'utf8'))
    await freshReopen(file, await ask('Seat passphrase'))
    console.log('PASS v2 export reopened with the required wallet fields (structural check).')
    return
  }
  const location = await outputLocation(path)
  const passwords = []
  for (const seat of [1, 2, 3]) {
    const pass = await ask('New passphrase for seat ' + seat)
    check(!newPassphraseProblem(pass) && pass === await ask('Confirm seat ' + seat), 'passphrase')
    passwords.push(pass)
  }
  const entries = await withHelper(location.parent, helper => generate(passwords, helper))
  await writeExports(location.output, entries)
  console.log('PASS three helper-backed testnet exports checked, reopened and saved.')
}

try { await main(process.argv.slice(2)) }
catch (e) { console.error('FAIL ' + safeFailure(e)); process.exitCode = 1 }
