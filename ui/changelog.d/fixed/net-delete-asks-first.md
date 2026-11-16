- **Delete on the /net page asks first.** On the saved-vault row, Delete removed the vault from this
  device without asking. If that member had no backup, it destroyed the only copy of their part of the
  key on this device. It now opens a confirmation that says the part is lost on this device unless a
  backup exists, offers to export it first, and asks for the vault's name before it deletes (a vault
  with no name asks for the first eight characters of its id). If the removal fails it says so and
  stays open. The Vaults screen and Settings now use this same confirmation, so the three can no
  longer differ: Settings' button now reads "Delete permanently", its name field no longer shows the
  name inside the box, and Vaults no longer shows it either.
