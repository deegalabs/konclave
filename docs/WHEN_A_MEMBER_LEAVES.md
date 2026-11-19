# When a member leaves the group

> For a group whose member is leaving: someone changes jobs, steps down as treasurer, or can no
> longer be trusted with a seat. It is written from [GUIDE.md](GUIDE.md), [RECOVERY.md](RECOVERY.md),
> [SECURITY.md](../SECURITY.md#known-limitations), the [README](../README.md) and the app's own
> screens; where they say more, they win.

## What you cannot do yet

You cannot add, remove or replace a member on an existing vault, or change how many must approve.
Membership is fixed when the vault is created
([GUIDE.md, UC-12](GUIDE.md#uc-12---members-registry)). Changing it in place is
[#154](https://github.com/deegalabs/konclave/issues/154), which is not built.

So a member who leaves keeps their seat on the vault, and their share still counts toward its
approvals, until the money moves to a new vault.

## What to do: move the money to a new vault

1. **Create a new vault** with the members who stay, and choose its rule (how many must approve).
   Do everything in [Your first day with a vault](FIRST_DAY.md) section 1 for it, before any money
   goes in.
2. **Check the new vault's address.** Open **Add funds** on the new vault, compare its viewing code
   with the other members, and copy its address (it starts with `u1`).
3. **Propose a payment from the old vault** to that address. **Max (minus fee)** fills in the whole
   balance less the network fee.
4. **Approve it by the old vault's rule**, then sign and send it, as with any payment.
5. **Check that it arrived** in the new vault's **Vault history**, on its **Add funds** screen.
6. **Move the work over.** Give the new address to whoever pays the group, and run new payments and
   payrolls from the new vault. Money sent to the old address later is still under the old vault's
   rule, leaver included.

## What it costs

- **The network fee.** Each payment pays one; it grows with the number of notes the payment spends,
  and the app shows it before you approve and again before you sign.
- **More than one payment, sometimes.** One payment can spend only a few notes for now
  ([#821](https://github.com/deegalabs/konclave/issues/821)). A vault whose balance is made of many
  small deposits may not be able to send it all at once: the app then asks for a smaller amount, and
  the group sends the rest in further payments. The app cannot merge small notes yet, and with very
  small deposits the fees can take a large part of the balance
  ([#1015](https://github.com/deegalabs/konclave/issues/1015)).
- **Time.** Everyone who stays must be present to create the new vault, and the members who sign
  each payment must be online together. A proposal expires after 72 hours.

## What happens to the books

- **The new vault starts empty.** Its ledger begins with the move.
- **The old vault's ledger stays in the app**, with its proposals and payments, for as long as the
  old vault exists on our coordinator. Before you stop using it, export the itemized CSV from its
  **Ledger** ([GUIDE.md, UC-11](GUIDE.md#uc-11---ledger--accounting-export)) and keep it with the
  group's records.
- **Each member's backup of the old vault** stays what it was: it brings back that member's seat
  ([RECOVERY.md, procedure A](RECOVERY.md#a-member-lost-their-device-share-recovery)).

## If the leaver cannot be trusted

**Move first, announce after.** The leaver's share still counts on the old vault, so until the money
has moved, the leaver can still approve and sign its payments with others.

This works only if the members who stay can reach the old vault's rule on their own. Fewer members
than the rule asks for can neither sign nor rebuild the key
([README](../README.md#trust-model-and-honest-limits)). In a vault where every member must sign
(for example 2 of 2), or where the members who stay are fewer than the rule, the money cannot move
without the leaver.
