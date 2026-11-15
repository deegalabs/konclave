- **After "Protect the vault" the passphrase boxes stayed editable and then showed up empty.** While the
  device was sealing your part they could still be typed in, and once it was saved they were blank, which
  read as a passphrase that had been erased. They are now locked while it saves, and replaced by a line
  saying the passphrase is set. What was saved was never affected: the passphrase that protects your part
  is the one you had typed when you pressed the button, and the backup file only opens with that same one
  (#928).
