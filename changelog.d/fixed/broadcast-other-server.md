- **A send is no longer lost to one light-client server being down.** When the server a send is broadcast through does not
  answer in time or cannot be reached, the coordinator now sends the same signed transaction through the next server
  it has, within three minutes in all; a server that answers and refuses the transaction is not asked again elsewhere.
  If no server takes it, the message now says the transaction may have reached the network and not to send it again
  before checking, since a server that timed out may have received it.
