# Postmortem: the helper stopped answering, and could not be told apart from dead

**Date:** 2026-08-27 · **Duration:** at least 11 minutes unresponsive (13:45-13:56 BRT), of which 4 minutes measured continuously
**Impact:** every one of the 26 vaults on the hosted helper. No funds at risk, no data lost, no transaction affected.
**Status:** service restored by restart. Root cause **still present** (#375).

---

## What happened

The maintainer reported the main site frozen: `/vaults` showed skeleton loaders that never resolved.

Checked from outside:

```
GET {helper}/api/health          HTTP 000 after 15s   (timeout)
GET {relay}/api/relay/probe...   HTTP 200 in  1.1s
GET {helper}/api/vault?vault=…   HTTP 000 after 25s
GET {helper}/api/vault/balance   HTTP 000 after 25s
```

Retried every 20 seconds for 4 minutes: twelve consecutive timeouts, no recovery. The container was up, the deploy was ACTIVE, and the boot log ended cleanly with `konclave-helper listening … 26 vault(s) restored`. So the process had started fine and then stopped answering — including on the liveness endpoint.

Restarted at 13:56:04 (one 502 while it came up), healthy at 13:56:13. Confirmed afterwards that nothing was lost: 26 vaults restored, and the test vault's registration, proposals, members, ledger and ceremony trail all answered in under a second.

## Cause

`helper-server/src/main.rs:987` handles requests in a **serial loop**, with no threads anywhere in the file:

```rust
for mut req in server.incoming_requests() {
    let r = handle(&state, &cfg, &method, &path, &body);   // runs to completion
    let _ = req.respond(with_cors(out));
}
```

Several handlers are minutes long. A send polls the relay inline with `max_polls: 300` at one second each — **up to five minutes** during which the service answers nothing at all, to anyone.

So the failure mode is not a crash. It is the service being *busy*, and being busy is indistinguishable from being dead from the outside, because `/api/health` queues behind the same loop.

## Trigger

The maintainer imported a vault on a **preview** deployment. Preview and production share the same helper, so an operation started from a preview URL froze the production vault for all 26 vaults, including other people's.

## Why it was not caught earlier

- **The helper does not log requests.** Only one line at boot. There is no way to see, from the logs, what it was doing — the diagnosis came entirely from probing endpoints from outside.
- **Health is not a health check.** It reports liveness but shares the queue with everything else, so it says "dead" whenever the answer is "busy".
- **There is no environment to try things in.** The only way to exercise a change against a real vault is production, which is #370, filed earlier the same day for exactly this reason and then demonstrated by it.
- **We had added work to the hot path** without weighing it against the serial loop. The funding gate (#347/#348) put a `vault_balance()` call — which can trigger a wallet sync — on the proposal-create path.

## What was done

- Restarted the service after confirming with the maintainer that nobody was mid-ceremony (a restart would abort a live signing ceremony).
- Filed **#375** with the cause and a fix order.
- Recorded on **#373** that both services run a single replica, which the maintainer confirmed from the dashboard — this also closes a question that had been blocking the domain work.

## What is still open

1. **Answer `/api/health` without entering the queue.** The cheapest change on the list and the one that ends "cannot tell busy from dead" permanently.
2. **One thread per request**, with a **per-vault lock** — without that lock, two sends for the same vault would fight over the same wallet directory.
3. **Stop holding a request open for five minutes.** The send blocks because it polls the relay inline; a queued job with a status endpoint removes the class. Bigger, and it changes the client contract.
4. **Staging (#370)**, so "try it" stops meaning "try it on the vaults holding real ZEC".

## Honest notes

- **The restart was a remedy, not a fix.** The same freeze will happen on the next long send. Nothing has changed except that we now know why.
- **I did not know the server was serial** before today, despite having changed that file three times in the previous 24 hours. I read the handlers and never the loop that calls them.
- **Adding the funding gate made this more likely** and I did not think about it at the time. It was the right fix for the right problem, and it put another blocking call on the busiest path.
- **The four-minute wait was necessary and cost four minutes.** With a health endpoint that answered, it would have taken one request to know the process was alive and busy rather than crashed.
