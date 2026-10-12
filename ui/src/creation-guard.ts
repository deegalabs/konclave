// Whether leaving the screen now would lose a vault creation. Until a member saves, its part of the
// key exists only in the page (nothing unsaved is ever persisted), so from the invite until the
// creation finished, closing or reloading must ask first. A stopped creation has nothing to lose.
export type CreationPhase = 'idle' | 'roster' | 'confirm' | 'dkg' | 'done' | 'error' | 'restored' | 'signsession'

export function creationBusy(phase: CreationPhase, finished: boolean, stopped: boolean, saved = false): boolean {
  if (stopped || finished) return false
  if (phase === 'done') return !saved // once this device saved its part, leaving loses nothing here
  return phase === 'roster' || phase === 'confirm' || phase === 'dkg'
}

/** What an attempt to close the create dialog (Esc, backdrop) means now. One rule: during a
 *  creation it asks; once the vault is finished it asks about the backup copy while that copy has
 *  not been taken, and then does what the dialog's own "open the vault" button does; otherwise it
 *  closes. */
export function closeIntent(s: { busy: boolean; finished: boolean; backupPending?: boolean }): 'ask' | 'ask-backup' | 'open-vault' | 'close' {
  if (s.busy) return 'ask'
  if (s.finished && s.backupPending) return 'ask-backup'
  if (s.finished) return 'open-vault'
  return 'close'
}
