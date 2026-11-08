- **What the browser still kept for vaults removed before v0.18.0 is now cleared.** Since
  2026-08-21, removing a vault deleted only its record; v0.18.0 made removal take everything else,
  but only for vaults removed from then on. A vault removed earlier left in the browser's storage the
  people saved for it (names, addresses and memos) and, if it was removed from Settings or from the
  create and join screen, its passkey shortcut (encrypted, of no use without that passkey), readable
  by anyone with access to the device or to that browser profile. The app now clears them when it
  opens, for every vault this device no longer holds. It keeps the device's record of the payments it
  signed, for the same reason a removal keeps it. When it cannot read which vaults the device holds
  (or, on a local bridge, when the bridge does not list them), it clears nothing and tries again the
  next time the app opens; with a hosted coordinator it leaves alone the traces of vaults that live
  on a local bridge.
