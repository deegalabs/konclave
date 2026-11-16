- **The Dashboard no longer says "Cannot pay right now: 0 of 2 seats present" when nothing is wrong (#693).**
  The card counted seats in the signing room, which this device joins only while a payment is open
  in the signing panel, so with no payment open it read 0 even with every member present, and after
  a panel had been opened and closed it kept the last count, which could read "2 of 2" with nobody
  there. The card no longer counts anyone: it says whether the coordinator answers and whether
  there is free money, and states what a payment needs ("a payment needs 2 of 3 members to sign").
  Who is online is still not known outside a payment (#291).
