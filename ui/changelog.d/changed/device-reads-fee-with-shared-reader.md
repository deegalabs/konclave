- **Your device reads a payment's network fee with the same reader the coordinator checks its own
  transaction with.** Before signing, the device reads the fee and the number of actions from the
  transaction, and that reading now comes from one shared function instead of the device's own copy,
  so the two sides cannot drift apart. What the device accepts does not change (#847).
