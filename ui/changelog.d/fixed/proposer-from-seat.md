- **A member who was not seat 1 could be refused a proposal with a message that blamed the wrong thing,
  or have it recorded under the first member's name (#591).** When a device's record had no name for
  its member, the payment and payroll screens proposed under the name of the vault's first member.
  The proposal was still signed for the device's real seat, so a vault with signed actions refused
  every seat but the first with "this was sent under a name that is not this device's seat" and sent
  the member looking for a fault in a list that was right. A vault without signed actions accepted
  the proposal and recorded it, and its first approval, under the first member. The screens now take
  the name from the seat this device holds, as the coordinator serves it, and the same seat signs the
  proposal. When the device cannot say (the vault is locked, the member list could not be read, or
  the coordinator has no name for the seat) Propose stays closed and the screen says which, and it
  never falls back to another member's name or to a placeholder. If this device's own list of members
  names its seat differently from the coordinator's, the screen shows the same warning the members
  page does, without blocking. Voting and renaming still read the device's saved name, and are the
  next change.
- **Changed: on a vault without signed actions, a device must unlock the vault before it proposes,
  and unlocking registers its key (#591).** A device that proposed there without unlocking used to be
  accepted, under the first member's name. Now the screen asks for the unlock first, because the seat
  is known only from the unlocked share; the unlock registers the device's key, and from the first
  device that does, the vault begins to refuse writes from anyone without a seat. A device opened
  only with a passkey reads the vault but must type the passphrase to propose.
