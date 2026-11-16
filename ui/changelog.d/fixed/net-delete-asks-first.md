- **Delete on the /net page asks first.** On the saved-vault row, Delete removed the vault from this
  device without asking. If that member had no backup, it destroyed the only copy of their part of the
  key on this device. It now opens the same confirmation the Vaults screen uses, which says the part is
  lost on this device unless a backup exists, offers to export it first, and keeps Cancel as the
  safe way out.
