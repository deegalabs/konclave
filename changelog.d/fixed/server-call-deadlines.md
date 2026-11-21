- **A light-client server that stops answering no longer holds a vault.** Every call the coordinator and the local
  bridge make to that server (the broadcast, registering a vault's viewing key, reading the chain's tip, and the sync
  as before) now stops at a deadline, and the caller reports the failure. On the hosted coordinator a broadcast that is
  stopped keeps its attempt on record, as any broadcast error does there, so nothing signs again because of it.
