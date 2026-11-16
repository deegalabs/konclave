- **A screen reader read the offline status twice, and the vault switcher opened empty with no
  explanation when the saved vaults could not be read (#320).** The offline pill sat inside a live
  region and also carried its own status role, so it was announced twice; it now has one. The
  switcher listed vaults with a reader that answers an empty list when this browser has no storage or
  the database will not open, so it could not tell "none saved" from "could not read". It now reads
  with the one the Vaults list uses, and says "Could not read the vaults on this device" when that
  read fails; the line is a disabled menu item, so menu navigation reaches it.
