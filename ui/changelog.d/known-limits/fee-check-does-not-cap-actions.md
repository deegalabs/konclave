- **The device limits padding, but not how many actions a payment carries.** Before it signs a
  payment from the vault's desk, your device checks that the fee is exactly ZIP 317's fee for the transaction's actions at a rate its
  clock allows (5,000 zatoshis per action, and also 1,000 under ZIP 2009 once its clock says block
  3,590,000 may have been reached), and it limits padding. But that limit grows with the
  transaction, and the coordinator builds the transaction: it chooses how many spends the vault is
  asked to sign, which of the vault's notes are spent and how the change is split. So a hostile or
  compromised coordinator can make the vault pay a higher fee than the payment needs. The extra goes
  to the network, not to the coordinator, and the recipient and the amount do not change. Two
  earlier entries said this more firmly than the code supports: the 0.10.0 Known limits ("refuses
  padding the coordinator signed itself") and the 0.19.0 entry for the lower network fee ("and so is
  padding that raises it"). This entry corrects both (#940).
