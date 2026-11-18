- **The coordinator reads the devices' signing answer more reliably while it waits for it.** How it
  sorts the messages in the signing room was tightened, and an answer whose check could not run is
  now read again instead of being dropped, so a send no longer times out for that reason. The signer
  now tells a refused signature apart from a check that could not run by its exit status.
