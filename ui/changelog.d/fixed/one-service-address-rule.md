- **A coordinator address you type is checked by one rule, and one with a password is refused.** On the
  desktop, the address of your own coordinator was checked only for starting with `https://` and
  containing a dot, by a copy of the same check in two screens, and the functions that store it (and
  the relay's, which no screen offers yet) checked nothing. So an address with a name and password
  (`https://user:pass@host`), a query or a fragment was accepted and kept in the browser's storage in
  plain text. The browser refuses a request to an address with a name and password, so every request
  to it failed without saying why; a query was carried into every request. Now both screens, both
  stores and both reads use one rule: https only (http only for `localhost` and `127.0.0.1`), the
  server itself with no path, no name or password, query, fragment, spaces, invisible or control
  characters, and at most 256 characters. A refused address says why and nothing is stored. An
  address saved before this release that the rule refuses is no longer used: the device has no
  coordinator of its own until you enter one again (Settings says so), and a refused relay address
  falls back to the built-in relay. The saved value is removed when you save another address or pick
  a coordination mode. The question asked before finishing a vault's creation with another server
  shows the server the vault was started with by its host only, without a name or password the
  address may have been saved with (#1067).
