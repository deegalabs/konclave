// What this browser keeps for a vault in localStorage, behind ONE door (#868).
//
// A PROTECTED vault (one whose record holds the access secret S) keeps its sealed values as an
// AES-GCM envelope `{v, iv, ct}` under a key derived from S (`deriveLocalKey`, vault-secret.ts); an
// open vault and the local bridge keep what they always kept, byte for byte. The rules, each in this
// file only:
//   - the key exists while S is in the session: `session.ts` calls `vaultLocalUnlocked` /
//     `vaultLocalLocked` from the setters that put S in and take it out, so no unlock path can skip it;
//   - there is NO cache of values. A read is `getItem` + decrypt, so two tabs never diverge and
//     "not loaded yet" is not a state that could be mistaken for "empty";
//   - a read answers ok | absent | locked | unreadable. Only `ok` and `absent` can be written over,
//     and a change is `updateLocal`, serialized per key, so no caller reads-then-writes on its own;
//   - an envelope that does not open is moved aside (never overwritten) and the read says unreadable;
//   - the primitives take S explicitly (export and import hold S before the session does).
// Only a vault whose record carries `secretCipher` is protected: a web vault with no record on this
// device is neither read nor written. The envelope is a JSON OBJECT on purpose: a bundle from before
// this reads `[...obj]` / `.filter` on it and throws, where a bare string would parse to `[]` and be
// overwritten. One-way for whoever migrated: do not roll the app back past this.
// Known limits: key names carry the vault id and sizes show; another member of the vault holds S.
import { deriveLocalKey } from './vault-secret'
import { b64, unb64 } from './bytes'

// sealed: an envelope under S for a protected vault, the clear value for an open one and the bridge.
// ephemeral: for a protected vault held in MEMORY while unlocked and never written (the payroll draft);
//   for an open vault and the bridge, the clear value, as always.
// plain: not touched by this module yet (read and written by its own file).
type Policy = 'sealed' | 'ephemeral' | 'plain'
/** Every per-vault key this browser keeps. `sweep-removed.ts` and `remove-vault.ts` iterate THIS. */
export const VAULT_KEYS = {
  benef: { prefix: 'konclave.benef.', policy: 'sealed' },
  draft: { prefix: 'konclave.folha.rascunho.', policy: 'ephemeral' },
  recent: { prefix: 'konclave.recentPayees.', policy: 'sealed' },
  seen: { prefix: 'konclave.seen.', policy: 'plain' },
  status: { prefix: 'konclave.status.', policy: 'plain' },
  prf: { prefix: 'konclave.prf.', policy: 'plain' },
} as const satisfies Record<string, { prefix: string; policy: Policy }>
export type VaultKeyName = keyof typeof VAULT_KEYS
/** The unkeyed lists of earlier versions: whose vault they belong to cannot be known, so they are only dropped. */
const LEGACY_KEYS = ['konclave.recentPayees', 'konclave.folha.rascunho']
export const [LEGACY_RECENTS_KEY, LEGACY_DRAFT_KEY] = LEGACY_KEYS as [string, string]
export function clearLegacyKeys(): void { for (const k of LEGACY_KEYS) { try { localStorage.removeItem(k) } catch { /* storage unavailable */ } } }

export const vaultKey = (name: VaultKeyName, id: string): string => VAULT_KEYS[name].prefix + id
/** Where an envelope that would not open is moved. */
export const unreadableKey = (name: VaultKeyName, id: string): string => `konclave.unreadable.${name}.${id}`
/** Every key function, the quarantine's included: the one list a sweep and a removal read. */
export const ALL_VAULT_KEY_FNS: ReadonlyArray<(id: string) => string> = (Object.keys(VAULT_KEYS) as VaultKeyName[]).flatMap(
  (n) => [(id: string) => vaultKey(n, id), ...(VAULT_KEYS[n].policy === 'sealed' || VAULT_KEYS[n].policy === 'ephemeral' ? [(id: string) => unreadableKey(n, id)] : [])],
)

export type LocalRead = { s: 'ok'; value: unknown } | { s: 'absent' } | { s: 'locked' } | { s: 'unreadable' }
/** What a change function returns to say "this is not a value I can change": nothing is written. */
export const REFUSE = Symbol('refuse')
export type LocalWrite = 'written' | 'locked' | 'unreadable' | 'failed'

const enc = new TextEncoder()
const aad = (id: string, name: string) => enc.encode(`konclave-local-v1|${id}|${name}`)
const bufOf = (b: Uint8Array): ArrayBuffer => b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength) as ArrayBuffer
const getRaw = (k: string): string | null => { try { return localStorage.getItem(k) } catch { return null } }

type Envelope = { v: 1; iv: string; ct: string }
function asEnvelope(o: unknown): Envelope | null {
  const e = o as Partial<Envelope> | null
  return e && typeof e === 'object' && !Array.isArray(e) && e.v === 1 && typeof e.iv === 'string' && typeof e.ct === 'string' ? (e as Envelope) : null
}
function envelopeOf(raw: string): Envelope | null {
  try { return asEnvelope(JSON.parse(raw)) } catch { return null }
}
async function seal(key: CryptoKey, id: string, name: string, text: string): Promise<string> {
  const iv = crypto.getRandomValues(new Uint8Array(12))
  const ct = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv: bufOf(iv), additionalData: aad(id, name) }, key, enc.encode(text)))
  return JSON.stringify({ v: 1, iv: b64(iv), ct: b64(ct) })
}
async function open(key: CryptoKey, id: string, name: string, e: Envelope): Promise<string> {
  const pt = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: bufOf(unb64(e.iv)), additionalData: aad(id, name) }, key, bufOf(unb64(e.ct)))
  return new TextDecoder().decode(pt)
}

// ---- the key, held by the session ----
const keys = new Map<string, Promise<CryptoKey>>()

/** S entered the session for `id`: the key is posted at once (no state of "opening") and anything
 *  still in the clear is sealed. Called from `session.ts` only. */
export function vaultLocalUnlocked(id: string, s: Uint8Array): void {
  const key = deriveLocalKey(s)
  keys.set(id, key)
  void migrate(id, key).catch(() => { /* the clear copy stays; the next unlock tries again */ })
}
/** S left the session for `id`. */
export function vaultLocalLocked(id: string): void {
  keys.delete(id)
  for (const k of [...memory.keys()]) if (k.endsWith(`.${id}`)) memory.delete(k)
}
/** What a protected vault keeps in memory only (the ephemeral names), as the JSON text. */
const memory = new Map<string, string>()
/** Where `name` is kept for `id` right now: 'memory' for an ephemeral name on a vault unlocked in this
 *  session, else 'storage'. One answer for the screens that say where a draft is. */
export function keptIn(id: string, name: VaultKeyName): 'memory' | 'storage' {
  return VAULT_KEYS[name].policy === 'ephemeral' && keys.has(id) ? 'memory' : 'storage'
}
/** Forget everything kept for `id` under `name`: the stored value, the one set aside, the memory copy. */
export function clearLocal(id: string, name: VaultKeyName): void {
  memory.delete(vaultKey(name, id))
  for (const k of [vaultKey(name, id), unreadableKey(name, id)]) { try { localStorage.removeItem(k) } catch { /* storage unavailable */ } }
}

// ---- protected or open, decided in one place ----
/** With no key: the vault's RECORD decides, read each time (nothing cached to go stale on an import or an
 *  upgrade, #406): a protected record is 'locked' (neither read nor written), an open one 'plain'; records
 *  that cannot be read are 'locked'. Only when there is no record does the answer come from whether this is the
 *  local bridge: on the bridge these keys are kept as they always were ('plain'), on the web a vault
 *  with no record here is 'locked'. That is api.ts's `IS_NET`, the value the screens chose their path
 *  with, and the one reading of it: not a second reading of the coordination mode, which could change
 *  under a running tab. */
async function modeWithoutKey(id: string): Promise<'plain' | 'locked'> {
  const bridge = async () => ((await import('./api')).IS_NET ? 'locked' : 'plain')
  try {
    const rec = (await (await import('./storage')).readVaults()).find((v) => v.id === id)
    if (!rec) return await bridge()
    return rec.secured ? 'locked' : 'plain'
  } catch { return 'locked' } // records that cannot be read may hide a protected vault: never plain
}

// ---- reads ----
async function quarantine(id: string, name: VaultKeyName, raw: string): Promise<void> {
  const q = unreadableKey(name, id)
  try {
    if (localStorage.getItem(q) !== null) return // never overwrite an earlier one: the value stays where it is
    localStorage.setItem(q, raw)
    if (localStorage.getItem(vaultKey(name, id)) === raw) localStorage.removeItem(vaultKey(name, id))
    console.error(`vault-local: ${name} for vault ${id.slice(0, 8)} did not open; kept aside`)
  } catch { /* storage blocked */ }
}
async function readWith(key: CryptoKey | null, id: string, name: VaultKeyName): Promise<LocalRead> {
  const sealed = VAULT_KEYS[name].policy === 'sealed'
  const raw = getRaw(vaultKey(name, id))
  // A copy set aside stays the answer: once the value was moved, "nothing here" would read as an empty
  // book and be exported, or written over, as one.
  if (raw === null) return sealed && getRaw(unreadableKey(name, id)) !== null ? { s: 'unreadable' } : { s: 'absent' }
  const e = envelopeOf(raw)
  try {
    if (e && !key) return { s: 'locked' }
    const value = JSON.parse(e && key ? await open(key, id, name, e) : raw) as unknown // no envelope: the clear form, until sealed
    if (sealed && !Array.isArray(value)) throw new Error('not a list') // a book is a list: any other shape is not the book
    return { s: 'ok', value }
  } catch {
    await quarantine(id, name, raw)
    return { s: 'unreadable' }
  }
}
/** Read with S given explicitly (export, import); `null` = a vault with no S, read in the clear. */
export async function readSealed(s: Uint8Array | null, id: string, name: VaultKeyName): Promise<LocalRead> {
  return readWith(s ? await deriveLocalKey(s) : null, id, name)
}
/** Read with the session's key. */
export async function readLocal(id: string, name: VaultKeyName): Promise<LocalRead> {
  if (VAULT_KEYS[name].policy === 'plain') return readWith(null, id, name)
  const k = keys.get(id)
  if (k && VAULT_KEYS[name].policy === 'ephemeral') {
    const m = memory.get(vaultKey(name, id))
    return m === undefined ? { s: 'absent' } : { s: 'ok', value: JSON.parse(m) as unknown }
  }
  if (k) return readWith(await k, id, name)
  return (await modeWithoutKey(id)) === 'plain' ? readWith(null, id, name) : { s: 'locked' }
}

// ---- writes: serialized per key, compare-and-set against another tab ----
const chains = new Map<string, Promise<unknown>>()
function serialized<T>(k: string, run: () => Promise<T>): Promise<T> {
  const guarded = () => (typeof navigator !== 'undefined' && navigator.locks ? navigator.locks.request(`konclave-local:${k}`, run) : run())
  const next = (chains.get(k) ?? Promise.resolve()).then(guarded, guarded)
  chains.set(k, next.catch(() => undefined))
  return next
}
/** The change itself. Runs INSIDE the key's chain: whatever has to be learned first (the key, whether the
 *  vault is protected) is learned there too, so two changes made in order cannot swap while one of them
 *  waits to find out. */
async function change(key: CryptoKey | null, id: string, name: VaultKeyName, fn: (cur: unknown) => unknown): Promise<LocalWrite> {
  const k = vaultKey(name, id)
  for (let attempt = 0; attempt < 50; attempt++) {
    const before = getRaw(k)
    const cur = await readWith(key, id, name)
    if (cur.s === 'locked') return 'locked'
    if (cur.s === 'unreadable') return 'unreadable'
    const next = fn(cur.s === 'ok' ? cur.value : undefined)
    if (next === REFUSE) return 'unreadable'
    const text = JSON.stringify(next)
    const out = key ? await seal(key, id, name, text) : text
    try {
      if (getRaw(k) !== before) continue // another tab wrote meanwhile: read again, do not lose its change
      localStorage.setItem(k, out)
      return 'written'
    } catch { return 'failed' }
  }
  return 'failed'
}
/** Change a value: `fn` gets the current one (undefined when absent). Writes only over ok or absent. */
export async function updateLocal(id: string, name: VaultKeyName, fn: (cur: unknown) => unknown): Promise<LocalWrite> {
  if (VAULT_KEYS[name].policy === 'plain') return serialized(vaultKey(name, id), () => change(null, id, name, fn))
  const k = keys.get(id)
  if (k && VAULT_KEYS[name].policy === 'ephemeral') {
    const cur = memory.get(vaultKey(name, id))
    const next = fn(cur === undefined ? undefined : (JSON.parse(cur) as unknown))
    if (next === REFUSE) return 'unreadable'
    memory.set(vaultKey(name, id), JSON.stringify(next)) // memory only: this vault is protected and unlocked
    return 'written'
  }
  return serialized(vaultKey(name, id), async () => {
    if (k) return change(await k, id, name, fn)
    return (await modeWithoutKey(id)) === 'plain' ? change(null, id, name, fn) : 'locked'
  })
}
/** Write with S given explicitly (an import holds S before the session does). `null` = in the clear. */
export async function writeSealed(s: Uint8Array | null, id: string, name: VaultKeyName, value: unknown): Promise<LocalWrite> {
  return serialized(vaultKey(name, id), async () => change(s ? await deriveLocalKey(s) : null, id, name, () => value))
}

/** The NEWEST copy of a value that would not open: the one still in place when a later bad value found
 *  the aside key already taken (the aside key holds the first one), else the one set aside. Opaque;
 *  only a backup carries it. */
export function heldAside(id: string, name: VaultKeyName): string | null {
  return getRaw(vaultKey(name, id)) ?? getRaw(unreadableKey(name, id))
}
/** Keep a copy that came from a backup, aside, where an unreadable one of this device would go. */
export function keepAside(id: string, name: VaultKeyName, raw: string): void {
  const q = unreadableKey(name, id)
  try { if (localStorage.getItem(q) === null) localStorage.setItem(q, raw) } catch { /* storage blocked */ }
}

/** An envelope that arrives as DATA (a backup written by an older tab carries the sealed book as its
 *  book), opened with the S of the vault it belongs to. The list inside, or undefined when it is not a
 *  v1 envelope for this vault and name or does not open. */
export async function openEnvelopeGiven(s: Uint8Array, id: string, name: VaultKeyName, value: unknown): Promise<unknown[] | undefined> {
  const e = asEnvelope(value)
  if (!e) return undefined
  try {
    const list = JSON.parse(await open(await deriveLocalKey(s), id, name, e)) as unknown
    return Array.isArray(list) ? list : undefined
  } catch { return undefined }
}

// ---- migration: the clear copy is replaced by an envelope of the same bytes ----
async function migrate(id: string, keyP: Promise<CryptoKey>): Promise<void> {
  const pending: Promise<unknown>[] = []
  // Every change is queued in this one synchronous pass, so a change made right after the unlock lines up behind it.
  for (const name of Object.keys(VAULT_KEYS) as VaultKeyName[]) {
    const k = vaultKey(name, id)
    // A protected vault's draft lives in memory now: the clear copy an earlier version left is deleted.
    if (VAULT_KEYS[name].policy === 'ephemeral') {
      // Brought into memory first (unless this session already has one), so the member does not lose it once.
      try {
        const raw = getRaw(k)
        if (raw !== null && !memory.has(k)) { JSON.parse(raw); memory.set(k, raw) }
      } catch { /* not JSON: nothing to bring over */ }
      try { localStorage.removeItem(k) } catch { /* storage unavailable */ }
      continue
    }
    if (VAULT_KEYS[name].policy !== 'sealed') continue
    pending.push(serialized(k, async () => {
      const key = await keyP
      const raw = getRaw(k)
      if (raw === null || envelopeOf(raw)) return
      try { if (!Array.isArray(JSON.parse(raw))) throw new Error('not a list') } catch { return await quarantine(id, name, raw) }
      const out = await seal(key, id, name, raw) // the raw string, not a re-serialised value
      const e = envelopeOf(out)
      if (!e || (await open(key, id, name, e)) !== raw) return
      if (getRaw(k) === raw) localStorage.setItem(k, out) // one write replaces the clear copy; a full quota leaves it
    }))
  }
  await Promise.all(pending)
}
