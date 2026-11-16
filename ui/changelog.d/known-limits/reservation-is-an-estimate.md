- **A proposal's reservation holds its amount plus a fee estimate, and only this app applies it.**
  The fee actually paid depends on the notes the wallet picks and can be higher than the estimate,
  so two open proposals can still add up to more than the vault can pay. The coordinator does not
  reserve across proposals: two members proposing at the same moment, or a client that does not
  apply the reservation, can each create a proposal the vault cannot fund once both are sent. When
  open proposals add up to more than the vault can spend, the dashboard says so.
