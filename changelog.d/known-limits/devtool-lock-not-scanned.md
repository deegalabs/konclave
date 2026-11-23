- **The automatic check of Rust dependencies against published security advisories does not cover
  the two tools the coordinator runs that are built from other projects.** It checks the root lock
  (the coordinator, the signer, the browser's signing module and the desktop shell) and the relay's
  own lock, not the lock under `engine/patches/` that `zcash-devtool` is built from, nor the one
  `zcash-sign` is built with in the Zcash Foundation's `frost-tools`. Open advisories against the
  `zcash-devtool` lock are being triaged before it is added.
