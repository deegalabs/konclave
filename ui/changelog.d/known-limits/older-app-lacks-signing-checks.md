- **A device on an app older than 0.21.0 does not have these checks.** It signs a payment again after
  the earlier transaction's deadline with no warning, and its `/net` page still signs. A payment
  needs enough devices to sign, so a vault is protected by the devices that were updated, not by the
  release.
