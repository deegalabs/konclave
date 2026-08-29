# The relay blind to the payment (#63)

**Claim.** In a `/net` send, the blind relay no longer sees **who a vault pays or how much**. The
SignRequest is sealed to the seated devices, and the ceremony never re-broadcasts the transaction, so
a relay operator (or anyone holding the room without the group key) reads only ciphertext.

**What the block can and cannot show.** The transaction below is a normal, confirmed mainnet send;
the chain proves a send happened, exactly as for any other Konclave payment. It **cannot** show that
the relay was blind, for the same reason it cannot show a signature was a threshold one: privacy on
the wire leaves no on-chain trace. So the blindness rests on the **captured relay-room trace** below,
not on the block.

- **Transaction:** `047fe6cafe792f72c38eb6cd379e7c43be9c79cf20801288cab342580e896db3`
- **Block:** 3,464,505 (2026-08-29)
- **Vault:** browser-DKG 2-of-2, both devices registered (so the helper sealed).

## The relay-room trace

Read from the vault's signing room over the public relay API, for this send:

```
seq 23  helper   net-sign-request-sealed   (69,434 bytes, under the relay's 131,072 cap)
seq 24  device   sreq                       (pczt: ABSENT)
seq 25  device   s1
seq 26  device   s1
seq 27  device   sp
seq 28  device   s2
seq 29  device   s2
seq 30  device   signed
seq 31  device   net-sign-response
```

Two things the trace establishes:

1. **The request carries no cleartext payment.** The helper's message is `net-sign-request-sealed`:
   the request is encrypted once under a random key, and only that 32-byte key is sealed to each
   device (hybrid sealing). The recipient address, amount, sighash and PCZT appear nowhere in it, and
   at 69,434 bytes it fits the relay's message cap (the un-hybrid version overflowed it).
2. **The ceremony re-broadcasts nothing.** The coordinator's `sreq` carries **no PCZT** (`pczt:
   ABSENT`); each device signs the PCZT it already opened from its own sealed box. Before this fix
   the `sreq` re-broadcast the PCZT in cleartext, and that PCZT decoded to the recipient and amount -
   caught by live validation, not by the unit tests.

A programmatic scan of every message in the room for this send found **no plaintext PCZT** in any
device message: nothing the relay can read decodes to the payment.

## Honest limit

This is confidentiality against the **relay operator** and a room-holder who lacks the group key. It
is **not** authentication: an outsider who holds the vault id could still register a device key, but
such a holder can already read the (pre-#63) cleartext request today - that is the vault-id-capability
concern (#388), and authenticating the registrant and the room messages is #392. So this proof is a
strict gain on the relay's blindness, with no claim beyond it.
