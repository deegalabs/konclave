- **"Reserved" and "Free" now count the network fee of open proposals (#1017).** The dashboard and
  the payment screens held back only the amount of each open proposal, so an open payroll of 0.0001
  ZEC reserved 0.0001 while about 0.00025 would leave the vault, and Free read higher than what could
  be paid. A proposal now reserves its amount plus an estimate of its fee, so on a vault with an open
  proposal Free is lower than before and a second proposal that only fit without that fee is refused.
  It is an estimate: the fee actually paid depends on the notes the wallet picks and can be higher.
  Where the proposals could not be read, or the fee could not be estimated, Reserved and Free show
  "-" instead of a figure that leaves the fee out. Only this app reserves: the coordinator does not
  reserve across proposals (see Known limits: the reservation is an estimate).
