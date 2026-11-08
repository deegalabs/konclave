- **A new vault's first read key could be set by anyone who knew the vault's id, from 2026-08-30
  until 2026-11-08 00:06 UTC
  ([GHSA-42h7-6fcj-554w](https://github.com/deegalabs/konclave/security/advisories/GHSA-42h7-6fcj-554w)).**
  Before a member's device registered a vault's read key, the coordinator accepted the first one from
  any caller that knew the vault id: the relay, someone holding the invite, or a member could learn it
  during the creation. Whoever set it first could read that vault's books through the coordinator
  (balance, history, proposals with their destinations, amounts and memos, ledger, members), obtain
  the vault's viewing key, and register devices in the seats no member had registered yet; the
  members' own reads and registrations were refused. It never allowed spending: signing needs the
  members' shares. For a vault made by a current app the window was usually seconds; a vault that
  never registered a read key stayed exposed until it got one or until the fix. Since v0.18.0 a new vault stays closed
  until its members' seat certificates agree on one package and one read key (ADR-0012), and no vault
  takes a first read key any more. **How to tell:** if your vault's books open on every member's
  device, it was not affected; if not, see the advisory before funding it. We have no report that this
  was used. At the fix, none of the vaults we checked on the hosted coordinator was without a read
  key; one, belonging to a user outside the project, was not opened for the check. Vaults created
  before keep their rules.
