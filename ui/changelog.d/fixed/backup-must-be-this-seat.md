- **A backup that does not belong to this seat is refused, instead of being restored.** Importing a
  vault backup now checks that the saved key is this seat's share of that vault, and a copy already
  on the device is checked the same way when it is opened. A backup made for another seat or another
  vault, or one whose key was edited, used to import without a word and only fail later, when the
  seat tried to sign. It now says the backup does not belong to this seat and imports nothing; a
  device holding such a copy says so when it is unlocked. A backup of your own seat is unaffected.
