- **A device accepts the lower network fee from block 3,590,000 (ZIP 2009, #847).** ZIP 2009
  (Proposed) lowers the fee per action from 5,000 to 1,000 zatoshis at mainnet block 3,590,000. A
  device on this version accepts a payment at either rate once its clock says the chain may have
  reached that block, and only at 5,000 before it. Any other fee is still refused, and so is padding
  that raises it. A payment at 1,000 that reaches a device whose clock is behind is refused with a
  message to check the date and time, not one about tampering. Nothing changes for a payment today:
  the coordinator still builds at 5,000, which stays valid after the switch.
- **One network fee estimate on every screen (#692).** The payment screen reserved 0.00015 ZEC for a
  payment while the proposal page and the signing panel showed 0.0001 for the same payment. The four
  screens now read one estimate from the rule the device signs by: 0.00015 ZEC for a payment to one
  person, and one more action for each payroll line beyond two. If the device cannot work it out (the
  app did not finish loading, or the device's clock is set before July 2026), Propose stays closed
  and says why.
