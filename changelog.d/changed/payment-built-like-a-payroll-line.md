- **A payment is now built the same way as a payroll line.** The coordinator and the local bridge
  build a single payment with the same builder that builds a payroll, as a payroll of one line, so a
  payment and a payroll share one set of rules. Nothing changes in what a payment pays: the same
  recipient, amount and memo, the same network fee, and the same shielded pool for the change. The
  payee's address and the memo are no longer passed to a helper program on its command line, where
  another process on the same machine could read them.
