/**
 * The username a browser password manager files a vault's passphrase under (#929).
 *
 * Every vault's passphrase field looked the same to a manager, so protecting a second vault made it
 * offer to UPDATE the first one's saved entry. A hidden username that differs per vault is what
 * tells it they are different logins. This file is the ONLY place that text is built, so the
 * create screen and the unlock screen cannot disagree about it: a username that differs by one
 * character between them is a manager that never pairs the two.
 *
 * What the manager learns, and what it must not: it learns the vault's local NAME (the name given
 * at creation, the same on every member's device) and a 4-hex tag. The tag is a salted hash of the
 * vault id, never the fingerprint, an id prefix or anything derived from the id directly, because
 * managers sync to clouds. The salt is a fixed public constant: it is domain separation, not a
 * secret, and it must be equal on every device so a restored backup pairs with its old entry.
 */
const TAG_SALT = 'konclave-manager-tag-v1'
/** Shown for a vault with no name. NOT translated and NOT the screen's display fallback: those
 *  differ per screen and per language, so a nameless vault would change username when the
 *  language does. */
const NAMELESS = 'Konclave'

/** The record's raw name, normalised once: NFC (a macOS-typed accent and a Linux one are the same
 *  name), trimmed, and the fixed literal when nothing is left. */
export function usernameName(rawName: string | null | undefined): string {
  return (rawName ?? '').normalize('NFC').trim() || NAMELESS
}

/** 4 hex characters of SHA-256(salt + " " + id), id trimmed and lower-cased like the fingerprint's.
 *  Resolves to null where WebCrypto is unavailable (no username is better than a name-only one,
 *  which would put two same-named vaults back on one entry). */
export async function vaultTag(id: string): Promise<string | null> {
  try {
    const data = new TextEncoder().encode(`${TAG_SALT} ${id.trim().toLowerCase()}`)
    const d = new Uint8Array(await crypto.subtle.digest('SHA-256', data))
    return Array.from(d.slice(0, 2), (b) => b.toString(16).padStart(2, '0')).join('')
  } catch {
    return null
  }
}

/** `name · tag`, from the record's RAW name and the vault id. Null when the tag cannot be made. */
export async function vaultUsername(rawName: string | null | undefined, id: string): Promise<string | null> {
  const tag = await vaultTag(id)
  return tag === null ? null : `${usernameName(rawName)} · ${tag}`
}
