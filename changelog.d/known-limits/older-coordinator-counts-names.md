- **A coordinator taken back to a version before this release counts names again.** Each proposal
  keeps the names beside the votes, so an older coordinator reads every record, but it counts the
  names, with the limits the change to counting approvals (Security, above) removes. A proposal it
  writes keeps only the names, so if it is still open after the update, its members vote again.
