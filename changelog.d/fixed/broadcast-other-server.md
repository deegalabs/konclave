- **A send no longer fails because one light-client server stops answering.** When the server a send is broadcast through
  cannot be reached, or does not answer within its time limit, the coordinator sends the same signed transaction through
  the next server it has that is close to the others, within three minutes in all. A failure after the transaction was
  handed to a server is reported as it is and not tried elsewhere. If no server takes it after a time-out, the message says the transaction may have reached
  the network and not to send it again before checking, since a server that timed out may have received it.
