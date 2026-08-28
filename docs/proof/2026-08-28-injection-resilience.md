# Injection-resilience proof — 2026-08-28

The send-poison fix (#391 / #394) proven live on mainnet: an outsider who knows only the vault's
**public** id posted a structurally-valid but cryptographically-bogus `net-sign-response` into a
running signing ceremony, and the send **survived** — the helper skipped the bogus message,
collected the real device signatures, and broadcast.

- **Vault:** the maintainer's 2-of-2 test vault (dan/bob).
- **Attacker:** an outside process holding only the public group key `eba68f41…785036`, from which
  the signing room `d4ff6c09…` is derived. It moved no funds and forged nothing — it can only read
  and post, which is the (open) privacy cost documented in #63/#340/#388, never a theft vector.
- **Transaction (the send that survived):**
  `ef80a1812275eccb58a032cdeeb1769e4890949257578c45e78348bcc07040c6`, mined at block **3,463,857**.

## The ceremony trace (from the relay room)

```
seq  1  p-7653eed4103e    rejoin
seq  2  p-ca4b1dd57dd0    rejoin
seq  3  p-7653eed4103e    armed
seq  4  p-ca4b1dd57dd0    armed
seq  5  helper            net-sign-request
seq  6  p-7653eed4103e    sreq
seq  7  p-ca4b1dd57dd0    s1
seq  8  p-7653eed4103e    s1
seq  9  redteam-attacker  net-sign-response  ← BOGUS INJECTION (outsider, garbage signatures)
seq 10  p-7653eed4103e    sp
seq 11  p-ca4b1dd57dd0    s2
seq 12  p-7653eed4103e    s2
seq 13  p-7653eed4103e    signed
seq 14  p-7653eed4103e    net-sign-response
```

`seq 9` is the outsider's bogus response, planted mid-ceremony. Before #394 the helper took the
first such message, failed to inject it, and returned 502 — so any outsider could DoS every send by
posting one junk message. After #394 it verifies each candidate (by trial-inject) and skips a bad
one, so the bogus at seq 9 was noise and the real response at seq 14 completed the send.

## Honest limit

The chain shows a normal, real, mined FROST send — it does **not** show that an injection happened
or was survived. That rests on this captured room trace and the deployed #394 fix, the same way the
cross-machine and phone rows in `PROOF.md` rest on the operators and the ceremony trail rather than
on the block.
