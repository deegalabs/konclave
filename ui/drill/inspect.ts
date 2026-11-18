import { readFileSync } from 'node:fs'
import init, { groupKeyOfPackage } from '../src/wasm-pkg/konclave_wasm.js'
import { bytesToHex, unb64 } from '../src/bytes.ts'
// @ts-expect-error The standalone opener is plain Node ESM.
import { openExport, examine } from '../../scripts/open-export.mjs'

const reasons = {
  open: 'Wrong passphrase or unreadable export.',
  version: 'A v2 export is required.',
  private: 'A Private vault and its read secret are required.',
  quorum: 'Expected one seated member of a 2-of-3 vault.',
  group: 'The group or participant packages disagree.',
  ceremony: 'The creation ceremony did not agree and finish.',
  wallet: 'A complete export needs an address, viewing key and scan floor.',
  floor: 'A nonnegative wallet scan floor is required.',
  viewing: 'The viewing key is missing.',
  registration: 'The registration does not match this ceremony and wallet.',
  helper: 'The isolated testnet helper or its registration is unavailable.',
  native: 'The native testnet receiver or wallet birthday check failed.',
  storage: 'The isolated record or reopened export differs.',
  child: 'The fresh process could not verify this export.',
  tty: 'Enter each passphrase on a terminal with echo disabled.',
  passphrase: 'Choose a strong passphrase and enter the same value twice.',
  path: 'Use a new output directory under a private directory outside the checkout.',
  tools: 'The testnet helper, pinned engine tools and receiver checker must be executable.',
  interrupted: 'The export drill was interrupted.',
  usage: 'Use self-test, generate NEW_DIRECTORY, or verify EXPORT_FILE.',
} as const

export function check(condition: unknown, reason: keyof typeof reasons): asserts condition {
  if (!condition) throw new Error(reasons[reason])
}

// Dependencies can put their inputs in errors. Only our fixed labels may reach a terminal.
export function safeFailure(e: unknown): string {
  const message = e instanceof Error ? e.message : ''
  return Object.values<string>(reasons).includes(message) ? message : 'The drill did not finish.'
}

export async function initDrillWasm() {
  const binary = new URL('../src/wasm-pkg/konclave_wasm_bg.wasm', import.meta.url)
  await init({ module_or_path: readFileSync(binary) })
}

export async function openSeat(file: { version?: number }, passphrase: string, seatOnly = false) {
  check(file?.version === 2, 'version')
  const { payload } = await openExport(file, passphrase).catch(() => { throw new Error(reasons.open) })
  return inspectSeat(payload, seatOnly)
}

export function checkViewingMetadata(ufvk: unknown, birthday: unknown) {
  check(typeof ufvk === 'string' && !!ufvk, 'viewing')
  checkScanFloor(birthday)
}

export function checkScanFloor(birthday: unknown) {
  check(typeof birthday === 'number' && Number.isSafeInteger(birthday) && birthday >= 0, 'floor')
}

export function inspectSeat(payload: Awaited<ReturnType<typeof openExport>>['payload'], seatOnly = false) {
  const { share, problems } = examine(payload)
  check(payload.governance === 'quorum' && typeof payload.accessSecret === 'string'
    && /^[0-9a-f]{64}$/.test(payload.accessSecret), 'private')
  check(share?.t === 2 && share.n === 3 && Number.isInteger(share.seat)
    && share.seat >= 1 && share.seat <= 3 && payload.threshold === share.t && payload.total === share.n
    && Array.isArray(payload.roster) && payload.roster.length === 3 && new Set(payload.roster).size === 3
    && payload.myName === payload.roster[share.seat - 1], 'quorum')
  check(payload.groupKey === payload.id && bytesToHex(groupKeyOfPackage(unb64(share.pubkeys))) === payload.id, 'group')
  if (seatOnly) {
    // Only the offline self-test accepts a pending, deliberately seat-only record.
    check(payload.pending === true && payload.address === '' && payload.ufvk === undefined
      && payload.birthday === undefined && !payload.abandoned, 'storage')
  } else {
    checkViewingMetadata(payload.ufvk, payload.birthday)
    check(!payload.pending && !payload.abandoned && problems.length === 0
      && typeof payload.address === 'string' && !!payload.address && typeof payload.changeReceiver === 'string'
      && !!payload.changeReceiver, 'wallet')
  }
  return { payload, share }
}
