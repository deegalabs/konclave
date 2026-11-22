- **An approval counts once per member, and only if it was signed once the vault requires signatures
  (#575).** An approval used to be a name: one recorded under a member's exact name while a vault
  still took unsigned actions went on counting as theirs after the vault required signatures, and two
  members with the same name counted as one. Votes now record their seat and their signature; the
  coordinator counts seats (a vote recorded without a signature no longer counts on a payment still
  open once signatures are required). An approval given before a vault required signatures has to be given
  again.
