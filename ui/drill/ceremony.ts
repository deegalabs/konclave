import { IDBFactory } from 'fake-indexeddb'
import { DeviceKey } from '../src/wasm-pkg/konclave_wasm.js'
import { DkgCeremony, DKG_VERSION, type DkgMsg } from '../src/dkg-ceremony'
import { b64, bytesToHex } from '../src/bytes'
import { bytesEqual } from '../src/net'
import { encodeBundle, deviceGroupKey } from '../src/signing'
import { deriveReadKey, deriveSeatProofKey, generateVaultSecret } from '../src/vault-secret'
import { saveVault, exportVault, recordVerifiedReceivers, updateVaultMeta } from '../src/storage'
import { check, initDrillWasm, openSeat } from './inspect.ts'
import { checkCreationHelper, registerDrill, type HelperSetup } from './registration'

const names = ['Ada', 'Ben', 'Cam']
const config = { n: 3, t: 2, g: 'quorum', vn: 'Export drill', cn: names[0]! } as const

// The Node process uses one device at a time. Each has its own IndexedDB and localStorage.
function deviceStorage() {
  const db = new IDBFactory()
  const mem = new Map<string, string>()
  const local = { getItem: (k: string) => mem.get(k) ?? null, setItem: (k: string, v: string) => mem.set(k, v) }
  return () => {
    Object.defineProperty(globalThis, 'indexedDB', { configurable: true, value: db })
    Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: local })
  }
}

export async function generateExports(passphrases: string[], helper?: HelperSetup) {
  await initDrillWasm()
  const previousStorage = ['indexedDB', 'localStorage'].map(name => [name, Object.getOwnPropertyDescriptor(globalThis, name)] as const)
  const room = crypto.randomUUID()
  const devices = names.map((name, i) => {
    const key = new DeviceKey()
    const ceremony = new DkgCeremony('seat-' + (i + 1), key, room, name)
    return { key, ceremony, activate: deviceStorage() }
  })
  const creator = devices[0]!.ceremony
  const queue: { from: string; msg: DkgMsg }[] = []
  let seq = 0
  function post(c: DkgCeremony, messages: DkgMsg[]) {
    for (const msg of messages) queue.push({ from: c.myTag, msg })
  }
  function deliver() {
    while (queue.length) {
      const { from, msg } = queue.shift()!
      seq++
      for (const { ceremony } of devices) {
        const result = ceremony.apply(from, msg)
        check(result.applied && !ceremony.aborted, 'ceremony')
        ceremony.noteSeq(seq)
        post(ceremony, result.out)
      }
    }
  }

  try {
    if (helper) {
      devices[0]!.activate()
      await checkCreationHelper(helper)
    }
    creator.setOwnConfig(config)
    post(creator, [{ type: 'config', v: DKG_VERSION, ...config }])
    for (const { key, ceremony } of devices) {
      post(ceremony, [{ type: 'hello', v: DKG_VERSION, encPub: b64(key.publicBytes()), name: ceremony.myName }])
    }
    deliver()
    for (const { ceremony } of devices) post(ceremony, ceremony.trySeat())
    deliver()
    const code = creator.code
    check(code && devices.every(d => d.ceremony.code === code), 'ceremony')
    for (const { ceremony } of devices) {
      const confirmed = ceremony.confirmCode(code)
      check(confirmed.ok, 'ceremony')
      post(ceremony, confirmed.out)
    }
    deliver()
    check(devices.every(d => d.ceremony.part3Done), 'ceremony')

    const secret = generateVaultSecret()
    const boxes = creator.sealSecretToOthers(secret)
    const id = bytesToHex(creator.session!.groupVk())
    const roster = creator.seatNames()
    const seats = []
    for (const { ceremony, activate } of devices) {
      const s = ceremony.session!
      const seat = ceremony.mySeat
      const box = boxes.find(b => b.to === seat)
      const access = ceremony.isCreator ? secret : box && ceremony.takeSecret(creator.myTag, seat, box.box, box.sig).secret
      check(access && bytesEqual(access, secret), 'ceremony')
      ceremony.useVaultKeys(await deriveReadKey(access), await deriveSeatProofKey(access))
      const group = deviceGroupKey({ pubkeys: s.pubkeys(), groupVk: s.groupVk() })
      check(bytesToHex(group) === id && bytesEqual(s.pubkeys(), creator.session!.pubkeys()), 'group')
      const pass = passphrases[seat - 1]!
      activate()
      await saveVault(id, {
        groupKey: group, address: '', name: config.vn, governance: config.g, myName: ceremony.myName,
        creatorName: config.cn, roster, accessSecret: access, pending: true,
        threshold: config.t, total: config.n, cp: DKG_VERSION, sealedShare: encodeBundle(s, seat, config.n, config.t),
      }, pass)
      post(ceremony, ceremony.markSaved())
      seats.push({ ceremony, activate, pass, seat })
    }
    deliver()
    check(seats.every(({ ceremony }) => ceremony.complete) && creator.pinBundle(), 'ceremony')

    const wallet = helper && await registerDrill(helper, creator)
    const exports = []
    for (const { ceremony, activate, pass, seat } of seats) {
      activate()
      if (wallet) {
        // Same receivers primitive as the helper, checked on testnet against the agreed package.
        check(await recordVerifiedReceivers(id, wallet.address, wallet.change_receiver, wallet.fingerprint,
          { address: '', change: '' }, wallet.birthday), 'storage')
        await updateVaultMeta(id, { pending: false })
      }
      const file = await exportVault(id, pass, wallet?.ufvk, wallet?.birthday)
      const { payload, share } = await openSeat(file, pass, !wallet)
      check(share.seat === seat && share.kp === b64(ceremony.session!.keyPackage())
        && share.pubkeys === b64(ceremony.session!.pubkeys()) && payload.groupKey === id, 'group')
      check(payload.cp === DKG_VERSION && payload.name === config.vn && payload.creatorName === config.cn
        && JSON.stringify(payload.roster) === JSON.stringify(roster) && payload.accessSecret === bytesToHex(secret)
        && payload.address === (wallet?.address ?? '') && payload.ufvk === wallet?.ufvk
        && payload.birthday === wallet?.birthday && payload.changeReceiver === wallet?.change_receiver, 'storage')
      exports.push({ seat, file })
    }
    return exports
  } finally {
    for (const { ceremony, key } of devices) { ceremony.session?.free(); key.free() }
    for (const [name, descriptor] of previousStorage) {
      if (descriptor) Object.defineProperty(globalThis, name, descriptor)
      else Reflect.deleteProperty(globalThis, name)
    }
  }
}
