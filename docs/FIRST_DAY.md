# Your first day with a vault

> For a group that has just created a Konclave vault, and for the treasurer who will run it. It says
> what to do on day one, how money comes in, how a payment goes out, and what to do if something
> stops working. It is written from [GUIDE.md](GUIDE.md), [RECOVERY.md](RECOVERY.md),
> [CLAIMS.md](CLAIMS.md) and the [README](../README.md); where they say more, they win.

Start small. Konclave has not been independently audited, and until
[#567](https://github.com/deegalabs/konclave/issues/567) is fixed a payment the group signs is only
as safe as our hosted coordinator. Do not keep significant funds in it yet
([README](../README.md#try-it-live)).

## 1. Before you put money in

Do these four things while everyone who created the vault is still together.

1. **Compare the fingerprint.** Every member should see the same short code. If one person's code
   differs, that person is not in this vault. The code confirms you are all in the same vault, not
   who each member is, so also check with each person that they joined, and that the vault has as
   many members as there are people. You can find the code again in Settings.
2. **Each member downloads their own backup.** In Settings, export the backup file and keep the
   passphrase that opens it. That file is the only spare copy of your part of the key: nothing else
   restores your seat if your device is lost
   ([RECOVERY.md, procedure A](RECOVERY.md#a-member-lost-their-device-share-recovery)).
   **Never collect everyone's backup in one place.** Whoever holds every backup holds the whole
   vault, which is the one thing a shared vault exists to prevent.
3. **Check that the vault says Private.** The vault list shows a **Private** or **Open** badge. A
   backup made on a Private vault carries what is needed to see the vault's money again (its
   address, its viewing key and the block to scan from). A backup made on an Open vault brings back
   your seat, not the vault ([RECOVERY.md](RECOVERY.md#the-complete-recovery-kit)).
4. **Write down who holds which seat.** Each member signs with their own device, and no one can sign
   for someone else. Know who the members are and how to reach them, because a payment needs enough
   of them at the same time (section 3).

If someone in the group is comfortable with a terminal, they can check that a backup is complete
without Konclave: `node scripts/open-export.mjs <file>` asks for the passphrase and says whether the
viewing key and the scan block are inside
([RECOVERY.md](RECOVERY.md#opening-an-export-without-konclave)).

**About the number of approvals.** A new vault asks for 2 approvals out of 3 members by default. If
your group chose as many approvals as members (for example 2 of 2), one lost device locks the funds
for good, and the app warns about it when the vault is created
([GUIDE.md, UC-1](GUIDE.md#uc-1---create-a-vault-dkg-in-vault-modal)). Today there is no way to
replace a lost seat or change the members of an existing vault
([#154](https://github.com/deegalabs/konclave/issues/154)).

## 2. Putting ZEC in

1. Open **Receive**. It shows the vault's address (it starts with `u1`), a QR code and a payment
   link.
2. Send ZEC to that address from any Zcash wallet. Receiving needs no approval and no signature.
3. The address is shielded: amounts and parties are encrypted on the chain. New funds land in the
   Ironwood pool, and the balance appears after the vault syncs
   ([GUIDE.md, UC-3](GUIDE.md#uc-3---fund--receive)).

Keep in mind who can read the vault's books: the members, and also our hosted coordinator, which
holds the vault's viewing key and can see the balance, the payments, the amounts and the memos
([README](../README.md#trust-model-and-honest-limits)). Outsiders and the chain cannot.

## 3. Paying together

A payment goes through four steps, and money moves only at the last one.

1. **Propose.** A member enters the amount and the recipient (a saved person or a pasted address).
   The address and the balance are checked before the proposal exists.
2. **Approve.** Members approve or refuse. Nothing moves until the vault's number of approvals is
   reached. A proposal that waits too long expires (72 hours) and can no longer be sent.
3. **Sign.** Once approved, members open the payment and press **Sign with my share**. The payment
   goes out when as many members as the vault's number of approvals have signed. Any member can
   sign, including one who did not approve it.
4. **Sent.** One shielded transaction goes out, with a preview and an explicit confirmation first.
   One click never moves money ([README](../README.md#using-it-step-by-step)).

**Agree on a time to sign.** The signatures take seconds once the members who sign are online, and
the whole send takes a few minutes, most of it building the transaction
([GUIDE.md, UC-6](GUIDE.md#uc-6---sign--send-frost-broadcast)). So the members who will sign should
have the app open at the same time. A short call or a message ("signing the rent now") is enough.

**Payroll.** Several people can be paid in one transaction, approved once. On the web this is about
4 to 5 lines per payroll for now
([#821](https://github.com/deegalabs/konclave/issues/821)).

## 4. If something goes wrong

**A member loses their device.** On a new device, open Konclave, import the backup file and enter
its passphrase. The member gets their seat back and can approve and sign again
([RECOVERY.md, procedure A](RECOVERY.md#a-member-lost-their-device-share-recovery)). Without the
backup, that seat is gone.

**Our coordinator stops answering.** The money stays on the chain and each member's key stays on
their own device: neither depends on the coordinator. What depends on it is everyday use. It reads
the vault's balance and books, receives the proposals and votes, and builds and sends each
payment, so while it is down the group waits
([README](../README.md#trust-model-and-honest-limits)). The proposals are kept on the coordinator's
disk, not in its memory ([RECOVERY.md](RECOVERY.md#where-each-secret-lives-the-trust-boundary)).

**Every Konclave service is gone for good.** Read
[IF_EVERY_SERVICE_DISAPPEARS.md](IF_EVERY_SERVICE_DISAPPEARS.md). In short: your key stays yours,
and with the backups of a Private vault the group can still see its money, but today it cannot send
without a coordinator, because one tool is not built yet
([#613](https://github.com/deegalabs/konclave/issues/613)).

## Where to read more

- [GUIDE.md](GUIDE.md): every use case, step by step.
- [RECOVERY.md](RECOVERY.md): backups and recovery, in detail.
- [CLAIMS.md](CLAIMS.md): what is proven and what is not.
- [SECURITY.md](../SECURITY.md#known-limitations): the known limits.
