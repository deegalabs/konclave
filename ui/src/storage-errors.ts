// The storage layer refuses with a CODE; the screen turns the code into a sentence in the member's
// language. Before #586 both dialogs showed `e.message` straight from storage.ts, so a member using
// the app in Portuguese read the most important message of a restore in English. The message on the
// error stays (English, for logs and tests); the dictionary key is looked up from the code.

export type StorageErrorCode =
  | 'no-storage'
  | 'no-vault'
  | 'no-id'
  | 'passphrase-required'
  | 'new-passphrase-required'
  | 'wrong-passphrase'
  | 'wrong-passphrase-saved'
  | 'not-an-export'
  | 'corrupt'
  | 'unsupported-version'
  | 'already-exists'
  | 'same-passphrase'
  | 'sealed-field-unreadable'

export class StorageError extends Error {
  readonly code: StorageErrorCode
  constructor(code: StorageErrorCode, message: string) {
    super(message)
    this.name = 'StorageError'
    this.code = code
  }
}

export const storageError = (code: StorageErrorCode, message: string) => new StorageError(code, message)

/** One mapping, used by the export and the import dialogs. The key exists in both dictionaries
 *  (the parity test holds that); an error without a code falls back to the dialog's generic line. */
const KEY: Record<StorageErrorCode, string> = {
  'no-storage': 'storage.err.noStorage',
  'no-vault': 'storage.err.noVault',
  'no-id': 'storage.err.noId',
  'passphrase-required': 'storage.err.passphraseRequired',
  'new-passphrase-required': 'storage.err.newPassphraseRequired',
  'wrong-passphrase': 'storage.err.wrongPassphrase',
  'wrong-passphrase-saved': 'storage.err.wrongPassphraseSaved',
  'not-an-export': 'storage.err.notAnExport',
  'corrupt': 'storage.err.corrupt',
  'unsupported-version': 'storage.err.unsupportedVersion',
  'already-exists': 'storage.err.alreadyExists',
  'same-passphrase': 'storage.err.samePassphrase',
  'sealed-field-unreadable': 'storage.err.sealedFieldUnreadable',
}

export function storageErrorKey(e: unknown, fallbackKey: string): string {
  return e instanceof StorageError ? KEY[e.code] : fallbackKey
}
