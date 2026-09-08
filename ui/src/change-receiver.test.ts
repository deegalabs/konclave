import 'fake-indexeddb/auto'
import { describe, it, expect } from 'vitest'
import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import {
  saveVault, listVaults, recordChangeReceiver, updateVaultMeta, deleteVault,
  exportVault, importVault, parseVaultExport, type VaultData,
} from './storage'

// The vault's change receiver, captured ONCE and never rewritten (#281, step 2).
//
// The money gate decides on recipient bytes, so it has to be able to tell the vault's own change
// output from a stranger's. It cannot derive it: `zcash-sign generate` mints the full viewing key
// from a RANDOM `sk` it then discards, so the internal (change) address is not a function of the
// public group key. The device is told, by the helper, at vault creation.
//
// That places trust in the helper AT THE MOMENT OF CAPTURE - the same trust the external
// `address` already gets. What makes it worth anything is the second half: the value is
// WRITE-ONCE. A helper that turns hostile later cannot re-answer `/api/vault` with the attacker's
// receiver and have the device accept it as "our change"; the stored value stands. Without that,
// the whole gate reduces to trusting whatever the helper said most recently, which is the bug
// #281 exists to close.
//
// So the write-once rule is not a storage nicety. It is the security property, and it is asserted
// here on behaviour AND on the source, because a second writer somewhere else would silently undo
// it - which is exactly the failure shape that produced #424, #425, #439 and #349.

const data: VaultData = {
  name: 'Vault', governance: 'quorum', myName: 'Alice', creatorName: 'Alice',
  groupKey: new Uint8Array(32).fill(7),
  address: 'u1externalreceiveaddress',
  roster: ['Alice', 'Bob'],
  sealedShare: new Uint8Array(32).fill(1),
}

/** The honest receiver, as the helper answers it at creation. */
const OURS = 'aa'.repeat(43)
/** What a helper that turned hostile would like the device to accept later. */
const ATTACKER = 'bb'.repeat(43)

async function fresh(id: string): Promise<void> {
  await deleteVault(id)
  await saveVault(id, data, 'correct horse battery staple')
}

async function receiverOf(id: string): Promise<string | undefined> {
  return (await listVaults()).find((v) => v.id === id)?.changeReceiver
}

describe('the vault change receiver is captured once', () => {
  it('is absent until it is recorded, and absent never means "matches nothing"', async () => {
    await fresh('cr-absent')
    // A vault registered before the helper published the field reads as UNKNOWN. The gate must
    // treat that as "I cannot tell change from a stranger" and stay unarmed - never as an empty
    // allowlist, which would refuse every honest send and, worse, invite someone to "fix" it by
    // trusting the request.
    expect(await receiverOf('cr-absent')).toBeUndefined()
  })

  it('records the receiver the helper published at creation', async () => {
    await fresh('cr-write')
    await recordChangeReceiver('cr-write', OURS)
    expect(await receiverOf('cr-write')).toBe(OURS)
  })

  it('REFUSES to overwrite one already recorded - this is the security property', async () => {
    await fresh('cr-once')
    await recordChangeReceiver('cr-once', OURS)
    await recordChangeReceiver('cr-once', ATTACKER)
    expect(await receiverOf('cr-once')).toBe(OURS)
  })

  it('reports whether it wrote, so a caller cannot mistake a refusal for a success', async () => {
    await fresh('cr-report')
    expect(await recordChangeReceiver('cr-report', OURS)).toBe(true)
    expect(await recordChangeReceiver('cr-report', ATTACKER)).toBe(false)
  })

  it('ignores an empty or malformed value instead of storing it', async () => {
    // The helper answers `""` for a registration written before the field existed. Storing that
    // would burn the write-once slot on a value that means "unknown", and the real receiver could
    // then never be captured.
    await fresh('cr-empty')
    expect(await recordChangeReceiver('cr-empty', '')).toBe(false)
    expect(await recordChangeReceiver('cr-empty', '   ')).toBe(false)
    expect(await receiverOf('cr-empty')).toBeUndefined()
    // Still capturable afterwards: the slot was not consumed.
    expect(await recordChangeReceiver('cr-empty', OURS)).toBe(true)
  })

  it('survives an unrelated metadata patch', async () => {
    // `updateVaultMeta` spreads a patch over the whole record. A rename must not drop the receiver.
    await fresh('cr-patch')
    await recordChangeReceiver('cr-patch', OURS)
    await updateVaultMeta('cr-patch', { myName: 'Alicia' })
    expect(await receiverOf('cr-patch')).toBe(OURS)
  })

  it('does nothing for a vault this device does not have', async () => {
    expect(await recordChangeReceiver('cr-missing', OURS)).toBe(false)
  })
})

describe('the export carries the pin', () => {
  it('a restored device inherits the receiver instead of re-asking the helper', async () => {
    // #480's lesson, applied. If the export dropped it, a restore would have to capture the
    // receiver again from the helper - at a moment when the helper may already be the thing being
    // defended against. Carrying it preserves the ORIGINAL capture, which is the only one made
    // before there was anything to defend.
    await fresh('cr-export')
    await recordChangeReceiver('cr-export', OURS)
    const blob = await exportVault('cr-export', 'correct horse battery staple')
    const parsed = parseVaultExport(JSON.stringify(blob)) // survives file/paste serialization
    await deleteVault('cr-export')
    await importVault(parsed, 'correct horse battery staple')
    expect(await receiverOf('cr-export')).toBe(OURS)
  })

  it('and the restored pin is still write-once', async () => {
    // A restore must not reopen the slot: an importer that wrote the field with a plain `put`
    // leaves it overwritable, and the guard below would not catch that on its own.
    expect(await recordChangeReceiver('cr-export', ATTACKER)).toBe(false)
    expect(await receiverOf('cr-export')).toBe(OURS)
  })
})

describe('nothing else may write the change receiver', () => {
  const SRC = new URL('.', import.meta.url).pathname

  function sources(dir: string): string[] {
    return readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
      const p = join(dir, e.name)
      if (e.isDirectory()) return e.name === 'wasm-pkg' ? [] : sources(p)
      if (!/\.tsx?$/.test(e.name) || /\.test\.tsx?$/.test(e.name)) return []
      return [p]
    })
  }

  it('only storage.ts assigns the field', () => {
    // Excludes test files deliberately: counting them would rebuild the blind spot, the same way
    // #468's guard had to. A screen that needs to capture the receiver calls
    // `recordChangeReceiver`; writing `changeReceiver:` anywhere else is a second implementation
    // of a write-once rule, and the second one is always the one that forgets the "once".
    const offenders = sources(SRC)
      .filter((p) => !p.endsWith('storage.ts'))
      .filter((p) => /changeReceiver\s*:/.test(readFileSync(p, 'utf8')))
      .map((p) => p.slice(SRC.length))
    expect(offenders, `these assign changeReceiver directly instead of calling recordChangeReceiver`).toEqual([])
  })

  it('SOMETHING outside the tests actually captures it', () => {
    // #468's guard, in the other direction. There the failure was a capability the UI offered to
    // USE with no screen that could CREATE it; `enrolPrf` was called only from its own test, so the
    // feature shipped, passed, and was unreachable. Here the same hole would be quieter still: the
    // gate would read `changeReceiver`, find it forever absent, stay unarmed on every vault, and
    // look exactly like a gate that is working.
    //
    // Test files are excluded on purpose - counting them is what rebuilds the blind spot.
    const callers = sources(SRC)
      .filter((p) => !p.endsWith('storage.ts'))
      .filter((p) => /recordChangeReceiver\s*\(/.test(readFileSync(p, 'utf8')))
      .map((p) => p.slice(SRC.length))
    expect(callers.length, 'nothing calls recordChangeReceiver, so the pin is never captured').toBeGreaterThan(0)
  })

  it('the metadata patch type cannot carry it', () => {
    // `updateVaultMeta` takes `Partial<Pick<VaultRecord, ...>>`. If the receiver is ever added to
    // that Pick, the write-once rule is bypassable through a rename, in one line, with no test
    // failing anywhere else.
    const src = readFileSync(join(SRC, 'storage.ts'), 'utf8')
    const decl = src.slice(src.indexOf('export async function updateVaultMeta'))
    const signature = decl.slice(0, decl.indexOf('): Promise<void>'))
    expect(signature).not.toContain('changeReceiver')
  })

  it('the writer refuses an existing value rather than merging over it', () => {
    const src = readFileSync(join(SRC, 'storage.ts'), 'utf8')
    const fn = src.slice(src.indexOf('export async function recordChangeReceiver'))
    const body = fn.slice(0, fn.indexOf('\n}'))
    expect(body, 'recordChangeReceiver must short-circuit when one is already stored').toMatch(
      /rec\.changeReceiver/,
    )
  })
})
