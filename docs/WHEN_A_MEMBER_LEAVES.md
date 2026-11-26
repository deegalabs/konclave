# When a member leaves the group

> This page is for a group whose member is leaving, for example someone who changes jobs, steps down
> as treasurer, or can no longer be trusted with a seat. It is written from [GUIDE.md](GUIDE.md), [RECOVERY.md](RECOVERY.md),
> [SECURITY.md](../SECURITY.md#known-limitations), the [README](../README.md) and the app's own
> screens; where they say more, they win.
>
> This procedure is checked against the code and the app's screens, but has not yet been run end to
> end. When it has, this note will say when.

## What you cannot do yet

You cannot add, remove or replace a member on an existing vault, or change how many must approve.
Membership is fixed when the vault is created
([GUIDE.md, UC-12](GUIDE.md#uc-12---members-registry)). Changing it in place is
[#154](https://github.com/deegalabs/konclave/issues/154), which is not built.

So a member who leaves keeps their seat on the vault, and their share still counts toward its
approvals, until the money moves to a new vault.

## What to do: move the money to a new vault

1. **Create a new vault** with the members who stay, and choose its rule (how many must approve).
   Do everything in [Your first day with a vault](FIRST_DAY.md#1-before-you-put-money-in), section 1,
   for it, before any money goes in.
2. **Check the new vault's address.** Open **Add funds** on the new vault and copy its address (it
   starts with `u1`). If the app first shows a **Viewing code**, compare it with the other members
   as in step 1. Every member who will approve should read the address on that screen themselves,
   so each can compare it later with the payment's recipient.
3. **Finish or refuse any open proposal on the old vault.** If the leaver cannot be trusted, refuse
   them all (see the last section). Money an open proposal holds is left out
   of what the vault can send.
4. **Send a small test first.** Propose a small payment from the old vault to that address,
   approve it, sign it, and check in the new vault's **Vault history** that it arrived (it can be
   spent a few blocks after it is mined). Only then move the rest.
5. **Propose the rest** from the old vault to the same address. **Max (minus fee)** fills in what
   the vault can send now, less an estimated network fee. If the app asks for a smaller amount or
   for two payments, do that, and send what remains in another payment. If a send fails because the
   vault does not hold enough for the payment plus the real fee, nothing was broadcast. Propose a
   slightly smaller amount.
6. **Approve it by the old vault's rule**, then sign and send it, as with any payment. Before
   approving, each approver compares the recipient shown with the address they read in step 2, and
   the amount with what they expect. The app shows the recipient again before each signature, so
   compare it there too.
7. **Check that it arrived** in the new vault's **Vault history**, on its **Add funds** screen, and
   look at the old vault's balance. A small amount can be left there, because the fee shown is an
   estimate, and money still waiting for confirmations is not included in what could be sent. If
   some remains, move it the same way, or accept that it stays under the old rule.
8. **Move the work over.** Give the new address to whoever pays the group, and run new payments and
   payrolls from the new vault. Each member adds the group's saved people again in the new vault's
   **Beneficiaries**. Money sent to the old address later is still under the old vault's rule,
   leaver included.

This needs a vault that shows **Private**. On a vault that shows **Open**, the app refuses to sign
a payment out of it, so its money cannot be moved this way
([#406](https://github.com/deegalabs/konclave/issues/406)).

## What it costs

- **The network fee.** Each payment pays one; it grows with the number of notes the payment spends,
  and the app shows an estimate before you approve and the exact fee, read from the transaction,
  before you sign.
- **More than one payment, sometimes.** One payment can spend only a few notes for now
  ([#821](https://github.com/deegalabs/konclave/issues/821)). A vault whose balance is made of many
  small deposits may not be able to send it all at once. The app then asks for a smaller amount, and
  the group sends the rest in further payments. The app cannot merge small notes yet, and with very
  small deposits the fees can take a large part of the balance
  ([#1015](https://github.com/deegalabs/konclave/issues/1015)).
- **Time.** Everyone who stays must be present to create the new vault, and the members who sign
  each payment must be online together. A proposal expires after 72 hours.

## What happens to the books

- **The new vault starts empty.** The move shows in its **Vault history**, on **Add funds**, as
  money received. Its **Ledger** lists only the payments the new vault makes, so it starts empty;
  in the old vault's Ledger, the move is the last payment.
- **The old vault's ledger stays in the app**, with its proposals and payments, for as long as the
  old vault exists on our coordinator. Before you stop using it, export the itemized CSV from its
  **Ledger** ([GUIDE.md, UC-11](GUIDE.md#uc-11---ledger--accounting-export)) and keep it with the
  group's records. If our coordinator no longer holds the old vault, its books cannot be opened in
  the app, and there is no tool yet to rebuild a vault from the backups
  ([#613](https://github.com/deegalabs/konclave/issues/613)).
- **Each member's backup of the old vault** stays what it was. It brings back that member's seat
  ([RECOVERY.md, procedure A](RECOVERY.md#a-member-lost-their-device-share-recovery)).

## If the leaver cannot be trusted

**Move first, announce after.** The leaver's share still counts on the old vault, so until the money
has moved, the leaver can still propose, approve and sign its payments with others. The move is not
hidden from them. As a member of the old vault, the leaver sees the proposal as soon as it is made,
and can refuse it, but cannot stop it while the members who stay reach the old vault's rule. So
agree on a time first, then propose, approve and sign in one sitting.

Refuse any open proposal on the old vault, including any the leaver made, before you propose the
move. Finishing one would pay it out of the money you are trying to protect, and an open proposal
also holds part of the balance back from the move.

The leaver can still read the old vault's books, and will see the move in them. They know the new
vault's address and the amount moved, and nothing after that. They cannot read the new vault's
books.

This works only if the members who stay can reach the old vault's rule on their own. Fewer members
than the rule asks for can neither sign nor rebuild the key
([README](../README.md#trust-model-and-honest-limits)). In a vault where every member must sign
(for example 2 of 2), or where the members who stay are fewer than the rule, the money cannot move
without the leaver.
