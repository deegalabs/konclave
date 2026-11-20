// A separate Node process for each export. Its file allowlist contains only reader code and WASM.
import { fork } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { check, initDrillWasm, openSeat, safeFailure } from './inspect.ts'

const entry = fileURLToPath(import.meta.url)
export function freshReopen(file, passphrase, seatOnly = false) {
  const reads = ['./inspect.ts', '../src/bytes.ts', '../src/wasm-pkg', '../../scripts/open-export.mjs',
    '../package.json', '../../package.json'].map(p => '--allow-fs-read=' + fileURLToPath(new URL(p, import.meta.url)))
  return new Promise((resolve, reject) => {
    const child = fork(entry, ['--reader'], {
      execArgv: ['--permission', ...reads], env: {}, stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
    })
    let reply
    let noisy = false
    for (const stream of [child.stdout, child.stderr]) stream.on('data', () => { noisy = true })
    const timer = setTimeout(() => child.kill(), 30_000)
    child.on('message', m => { reply = m })
    child.on('error', () => reject(new Error('The fresh process could not verify this export.')))
    child.on('close', code => {
      clearTimeout(timer)
      try {
        check(!noisy && code === 0 && reply, 'child')
        if (reply.refused) throw new Error(safeFailure(new Error(reply.refused)))
        check([1, 2, 3].includes(reply.seat), 'quorum')
        resolve(reply.seat)
      } catch (e) { reject(e) }
    })
    child.send({ file, passphrase, seatOnly }, err => { if (err) child.kill() })
  })
}

if (process.argv[2] === '--reader' && process.send) {
  process.once('message', async ({ file, passphrase, seatOnly }) => {
    let result
    try {
      await initDrillWasm()
      const { share } = await openSeat(file, passphrase, seatOnly)
      result = { seat: share.seat }
    } catch (e) { result = { refused: safeFailure(e) } }
    process.send(result, () => process.disconnect())
  })
}
