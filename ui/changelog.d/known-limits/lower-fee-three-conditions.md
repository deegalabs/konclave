- **Since block 3,590,000 (mined on 19 November 2026), a vault pays the lower network fee only when
  three things hold (#847).** The operator of the vault's server has allowed the lower fee (by
  default it is not allowed, and every vault then pays 5,000 zatoshis per action; the hosted server
  has allowed it since 19 November 2026); every seat of the vault has reported that its device accepts the
  lower fee, which a device does when it unlocks on 0.21.0 or later; and the server's own view of the
  chain has reached that block. Otherwise the vault pays 5,000 per action, which stays valid and can
  be told apart on chain from wallets that pay 1,000. So a vault whose seats have not all reported
  stays at 5,000 per action. The device that unlocked a seat last speaks for it: a seat that has
  never unlocked on 0.21.0 or later, or that unlocks again on an app older than 0.21.0, puts the
  whole vault back on 5,000. To move a vault to the lower fee, each member unlocks it once on 0.21.0
  or later, on the device they sign with.
