- **Until the coordinator switches, every vault payment pays 5,000 zatoshis per action, and can be
  told apart.** After block 3,590,000 (expected around 19 November 2026), wallets that follow ZIP 2009
  pay 1,000; the fee is public, so a vault transaction paying five times that stands out from theirs.
  The plan is for the coordinator to build at 1,000 in a later release, only for a vault whose every
  device accepts that rate; that is not built yet. A vault with one device that is never updated (a
  desktop install has no updater, #606) would keep paying 5,000.
- **The estimate stays at 5,000 per action after the switch**, because a device still accepts 5,000.
  Once the coordinator pays 1,000, the screens reserve more than a payment costs.
- **5,000 per action stays accepted with no end date**, so a coordinator can still choose the higher
  fee after the switch: the fee every vault pays today.
- **A device starts accepting 1,000 about 30 hours before its clock expects block 3,590,000.** It
  judges the height by its own clock, which cannot place the chain closer than that.
