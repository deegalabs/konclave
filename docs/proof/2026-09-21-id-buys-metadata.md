# A vault id buys metadata, not contents (#388 / #402 / #476)

**Claim.** Someone holding only a vault's 64-hex id - the string a forwarded link carries - can read
that vault's **shape** and nothing else. Balance, transaction history, ledger, proposals, ceremonies,
member names and the viewing key all require `readKey`, which only a seated member's device derives
from the per-vault secret `S`.

**Why this is a script and not a transcript.** `docs/PROOF.md` cited "the probe log" for this and
**no such log was in the repository** - the claim rested on the operator's word while appearing to
rest on evidence. A transcript would have fixed the citation and not the problem: it proves what
happened once, on someone else's machine, to a vault you cannot inspect.

So the evidence is `scripts/probe-opacity.mjs`, which you run against **your own** vault:

```
node scripts/probe-opacity.mjs <vault-id> --times 3
```

It holds no key, sends no header, and could not write anything if it tried - which is the same
position as whoever found the link. It exits non-zero if any private read answers anything but 401.

## A captured run

Against a protected 2-of-3 vault on 2026-09-21. The id is redacted here for the obvious reason:
publishing it would hand over exactly the metadata this document is about.

```
pass 1
  200     359b  /api/vault   <- open by design
  401      46b  /api/vault/balance
  401      46b  /api/vault/transactions
  401      46b  /api/vault/ceremonies
  401      46b  /api/vault/proposals
  401      46b  /api/vault/ledger
  401      46b  /api/vault/ledger.csv
  401      46b  /api/vault/members
... (passes 2 and 3 identical)

The open route answered: 200/359  200/359  200/359
  byte-identical across every pass.

VERIFIED: every private read refused; the id bought metadata only.
```

**359 bytes is this vault's number, not a constant.** It varies with the vault's name and addresses;
`docs/PROOF.md` cites 253 for a different vault and both are right. What carries the claim is that
the number does not CHANGE, not what it is.

## What an id does buy, stated plainly

`/api/vault` is outside the gate deliberately, and the coordinator says so at the route: *"This
closes DISCOVERY, not authorization: whoever has an id can still read that vault."* It returns the
quorum shape, the member count, the receive address and the change receiver.

Two reasons it stays open, both checked rather than assumed: the change receiver is an address of the
same class as the published one and grants no viewing power, and `Layout.tsx` reads the vault BEFORE
it decides whether to show the unlock - so gating that route would make a locked vault answer `null`,
skip the unlock decision, and land the member on a blank screen.

## What this does NOT show

That a vault **mid-payment** is indistinguishable from an idle one. That is the same check run while
a ceremony is happening, comparing the byte count before, during and after. The script prints exactly
what you compare; run it during a payment to see that half. `docs/PROOF.md` row for `3fa08dce...`
records such a run, and until someone repeats it with this script, that row rests on the operator's
word - which is now written down rather than implied.

## The other half of honesty: it fails where it should

Run against one of the ~5 legacy vaults created before #388, the same script reports:

```
  200      25b  /api/vault/members
FAIL: a gated read did not answer 401. This vault is not protected, or the gate has a hole.
```

Those vaults are readable by anyone holding their id, and there is no automatic migration. A check
that could not tell them apart from a protected vault would be worth nothing.
