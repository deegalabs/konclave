import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { spawnSync } from 'node:child_process'
import { coordinatorCreationMin, helperBase, registerVaultResult, setCoordMode, type HelperVault } from '../src/helper'
import { creationAllowed, CREATION_PROTOCOL } from '../src/creation-protocol'
import type { DkgCeremony } from '../src/dkg-ceremony'
import { bytesToHex } from '../src/bytes'
import { receiversFingerprint } from '../src/format'
import { check, checkViewingMetadata } from './inspect.ts'

export type HelperSetup = { origin: string; vaults: string; checker: string }

async function localCall<T>(origin: string, call: () => Promise<T>) {
  check(/^http:\/\/127\.0\.0\.1:\d+$/.test(origin), 'helper')
  setCoordMode('custom', origin)
  check(helperBase() === origin, 'helper')
  const fetch = globalThis.fetch
  globalThis.fetch = (url, init) => {
    check((url === origin + '/api/health' && !init?.method)
      || (url === origin + '/api/vault' && init?.method === 'POST'), 'helper')
    return fetch(url, { ...init, redirect: 'error', signal: init?.signal ?? AbortSignal.timeout(180_000) })
  }
  try { return await call() } finally { globalThis.fetch = fetch }
}

export async function checkCreationHelper(helper: HelperSetup) {
  check(creationAllowed(CREATION_PROTOCOL, await localCall(helper.origin, coordinatorCreationMin)), 'helper')
}

type Registration = {
  vault_id: string; cp: number; threshold: number; total: number; address: string
  change_receiver: string; ufvk: string; birthday: number
}

export function matchRegistration(reg: Registration, publicView: HelperVault, id: string, digest: string) {
  check(publicView.state === 'pinned' && publicView.pkp_digest === digest && publicView.vault_id === id
    && reg.vault_id === id && reg.cp === CREATION_PROTOCOL && reg.threshold === 2 && reg.total === 3
    && publicView.threshold === reg.threshold && publicView.total === reg.total, 'registration')
  check(typeof reg.address === 'string' && !!reg.address && reg.address === publicView.address
    && typeof reg.change_receiver === 'string' && !!reg.change_receiver && reg.change_receiver === publicView.change_receiver, 'registration')
  checkViewingMetadata(reg.ufvk, reg.birthday)
}

export async function registerDrill(helper: HelperSetup, creator: DkgCeremony) {
  const bundle = creator.pinBundle()
  const cfg = creator.config
  check(creator.complete && bundle && cfg?.vn, 'ceremony')
  const id = bytesToHex(creator.session!.groupVk())
  const answer = await localCall(helper.origin, () => registerVaultResult(id, cfg.vn!, cfg.t, cfg.n, CREATION_PROTOCOL, bundle))
  check('ok' in answer, 'helper')
  const dir = join(helper.vaults, id)
  const raw = await readFile(join(dir, 'registration.json'), 'utf8')
  const reg: Registration = JSON.parse(raw)
  matchRegistration(reg, answer.ok, id, bytesToHex(creator.session!.pkpDigest()))
  // Give the native check the SAME bytes we export. A path supplied by the JSON is never followed.
  const result = spawnSync(helper.checker, [join(dir, 'wallet')], { input: raw, encoding: 'utf8', timeout: 15_000, windowsHide: true })
  check(result.status === 0, 'native')
  const [external, internal] = JSON.parse(result.stdout) as [number[], number[]]
  const fingerprint = await receiversFingerprint(id, bytesToHex(Uint8Array.from(external)), bytesToHex(Uint8Array.from(internal)))
  return { ...reg, fingerprint }
}
