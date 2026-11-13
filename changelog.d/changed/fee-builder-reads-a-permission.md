- **The builder of a payment or a payroll can take a permission into its network-fee decision, and a
  switch pins it.** The coordinator's builder reads the wallet's own block height and a permission,
  and the coordinator checks the fee of its own transaction before anyone is asked to approve it,
  refusing it unless it pays exactly the fee the builder's rule gives (a consistency check on its own
  build, not a defence: from block 3,590,000 the devices accept either fee). A
  vault can be given the permission only when every one of its seats has reported that its device
  accepts the lower fee, and only while the operator's switch is set to allow it. The switch is on by
  default: every payment pays what it paid before, 5,000 per action.
