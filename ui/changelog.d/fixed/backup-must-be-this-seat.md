- **A backup whose key does not match its own seat and vault is refused, instead of being
  restored.** Importing a vault backup now checks the saved key against the vault's public keys
  the backup carries (the seat, the vault key, the quorum and the seat's public share), and a copy
  already on the device is checked the same way when it is opened. A backup that holds one seat's
  key under another seat, or another vault's key, or a key that no longer matches its public share,
  used to import without a word and only fail later, when the seat tried to sign. It now says the
  backup does not belong to this seat and imports nothing; a device holding such a copy says so
  when it is unlocked. A backup of your own seat is unaffected. The check cannot tell who made a
  file: restore only from a backup you made, under your own passphrase.
