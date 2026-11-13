- **With the lower network fee in force for a vault's build, the coordinator refuses its own build
  unless it pays exactly that fee.** Its check of its own transaction used to accept either fee once
  the permission applied; it now requires the one the builder's rule gives (1,000 per action with the
  lower fee in force, 5,000 otherwise). A consistency check on the coordinator's own build, not a
  defence: the devices judge the fee they sign and still accept both.
