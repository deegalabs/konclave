- **Creating a vault is hardened.** New vaults are created under a new creation protocol, and
  before a new vault's address is shown the app gives each member a viewing code to compare with
  the others outside the app, and shows the address once the member confirms they compared it. An
  app older than this one cannot create or join a new vault: from 0.13.0 it says to update before
  it starts; an older one fails when it registers the vault. Vaults that already exist keep working
  as before.
