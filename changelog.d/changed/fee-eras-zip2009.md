- **The network fee rule has one home, and follows ZIP 2009 by the block height the device's clock allows (#847).** The fee per
  action (5,000 zatoshis, and 1,000 from mainnet block 3,590,000 under ZIP 2009, Proposed) lives in
  one table in the shared crate, beside the network-upgrade rows; the device's signing check and the
  app's fee estimate both read it. Source scans fail the build when the Rust crates or the app write
  the fee constants, a marginal fee or the switch height in the forms they know (the coordinator's
  two files are excused until it reads the table).
  The desktop app carries the same device check as the web app: see the app's changelog. The
  coordinator still builds at 5,000.
