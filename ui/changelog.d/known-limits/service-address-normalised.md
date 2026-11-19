- **A coordinator address saved before this release can read back differently, and old vault records
  keep the address they stored (#1067).** An address saved in a spelling other than its normal form
  (mixed case, `:443`, a non-ASCII name, a numeric IPv4 form) now reads back normalised, so a vault
  whose creation was started against the old spelling shows the "this vault was created while this
  device used another server" question when you finish it, although it is the same server. Answer it
  only if you recognise the server. And a vault record written before this release keeps whatever
  coordinator address it stored, a password included if the address had one: it is no longer shown
  with the password, but it is not removed from the record. An address saved before this release
  with a name and password stays in this device's storage until you save another address or pick a
  coordination mode; it is no longer used or shown.
