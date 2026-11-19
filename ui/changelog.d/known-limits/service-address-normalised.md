- **A coordinator address saved before this release can read back differently, and old vault records
  keep the address they stored (#1067).** An address saved in mixed case or with `:443` now reads back
  normalised (lower case, no default port), so a vault whose creation was started against the old
  spelling shows the "this vault was created while this device used another server" question when
  you finish it, although it is the same server. Answer it only if you recognise the server. And a
  vault record written before this release keeps whatever coordinator address it stored, a password
  included if the address had one: it is no longer shown with the password, but it is not removed
  from the record.
