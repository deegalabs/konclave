- **The /net page no longer copies in silence.** Its "Copy address" button for the vault's address
  and the signing-session code copied without waiting for the browser and said nothing either way,
  so a refused copy left the old clipboard in place unnoticed. The address button now says "Copied"
  only when the browser confirmed it, and says so when it did not; the session code has the app's
  copy button, which shows a check only when the copy worked (#313).
