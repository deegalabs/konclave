- **A protected vault this device holds a record of is not named before it is unlocked.** When you
  open the app on such a vault, the app decides from that record that it must be unlocked, and asks
  for the passphrase without sending the vault's id to the coordinator first. The screens behind the
  unlock prompt are no longer loaded, so they make no reads of their own either, and the same holds
  when you leave the unlock prompt and when you switch to the vault from another one in the rail.
  After you unlock, the reads go out as before. The rail now says "Locked" under the vault's name
  while it waits, and the app behind the prompt can no longer be reached with the keyboard. The app
  still shows that it was opened (its liveness check and version check), and neither names a vault.
  A vault this device holds no record of is still read through the coordinator, as before.
