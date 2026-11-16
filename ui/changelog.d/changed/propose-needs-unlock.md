- **On a vault without signed actions, a device must unlock the vault before it proposes,
  and unlocking registers its key (#591).** A device that proposed there without unlocking used to be
  accepted, under the first member's name. Now the proposing screen asks for the passphrase first, right there, because the seat
  is known only from the unlocked share; the unlock registers the device's key, and from the first
  device that does, the vault begins to refuse writes from anyone without a seat. A device opened
  only with a passkey reads the vault but must type the passphrase to propose.
