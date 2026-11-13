- **The device limits padding, but not how many actions a payment carries.** Before it signs a
  payment from the vault's desk, your device checks that the fee is exactly the standard network fee
  (ZIP 317) for the transaction's actions, and it limits padding. But that limit grows with the
  transaction, and the coordinator builds the transaction: it chooses how many spends the vault is
  asked to sign, which of the vault's notes are spent and how the change is split. So a hostile or
  compromised coordinator can make the vault pay a higher fee than the payment needs. The extra goes
  to the network, not to the coordinator, and the recipient and the amount do not change. Two
  earlier entries said this more firmly than the code supports: the 0.10.0 Known limits ("refuses
  padding the coordinator signed itself") and the 0.19.0 entry for the lower network fee ("and so is
  padding that raises it"). This entry corrects both (#940).
