- **After an earlier transaction's deadline, a device signed the same payment again with no warning
  (from 0.13.0 until 0.21.0).** Since 0.13.0 your device keeps a record of the transactions it
  signed, and warns you before it signs a second, different transaction for the same proposal. That
  warning stopped once, by the device's own clock and with a margin, the earlier transaction could no
  longer be mined: from then on a new transaction for the proposal got the ordinary Sign prompt, the
  one a first signature gets. But the device cannot see the chain, so it could not know whether the
  earlier transaction had been mined before its deadline. A hostile or compromised coordinator could
  send the first transaction, tell the members the send had failed, wait for the deadline and build
  the payment again. If enough members to sign pressed Sign once more, and the vault held enough for
  both, the payment went out twice. The record was also kept per proposal, so the same payment shown
  as a new proposal got the ordinary prompt too. The 0.13.0 entry said the device "refuses to sign a
  second transaction for the same approval without the explicit confirmation of the member who
  signs"; that held only while the earlier one could still be mined, and only under the same
  proposal. Since 0.21.0 the device asks in that case too: it says it cannot tell whether the
  earlier transaction went out, shows that transaction's id only when it can confirm it signed it,
  so you can look it up in a block explorer, and signs only after you confirm. It also recognises a
  payment with exactly the same recipients, amounts and memos that it signed under another proposal
  in the last seven days, and asks whether this is a separate payment. Proposals are signed only
  from their signing panel; the standalone `/net` page no longer signs payments. This narrows the
  risk of a payment going out twice; it does not close it. The device still cannot see the chain: it
  asks, and your check in a block explorer is the protection. And until approvals are bound to what
  a payment pays (#567), the coordinator still supplies the proposal and the lines the device
  compares. It applies only on a device running 0.21.0 or later: reload the web app and install the
  0.21.0 desktop app. This is the later entry the 0.21.0 Security entry announced. We found this in
  our own review while designing #567. We have no report that it was used.
