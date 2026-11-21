- **The browser core can say whether a saved key belongs to a seat of a vault.** One check in the
  signing core compares a device's saved key with the vault's public keys (the seat, the vault key,
  the quorum and the public share recorded for the seat). The app uses it to refuse a backup, or a
  saved copy, that is not the seat's own; see the app's changelog.
