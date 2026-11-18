import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { constants } from 'node:fs'
import { access, mkdir, mkdtemp, open, realpath, rm, rmdir, stat } from 'node:fs/promises'
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { createInterface } from 'node:readline'
import { fileURLToPath } from 'node:url'
import { check } from './inspect.ts'

export async function outputLocation(path) {
  const parent = await realpath(dirname(resolve(path)))
  const repo = await realpath(fileURLToPath(new URL('../../', import.meta.url)))
  const rel = relative(repo, parent)
  check(rel === '..' || rel.startsWith('..' + sep) || isAbsolute(rel), 'path')
  const info = await stat(parent)
  check(info.isDirectory() && (process.platform === 'win32' || (info.uid === process.getuid() && !(info.mode & 0o077))), 'path')
  const output = join(parent, basename(resolve(path)))
  const exists = await stat(output).then(() => true, e => { if (e.code !== 'ENOENT') throw e; return false })
  check(!exists, 'path')
  return { parent, output }
}

export async function writeExports(output, entries) {
  await mkdir(output, { mode: 0o700 })
  const created = []
  try {
    for (const { seat, file } of entries) {
      const path = join(output, 'seat-' + seat + '.konclave.json')
      const handle = await open(path, 'wx', 0o600)
      created.push(path)
      try { await handle.writeFile(JSON.stringify(file)) } finally { await handle.close() }
    }
  } catch (e) {
    for (const path of created) await rm(path)
    await rmdir(output)
    throw e
  }
}

export async function withHelper(parent, run) {
  const binaries = []
  for (const key of ['KONCLAVE_HELPER_BINARY', 'KONCLAVE_ZCASH_SIGN', 'KONCLAVE_DEVTOOL', 'KONCLAVE_RECEIVER_CHECK']) {
    const path = process.env[key]
    check(path && isAbsolute(path) && await access(path, constants.X_OK).then(() => true, () => false), 'tools')
    binaries.push(await realpath(path))
  }
  const [binary, zcashSign, devtool, checker] = binaries
  const scratch = await mkdtemp(join(parent, '.konclave-setup-'))
  const addr = '127.0.0.1:14780'
  let child, exited
  let interrupted = false
  const cancel = () => { interrupted = true; child?.kill() }
  try {
    const vaults = join(scratch, 'vaults')
    await mkdir(vaults, { mode: 0o700 })
    child = spawn(binary, [], {
      cwd: scratch, stdio: ['ignore', 'ignore', 'pipe'], windowsHide: true,
      env: { ...process.env, KONCLAVE_HELPER_ADDR: addr, KONCLAVE_NETWORK: 'test',
        KONCLAVE_LIGHTWALLETD: 'testnet.zec.rocks:443', KONCLAVE_VAULTS_DIR: vaults,
        KONCLAVE_ZCASH_SIGN: zcashSign, KONCLAVE_DEVTOOL: devtool, KONCLAVE_RELAY_BASES: '' },
    })
    exited = once(child, 'close').catch(() => {})
    process.once('SIGINT', cancel)
    process.once('SIGTERM', cancel)
    // This child's post-bind announcement excludes an unrelated process already using the port.
    // Drain and discard its output, including engine errors.
    const lines = createInterface({ input: child.stderr })
    let timer
    try {
      const bound = new Promise(resolve => lines.on('line', s => {
        if (s.startsWith('konclave-helper listening on ' + addr + ' (network=test, 0 vault(s) restored,')) resolve(true)
      }))
      check(await Promise.race([bound, exited.then(() => false),
        new Promise(resolve => { timer = setTimeout(() => resolve(false), 15_000) })]), 'helper')
    } finally { clearTimeout(timer) }
    const entries = await run({ origin: 'http://' + addr, vaults, checker })
    check(!interrupted, 'interrupted')
    return entries
  } finally {
    process.removeListener('SIGINT', cancel)
    process.removeListener('SIGTERM', cancel)
    child?.kill()
    await exited
    // mkdtemp created this entire tree for this invocation.
    await rm(scratch, { recursive: true, force: true })
  }
}
