- **Correction to 0.21.0: the coordinator checks the fee of its own transaction before the devices
  are asked to sign it, not before anyone is asked to approve it.** The 0.21.0 entry on the
  builder's fee permission said the second; the check runs when the payment is built for signing,
  after the members have approved it. What it checks is unchanged.
