- **Two vaults finishing at the same time on one device could leave one without its member list.**
  When two vaults finished their setup together, one of them could read the other's "already there"
  answer as its own and finish without the coordinator having its member list, so its proposals were
  refused afterwards. Each setup now reads only the answer to its own request, and stays unfinished
  when its own answer is missing.
