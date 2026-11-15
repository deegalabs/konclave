- **A browser password manager could overwrite one vault's passphrase with another's (#929).** Every
  vault's passphrase field looked the same to the manager, so protecting a second vault, or changing a
  passphrase, made it offer to update the entry saved for the first, and accepting lost that saved
  copy. Where you choose a passphrase (protecting a vault, changing it) and in the export dialog, the
  field now carries a hidden username made of the vault's name and a 4-character tag, so each vault
  has its own entry, and says whether the passphrase is new or the current one. What your manager now
  learns: the vault's name (the one given when it was created, the same on every member's device) and
  that tag. The tag comes from a salted hash of the vault's id, not from the id or its fingerprint, and
  it is the same on every device and for every member of the vault. An entry saved before this has no
  username and can be deleted from the manager. The fields where you type the passphrase to open a
  vault follow in a later release.
