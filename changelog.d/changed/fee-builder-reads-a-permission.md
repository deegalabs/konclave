- **The builder of a payment or a payroll can take a permission into its network-fee decision, and a
  switch pins it.** The coordinator's builder reads the wallet's own block height and a permission,
  and the coordinator checks the fee of its own transaction before anyone is asked to approve it. No
  vault has the permission yet: every payment pays what it paid before, 5,000 per action, and the
  switch is on by default.
