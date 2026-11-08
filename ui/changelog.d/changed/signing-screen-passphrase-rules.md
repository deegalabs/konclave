- The signing screen and the proposal page now show proposals through one shared reading, and the confirmation lists every
  line of a payroll.
- A vault saved on this device under an older, weaker key setting is re-saved at the current one the next time its
  passphrase is typed. The first unlock after this takes a moment longer. A passkey unlock does not do it.
- **A new passphrase has to be harder to guess.** Creating or joining a vault, and changing a passphrase, now ask for at
  least 12 characters and refuse common passwords and repetition. Below 20 characters they also refuse the most common
  patterns of a word with numbers or a year. The generator and random passwords from a password manager pass: all of them from 20 characters, and most shorter ones that mix upper and lower case. A passphrase you
  already have still opens your vault and your backups, and you can change it at any time. The check reads the shape of the
  text and knows only a short list of seasons, months and common names, so a passphrase it accepts is not proof
  of a strong one.
