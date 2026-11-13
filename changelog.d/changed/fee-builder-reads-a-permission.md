- **The builder of a payment or a payroll can now pay the lower network fee, and a switch pins it.**
  The coordinator's builder takes a permission and the wallet's own block height into its fee
  decision, and the coordinator checks the fee of its own transaction before anyone is asked to
  approve it. No vault is switched to a different fee yet: every payment pays what it paid before,
  5,000 per action, until the lower fee has been tried on staging after block 3,590,000.
