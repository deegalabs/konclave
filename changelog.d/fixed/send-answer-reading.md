- **The coordinator reads the devices' signing answer more reliably while it waits for it.** How it
  sorts the messages in the signing room was tightened, and an answer whose check could not run for a
  moment is read again a few times instead of being dropped. The signer now tells a refused
  signature apart from a check that could not run by its exit status, and the coordinator asks the
  signer whether it does before reading its exits that way.
